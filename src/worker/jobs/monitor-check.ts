import os from "node:os";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { monitors } from "@/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ensureActor } from "@/modules/ledger/service";
import type { CheckOptions } from "@/modules/monitors/check";
import { evaluateMonitor } from "@/modules/monitors/evaluate";
import { applyOutcome } from "@/modules/monitors/outcome";
import { highFrequencyClaims } from "@/modules/monitors/highfreq";
import {
  ENQUEUE_LEASE_SECONDS,
  type Monitor,
  reserveMonitorForFollowUp,
} from "@/modules/monitors/service";
import { checkTypeKind } from "@/modules/monitors/types/catalog";
import { isScheduledKind } from "@/modules/monitors/types/contract";

import { QUEUES, type MonitorCheckJob } from "../queues";

/**
 * Evaluating one monitor, on the schedule.
 *
 * What this file used to also do — persist the observation, reconcile
 * the status, open or resolve the incident, page — moved to
 * `modules/monitors/outcome.ts` when manual monitors arrived needing
 * every line of it. What is left is the part that is genuinely the
 * worker's: which monitor, when, and what follows.
 *
 * `sendOpenedNotifications` is re-exported because the alerting tests
 * and the commercial incident handler have always reached for it here,
 * and moving a function is not a reason to move its callers.
 */
const log = logger.child({ job: "monitor-check" });

export { claimOpenedNotifications } from "@/modules/monitors/outcome";

export interface MonitorCheckDeps {
  boss?: {
    send: (name: string, data: object, options?: object) => Promise<unknown>;
  };
  fetchImpl?: typeof fetch;
  /** See `ProbeContext.lookup` — injectable so a test need not resolve. */
  lookup?: CheckOptions["lookup"];
  allowPrivateTargets?: boolean;
  /** Overrides the ledger identity this replica writes under. */
  actorId?: string;
}

interface Enqueuer {
  send: (name: string, data: object, options?: object) => Promise<unknown>;
}

/**
 * This replica's ledger identity. One actor per worker process, so each
 * replica keeps its own chain and its own sequence — which is exactly
 * why the chains are per-actor: adding a replica adds a chain instead
 * of adding contention to one.
 */
export function workerActorId(): Promise<string> {
  const name =
    process.env.VIGIL_ACTOR_NAME ?? process.env.HOSTNAME ?? os.hostname();
  return ensureActor(db, "worker", name);
}

/** The cron tick's period. pg-boss's cron floor is 60s by construction. */
const TICK_PERIOD_MS = 60_000;

/**
 * The sub-minute path.
 *
 * The scheduling policy can ask for the next evaluation sooner than the
 * next tick — that is the whole point of tightening on a suspicious
 * monitor. pg-boss's cron cannot fire faster than once a minute, so
 * when the policy asks for sooner, the check enqueues its own follow-up.
 *
 * The floor this delivers is pg-boss's job poll interval — a couple of
 * seconds — which is comfortably below the shortest interval an operator
 * can configure, so a 10s monitor really is checked every 10s. Going
 * faster than that is the 2.0 scheduler's job.
 *
 * Three things here are load-bearing, and this path had all three wrong.
 *
 * The interval is measured from `lastCheckedAt`, not from the clock. Both
 * timestamps are written from one `now` inside `recordCheckOutcome`, so
 * the subtraction is exact. Reading the clock again a few milliseconds
 * later instead made the comparison depend on how long the write took.
 *
 * The boundary is INCLUSIVE, and that is a measured decision rather than
 * a taste. A monitor whose interval equals the tick period has no slack
 * at all: the tick probes it at the first tick at or after
 * `next_evaluation_at - TICK_GRACE_SECONDS`, so the moment queue delay
 * exceeds the grace, that instant falls past a tick boundary and the
 * monitor waits a whole further cycle - 120 seconds for a 60-second
 * monitor. Excluding the equal case cost 5 checks per second of a
 * thousand-monitor fleet at two workers, 16.57/s down to 11.58/s, and
 * the loss shrank as workers were added because a faster drain keeps
 * more monitors inside the grace. `docs/SCALING.md` has both runs.
 *
 * So: an interval at or below the tick period schedules itself, and
 * anything longer belongs to the tick.
 *
 * And it reserves the monitor before enqueueing. The queue's `stately`
 * policy drops a second job only while the first is still `created`; once
 * pg-boss moves it to `active` the singleton key permits another, so a
 * tick firing in that window enqueues a monitor already being probed.
 * Sharing the scheduler's claim column closes it — the follow-up and the
 * tick now compete for the same lease instead of for a queue index, and
 * losing means somebody else already owns the next dispatch.
 *
 * Exported for the tests. The window where the reservation is lost opens
 * between `applyOutcome` clearing the claim and this function taking it,
 * which is microseconds wide and cannot be staged through
 * `runMonitorCheck` - and an untestable branch in a concurrency guard is
 * how the guard stops being one.
 */
export async function scheduleFastFollowUp(
  monitor: Monitor,
  boss: Enqueuer | undefined,
): Promise<void> {
  if (!boss || monitor.paused || monitor.nextEvaluationAt === null) return;
  const decidedAt = monitor.lastCheckedAt?.getTime() ?? Date.now();
  if (monitor.nextEvaluationAt.getTime() - decidedAt > TICK_PERIOD_MS) return;

  // Until it runs, plus room to run in. A lease that expired at the
  // moment the job became due would free the monitor for the very tick
  // this reservation exists to exclude.
  const untilDueMs = Math.max(
    0,
    monitor.nextEvaluationAt.getTime() - Date.now(),
  );
  const reserved = await reserveMonitorForFollowUp(
    db,
    monitor.id,
    Math.ceil(untilDueMs / 1000) + ENQUEUE_LEASE_SECONDS,
  );
  if (!reserved) return;

  await boss.send(
    QUEUES.monitorCheck,
    { monitorId: monitor.id } satisfies MonitorCheckJob,
    { singletonKey: monitor.id, startAfter: monitor.nextEvaluationAt },
  );
}

/**
 * Evaluates one monitor and applies the consequences.
 *
 * Never throws for per-monitor problems — the next tick re-enqueues, so
 * a retry here would only double-probe a struggling target.
 */
export async function runMonitorCheck(
  monitorId: string,
  deps: MonitorCheckDeps = {},
): Promise<void> {
  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, monitorId),
  });
  if (!monitor || monitor.paused) return;

  // A group or a manual monitor has nothing to evaluate on a timer, and
  // `findDueMonitors` does not select one. A job for one can still
  // arrive — queued before the monitor's type was changed, or before
  // this version was deployed — and honouring it would write an
  // observation on a cadence that means nothing for that kind, on top
  // of the one the operator's own edit already recorded.
  if (!isScheduledKind(checkTypeKind(monitor.checkType))) {
    log.debug(
      { monitorId, checkType: monitor.checkType },
      "skipped: this kind is not scheduled",
    );
    return;
  }

  // The tick already filters these out. This is the second line, and it
  // is not redundant: a job for this monitor can be sitting in the queue
  // with a `startAfter` from before high frequency was enabled, or from
  // before this replica's plane took the shard. Honouring it would probe
  // a target that is already being probed twice a second and write a
  // second observation of the same instant.
  if ((await highFrequencyClaims())(monitor)) {
    log.debug({ monitorId }, "skipped: the high-frequency plane owns this");
    return;
  }


  const outcome = await evaluateMonitor(db, monitor, {
    allowPrivateTargets:
      deps.allowPrivateTargets ?? env.ALLOW_PRIVATE_MONITOR_TARGETS,
    fetchImpl: deps.fetchImpl,
    lookup: deps.lookup,
  });

  const updated = await applyOutcome(monitor, outcome, {
    actorId: deps.actorId ?? (await workerActorId()),
    boss: deps.boss,
  });

  await scheduleFastFollowUp(updated, deps.boss);
}
