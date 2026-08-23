import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/db";
import { sql } from "drizzle-orm";

import { drainStaleQueueBacklog } from "@/worker/queue-backlog";
import {
  HIGH_CHURN_DELETE_AFTER_SECONDS,
  HIGH_CHURN_QUEUES,
  QUEUES,
} from "@/worker/queues";

/**
 * The queue-retention contract, proven against a real pg-boss.
 *
 * Two facts carry the fix and both are asserted here rather than
 * remembered: `create_queue` is INSERT ... ON CONFLICT DO NOTHING, so a
 * retention option passed at creation never reaches an upgraded
 * installation — which is why the worker applies retention through
 * `updateQueue` after creation; and `updateQueue` COALESCEs per key, so
 * setting `deleteAfterSeconds` must leave the policy, retry and expiry
 * options exactly as the queue was created with. A regression in either
 * fact silently returns a large fleet to pg-boss's seven-day default —
 * measured at ~437 bytes per completed `monitor-check` job, which is
 * ~4 GB of Postgres for 1,000 monitors on a 60-second cadence.
 */
describe("high-churn queue retention", () => {
  let boss: PgBoss;
  const name = `retention-test-${Math.random().toString(36).slice(2, 10)}`;

  beforeAll(async () => {
    boss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      application_name: "vigil-test-retention",
    });
    boss.on("error", () => undefined);
    await boss.start();
  });

  afterAll(async () => {
    await boss.deleteQueue(name).catch(() => undefined);
    await boss.stop({ graceful: false });
  });

  async function queueRow(queue: string) {
    const { rows } = await db.execute<{
      policy: string | null;
      retry_limit: number;
      expire_seconds: number;
      deletion_seconds: number;
    }>(sql`
      select policy, retry_limit, expire_seconds, deletion_seconds
        from pgboss.queue where name = ${queue}
    `);
    return rows[0];
  }

  it("createQueue alone leaves the seven-day default in place", async () => {
    await boss.createQueue(name, {
      policy: "stately",
      retryLimit: 0,
      expireInSeconds: 60,
    });
    const row = await queueRow(name);
    expect(row?.policy).toBe("stately");
    // The default this fix exists for. If pg-boss ever changes it, the
    // arithmetic in queues.ts needs re-deriving, so fail loudly here.
    expect(row?.deletion_seconds).toBe(604_800);
  });

  it("updateQueue sets retention and touches nothing else", async () => {
    await boss.updateQueue(name, {
      deleteAfterSeconds: HIGH_CHURN_DELETE_AFTER_SECONDS,
    });
    const row = await queueRow(name);
    expect(row?.deletion_seconds).toBe(HIGH_CHURN_DELETE_AFTER_SECONDS);
    expect(row?.policy).toBe("stately");
    expect(row?.retry_limit).toBe(0);
    expect(row?.expire_seconds).toBe(60);
  });

  it("drains the backlog an upgrade inherits, and only that", async () => {
    // pg-boss stamps deletion_seconds PER ROW at insert, so updateQueue
    // governs only rows created afterwards. The drain below is what
    // reaches the rows an upgraded installation already holds — proven
    // here on a real queue with one stale row and one fresh one.
    await boss.createQueue(QUEUES.monitorCheck, {
      policy: "stately",
      retryLimit: 0,
      expireInSeconds: 60,
    });
    // Distinct singleton keys: `stately` collapses same-key sends, and
    // a collapsed second send would make this test assert on one row.
    const staleId = await boss.send(
      QUEUES.monitorCheck,
      { probe: "stale" },
      { singletonKey: `stale-${name}` },
    );
    const freshId = await boss.send(
      QUEUES.monitorCheck,
      { probe: "fresh" },
      { singletonKey: `fresh-${name}` },
    );
    // Completed long ago vs completed just now, written directly: the
    // states are the drain's input, not the machinery under test.
    await db.execute(sql`
      update pgboss.job set state = 'completed',
        completed_on = now() - interval '2 hours'
      where name = ${QUEUES.monitorCheck} and id = ${staleId}::uuid
    `);
    await db.execute(sql`
      update pgboss.job set state = 'completed', completed_on = now()
      where name = ${QUEUES.monitorCheck} and id = ${freshId}::uuid
    `);

    const drained = await drainStaleQueueBacklog(db);
    expect(drained).toBeGreaterThanOrEqual(1);

    const { rows: left } = await db.execute<{ id: string }>(sql`
      select id from pgboss.job
      where name = ${QUEUES.monitorCheck}
        and id in (${staleId}::uuid, ${freshId}::uuid)
    `);
    expect(left.map((row) => row.id)).toEqual([freshId]);
  });

  it("the maintenance sweep enforces the per-row window, live", async () => {
    // Mechanism proof with compressed constants. The soak cells cannot
    // show this — a one-hour window ends at the exact minute the first
    // row becomes deletable — and the two tests above only prove the
    // numbers LAND, not that anything acts on them. Here a second boss
    // watches a row it finished actually disappear.
    //
    // BOTH timers are compressed, and the first draft of this test is
    // why that sentence exists: deletion runs inside the SUPERVISE tick
    // (default sixty seconds), with maintenanceIntervalSeconds only a
    // per-queue gate the tick consults. Compressing the gate alone left
    // the row alive for the full supervise minute and failed the test —
    // which is precisely the misunderstanding a mechanism test is for.
    const sweeper = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      application_name: "vigil-test-sweeper",
      superviseIntervalSeconds: 5,
      maintenanceIntervalSeconds: 10,
    });
    sweeper.on("error", () => undefined);
    await sweeper.start();
    const sweepQueue = `sweep-test-${Math.random().toString(36).slice(2, 10)}`;
    try {
      await sweeper.createQueue(sweepQueue, {});
      await sweeper.updateQueue(sweepQueue, { deleteAfterSeconds: 5 });
      const jobId = await sweeper.send(sweepQueue, {});
      await db.execute(sql`
        update pgboss.job set state = 'completed',
          completed_on = now() - interval '10 seconds'
        where name = ${sweepQueue} and id = ${jobId}::uuid
      `);

      const deadline = Date.now() + 45_000;
      for (;;) {
        const { rows } = await db.execute<{ id: string }>(sql`
          select id from pgboss.job
          where name = ${sweepQueue} and id = ${jobId}::uuid
        `);
        if (rows.length === 0) break;
        if (Date.now() > deadline) {
          throw new Error(
            "the maintenance sweep never deleted a row 10s past its 5s window",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    } finally {
      await sweeper.deleteQueue(sweepQueue).catch(() => undefined);
      await sweeper.stop({ graceful: false });
    }
  }, 60_000);

  it("covers the per-check and per-minute producers, and spares the evidence queues", () => {
    // The queues that produce one row per check dominate the table;
    // a list that lost one has lost the fix.
    expect(HIGH_CHURN_QUEUES).toContain(QUEUES.monitorCheck);
    // Recovery and escalation job rows are how an operator reconstructs
    // why somebody was or was not paged. They stay on the default.
    expect(HIGH_CHURN_QUEUES).not.toContain(QUEUES.recoveryExecute);
    expect(HIGH_CHURN_QUEUES).not.toContain(QUEUES.recoveryVerify);
    expect(HIGH_CHURN_QUEUES).not.toContain(QUEUES.recoveryEscalate);
    expect(HIGH_CHURN_QUEUES).not.toContain(QUEUES.escalationStep);
    expect(HIGH_CHURN_QUEUES).not.toContain(QUEUES.retention);
  });
});
