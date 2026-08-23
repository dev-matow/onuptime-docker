import type { DbClient } from "@/db";
import { highFrequencyClaims } from "@/modules/monitors/highfreq";
import {
  claimMonitorsForDispatch,
  deferHighFrequencyOwned,
  findDueMonitors,
  type Monitor,
  schedulerBacklog,
} from "@/modules/monitors/service";


import {
  QUEUES,
  type MonitorCheckJob,
} from "../queues";

/**
 * How long a monitor the high-frequency plane owns is stood down for.
 *
 * One tick period, so it is out of the way until the next selection and
 * no longer than that. This doubles as the failover latency: if that
 * plane dies while a monitor is deferred, the ordinary scheduler picks
 * it up on the tick after this one.
 */
const HIGH_FREQUENCY_DEFERRAL_SECONDS = 60;

interface Enqueuer {
  /**
   * How many jobs are waiting on a queue, when the implementation can
   * say. Optional because the only other caller of this interface is a
   * test's object literal, and a required method there would be a fake
   */
  /** Returns the ids it actually inserted, or null when it inserted
   * nothing - pg-boss ends this statement in `ON CONFLICT DO NOTHING`
   * against the queue's own unique index, so a monitor that already has
   * a waiting check is silently dropped. */
  insert: (
    name: string,
    jobs: { data: object; singletonKey?: string }[],
    options?: { returnId?: boolean },
  ) => Promise<string[] | null | unknown>;
}

export interface TickResult {
  /** Monitors due when the tick started, and the age of the oldest. */
  backlog: number;
  lagSeconds: number;
  /** Selected by the ranking, after the high-frequency filter. */
  selected: number;
  /** Claimed by this tick. */
  claimed: number;
  /**
   * Jobs the queue actually accepted, which is not the same number.
   *
   * pg-boss inserts with `ON CONFLICT DO NOTHING` against the unique
   * index that permits one waiting and one running check per monitor, so
   * on a backed-up installation most claimed monitors already have a job
   * waiting and are dropped. Reporting the claim as the enqueue made a
   * saturated scheduler look like a busy one: the fleet view said
   * "enqueued 4,900" while the queue took none of them.
   */
  enqueued: number;
  durationMs: number;
}

/**
 * One scheduler tick: find what is due, claim it, enqueue it.
 *
 * Extracted from `worker/index.ts` because a closure inside `main()`
 * cannot be tested, and the properties this function has to hold are
 * exactly the ones nobody can check by reading:
 *
 *   - two ticks running at once enqueue each monitor at most once;
 *   - a monitor already claimed by another tick is not re-enqueued;
 *   - a tick does not enqueue more than its batch, however far behind
 *     the fleet is, so a worker that was down for an hour comes back to
 *     a few minutes of catch-up rather than to one enormous burst;
 *   - nothing is enqueued that was not first claimed.
 *
 * WHY THERE IS NO LEASE TABLE HERE. Three DB-arbitrated locks already
 * stand between two workers and duplicated work, and all three were
 * there before this file: pg-boss elects a cron sender with a
 * conditional UPDATE on its own version row; the tick queue's
 * `singleton` policy has a unique index permitting one ACTIVE tick; and
 * the check queue's `stately` policy has one permitting one queued and
 * one active job per monitor. What was missing was not exclusivity, it
 * was that selection ignored all of it: the tick could re-enqueue a
 * monitor whose check was still running, because that `stately` policy
 * permits one QUEUED job beside the active one and selection was
 * level-triggered on `next_evaluation_at`, which enqueueing did not
 * change. The claim below closes that by making selection stateful, not
 * by adding a fourth lock.
 *
 * `organizationId` narrows the whole tick to one tenant. The worker never
 * passes one - a tick schedules the installation, which is the point -
 * and it exists because a tick that does not have it has no blast radius
 * at all. Two test files sharing a database, one calling this and one
 * holding high-frequency shard leases, is a tick probing and deferring
 * the other file's fixtures mid-assertion; the symptom was two suites
 * that passed alone and failed together, intermittently, depending on
 * how vitest happened to interleave them.
 *
 * No duplicate count is quoted here, and two earlier drafts of this
 * comment quoted one. Fifty-nine came from a benchmark whose threshold
 * counted the adaptive scheduler legitimately tightening on a monitor
 * that had failed once; eight replaced it and came from a dirty tree
 * with workers leaked from an earlier run probing the same monitors. On
 * clean trees the figure is zero, in every cell of both builds - so
 * this closes a hole rather than fixing an observed fault, and
 * `docs/SCALING.md` says so at the length that deserves.
 */
export async function runMonitorTick(
  db: DbClient,
  boss: Enqueuer,
  organizationId?: string,
): Promise<TickResult> {
  const startedAt = Date.now();
  const backlog = await schedulerBacklog(db, organizationId);
  const due = await findDueMonitors(db, undefined, organizationId);

  // Monitors a live high-frequency lease already covers are left alone:
  // two planes probing one target is a doubled request rate the operator
  // never asked for, and two observations of the same instant in
  // `monitor_checks`. The test is on the lease and not on the flag, so a
  // monitor whose worker died falls back to this cadence rather than to
  // none — degrading from 500ms to 2s is a service level; degrading to
  // silence is an outage nobody sees.
  //
  // Filtered BEFORE the claim, not after: claiming a monitor this plane
  // owns and then dropping it would hold a lease nothing was going to
  // use.
  //
  // And the ones filtered out are deferred, because otherwise they come
  // back at the head of the very next tick and every tick after it -
  // nothing advances `next_evaluation_at` while that plane owns them, so
  // "most overdue first" pins them there permanently and they spend
  // selection slots that can never become work. See
  // `deferHighFrequencyOwned`.
  const heldByHighFrequency = await highFrequencyClaims();
  const candidates: Monitor[] = [];
  const deferred: string[] = [];
  for (const monitor of due) {
    if (heldByHighFrequency(monitor)) deferred.push(monitor.id);
    else candidates.push(monitor);
  }
  await deferHighFrequencyOwned(db, deferred, HIGH_FREQUENCY_DEFERRAL_SECONDS);

  // Read before the synthetic plane's backpressure filter thins the
  // list, so `selected` keeps meaning what its comment says: what the
  // ranking chose, after the high-frequency filter. What backpressure
  // then held back is reported separately.
  const selected = candidates.length;

  // Claim, then enqueue, and only what was claimed.
  //
  // The order is the interesting part, because both orders lose
  // something and only one of them loses the right thing. Claiming
  // second means a failure between the two enqueues a monitor that was
  // never claimed, so the next tick enqueues it again — a duplicate
  // probe, and duplicates are what this whole mechanism exists to stop.
  // Claiming first means a failure between the two leaves a monitor
  // claimed but not enqueued, so it is silent until the lease runs out:
  // ninety seconds of one monitor's cadence, self-healing, and visible
  // in the backlog. Ninety seconds late beats twice as often.

  const claimed = await claimMonitorsForDispatch(
    db,
    candidates.map((monitor) => monitor.id),
  );


  let enqueued = 0;
  if (claimed.length > 0) {
    // One statement for the whole fan-out. It used to be one `send` per
    // monitor awaited in parallel, which is a round trip per monitor per
    // tick — a thousand of them every minute at a thousand monitors, and
    // the shape that makes a tick's duration a function of fleet size
    // rather than of the work it represents.
    const inserted = await boss.insert(
      QUEUES.monitorCheck,
      claimed.map((monitorId) => ({
        data: { monitorId } satisfies MonitorCheckJob,
        // Kept even though the claim now makes a duplicate enqueue
        // nearly impossible. "Nearly" is why: this is the database's
        // own guarantee that one monitor has at most one queued and one
        // active check, and it costs nothing to leave the belt on
        // beside the braces.
        singletonKey: monitorId,
      })),
      // Without this pg-boss builds its statement with no RETURNING
      // clause and hands back `null` however many jobs it accepted -
      // `returnId = !!spy || !!options.returnId` in its manager - so the
      // count below was zero on every real tick. The Workers page read
      // it, `worker_nodes.last_tick_enqueued` stored it, and the metric
      // added to tell a saturated scheduler from a busy one reported the
      // saturated value forever. The integration test agreed with it
      // because its fake queue returns fabricated ids, which is the
      // shape of test that only ever confirms the double.
      { returnId: true },
    );
    // What the queue took, not what was offered. `null` means it took
    // nothing - every job lost the singleton index to one already
    // queued. An array is the ids it accepted. An implementation that
    // reports neither - an older pg-boss - falls back to the claim,
    // which is the closest true statement available.
    enqueued = Array.isArray(inserted)
      ? inserted.length
      : inserted === null
        ? 0
        : claimed.length;
  }

  const result: TickResult = {
    backlog: backlog.dueCount,
    lagSeconds: backlog.oldestDueSeconds,
    selected,
    claimed: claimed.length,
    enqueued,
    durationMs: Date.now() - startedAt,
  };

  // Deliberately does not log. The caller does, because the caller is
  // the one place a binding for these numbers is const-correct in both
  // editions - the commercial build feeds them to the fleet view and the
  // free one only logs them, and a tick that logged for itself would
  // leave Core holding a return value nothing reads.
  return result;
}

