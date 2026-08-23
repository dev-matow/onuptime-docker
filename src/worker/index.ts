import "dotenv/config";

import { PgBoss } from "pg-boss";

import { db } from "@/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { HighFrequencyPlane } from "@/modules/monitors/highfreq";

import {
  backfillChannelDestinations,
  sealPlainChannelSecrets,
} from "@/modules/notifications/channel-service";


import { runHighFrequencyRollupJob } from "./jobs/high-frequency";
import { runMonitorCheck } from "./jobs/monitor-check";
import { runMonitorTick } from "./jobs/monitor-tick";
// A second import from the same module rather than a second specifier on
// the line above, because the marker acts on whole lines: folded into
// one import, `workerActorId` survives into Core as an unused binding
// and Core's own CI reports a warning nobody there can act on.
import { runNotificationDelivery } from "./jobs/notification-delivery";
import { pruneOldChecks } from "./jobs/retention";
import { drainStaleQueueBacklog } from "./queue-backlog";
import {
  HIGH_CHURN_DELETE_AFTER_SECONDS,
  HIGH_CHURN_QUEUES,
  QUEUE_MAINTENANCE_INTERVAL_SECONDS,
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
    // Deletion of finished jobs happens ONLY on this sweep, and pg-boss's
    // default is once a day — sized for queues where jobs are business
    // records. Ours are transport (see HIGH_CHURN_DELETE_AFTER_SECONDS in
    // queues.ts), and a day of `monitor-check` completions on a large
    // fleet is millions of rows the product has no reader for.
    maintenanceIntervalSeconds: QUEUE_MAINTENANCE_INTERVAL_SECONDS,
  });

  boss.on("error", (error) => log.error({ err: error }, "pg-boss error"));

  await boss.start();

  // Channels migrated from webhook_endpoints carry `plain:` secret
  // envelopes (migration 0023 has no encryption key); seal them before
  // anything delivers. Idempotent, a no-op after the first boot.
  await sealPlainChannelSecrets(db);
  // Same reason, same constraint: 0024 added the denormalized
  // destination column and could not compute it from SQL. Filling it
  // here is what lets the settings list render without decrypting.
  await backfillChannelDestinations(db);

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

  // Retention for the high-churn queues, applied AFTER creation and
  // through `updateQueue` on purpose: `create_queue` is INSERT ... ON
  // CONFLICT DO NOTHING, so an option added there reaches new
  // installations and silently never reaches an upgraded one. This is
  // the single code path both get. Policy and retry options are not
  // touched — `updateQueue` cannot change a policy at all, and the
  // per-key COALESCE leaves every option not named here as it stands.
  for (const queue of HIGH_CHURN_QUEUES) {
    await boss.updateQueue(queue, {
      deleteAfterSeconds: HIGH_CHURN_DELETE_AFTER_SECONDS,
    });
  }
  // The update above reaches rows created from here on — pg-boss stamps
  // the deletion window per row at insert — so the backlog an upgrade
  // inherits is drained explicitly, in batches, off the boot path.
  void drainStaleQueueBacklog(db).catch((error) =>
    log.warn({ err: error }, "stale queue backlog drain failed"),
  );

  await boss.work(QUEUES.monitorTick, async () => {
    const result = await runMonitorTick(db, boss);
    // Logged here rather than inside the tick, and that is what keeps
    // `result` const-correct in BOTH editions: every other reader of it
    // is in the commercial block below, so without a Core reader the
    // stripped tree would carry a binding nothing uses. The tick returns
    // its numbers; the worker decides what to say about them.
    //
    // Silent when there was nothing to do. This fires every minute, and
    // a line per idle tick buries the ones that matter.
    if (result.claimed > 0 || result.backlog > 0) {
      log.info(
        {
          due: result.backlog,
          lagSeconds: Math.round(result.lagSeconds),
          selected: result.selected,
          claimed: result.claimed,
          enqueued: result.enqueued,
          durationMs: result.durationMs,
        },
        "scheduler tick",
      );
    }
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
  // default: with no monitor enabled its whole footprint is the
  // discovery query, one indexed SELECT every two seconds. It used to
  // also hold all sixteen shard leases while idle — upserts every two
  // seconds, ~700k WAL writes a day on an installation using none of it
  // — and to run its 25ms scheduler over an empty table; both now start
  // in the same reload pass that first sees a monitor, so onboarding
  // latency is unchanged and the idle cost is the one query. Gating the
  // plane behind an environment variable would mean an operator can
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
    // Stopped before pg-boss too: its final pass closes any round that
    // became decidable during shutdown, and that pass writes.
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
