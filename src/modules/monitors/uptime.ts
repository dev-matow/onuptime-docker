import { inArray, sql, type SQL } from "drizzle-orm";

import { monitorChecks, monitors } from "@/db/schema";

import { STANDING_OBSERVATION_CHECK_TYPE_IDS } from "./types/catalog";

/**
 * Duration-weighted uptime: the one methodology.
 *
 * Every uptime number in the product — the list stat, the detail
 * windows, the status-page strip and its headline — comes from here.
 * Before 1.13.0 each of them counted rows: `ok samples / total samples`.
 * That is only the same thing as uptime when samples are evenly spaced,
 * and Vigil's scheduler deliberately makes sure they are not. A
 * suspicious monitor is probed `SUSPICION_DIVISOR` times as often and a
 * calm one `CALM_MULTIPLIER` times less, so a count-weighted ratio
 * oversamples exactly the minutes that went wrong — up to 32x — and
 * reports an outage as far worse than it was. The adaptive scheduler is
 * the right behaviour; counting rows was the wrong reader.
 *
 * The fix is to weight each observation by how long it stood for. A
 * sample at `t` is evidence about the monitor from `t` until the next
 * sample, and about nothing else.
 *
 * ── the coverage horizon ────────────────────────────────────────────
 *
 * "Until the next sample" cannot be unbounded, or one sample before a
 * three-day worker outage would report three days of green. So a
 * sample's evidence expires: it stands for at most `coverageHorizonMs`.
 * Time nothing vouches for is *uncovered* — excluded from the numerator
 * and the denominator alike, and reported separately so the caller can
 * say "98% of the 71% we could see" rather than quietly averaging a
 * blackout into a good number.
 *
 * Uncovered time is what a paused monitor produces, and that is
 * deliberate. Pausing writes no checks, so a paused stretch is exactly
 * "no evidence" — which is the truth, and needs no pause-history table
 * to say.
 *
 * The horizon is a property of the *kind* of evidence, not only of the
 * cadence. A probe's result goes stale because the thing it measured
 * can change without saying so; an operator's statement on a manual
 * monitor cannot, and is replaced rather than expiring. See
 * `coverageHorizonMs`.
 *
 * ── what counts as up ───────────────────────────────────────────────
 *
 * `ok` — so `degraded` counts as up. Uptime answers "was it serving",
 * not "was it fast"; response time is its own number.
 *
 * `indeterminate` observations establish no state at all. They are
 * Vigil saying "I could not tell" (a ping probe without CAP_NET_RAW, a
 * check type this build dropped), and neither the numerator, the
 * denominator, nor the timeline should hear from them. The previous
 * measured state simply carries on through — still expiring at its own
 * horizon, so a monitor that goes indeterminate forever goes uncovered
 * rather than staying green.
 */

/** A measured observation. `indeterminate` rows must be filtered out first. */
export interface UptimeSample {
  at: Date;
  ok: boolean;
}

export interface UptimeWindowBounds {
  start: Date;
  /** Exclusive. Callers pass `min(now, requestedEnd)` — the future is not covered. */
  end: Date;
}

export interface UptimeResult {
  /** Milliseconds inside the window that a sample vouched for. */
  coveredMs: number;
  /** Of those, how many were `ok`. */
  upMs: number;
  /** Window milliseconds no sample vouched for: gaps, pauses, downtime of Vigil itself. */
  uncoveredMs: number;
  /**
   * `upMs / coveredMs` as a percentage, or null when nothing was
   * covered. Null is not 0% — "we did not see" and "it was down" are
   * different claims and the UI renders them differently.
   */
  uptimePct: number | null;
}

/**
 * How long one observation stands for, given the monitor's configured
 * interval.
 *
 * Three intervals, floored at a minute. Three because the scheduler may
 * legitimately stretch to `CALM_MULTIPLIER` (2) intervals and still be
 * healthy, and one more interval absorbs ordinary queue lag without
 * manufacturing fake gaps. Floored at a minute because a 2-second
 * monitor would otherwise report a routine worker redeploy as an
 * outage-shaped hole in its coverage.
 *
 * Wrong in the safe direction: too short shows uncovered time that an
 * operator can explain, too long invents green.
 */
export function coverageHorizonMs(
  intervalSeconds: number,
  checkType?: string,
): number {
  if (checkType !== undefined && standsIndefinitely(checkType)) {
    return STANDING_HORIZON_MS;
  }
  return Math.max(60_000, intervalSeconds * 3_000);
}

/**
 * The exception, and the only one: an observation that nothing will
 * contradict except a person.
 *
 * Every other kind produces evidence with a shelf life, because the
 * thing it measured can change without telling anybody — that is what
 * the horizon is for. An operator's statement is different in kind. It
 * does not decay; it is *replaced*, by the same operator or another
 * one, and until then it is exactly as true as it was when it was made.
 * Expiring it would report "no data" for a monitor that is doing
 * precisely what it was asked to do, and the reader would have no way
 * to tell that from a monitor nobody is watching.
 *
 * Ten years rather than Infinity, because the SQL counterpart has to
 * express the same number to `make_interval` and the parity test
 * compares the two against the same history. Any value past the widest
 * window (90 days) behaves identically; this one is unmistakably "not a
 * real duration".
 */
const STANDING_HORIZON_SECONDS = 315_360_000;

const STANDING_HORIZON_MS = STANDING_HORIZON_SECONDS * 1000;

function standsIndefinitely(checkType: string): boolean {
  return STANDING_OBSERVATION_CHECK_TYPE_IDS.includes(checkType);
}

/**
 * The methodology itself, as a pure function over samples.
 *
 * This is the definition; `uptimeSegments()` below is the same rule
 * expressed in SQL so a 90-day page does not ship a million rows to
 * Node. `tests/unit/uptime.test.ts` pins the semantics here and
 * `tests/integration/uptime-parity.test.ts` proves the SQL agrees on
 * randomised histories — which is what makes "one methodology" a fact
 * rather than an intention.
 *
 * @param samples measured observations, any order; sorted internally.
 */
export function uptimeFromSamples(
  samples: readonly UptimeSample[],
  window: UptimeWindowBounds,
  horizonMs: number,
): UptimeResult {
  const windowStart = window.start.getTime();
  const windowEnd = window.end.getTime();
  const windowMs = Math.max(0, windowEnd - windowStart);
  if (windowMs === 0) {
    return { coveredMs: 0, upMs: 0, uncoveredMs: 0, uptimePct: null };
  }

  const ordered = [...samples]
    .map((s) => ({ at: s.at.getTime(), ok: s.ok }))
    // A sample whose horizon expires before the window opens is evidence
    // about a time nobody asked for. Dropping it here is what lets the
    // SQL bound its scan by `checked_at > start - horizon` instead of
    // hunting backwards for a carry-in row.
    .filter((s) => s.at + horizonMs > windowStart && s.at < windowEnd)
    .sort((a, b) => a.at - b.at);

  let coveredMs = 0;
  let upMs = 0;

  for (const [index, sample] of ordered.entries()) {
    const next = ordered[index + 1];
    const segmentStart = Math.max(sample.at, windowStart);
    const segmentEnd = Math.min(
      next ? next.at : windowEnd,
      windowEnd,
      sample.at + horizonMs,
    );
    const durationMs = segmentEnd - segmentStart;
    if (durationMs <= 0) continue;
    coveredMs += durationMs;
    if (sample.ok) upMs += durationMs;
  }

  return {
    coveredMs,
    upMs,
    uncoveredMs: windowMs - coveredMs,
    uptimePct: coveredMs === 0 ? null : round2((upMs / coveredMs) * 100),
  };
}

/** Two decimals, the precision every uptime surface renders. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Observations that actually measured something.
 *
 * An `indeterminate` check is Vigil saying "I could not tell" — a ping
 * monitor on a worker without CAP_NET_RAW, or a check type this build no
 * longer has. Those rows are stored `ok = false` (there is no third
 * boolean), so counting them as downtime publishes a red strip for an
 * operator configuration problem, which is precisely the false outage
 * `docs/UPGRADE.md` promises never happens. They belong in neither the
 * numerator nor the denominator, and they establish no state.
 *
 * `is distinct from`, never `<>`: migration 0010 leaves `verdict` NULL
 * on every pre-1.10 row and `<>` is NULL for those, which would drop the
 * entire pre-upgrade history out of the timeline.
 *
 * One definition, exported, because it used to be two — `monitors/` and
 * `status-pages/` each carried a copy, which is how they drifted.
 */
export const MEASURED: SQL = sql`${monitorChecks.verdict} is distinct from 'indeterminate'`;

/**
 * The horizon expression, in seconds, as SQL — the exact counterpart of
 * `coverageHorizonMs`. It reads `interval_seconds` off the joined
 * monitor row, so a monitor's own cadence decides how long its
 * observations stand for, and `check_type` for the one kind whose
 * observations do not expire at all.
 *
 * If you change one of these, change the other: the parity test compares
 * them against the same history and will fail loudly, which is the
 * point.
 */
const INTERVAL_HORIZON = sql`greatest(60, ${monitors.intervalSeconds} * 3)`;

/**
 * Each id is bound as its own parameter rather than the list being sent
 * as one array: an array parameter has to arrive already in Postgres'
 * literal syntax, and a driver that decides otherwise turns a horizon
 * expression into a runtime cast error on every uptime query in the
 * product. One placeholder per id is the boring version, and the list
 * has one entry.
 */
const HORIZON_SECONDS =
  STANDING_OBSERVATION_CHECK_TYPE_IDS.length === 0
    ? INTERVAL_HORIZON
    : sql`case when ${monitors.checkType} in (${sql.join(
        STANDING_OBSERVATION_CHECK_TYPE_IDS.map((id) => sql`${id}`),
        sql`, `,
      )}) then ${STANDING_HORIZON_SECONDS} else ${INTERVAL_HORIZON} end`;

/**
 * `uptimeFromSamples` as SQL: one row per (monitor, segment), already
 * clipped to the window and to each sample's coverage horizon.
 *
 * Callers `sum(duration_ms)` over it — total for the denominator,
 * `filter (where ok)` for the numerator — or join it to a day series for
 * a per-day strip. Emitting segments rather than a finished percentage
 * is what lets one expression serve both surfaces from one rule.
 *
 * Self-contained on purpose: it joins `monitors` for the horizon and
 * takes the monitor set as a value, so no caller has to know the alias
 * it uses internally or keep a filter fragment in step with it.
 *
 * The scan is bounded by the horizon on both sides — a sample older than
 * `start - horizon` cannot reach into the window — so there is no
 * separate carry-in lookup to get wrong.
 */
export function uptimeSegments(
  monitorIds: readonly string[],
  windowStart: Date,
  windowEnd: Date,
): SQL {
  // Every bound is cast explicitly. An untyped bind parameter next to
  // `make_interval(...)` leaves Postgres to guess, and it guesses
  // `interval` — so `$1 - make_interval(...)` fails to resolve against a
  // timestamptz column rather than doing the obvious thing.
  const start = sql`${windowStart}::timestamptz`;
  const end = sql`${windowEnd}::timestamptz`;
  return sql`
    select
      s.monitor_id,
      s.ok,
      s.seg_start,
      s.seg_end,
      extract(epoch from (s.seg_end - s.seg_start)) * 1000 as duration_ms
    from (
      select
        ${monitorChecks.monitorId} as monitor_id,
        ${monitorChecks.ok} as ok,
        greatest(${monitorChecks.checkedAt}, ${start}) as seg_start,
        least(
          coalesce(
            lead(${monitorChecks.checkedAt}) over (
              partition by ${monitorChecks.monitorId}
              order by ${monitorChecks.checkedAt}
            ),
            ${end}
          ),
          ${end},
          ${monitorChecks.checkedAt} + make_interval(secs => ${HORIZON_SECONDS})
        ) as seg_end
      from ${monitorChecks}
      join ${monitors} on ${monitors.id} = ${monitorChecks.monitorId}
      where ${inArray(monitorChecks.monitorId, monitorIds)}
        and ${MEASURED}
        and ${monitorChecks.checkedAt} < ${end}
        and ${monitorChecks.checkedAt} > ${start} - make_interval(secs => ${HORIZON_SECONDS})
    ) s
    where s.seg_end > s.seg_start
  `;
}
