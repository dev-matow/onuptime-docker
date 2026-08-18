import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { monitors } from "@/db/schema";
import {
  claimMonitorsForDispatch,
  findDueMonitors,
  schedulerBacklog,
  type Monitor,
} from "@/modules/monitors/service";

import { createTestOrg, db, type TestActor } from "../helpers";

/**
 * The scheduler's claim, and the two properties everything else rests on.
 *
 * ONE: two ticks running at once take disjoint sets. That is what makes
 * a second worker safe to start, and it is a property of `for update
 * skip locked` rather than of anybody's care.
 *
 * TWO: a claimed monitor leaves the due list until its check re-stamps
 * it. That is what stopped the tick re-enqueueing a monitor whose check
 * was still running — eight duplicate observations in a measured
 * two-minute two-worker window before it existed, and the reason this
 * file has a mutation test at the bottom rather than only an assertion.
 *
 * Not `@edition:ee`: the claim is Core. Both editions run one scheduler
 * tick against one queue, and a free installation with a thousand
 * monitors has exactly the same duplicate problem as a paid one.
 */

/** A monitor that is due right now. */
async function makeDueMonitor(
  actor: TestActor,
  overrides: Partial<typeof monitors.$inferInsert> = {},
): Promise<Monitor> {
  const [row] = await db
    .insert(monitors)
    .values({
      organizationId: actor.organizationId,
      name: `sched-${randomUUID().slice(0, 8)}`,
      url: "https://vigil-tests.example.com/health",
      checkType: "http",
      intervalSeconds: 60,
      // A year overdue, not a minute. Every suite shares one database
      // and leaves its monitors behind, so a fixture that is merely due
      // sorts behind thousands of older ones and falls off the limit -
      // which reads as "the scheduler skipped it" and is really "the
      // test asked the wrong question".
      nextEvaluationAt: new Date(Date.now() - 365 * 24 * 3_600_000),
      ...overrides,
    })
    .returning();
  return row!;
}

async function nextEvaluationOf(id: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: monitors.nextEvaluationAt })
    .from(monitors)
    .where(eq(monitors.id, id));
  return row?.at ?? null;
}

async function claimedUntil(id: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: monitors.dispatchClaimedUntil })
    .from(monitors)
    .where(eq(monitors.id, id));
  return row?.at ?? null;
}

/** The lease running out, without waiting ninety seconds for it. */
async function expireClaim(id: string): Promise<void> {
  await db
    .update(monitors)
    .set({ dispatchClaimedUntil: sql`now() - interval '1 second'` })
    .where(eq(monitors.id, id));
}

/**
 * Only this tenant's monitors.
 *
 * Scoped in the QUERY, not filtered afterwards. Every suite shares one
 * database and leaves its fleet behind, so an installation-wide
 * selection here would be ranking this test's two monitors against tens
 * of thousands of other people's - and the fair ranking would correctly
 * put rank 2 of a small tenant behind rank 1 of every other tenant,
 * which reads as "the scheduler lost it".
 */
async function dueForOrg(actor: TestActor): Promise<Monitor[]> {
  return findDueMonitors(db, 10_000, actor.organizationId);
}

/**
 * Holds a row lock while `body` runs, then releases it.
 *
 * Not `withRowLocked`: that one waits until the callers are BLOCKED
 * behind the lock, which is the right barrier for a read-check-write
 * race and the wrong one here. `skip locked` means the caller never
 * blocks - that is the whole property - so a barrier that waits for a
 * waiter waits forever.
 */
async function whileRowLocked<T>(
  table: string,
  id: string,
  body: () => Promise<T>,
): Promise<T> {
  const holder = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
  });
  const client = await holder.connect();
  try {
    await client.query("begin");
    await client.query(`select id from ${table} where id = $1 for update`, [
      id,
    ]);
    return await body();
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
    await holder.end();
  }
}

describe("findDueMonitors", () => {
  it("selects a monitor whose next evaluation has passed, and skips one that is paused", async () => {
    const actor = await createTestOrg();
    const due = await makeDueMonitor(actor);
    const paused = await makeDueMonitor(actor, { paused: true });

    const ids = (await dueForOrg(actor)).map((m) => m.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(paused.id);
  });

  it("never selects a kind that has nothing to probe", async () => {
    const actor = await createTestOrg();
    const group = await makeDueMonitor(actor, {
      checkType: "group",
      url: "service",
    });
    const manual = await makeDueMonitor(actor, {
      checkType: "manual",
      url: "vendor",
    });

    const ids = (await dueForOrg(actor)).map((m) => m.id);
    expect(ids).not.toContain(group.id);
    expect(ids).not.toContain(manual.id);
  });

  it("gives every tenant a turn before giving any tenant a second one", async () => {
    // The starvation this ranking exists to prevent: one workspace with
    // a large fleet used to own the head of the ordering for as long as
    // it was behind, and the workspace beside it waited out all of them.
    const big = await createTestOrg();
    const small = await createTestOrg();
    for (let index = 0; index < 20; index += 1) {
      await makeDueMonitor(big, {
        // Older than the small tenant's, so a global most-overdue-first
        // ordering would put all twenty of them first.
        nextEvaluationAt: new Date(Date.now() - 800 * 24 * 3_600_000),
      });
    }
    const only = await makeDueMonitor(small, {
      nextEvaluationAt: new Date(Date.now() - 700 * 24 * 3_600_000),
    });

    // Deliberately NOT scoped: tenant fairness is a property of the
    // installation-wide ordering, and asking one tenant at a time would
    // assert nothing about it. Both fixtures are older than anything
    // else in the shared database, so they sort to the front of rank 1.
    const selected = (await findDueMonitors(db, 20_000)).filter((m) =>
      [big.organizationId, small.organizationId].includes(m.organizationId),
    );
    const position = selected.findIndex((m) => m.id === only.id);
    expect(position).toBeGreaterThanOrEqual(0);
    // Rank 1 of the small tenant sorts beside rank 1 of the big one, so
    // it is reached in the first couple of rows rather than after twenty.
    expect(position).toBeLessThan(3);
  });

  it("orders most-overdue-first inside one tenant", async () => {
    const actor = await createTestOrg();
    const older = await makeDueMonitor(actor, {
      nextEvaluationAt: new Date(Date.now() - 800 * 24 * 3_600_000),
    });
    const newer = await makeDueMonitor(actor, {
      nextEvaluationAt: new Date(Date.now() - 700 * 24 * 3_600_000),
    });

    const ids = (await dueForOrg(actor)).map((m) => m.id);
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));
  });

  it("honours the limit", async () => {
    const actor = await createTestOrg();
    for (let index = 0; index < 5; index += 1) await makeDueMonitor(actor);
    expect(await findDueMonitors(db, 3, actor.organizationId)).toHaveLength(3);
  });
});

describe("claimMonitorsForDispatch", () => {
  it("takes the monitor off the selectable list without moving its due time", async () => {
    const actor = await createTestOrg();
    const monitor = await makeDueMonitor(actor);
    const dueBefore = await nextEvaluationOf(monitor.id);

    expect(await claimMonitorsForDispatch(db, [monitor.id])).toEqual([
      monitor.id,
    ]);
    expect((await dueForOrg(actor)).map((m) => m.id)).not.toContain(monitor.id);
    expect((await claimedUntil(monitor.id))!.getTime()).toBeGreaterThan(
      Date.now(),
    );
    // The half that matters. The first version of this claim pushed
    // `next_evaluation_at` forward, which also worked - and hid every
    // measurement of how late the fleet was, because lateness is read
    // from that column.
    expect((await nextEvaluationOf(monitor.id))!.getTime()).toBe(
      dueBefore!.getTime(),
    );
  });

  it("refuses a monitor that is no longer due", async () => {
    const actor = await createTestOrg();
    const monitor = await makeDueMonitor(actor, {
      nextEvaluationAt: new Date(Date.now() + 3_600_000),
    });
    // The window this closes: the tick read the monitor as due, the
    // check completed before the claim landed, and claiming anyway would
    // push a just-probed monitor an extra lease into the future.
    expect(await claimMonitorsForDispatch(db, [monitor.id])).toEqual([]);
  });

  it("refuses a monitor that was paused since the read", async () => {
    const actor = await createTestOrg();
    const monitor = await makeDueMonitor(actor);
    await db
      .update(monitors)
      .set({ paused: true })
      .where(eq(monitors.id, monitor.id));
    expect(await claimMonitorsForDispatch(db, [monitor.id])).toEqual([]);
  });

  it("becomes due again when the lease runs out", async () => {
    const actor = await createTestOrg();
    const monitor = await makeDueMonitor(actor);
    await claimMonitorsForDispatch(db, [monitor.id]);
    expect((await dueForOrg(actor)).map((m) => m.id)).not.toContain(monitor.id);

    // The lease running out, simulated by moving the clock rather than
    // by waiting ninety seconds. The property under test is that the
    // lease is FINITE - a job that was dropped takes its monitor back
    // instead of parking it forever - and that is about the predicate,
    // not about the duration.
    await expireClaim(monitor.id);
    expect((await dueForOrg(actor)).map((m) => m.id)).toContain(monitor.id);
  });

  it("skips a monitor another scheduler is holding, and takes the rest", async () => {
    const actor = await createTestOrg();
    const held = await makeDueMonitor(actor);
    const free = await makeDueMonitor(actor);

    // A third connection holds the row, exactly as a concurrent tick
    // would between its own lock and its own commit.
    const startedAt = Date.now();
    const claimed = await whileRowLocked("monitors", held.id, () =>
      claimMonitorsForDispatch(db, [held.id, free.id]),
    );
    expect(claimed).toEqual([free.id]);
    // And it did not WAIT for the holder, which is the half that makes
    // a second scheduler an addition rather than a queue behind the
    // first. Generous: the assertion is "returned promptly", not a
    // latency budget.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    // The held monitor is still due, so the next tick gets it.
    expect((await dueForOrg(actor)).map((m) => m.id)).toContain(held.id);
  });

  it("claims each monitor exactly once when two schedulers race", async () => {
    const actor = await createTestOrg();
    const fleet: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      fleet.push((await makeDueMonitor(actor)).id);
    }

    const [a, b] = await Promise.all([
      claimMonitorsForDispatch(db, fleet),
      claimMonitorsForDispatch(db, fleet),
    ]);

    const all = [...a, ...b];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([...fleet].sort());
  });

  it("is a no-op for an empty list", async () => {
    expect(await claimMonitorsForDispatch(db, [])).toEqual([]);
  });

  it("claims a batch larger than one statement can bind", async () => {
    // `inArray` binds one parameter per id and Postgres refuses past
    // 65,535 in one Bind message - measured, not assumed: 65,535
    // succeeds and 70,000 fails. `MONITOR_SCHEDULER_BATCH` is settable
    // to tens of thousands, so without chunking an operator raising it
    // far enough would break every tick with a protocol error.
    //
    // 2,500 real monitors would make this test a minute long, so the
    // list is padded with ids that do not exist: chunking has to survive
    // them too, and a chunk that matches nothing must not stop the ones
    // that do.
    const actor = await createTestOrg();
    const real = [
      (await makeDueMonitor(actor)).id,
      (await makeDueMonitor(actor)).id,
    ];
    const padding = Array.from(
      { length: 2_500 },
      () =>
        "00000000-0000-7000-8000-" +
        randomUUID().replace(/-/g, "").slice(0, 12),
    );
    const claimed = await claimMonitorsForDispatch(db, [
      ...padding.slice(0, 1_200),
      ...real,
      ...padding.slice(1_200),
    ]);
    expect(claimed.sort()).toEqual([...real].sort());
  });
});

describe("the claim's guards are load-bearing", () => {
  /**
   * Mutation one: the still-due predicate, removed.
   *
   * An assertion that the claim refuses a monitor which is not due
   * proves nothing on its own - it passes just as well against an
   * implementation that refuses everything, or one that was never asked.
   * So the same monitor is run through the same UPDATE with the
   * predicate taken out, and that version has to succeed. If it ever
   * stops succeeding, this test is no longer exercising what it claims.
   */
  it("pushes a just-probed monitor forward without the still-due predicate", async () => {
    const actor = await createTestOrg();
    // Probed a moment ago: `recordCheckOutcome` has stamped its next
    // evaluation a full interval out.
    const monitor = await makeDueMonitor(actor, {
      nextEvaluationAt: new Date(Date.now() + 60_000),
    });

    expect(await claimMonitorsForDispatch(db, [monitor.id])).toEqual([]);
    const guardedAt = await nextEvaluationOf(monitor.id);
    expect(guardedAt!.getTime()).toBeLessThan(Date.now() + 65_000);

    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
    try {
      const mutant = await pool.query<{ id: string }>(
        `with locked as (
           select id from monitors where id = $1 for update skip locked
         )
         update monitors
            set next_evaluation_at = now() + interval '90 seconds'
           from locked
          where monitors.id = locked.id
         returning monitors.id as id`,
        [monitor.id],
      );
      expect(mutant.rows.map((row) => row.id)).toEqual([monitor.id]);
      // The damage: a monitor probed seconds ago is parked ninety
      // seconds out instead of sixty, every time a tick and a check
      // overlap. A cadence quietly longer than the configured one is
      // the failure mode this predicate exists to keep out, and it is
      // invisible from every screen in the product.
      const mutantAt = await nextEvaluationOf(monitor.id);
      expect(mutantAt!.getTime()).toBeGreaterThan(Date.now() + 80_000);
    } finally {
      await pool.end();
    }
  });

  /**
   * Mutation two: `skip locked`, removed.
   *
   * The guarded claim above returns while another connection holds the
   * row. This one, without the skip, waits for it - so a second
   * scheduler would stall behind the first for as long as the first
   * held anything, instead of taking what was free.
   */
  it("waits for the holder without `skip locked`", async () => {
    const actor = await createTestOrg();
    const held = await makeDueMonitor(actor);

    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
    try {
      const outcome = await whileRowLocked("monitors", held.id, async () => {
        const client = await pool.connect();
        try {
          return await Promise.race([
            client
              .query(`select id from monitors where id = $1 for update`, [
                held.id,
              ])
              .then(() => "returned" as const),
            new Promise<"blocked">((resolve) =>
              setTimeout(() => resolve("blocked"), 1_200),
            ),
          ]);
        } finally {
          // Released after the race resolves. The blocked query is
          // abandoned with the connection, which the pool ends below.
          client.release(true);
        }
      });
      expect(outcome).toBe("blocked");
    } finally {
      await pool.end();
    }
  }, 15_000);
});

describe("schedulerBacklog", () => {
  it("counts what is due and how old the oldest of it is", async () => {
    const actor = await createTestOrg();
    await makeDueMonitor(actor);
    const before = await schedulerBacklog(db, actor.organizationId);
    expect(before.dueCount).toBe(1);
    expect(before.oldestDueSeconds).toBeGreaterThanOrEqual(300);
  });

  it("still counts a monitor a tick has claimed, because it is still late", async () => {
    // THE REGRESSION THIS FILE EXISTS TO HOLD. The claim used to move
    // `next_evaluation_at`, which is also what lateness is read from, so
    // claiming a backlog made it disappear: a fleet the workers could
    // not keep up with reported a lag of at most one lease, forever,
    // however far behind it actually was. The operator page and the
    // capacity benchmark were both reading a number the claim had
    // flattened, and the "after" figures nearly went out that way.
    const actor = await createTestOrg();
    const mine = [
      (await makeDueMonitor(actor)).id,
      (await makeDueMonitor(actor)).id,
    ];
    const before = await schedulerBacklog(db, actor.organizationId);
    expect(before.dueCount).toBe(2);

    await claimMonitorsForDispatch(db, mine);

    const after = await schedulerBacklog(db, actor.organizationId);
    expect(after.dueCount).toBe(2);
    expect(after.oldestDueSeconds).toBeGreaterThanOrEqual(
      before.oldestDueSeconds,
    );
    // And they are no longer SELECTABLE, which is the other half: the
    // claim did its job without lying about the fleet.
    expect(await findDueMonitors(db, 10_000, actor.organizationId)).toEqual([]);
  });

  it("ignores high-frequency monitors, whose due time that plane never writes", async () => {
    // `setHighFrequency` deliberately leaves `next_evaluation_at` alone
    // and the plane never writes it, so a high-frequency monitor's due
    // time is frozen at whatever it was when the flag went on. Counted,
    // it would report as permanently and unboundedly late and drown
    // every real number on the page.
    const actor = await createTestOrg();
    await makeDueMonitor(actor, { highFrequency: true });
    expect((await schedulerBacklog(db, actor.organizationId)).dueCount).toBe(0);
  });
});
