import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { monitors } from "@/db/schema";
import {
  claimMonitorsForDispatch,
  type Monitor,
} from "@/modules/monitors/service";
import { runMonitorTick } from "@/worker/jobs/monitor-tick";
import { QUEUES } from "@/worker/queues";

import { createTestOrg, db, type TestActor } from "../helpers";

/**
 * The scheduler tick, driven end to end against a real database.
 *
 * The failures this covers are the ones that only appear with more than
 * one worker, and every one of them was reachable before the claim
 * existed: a tick re-enqueueing a monitor whose check was still running,
 * two ticks enqueueing the same monitor, and a fleet that is behind
 * turning a restart into one enormous burst.
 *
 * The queue is a fake, deliberately. What is under test is which
 * monitors a tick decides to enqueue and how many times — pg-boss's own
 * exclusivity is pg-boss's to prove, and mixing the two would produce a
 * test that passes because of the queue's unique index while the
 * selection quietly double-counts.
 */

interface Inserted {
  name: string;
  jobs: { data: object; singletonKey?: string }[];
  options?: { returnId?: boolean };
}

/** Records what a tick asked the queue for. */
function fakeBoss() {
  const inserts: Inserted[] = [];
  return {
    inserts,
    monitorIds: () =>
      inserts
        .filter((insert) => insert.name === QUEUES.monitorCheck)
        .flatMap((insert) =>
          insert.jobs.map(
            (job) => (job.data as { monitorId: string }).monitorId,
          ),
        ),
    insert: async (
      name: string,
      jobs: { data: object; singletonKey?: string }[],
      options?: { returnId?: boolean },
    ) => {
      inserts.push({ name, jobs, options });
      // pg-boss returns ids ONLY when asked. `returnId = !!spy ||
      // !!options.returnId` in its manager, so a caller that omits the
      // option gets `null` however many jobs were accepted - and a
      // double that returned ids regardless is why `enqueued` read zero
      // in production for a release while this suite stayed green.
      if (!options?.returnId) return null;
      return jobs.map((_, index) => `job-${inserts.length}-${index}`);
    },
  };
}

async function makeDueMonitor(
  actor: TestActor,
  overrides: Partial<typeof monitors.$inferInsert> = {},
): Promise<Monitor> {
  const [row] = await db
    .insert(monitors)
    .values({
      organizationId: actor.organizationId,
      name: `tick-${randomUUID().slice(0, 8)}`,
      url: "https://vigil-tests.example.com/health",
      checkType: "http",
      intervalSeconds: 60,
      // Older than anything any other suite leaves behind, so this
      // fixture is at the front of the fair ranking rather than
      // somewhere behind tens of thousands of other people's monitors.
      nextEvaluationAt: new Date(Date.now() - 365 * 24 * 3_600_000),
      ...overrides,
    })
    .returning();
  return row!;
}

/** What this tenant's tick enqueued, out of a tick that ran over the
 * whole installation. */
function mineOnly(enqueued: string[], mine: string[]): string[] {
  const wanted = new Set(mine);
  return enqueued.filter((id) => wanted.has(id));
}

describe("runMonitorTick", () => {
  it("enqueues exactly what it claimed", async () => {
    const actor = await createTestOrg();
    const monitor = await makeDueMonitor(actor);
    const boss = fakeBoss();

    const result = await runMonitorTick(db, boss, actor.organizationId);

    expect(mineOnly(boss.monitorIds(), [monitor.id])).toEqual([monitor.id]);
    expect(result.claimed).toBeGreaterThan(0);
    expect(result.enqueued).toBe(result.claimed);
    // Every job carries the monitor as its singleton key, which is the
    // database's own backstop against a second queued check.
    const job = boss.inserts[0]!.jobs.find(
      (candidate) =>
        (candidate.data as { monitorId: string }).monitorId === monitor.id,
    );
    expect(job!.singletonKey).toBe(monitor.id);
  });

  it("does not enqueue the same monitor twice in a row", async () => {
    const actor = await createTestOrg();
    const monitor = await makeDueMonitor(actor);

    const first = fakeBoss();
    await runMonitorTick(db, first, actor.organizationId);
    expect(mineOnly(first.monitorIds(), [monitor.id])).toEqual([monitor.id]);

    // The check is still running: nothing has re-stamped
    // `next_evaluation_at`. Before the claim this second tick enqueued
    // it again, and the two ran back to back.
    const second = fakeBoss();
    await runMonitorTick(db, second, actor.organizationId);
    expect(mineOnly(second.monitorIds(), [monitor.id])).toEqual([]);
  });

  it("enqueues it again once the check has re-stamped it", async () => {
    const actor = await createTestOrg();
    const monitor = await makeDueMonitor(actor);
    await runMonitorTick(db, fakeBoss(), actor.organizationId);

    // What `recordCheckOutcome` does when the probe lands: it clears the
    // claim and stamps the next due time from the adaptive policy.
    await db
      .update(monitors)
      .set({
        dispatchClaimedUntil: null,
        nextEvaluationAt: sql`now() - interval '1 second'`,
      })
      .where(eq(monitors.id, monitor.id));

    const boss = fakeBoss();
    await runMonitorTick(db, boss, actor.organizationId);
    expect(mineOnly(boss.monitorIds(), [monitor.id])).toEqual([monitor.id]);
  });

  it("enqueues each monitor once when two ticks run at the same moment", async () => {
    const actor = await createTestOrg();
    const fleet: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      fleet.push((await makeDueMonitor(actor)).id);
    }

    const a = fakeBoss();
    const b = fakeBoss();
    await Promise.all([
      runMonitorTick(db, a, actor.organizationId),
      runMonitorTick(db, b, actor.organizationId),
    ]);

    const enqueued = [
      ...mineOnly(a.monitorIds(), fleet),
      ...mineOnly(b.monitorIds(), fleet),
    ];
    // No monitor twice, and none dropped: the two ticks partitioned the
    // fleet between them without knowing about each other.
    expect(new Set(enqueued).size).toBe(enqueued.length);
    expect(enqueued.sort()).toEqual([...fleet].sort());
  });

  it("recovers a monitor whose job was lost, once the lease runs out", async () => {
    const actor = await createTestOrg();
    const monitor = await makeDueMonitor(actor);

    // The worker died between claiming and enqueueing, or the job was
    // dropped. Either way the monitor is claimed and nothing will ever
    // probe it — until the lease expires.
    await claimMonitorsForDispatch(db, [monitor.id]);
    const during = fakeBoss();
    await runMonitorTick(db, during, actor.organizationId);
    expect(mineOnly(during.monitorIds(), [monitor.id])).toEqual([]);

    await db
      .update(monitors)
      .set({ dispatchClaimedUntil: sql`now() - interval '1 second'` })
      .where(eq(monitors.id, monitor.id));
    const after = fakeBoss();
    await runMonitorTick(db, after, actor.organizationId);
    expect(mineOnly(after.monitorIds(), [monitor.id])).toEqual([monitor.id]);
  });

  it("leaves a monitor claimed when the enqueue fails, rather than enqueueing it twice", async () => {
    const actor = await createTestOrg();
    const monitor = await makeDueMonitor(actor);

    const broken = {
      insert: async () => {
        throw new Error("queue is unreachable");
      },
    };
    await expect(
      runMonitorTick(db, broken, actor.organizationId),
    ).rejects.toThrow("queue is unreachable");

    // The deliberate trade: the monitor is silent until the lease runs
    // out, rather than enqueued a second time by the next tick. Ninety
    // seconds late beats twice as often, and the backlog shows it.
    const next = fakeBoss();
    await runMonitorTick(db, next, actor.organizationId);
    expect(mineOnly(next.monitorIds(), [monitor.id])).toEqual([]);
    const [row] = await db
      .select({ at: monitors.dispatchClaimedUntil })
      .from(monitors)
      .where(eq(monitors.id, monitor.id));
    expect(row!.at!.getTime()).toBeGreaterThan(Date.now());
  });

  it("never enqueues a paused monitor", async () => {
    const actor = await createTestOrg();
    const paused = await makeDueMonitor(actor, { paused: true });
    const boss = fakeBoss();
    await runMonitorTick(db, boss, actor.organizationId);
    expect(mineOnly(boss.monitorIds(), [paused.id])).toEqual([]);
  });

  it("reports nothing enqueued when the queue accepted nothing", async () => {
    // pg-boss inserts with ON CONFLICT DO NOTHING against the index that
    // permits one waiting check per monitor, and returns null when it
    // took none. Reporting the claim instead made a saturated scheduler
    // look like a busy one on the fleet view.
    const actor = await createTestOrg();
    await makeDueMonitor(actor);
    const refuses = {
      insert: async () => null,
    };
    const result = await runMonitorTick(db, refuses, actor.organizationId);
    expect(result.claimed).toBeGreaterThan(0);
    expect(result.enqueued).toBe(0);
  });

  it("reports the backlog it found", async () => {
    const actor = await createTestOrg();
    await makeDueMonitor(actor);
    const result = await runMonitorTick(db, fakeBoss(), actor.organizationId);
    expect(result.backlog).toBeGreaterThan(0);
    // A year overdue, in seconds.
    expect(result.lagSeconds).toBeGreaterThan(1_000);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("the enqueued count", () => {
  it("asks pg-boss for the ids, or it can only ever report zero", async () => {
    // The contract, pinned. pg-boss builds its insert with a RETURNING
    // clause only when `options.returnId` is set; without it the call
    // resolves to null whatever it accepted. A tick that does not ask
    // therefore reports `enqueued: 0` on every real tick forever, which
    // is exactly the value that means "the queue took nothing" - so the
    // metric added to tell a saturated scheduler from a busy one is
    // pinned to the saturated reading.
    const actor = await createTestOrg();
    const { id: monitorId } = await makeDueMonitor(actor);
    const boss = fakeBoss();

    const result = await runMonitorTick(db, boss, actor.organizationId);

    const insert = boss.inserts.find(
      (entry) => entry.name === QUEUES.monitorCheck,
    );
    expect(insert?.options?.returnId).toBe(true);
    expect(result.enqueued).toBeGreaterThan(0);
    expect(boss.monitorIds()).toContain(monitorId);
  });
});
