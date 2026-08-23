import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import { db, poolStats } from "@/db";
import { member, organization, user } from "@/db/schema";
import type { CheckResult } from "@/modules/monitors/check";

export interface TestActor {
  organizationId: string;
  userId: string;
}

/**
 * Inserts a throwaway user + organization + owner membership directly.
 * Every test creates its own tenant, so suites can run in parallel
 * against one database without truncation or ordering constraints.
 */
export async function createTestOrg(): Promise<TestActor> {
  const suffix = randomUUID().slice(0, 8);
  const userId = `test-user-${suffix}`;
  const organizationId = `test-org-${suffix}`;

  await db.insert(user).values({
    id: userId,
    name: `Test User ${suffix}`,
    email: `test-${suffix}@example.com`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: organizationId,
    name: `Test Org ${suffix}`,
    slug: `test-org-${suffix}`,
    createdAt: new Date(),
  });
  await db.insert(member).values({
    id: `test-member-${suffix}`,
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });

  return { organizationId, userId };
}

export { db };

/**
 * Forces two callers to overlap, instead of hoping they do.
 *
 * The problem this exists for: a test that fires two service calls with
 * `Promise.all` and asserts one of them loses is asserting an
 * INTERLEAVING, not an invariant - and it only gets that interleaving
 * when the process is warm. Measured on this codebase: two concurrent
 * `changeIncidentStatus` calls genuinely overlapped in 29 of 30 warm
 * runs and serialised in the 30th, and serialised consistently on a
 * cold process. So the test passed in the full suite and failed when
 * run alone, which is the worst possible signal - it reads as
 * flakiness in the product.
 *
 * `withRowLocked` removes the guesswork. A separate connection takes a
 * row lock and holds it while `body` starts both callers; both get past
 * their own non-locking SELECT and block on their UPDATE, so both have
 * READ THE SAME STATE. Releasing the lock lets them race for the write,
 * which is the interleaving the test means to exercise, every time.
 *
 * The one timing element left is how long to let the callers reach
 * their UPDATE, and it is bounded by watching `pg_locks` rather than by
 * sleeping: the barrier waits until the expected number of waiters is
 * actually blocked on the row, so a slow machine waits longer rather
 * than producing a different test.
 */
export async function withRowLocked<T>(
  table: string,
  id: string,
  waiters: number,
  body: () => Promise<T>,
  /**
   * Runs on the HOLDER's connection, inside its transaction, after the
   * callers are blocked and before the lock is released.
   *
   * This is what turns the barrier from "both read the same state" into
   * "both read a state that a third writer then changed". It is the
   * only way to reproduce a read-check-write race deterministically:
   * the caller's read has already happened, its write is blocked, and
   * this commits the change its guard was checked against. Without it a
   * test of such a guard tests whichever earlier check happens to fire
   * first - which is how the acknowledgement test came to prove the
   * status guard above the predicate rather than the predicate.
   */
  beforeRelease?: (client: PoolClient) => Promise<void>,
  /** `barrierMs`: how long to wait for the callers to block before
   * giving up and dumping what every backend was doing. Defaults to
   * eight seconds; raise it for a suite whose callers do more work
   * before their UPDATE than a single statement. */
  options?: { barrierMs?: number },
): Promise<T> {
  const holder = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
  });
  const client = await holder.connect();
  try {
    await client.query("begin");
    const lockPid = (
      await client.query<{ pid: number }>("select pg_backend_pid() as pid")
    ).rows[0]!.pid;
    await client.query(`select id from ${table} where id = $1 for update`, [
      id,
    ]);

    let settledEarly: string | null = null;
    const running = body();
    void Promise.resolve(running).then(
      (value) => {
        settledEarly = `resolved: ${JSON.stringify(value)?.slice(0, 300)}`;
      },
      (error: Error) => {
        settledEarly = `rejected: ${error?.constructor?.name} ${error?.message}`;
      },
    );

    // Wait until `waiters` backends are actually blocked behind this
    // lock. Polling a fact beats sleeping a guess: on a slow machine
    // this waits, and on a fast one it proceeds immediately.
    //
    // How long that fact is worth waiting FOR is a parameter, because it
    // is not a property of the code under test: it is how long two
    // callers take to open a transaction, read, and reach their UPDATE
    // while a hundred and sixty-eight other files hammer the same
    // Postgres. Eight seconds was enough for every suite that used this
    // until the task suites arrived, and then failed roughly one full
    // run in three - never alone, only under the parallel suite, which
    // is the shape that reads as a product bug and is not one.
    const deadline = Date.now() + (options?.barrierMs ?? 8_000);
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      // The whole wait CHAIN rooted at this backend, not just its
      // direct waiters. Postgres queues row-lock waiters: the first
      // caller waits on this connection, and the second waits on the
      // FIRST caller, so `pg_blocking_pids` reports one waiter however
      // many are queued. Counting only direct waiters made this barrier
      // time out at two callers, which is how the queueing was found.
      const { rows } = await client.query<{ count: string }>(
        `with recursive waiting(pid) as (
           select pid from pg_stat_activity
            where pid <> $1 and $1 = any(pg_blocking_pids(pid))
           union
           select a.pid from pg_stat_activity a, waiting w
            where a.pid <> $1 and w.pid = any(pg_blocking_pids(a.pid))
         )
         select count(*) as count from waiting`,
        [lockPid],
      );
      if (Number(rows[0]!.count) >= waiters) break;
      if (Date.now() > deadline) {
        // A barrier that gives up has to say what the database was
        // actually doing, or the next reader reruns it and guesses.
        const { rows: activity } = await client.query<{
          pid: number;
          state: string | null;
          wait: string | null;
          blockers: string;
          query: string;
        }>(
          `select pid, state, wait_event_type as wait,
                  coalesce(array_to_string(pg_blocking_pids(pid), ','), '') as blockers,
                  coalesce(datname, '-') || ' ' || left(regexp_replace(query, '\\s+', ' ', 'g'), 70) as query
             from pg_stat_activity
            where backend_type = 'client backend' and pid <> pg_backend_pid()
            order by pid`,
        );
        throw new Error(
          [
            `barrier timed out: expected ${waiters} writer(s) blocked on ${table}.${id}, saw ${rows[0]!.count}.`,
            "The callers under test did not reach their UPDATE, so the test is not exercising what it claims.",
            `holder pid ${lockPid}. Application pool: ${JSON.stringify(poolStats())}.`,
            `body() settled before the barrier released? ${settledEarly ?? "no, still pending"}`,
            "Backends on this database:",
            ...activity.map(
              (row) =>
                `  pid ${row.pid} ${row.state ?? "-"} wait=${row.wait ?? "-"} blockedBy=[${row.blockers}] ${row.query}`,
            ),
          ].join("\n"),
        );
      }
    }

    if (beforeRelease) await beforeRelease(client);
    await client.query("commit");
    return await running;
  } finally {
    client.release();
    await holder.end();
  }
}

/**
 * A judged check result, as `performCheck` would return one.
 *
 * Tests construct these by hand to drive `recordCheckOutcome` without a
 * transport. Keeping the builder here rather than in each suite means
 * the day a field is added to `CheckResult` there is one place to add
 * it, instead of six copies that quietly disagree.
 */
export function checkResult(overrides: Partial<CheckResult> = {}): CheckResult {
  const base: CheckResult = {
    ok: true,
    degraded: false,
    statusCode: 200,
    responseTimeMs: 100,
    error: null,
    verdict: "up",
    failureClass: null,
    facts: { statusCode: 200, responseTimeMs: 100 },
    failedAssertions: [],
  };
  return { ...base, ...overrides };
}

/** A passing check. */
export function okResult(responseTimeMs = 100): CheckResult {
  return checkResult({
    responseTimeMs,
    facts: { statusCode: 200, responseTimeMs },
  });
}

/** A check that reached the target and disliked the answer. */
export function failResult(): CheckResult {
  return checkResult({
    ok: false,
    verdict: "down",
    failureClass: "assertion",
    statusCode: 503,
    responseTimeMs: 250,
    error: "Unexpected status 503",
    facts: { statusCode: 503, responseTimeMs: 250 },
    failedAssertions: ["status"],
  });
}

/** A check that could not run here at all. */
export function indeterminateResult(error: string): CheckResult {
  return checkResult({
    ok: false,
    verdict: "indeterminate",
    failureClass: "misconfigured",
    statusCode: null,
    responseTimeMs: null,
    error,
    facts: {},
  });
}
