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
import type { Monitor } from "@/modules/monitors/service";
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

export { sendOpenedNotifications } from "@/modules/monitors/outcome";

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
 * when the policy asks for sooner, the check enqueues its own
 * follow-up. The queue's `stately` policy with the monitor id as
 * singleton key means this can never race the tick into a double probe:
 * whichever arrives second is dropped.
 *
 * The floor this delivers is pg-boss's job poll interval — a couple of
 * seconds — which is comfortably below the shortest interval an operator
 * can configure, so a 10s monitor really is checked every 10s. Going
 * faster than that is the 2.0 scheduler's job.
 */
async function scheduleFastFollowUp(
  monitor: Monitor,
  boss: Enqueuer | undefined,
): Promise<void> {
  if (!boss || monitor.paused || monitor.nextEvaluationAt === null) return;
  if (monitor.nextEvaluationAt.getTime() - Date.now() >= TICK_PERIOD_MS) return;

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
