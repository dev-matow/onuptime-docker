import "dotenv/config";

import { PgBoss } from "pg-boss";

import { db } from "@/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { findDueMonitors } from "@/modules/monitors/service";

import { runMonitorCheck } from "./jobs/monitor-check";
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
  await boss.createQueue(QUEUES.retention);

  await boss.work(QUEUES.monitorTick, async () => {
    const due = await findDueMonitors(db);
    if (due.length === 0) return;

    log.debug({ count: due.length }, "enqueueing due monitor checks");
    await Promise.all(
      due.map((monitor) =>
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


  await boss.work(QUEUES.retention, async () => {
    await pruneOldChecks();
  });

  // Cron minimum granularity is one minute; monitor intervals are
  // multiples of 60s, so every due monitor is picked up on time.
  await boss.schedule(QUEUES.monitorTick, "* * * * *");
  await boss.schedule(QUEUES.retention, "0 3 * * *");

  // Fire an immediate tick so a fresh deployment doesn't idle for the
  // first minute; the singleton policy dedupes against the cron.
  await boss.send(QUEUES.monitorTick, {});

  log.info("worker started");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
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
