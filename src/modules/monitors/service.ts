import { and, asc, desc, eq, gte, isNull, or, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { monitorChecks, monitors } from "@/db/schema";
import { NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit";
import { stampFact } from "@/modules/ledger/service";

import type { CheckResult } from "./check";
import { nextEvaluationAt, type RecentObservation } from "./scheduling";
import type { CreateMonitorInput, UpdateMonitorInput } from "./schemas";
import {
  advanceFailureRun,
  reconcile,
  type Reconciliation,
} from "./status-controller";
import type { Verdict } from "./types/conditions";
import { monitorColumnsFor } from "./types/persist";
import { requireSpec } from "./types/specs";

export type Monitor = typeof monitors.$inferSelect;
export type MonitorCheck = typeof monitorChecks.$inferSelect;

interface Actor {
  organizationId: string;
  userId: string;
}

export interface MonitorListItem extends Monitor {
  uptime24hPct: number | null;
  avgResponseMs: number | null;
}

/**
 * Observations that actually measured something.
 *
 * An `indeterminate` check is Vigil saying "I could not tell" — a ping
 * monitor on a worker without CAP_NET_RAW, or a check type this build
 * no longer has. Those rows are stored `ok = false` (there is no third
 * boolean), so counting them as downtime publishes a red 0% strip for
 * an operator configuration problem, which is precisely the false
 * outage `docs/UPGRADE.md` promises never happens. They belong in
 * neither the numerator nor the denominator.
 *
 * `is distinct from`, never `<>`: migration 0010 leaves `verdict` NULL
 * on every pre-1.10 row, and `<>` is NULL for those — which would drop
 * the entire pre-upgrade history out of the denominator.
 */
const MEASURED = sql`${monitorChecks.verdict} is distinct from 'indeterminate'`;

export async function listMonitors(
  db: DbClient,
  organizationId: string,
): Promise<MonitorListItem[]> {
  const stats = db.$with("stats").as(
    db
      .select({
        monitorId: monitorChecks.monitorId,
        uptime24hPct: sql<number>`
          round(
            count(*) filter (where ${monitorChecks.ok} and ${MEASURED}) * 100.0
            / nullif(count(*) filter (where ${MEASURED}), 0),
            2
          )
        `.as("uptime_24h_pct"),
        avgResponseMs: sql<number>`
          round(avg(${monitorChecks.responseTimeMs}) filter (where ${monitorChecks.ok}))
        `.as("avg_response_ms"),
      })
      .from(monitorChecks)
      .where(gte(monitorChecks.checkedAt, sql`now() - interval '24 hours'`))
      .groupBy(monitorChecks.monitorId),
  );

  const rows = await db
    .with(stats)
    .select({
      monitor: monitors,
      uptime24hPct: stats.uptime24hPct,
      avgResponseMs: stats.avgResponseMs,
    })
    .from(monitors)
    .leftJoin(stats, eq(stats.monitorId, monitors.id))
    .where(eq(monitors.organizationId, organizationId))
    .orderBy(asc(monitors.createdAt));

  return rows.map(({ monitor, uptime24hPct, avgResponseMs }) => ({
    ...monitor,
    uptime24hPct: uptime24hPct === null ? null : Number(uptime24hPct),
    avgResponseMs: avgResponseMs === null ? null : Number(avgResponseMs),
  }));
}

export interface UptimeWindow {
  label: "24h" | "7d" | "30d";
  uptimePct: number | null;
  avgResponseMs: number | null;
}

export interface MonitorDetail {
  monitor: Monitor;
  windows: UptimeWindow[];
  recentChecks: MonitorCheck[];
}

export async function getMonitorDetail(
  db: DbClient,
  organizationId: string,
  monitorId: string,
): Promise<MonitorDetail> {
  const monitor = await findMonitorOrThrow(db, organizationId, monitorId);

  const [aggregate] = await db
    .select({
      ok24h: sql<number>`count(*) filter (where ${okWithin("24 hours")})`,
      total24h: sql<number>`count(*) filter (where ${within("24 hours")})`,
      avg24h: sql<
        number | null
      >`round(avg(${monitorChecks.responseTimeMs}) filter (where ${okWithin("24 hours")}))`,
      ok7d: sql<number>`count(*) filter (where ${okWithin("7 days")})`,
      total7d: sql<number>`count(*) filter (where ${within("7 days")})`,
      avg7d: sql<
        number | null
      >`round(avg(${monitorChecks.responseTimeMs}) filter (where ${okWithin("7 days")}))`,
      ok30d: sql<number>`count(*) filter (where ${okWithin("30 days")})`,
      total30d: sql<number>`count(*) filter (where ${within("30 days")})`,
      avg30d: sql<
        number | null
      >`round(avg(${monitorChecks.responseTimeMs}) filter (where ${okWithin("30 days")}))`,
    })
    .from(monitorChecks)
    .where(eq(monitorChecks.monitorId, monitorId));

  const recentChecks = await db.query.monitorChecks.findMany({
    where: eq(monitorChecks.monitorId, monitorId),
    orderBy: [desc(monitorChecks.checkedAt)],
    limit: 60,
  });

  const windows: UptimeWindow[] = [
    window("24h", aggregate?.ok24h, aggregate?.total24h, aggregate?.avg24h),
    window("7d", aggregate?.ok7d, aggregate?.total7d, aggregate?.avg7d),
    window("30d", aggregate?.ok30d, aggregate?.total30d, aggregate?.avg30d),
  ];

  return { monitor, windows, recentChecks };
}

function within(interval: string) {
  // Carries the MEASURED filter, so it applies to the denominator and
  // the numerator alike — `okWithin` is built from this.
  return sql`${monitorChecks.checkedAt} > now() - ${sql.raw(`interval '${interval}'`)} and ${MEASURED}`;
}

function okWithin(interval: string) {
  return sql`${within(interval)} and ${monitorChecks.ok}`;
}

function window(
  label: UptimeWindow["label"],
  ok: number | undefined,
  total: number | undefined,
  avg: number | null | undefined,
): UptimeWindow {
  const totalCount = Number(total ?? 0);
  return {
    label,
    uptimePct:
      totalCount === 0
        ? null
        : Math.round((Number(ok ?? 0) / totalCount) * 10_000) / 100,
    avgResponseMs: avg === null || avg === undefined ? null : Number(avg),
  };
}

export async function createMonitor(
  db: DbClient,
  actor: Actor,
  input: CreateMonitorInput,
): Promise<Monitor> {
  const spec = requireSpec(input.checkType);
  return db.transaction(async (tx) => {
    const [monitor] = await tx
      .insert(monitors)
      .values({
        organizationId: actor.organizationId,
        createdBy: actor.userId,
        name: input.name,
        checkType: input.checkType,
        url: input.url,
        intervalSeconds: input.intervalSeconds,
        timeoutMs: input.timeoutMs,
        degradedThresholdMs: input.degradedThresholdMs,
        failureWindowSeconds: input.failureWindowSeconds,
        // Due immediately: a monitor nobody has checked has nothing to
        // schedule around, and waiting one interval to find out the URL
        // was wrong is the worst possible first impression.
        nextEvaluationAt: new Date(),
        ...monitorColumnsFor(spec, input),
      })
      .returning();
    if (!monitor) throw new Error("insert returned no row");

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "monitor.created",
      targetType: "monitor",
      targetId: monitor.id,
      metadata: { name: monitor.name, url: monitor.url },
    });
    return monitor;
  });
}

export async function updateMonitor(
  db: DbClient,
  actor: Actor,
  monitorId: string,
  input: UpdateMonitorInput,
): Promise<Monitor> {
  return db.transaction(async (tx) => {
    const existing = await findMonitorOrThrow(
      tx,
      actor.organizationId,
      monitorId,
    );

    // Settings are normalised against the effective type, merging what
    // was submitted over what is stored. Doing it any other way means a
    // type switch can leave the previous type's settings behind.
    const checkType = input.checkType ?? existing.checkType;
    const spec = requireSpec(checkType);
    const columns = monitorColumnsFor(spec, {
      port: input.port === undefined ? existing.port : input.port,
      method: input.method ?? existing.method,
      expectedStatusCode:
        input.expectedStatusCode === undefined
          ? existing.expectedStatusCode
          : input.expectedStatusCode,
      bodyKeyword:
        input.bodyKeyword === undefined
          ? existing.bodyKeyword
          : input.bodyKeyword,
      keywordAbsent: input.keywordAbsent ?? existing.keywordAbsent,
      tlsCheck: input.tlsCheck ?? existing.tlsCheck,
      tlsWarnDays: input.tlsWarnDays ?? existing.tlsWarnDays,
      config: input.config === undefined ? existing.config : input.config,
    });

    const [updated] = await tx
      .update(monitors)
      .set({
        ...input,
        checkType,
        ...columns,
        // Editing the rule creates a new version of it. The old version
        // is never touched, so an observation recorded under it stays
        // interpretable — which is the whole point of versioning the
        // spec rather than mutating it in place.
        specVersion: ruleChanged(existing, input)
          ? existing.specVersion + 1
          : existing.specVersion,
        // A changed baseline should take effect now, not after the old
        // one elapses.
        ...(input.intervalSeconds !== undefined &&
        input.intervalSeconds !== existing.intervalSeconds
          ? { nextEvaluationAt: new Date() }
          : {}),
        // DELIBERATELY ABSENT: `firstFailureAt` is not reset when
        // `failureWindowSeconds` changes. It looks like an oversight and
        // is not.
        //
        // Measuring the run from its real start works in both
        // directions. Widening mid-outage extends the deadline from the
        // original failure — you asked for more tolerance and you get
        // it. Narrowing fires the incident immediately — you asked for
        // less, and you have already been failing that long.
        //
        // Resetting would break the second one: narrowing a window
        // during a live outage would restart the clock and *delay* an
        // incident that is already overdue. Making a monitoring product
        // slower to page in response to an operator asking it to be
        // faster is the one direction this must never move.
      })
      .where(eq(monitors.id, monitorId))
      .returning();
    if (!updated) throw new NotFoundError("Monitor not found.");

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "monitor.updated",
      targetType: "monitor",
      targetId: monitorId,
      metadata: { fields: Object.keys(input) },
    });
    return updated;
  });
}

export async function setMonitorPaused(
  db: DbClient,
  actor: Actor,
  monitorId: string,
  paused: boolean,
): Promise<Monitor> {
  return db.transaction(async (tx) => {
    await findMonitorOrThrow(tx, actor.organizationId, monitorId);

    const [updated] = await tx
      .update(monitors)
      // Unpausing starts from a clean slate. `firstFailureAt` is the
      // one that matters since 1.10.0: it is what the status controller
      // derives from, so leaving it set means the first failing check
      // after a week-long pause computes "failing for a week" and pages
      // immediately, skipping `failureWindowSeconds` entirely.
      // `consecutiveFailures` is now only informational, and
      // `nextEvaluationAt` has to move or a resumed monitor waits out a
      // schedule computed before the pause.
      //
      // `currentStatus: "unknown"` is load-bearing too, and looks like
      // the opposite. `deriveStatus` returns `previousStatus` for a
      // failing check inside the window, so leaving a `down` status on
      // the row means the first failing check after the resume derives
      // `down` again and opens an incident at once — the same skipped
      // window `firstFailureAt` is cleared to prevent. Verified by
      // removing this line: the monitor pages immediately.
      //
      // The cost is that a resumed monitor reads `unknown` until it is
      // measured again, and `getPublicStatusPage` compensates by asking
      // what the latest *observation* was rather than trusting this
      // column. That compensating rule has to treat a `down` verdict as
      // evidence as well as an `indeterminate` one — the clean slate
      // written here is exactly what makes a failing monitor's stored
      // status `unknown`, so a rule keyed on `indeterminate` alone
      // publishes a green banner over a live failure.
      .set({
        paused,
        consecutiveFailures: 0,
        currentStatus: "unknown",
        firstFailureAt: null,
        nextEvaluationAt: new Date(),
      })
      .where(eq(monitors.id, monitorId))
      .returning();
    if (!updated) throw new NotFoundError("Monitor not found.");

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: paused ? "monitor.paused" : "monitor.resumed",
      targetType: "monitor",
      targetId: monitorId,
    });
    return updated;
  });
}

export async function deleteMonitor(
  db: DbClient,
  actor: Actor,
  monitorId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const monitor = await findMonitorOrThrow(
      tx,
      actor.organizationId,
      monitorId,
    );

    await tx.delete(monitors).where(eq(monitors.id, monitorId));
    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "monitor.deleted",
      targetType: "monitor",
      targetId: monitorId,
      metadata: { name: monitor.name, url: monitor.url },
    });
  });
}

export interface RecordedCheck {
  monitor: Monitor;
  /** What the controller says should be true now. */
  reconciliation: Reconciliation;
}

/** How many observations the scheduling policy is shown. */
const RECENT_OBSERVATION_WINDOW = 10;

/** Fields that make up the rule, as opposed to its labelling or routing. */
function ruleChanged(existing: Monitor, input: UpdateMonitorInput): boolean {
  const compare: Array<[unknown, unknown]> = [
    [input.checkType, existing.checkType],
    [input.url, existing.url],
    [input.port, existing.port],
    [input.method, existing.method],
    [input.intervalSeconds, existing.intervalSeconds],
    [input.timeoutMs, existing.timeoutMs],
    [input.degradedThresholdMs, existing.degradedThresholdMs],
    [input.expectedStatusCode, existing.expectedStatusCode],
    [input.bodyKeyword, existing.bodyKeyword],
    [input.keywordAbsent, existing.keywordAbsent],
    [input.tlsCheck, existing.tlsCheck],
    [input.tlsWarnDays, existing.tlsWarnDays],
    [input.failureWindowSeconds, existing.failureWindowSeconds],
  ];
  if (
    compare.some(([next, current]) => next !== undefined && next !== current)
  ) {
    return true;
  }
  return (
    input.config !== undefined &&
    JSON.stringify(input.config ?? null) !==
      JSON.stringify(existing.config ?? null)
  );
}

/**
 * The exact content an observation is hashed over.
 *
 * Exported because a verifier has to reconstruct the same bytes the
 * writer hashed, from the stored columns. If the two ever disagree the
 * chain is unverifiable, so there is one function and both sides call
 * it — the CI chain test is what keeps that honest.
 */
export function observationClaim(outcome: CheckResult, checkedAt: Date) {
  return {
    // `ok` and `checkedAt` are the two columns every uptime number is
    // computed from, so they are exactly the two an edit would target.
    // Both were derivable from the hashed verdict and clock, but
    // nothing cross-checked them — `UPDATE monitor_checks SET ok = true`
    // left the chain verifying happily. Rows written today are what a
    // 2.0 verifier reads, so this is cheap now and impossible later.
    ok: outcome.ok,
    checkedAt: checkedAt.toISOString(),
    verdict: outcome.verdict,
    failureClass: outcome.failureClass,
    statusCode: outcome.statusCode,
    responseTimeMs: outcome.responseTimeMs,
    error: outcome.error,
    facts: outcome.facts,
  };
}

export interface RecordCheckOptions {
  /**
   * The actor whose ledger chain this observation joins. Optional so a
   * test or a one-off script can record without an identity; production
   * always supplies one.
   */
  actorId?: string;
  now?: Date;
}

/**
 * Persists an observation and advances the monitor's derived state.
 *
 * Returns what the status controller concluded rather than transition
 * flags. The caller acts on that conclusion, and because the conclusion
 * is a function of current state rather than of a change, acting on it
 * twice is harmless and never acting on the intervening state is
 * survivable — which is the whole reason for the change.
 */
export async function recordCheckOutcome(
  db: DbClient,
  monitor: Monitor,
  outcome: CheckResult,
  options: RecordCheckOptions = {},
): Promise<RecordedCheck> {
  const now = options.now ?? new Date();
  const verdict: Verdict = outcome.verdict;

  const firstFailureAt = advanceFailureRun(
    monitor.firstFailureAt,
    verdict,
    now,
  );
  const reconciliation = reconcile(
    { failureWindowSeconds: monitor.failureWindowSeconds },
    {
      verdict,
      firstFailureAt,
      previousStatus: monitor.currentStatus,
      now,
    },
  );

  const consecutiveFailures =
    verdict === "down"
      ? monitor.consecutiveFailures + 1
      : verdict === "indeterminate"
        ? monitor.consecutiveFailures
        : 0;

  const [updated] = await db.transaction(async (tx) => {
    const stamp = options.actorId
      ? await stampFact(
          tx,
          {
            actorId: options.actorId,
            kind: "observation",
            subject: monitor.id,
            specVersion: monitor.specVersion,
            claim: observationClaim(outcome, now),
          },
          now.getTime(),
        )
      : null;

    await tx.insert(monitorChecks).values({
      monitorId: monitor.id,
      checkedAt: now,
      ok: outcome.ok,
      statusCode: outcome.statusCode,
      responseTimeMs: outcome.responseTimeMs,
      error: outcome.error,
      verdict,
      failureClass: outcome.failureClass,
      facts: outcome.facts,
      ...(stamp
        ? {
            actorId: stamp.actorId,
            hlc: stamp.hlc,
            seq: stamp.seq,
            prevHash: stamp.prevHash,
            hash: stamp.hash,
            specVersion: stamp.specVersion,
          }
        : {}),
    });

    // The policy hook's inputs, read back inside the same transaction so
    // it sees the observation just written.
    const recent: RecentObservation[] = await tx
      .select({ ok: monitorChecks.ok, verdict: monitorChecks.verdict })
      .from(monitorChecks)
      .where(eq(monitorChecks.monitorId, monitor.id))
      .orderBy(desc(monitorChecks.checkedAt), desc(monitorChecks.id))
      .limit(RECENT_OBSERVATION_WINDOW)
      .then((rows) =>
        rows.map((row) => ({
          ok: row.ok,
          verdict: (row.verdict as Verdict | null) ?? undefined,
        })),
      );

    return (
      tx
        .update(monitors)
        .set({
          consecutiveFailures,
          firstFailureAt,
          currentStatus: reconciliation.status,
          lastCheckedAt: now,
          nextEvaluationAt: nextEvaluationAt(
            {
              intervalSeconds: monitor.intervalSeconds,
              // The status just derived, not the stale one on the row.
              currentStatus: reconciliation.status,
            },
            recent,
            now,
          ),
          // Only overwrite when this check actually measured the cert.
          ...(outcome.tlsDaysRemaining === undefined
            ? {}
            : { tlsDaysRemaining: outcome.tlsDaysRemaining }),
        })
        // `paused = false` in the predicate, so a pause that lands while
        // this probe was in flight wins the race. `runMonitorCheck` reads
        // `paused` once, before the probe; without this an operator who
        // pauses a monitor one second before its failure window elapses —
        // precisely to stop the page — still gets paged, and worse, the
        // incident is then unresolvable, because every subsequent check
        // returns early while paused and nothing is left to close it.
        //
        // `paused` alone was not enough, because a pause and a resume
        // both fit inside one 30s probe flight. The row is `paused =
        // false` again by the time this lands, so the write went
        // through and restored the pre-pause `first_failure_at` that
        // the resume had just cleared — the monitor then computed
        // "failing since last week" from its first check back and paged
        // at once, `notified_at` and all. Requiring the value this
        // computation was derived from to still be on the row is what
        // makes the write conditional on the state it assumed.
        .where(
          and(
            eq(monitors.id, monitor.id),
            eq(monitors.paused, false),
            monitor.firstFailureAt === null
              ? isNull(monitors.firstFailureAt)
              : eq(monitors.firstFailureAt, monitor.firstFailureAt),
          ),
        )
        .returning()
    );
  });

  if (!updated) {
    // Several ways to match no row, and they are not the same event.
    const current = await db.query.monitors.findFirst({
      where: eq(monitors.id, monitor.id),
    });
    if (!current) throw new NotFoundError("Monitor disappeared mid-check.");

    // Something moved under the probe — a pause, or a pause and a
    // resume, either way the row is no longer the one this outcome was
    // derived from. The observation stays — it was genuinely made, and
    // a ledger does not un-write facts — but nothing is derived from
    // it: no status change, no incident, no schedule. Returning the
    // current row rather than the stale pre-probe one keeps every
    // caller honest: paused, and the fast-path follow-up declines;
    // resumed, and `next_evaluation_at` is already now, so the monitor
    // measures again immediately instead of losing a cycle.
    return {
      monitor: current,
      reconciliation: {
        status: current.currentStatus,
        openIncident: false,
        resolveIncidents: false,
      },
    };
  }

  return { monitor: updated, reconciliation };
}

/**
 * Slack on the due predicate, and it is load-bearing.
 *
 * The tick runs on the minute, but `next_evaluation_at` is stamped when
 * a probe *completes* — a few seconds past the boundary. Without slack
 * a monitor due at :02:02 is missed by the :02:00 tick and waits for
 * :03:00, every single cycle, so a 120s cadence settles at 180s and a
 * 61s one at 120s. 1.9.x had exactly this constant for exactly this
 * reason; it was dropped when the predicate moved to a stored
 * timestamp, and the drift came straight back.
 *
 * Half a tick period: enough to absorb probe duration, small enough
 * that being early never costs more than half an interval. Anything
 * scheduled sooner than a tick apart is handled by the check job's own
 * follow-up instead.
 */
const TICK_GRACE_SECONDS = 30;

/**
 * Monitors the scheduler owes a probe.
 *
 * Note what is not here: any arithmetic on intervals. The predicate is
 * "is it time yet, allowing for tick alignment", and *when* was decided
 * by `nextEvaluationAt` when the last observation landed. That
 * separation is the point — the old `WHERE last_checked_at + interval
 * <= now()` meant the selection query *was* the scheduling policy, so
 * changing the policy meant rewriting the scheduler.
 *
 * Most-overdue first, so a batch `limit` can never starve a monitor:
 * anything skipped this tick sorts even earlier on the next one.
 */
export async function findDueMonitors(
  db: DbClient,
  limit = 500,
): Promise<Monitor[]> {
  return db.query.monitors.findMany({
    where: and(
      eq(monitors.paused, false),
      or(
        isNull(monitors.nextEvaluationAt),
        sql`${monitors.nextEvaluationAt} - make_interval(secs => ${TICK_GRACE_SECONDS}) <= now()`,
      ),
    ),
    orderBy: [sql`${monitors.nextEvaluationAt} asc nulls first`],
    limit,
  });
}

async function findMonitorOrThrow(
  db: DbClient,
  organizationId: string,
  monitorId: string,
): Promise<Monitor> {
  const monitor = await db.query.monitors.findFirst({
    where: and(
      eq(monitors.id, monitorId),
      eq(monitors.organizationId, organizationId),
    ),
  });
  if (!monitor) throw new NotFoundError("Monitor not found.");
  return monitor;
}
