import "dotenv/config";

import { PgBoss } from "pg-boss";

import { db } from "@/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  HighFrequencyPlane,
  highFrequencyClaims,
} from "@/modules/monitors/highfreq";
import { findDueMonitors } from "@/modules/monitors/service";

import { runHighFrequencyRollupJob } from "./jobs/high-frequency";
import { runMonitorCheck } from "./jobs/monitor-check";
import { runNotificationDelivery } from "./jobs/notification-delivery";
import { pruneOldChecks } from "./jobs/retention";
import {
  QUEUES,
  type EscalationStepJob,
  type MonitorCheckJob,
  type RecoveryEscalateJob,
  type RecoveryExecuteJob,
  type RecoveryVerifyJob,
} from "./queues";

/**
 * The Vigil worker: a separate long-running process that owns all
 * background execution. pg-boss keeps its queue inside Postgres
 * (schema `pgboss`), so the app has exactly one stateful dependency,
 * and multiple worker replicas coordinate through SKIP LOCKED — no
 * Redis, no duplicate cron firing.
 */
const log = logger.child({ process: "worker" });

async function main() {
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    application_name: "vigil-worker",
  });

  boss.on("error", (error) => log.error({ err: error }, "pg-boss error"));

  await boss.start();

  // One tick in flight at a time, even with multiple workers.
  await boss.createQueue(QUEUES.monitorTick, { policy: "singleton" });
  // Per singletonKey (= monitorId): at most one queued + one active,
  // so a slow target can't pile up duplicate probes.
  await boss.createQueue(QUEUES.monitorCheck, {
    policy: "stately",
    retryLimit: 0,
    expireInSeconds: 60,
  });
  // No pg-boss retries: the jobs aren't idempotent mid-flow (a re-run
  // after the trigger fired would fire it twice). A dropped chain is
  // closed by the nightly stale-attempt sweep (retention job), and the
  // escalation failsafe pages independently when alerts were held.
  await boss.createQueue(QUEUES.recoveryExecute, {
    retryLimit: 0,
    expireInSeconds: 180,
  });
  await boss.createQueue(QUEUES.recoveryVerify, {
    retryLimit: 0,
    expireInSeconds: 120,
  });
  // Escalation IS idempotent (notifiedAt claim), and as the safety net
  // it must fire — so unlike the other recovery jobs it gets retries.
  await boss.createQueue(QUEUES.recoveryEscalate, {
    retryLimit: 2,
    expireInSeconds: 60,
  });
  // Escalation steps re-check ack/resolution before paging, so a retry
  // is safe; it must fire, so give it retries like the failsafe.
  await boss.createQueue(QUEUES.escalationStep, {
    retryLimit: 2,
    expireInSeconds: 120,
  });
  await boss.createQueue(QUEUES.notificationDelivery, { policy: "singleton" });
  // Created, not only scheduled. pg-boss enforces a foreign key from
  // `schedule` to `queue`, so a cron for a queue nobody declared takes
  // the whole worker down at startup — on a fresh database, which is
  // exactly where nobody is watching the logs.
  await boss.createQueue(QUEUES.highFrequencyRollup, { policy: "singleton" });
  await boss.createQueue(QUEUES.retention);

  await boss.work(QUEUES.monitorTick, async () => {
    const due = await findDueMonitors(db);
    if (due.length === 0) return;

    // Monitors a live high-frequency lease already covers are left
    // alone: two planes probing one target is a doubled request rate
    // the operator never asked for, and two observations of the same
    // instant in `monitor_checks`. The test is on the lease and not on
    // the flag, so a monitor whose worker died falls back to this
    // cadence rather than to none — degrading from 500ms to 2s is a
    // service level; degrading to silence is an outage nobody sees.
    const claimed = await highFrequencyClaims();
    const queued = due.filter((monitor) => !claimed(monitor));
    if (queued.length === 0) return;

    log.debug({ count: queued.length }, "enqueueing due monitor checks");
    await Promise.all(
      queued.map((monitor) =>
        boss.send(
          QUEUES.monitorCheck,
          { monitorId: monitor.id } satisfies MonitorCheckJob,
          {
            singletonKey: monitor.id,
          },
        ),
      ),
    );
  });

  await boss.work<MonitorCheckJob>(
    QUEUES.monitorCheck,
    { batchSize: 10, localConcurrency: 2 },
    async (jobs) => {
      await Promise.all(
        jobs.map(async (job) => {
          try {
            await runMonitorCheck(job.data.monitorId, { boss });
          } catch (error) {
            // Swallow per-monitor failures: the next tick re-enqueues.
            log.error(
              { err: error, monitorId: job.data.monitorId },
              "monitor check failed unexpectedly",
            );
          }
        }),
      );
    },
  );


  await boss.work(QUEUES.notificationDelivery, async () => {
    const result = await runNotificationDelivery(db);
    // Silent when there was nothing to do: this fires every minute, and
    // a log line per idle tick buries the ones that matter.
    if (result.claimed > 0) log.info(result, "notification delivery tick");
  });

  await boss.work(QUEUES.retention, async () => {
    await pruneOldChecks();
  });

  await boss.work(QUEUES.highFrequencyRollup, async () => {
    await runHighFrequencyRollupJob();
  });

  // Cron minimum granularity is one minute; monitor intervals are
  // multiples of 60s, so every due monitor is picked up on time.
  await boss.schedule(QUEUES.monitorTick, "* * * * *");
  // Every minute, like the monitor tick. Backoff lives in the row's
  // `next_attempt_at`, not in the schedule, so a tighter cron would only
  // add empty wake-ups.
  await boss.schedule(QUEUES.notificationDelivery, "* * * * *");
  await boss.schedule(QUEUES.retention, "0 3 * * *");
  await boss.schedule(QUEUES.highFrequencyRollup, "* * * * *");

  // Fire an immediate tick so a fresh deployment doesn't idle for the
  // first minute; the singleton policy dedupes against the cron.
  await boss.send(QUEUES.monitorTick, {});
  // A message queued just before the last shutdown should not wait a
  // minute for its first attempt.
  await boss.send(QUEUES.notificationDelivery, {});

  // The high-frequency plane. Started unconditionally and idle by
  // default: with no monitor enabled it holds its shard leases and
  // reloads an empty set, which is one indexed query every two seconds.
  // Gating it behind an environment variable would mean an operator can
  // enable high frequency in the UI on a deployment where nothing is
  // running to honour it — a setting that saves and then does nothing is
  // worse than a setting that is absent.
  const highFrequency = new HighFrequencyPlane({ boss });
  await highFrequency.start();

  log.info("worker started");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    // Stopped before pg-boss, because stopping it releases the shard
    // leases and flushes the sample buffer, and both of those want a
    // working database connection.
    await highFrequency.stop();
    await boss.stop({ graceful: true, timeout: 15_000 });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  log.fatal({ err: error }, "worker failed to start");
  process.exit(1);
});
