import { sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { monitorHfSamples } from "@/db/schema";

/**
 * What the plane ACHIEVED, read from the observations themselves.
 *
 * This is the number the monitor form shows next to the configured one,
 * and the two are shown separately on purpose. A configured interval is
 * a request; this is what happened. Until this feature existed, the
 * product had exactly one cadence figure — the one the operator typed —
 * and it was presented as if it were a fact about the world. It was not:
 * the delivered floor was pg-boss's poll, roughly four times the
 * shortest number the form would accept, and nothing anywhere said so.
 *
 * Measured from consecutive samples rather than from the scheduler's own
 * counters, because the scheduler's intent is the thing in doubt. A
 * scheduler that believes it fired every slot and a database that
 * received half of them disagree, and the samples are the half that is
 * true.
 *
 * ── what this is not ─────────────────────────────────────────────────
 *
 * It is not detection time and cannot be turned into one. Cadence is the
 * gap between probes; detection additionally costs the probe's own
 * duration, the failure window the operator configured, the incident
 * path and the notification path. `docs/HIGH-FREQUENCY.md` sets out the
 * five terms. Nothing in this module returns a "time to detect" field,
 * and nothing should add one.
 */

export interface AchievedCadence {
  /** How far back the figures were measured over. */
  windowMinutes: number;
  samples: number;
  /** Gap between consecutive samples, in milliseconds. */
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  /**
   * Gaps of at least twice the configured interval — one or more whole
   * slots that did not happen. Derived from the samples for the same
   * reason everything else here is.
   */
  missedSlots: number;
  lastSampleAt: Date | null;
}

/**
 * The window the UI reads over.
 *
 * Fifteen minutes: long enough that a 500ms monitor contributes 1,800
 * samples and a percentile means something, short enough that an
 * operator who just fixed something sees it recover rather than seeing
 * it averaged with the hour before.
 */
export const ACHIEVED_WINDOW_MINUTES = 15;

/**
 * Achieved cadence for one monitor.
 *
 * Percentiles come from `percentile_cont` in Postgres rather than from
 * shipping every gap to Node: at 500ms a fifteen-minute window is 1,800
 * rows per monitor, and a page that renders four monitors would move
 * seven thousand rows to compute six numbers.
 */
export async function achievedCadence(
  db: DbClient,
  monitorId: string,
  windowMinutes: number = ACHIEVED_WINDOW_MINUTES,
  /**
   * The configured interval, needed only to count missed slots. Null
   * when the monitor is not on the plane, which makes the count null
   * rather than zero — "no slots were missed" and "there are no slots"
   * are different statements.
   */
  configuredIntervalMs: number | null = null,
): Promise<AchievedCadence> {
  const result = await db.execute<{
    samples: string;
    p50: string | null;
    p95: string | null;
    p99: string | null;
    max_ms: string | null;
    missed: string;
    last_at: string | null;
  }>(sql`
    with gaps as (
      select
        ${monitorHfSamples.observedAt} as observed_at,
        extract(epoch from (
          ${monitorHfSamples.observedAt}
          - lag(${monitorHfSamples.observedAt}) over (order by ${monitorHfSamples.observedAt})
        )) * 1000 as gap_ms
      from ${monitorHfSamples}
      where ${monitorHfSamples.monitorId} = ${monitorId}
        and ${monitorHfSamples.observedAt} >= now() - make_interval(mins => ${windowMinutes})
    )
    select
      count(*) filter (where gap_ms is not null) as samples,
      percentile_cont(0.5) within group (order by gap_ms) as p50,
      percentile_cont(0.95) within group (order by gap_ms) as p95,
      percentile_cont(0.99) within group (order by gap_ms) as p99,
      max(gap_ms) as max_ms,
      count(*) filter (
        where ${configuredIntervalMs === null ? sql`false` : sql`gap_ms >= ${configuredIntervalMs * 2}`}
      ) as missed,
      max(observed_at) as last_at
    from gaps
  `);

  const row = result.rows[0];
  return {
    windowMinutes,
    samples: Number(row?.samples ?? 0),
    p50Ms: round(row?.p50),
    p95Ms: round(row?.p95),
    p99Ms: round(row?.p99),
    maxMs: round(row?.max_ms),
    missedSlots: Number(row?.missed ?? 0),
    lastSampleAt: row?.last_at ? new Date(row.last_at) : null,
  };
}

/** Whole milliseconds; the samples themselves are not finer than that. */
function round(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}
