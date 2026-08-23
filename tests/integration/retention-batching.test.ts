import { randomUUID } from "node:crypto";

import { and, eq, lt, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { monitorChecks } from "@/db/schema";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import { createMonitor } from "@/modules/monitors/service";
import { pruneOldChecks } from "@/worker/jobs/retention";

import { createTestOrg, db } from "../helpers";

/**
 * The observation prune converges past its batch size.
 *
 * `monitor_checks` is the biggest table in the product and its prune
 * used to be the one UNBATCHED delete in the retention job: a first run
 * on an installation that had never pruned removed everything in a
 * single statement — locks for the duration and a WAL burst sized by
 * the backlog. It is now ctid-batched like every other prune in the
 * file, and this test seeds more than two batches of expired rows to
 * prove the loop drains the whole backlog rather than stopping at one
 * bite — a retention job that removes 5,000 rows a night from a table
 * gaining a million is a leak with a schedule.
 */
describe("check retention batching", () => {
  it("drains a backlog larger than the batch and spares live evidence", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, {
      name: `Retention ${randomUUID().slice(0, 8)}`,
      url: "https://vigil-retention-tests.example.com/health",
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 5_000,
      degradedThresholdMs: 3_000,
      expectedStatusCode: null,
      bodyKeyword: null,
      keywordAbsent: false,
      checkType: "http",
      tlsCheck: false,
      tlsWarnDays: 14,
      failureWindowSeconds: 0,
    } satisfies CreateMonitorInput);

    // Far past any retention window OR SLO observation floor another
    // suite could be holding — the floor tracks live objectives, whose
    // fixtures sit months back, not years.
    const ancient = Date.now() - 500 * 86_400_000;
    const expired = Array.from({ length: 12_000 }, (_, index) => ({
      monitorId: monitor.id,
      checkedAt: new Date(ancient + index * 1_000),
      ok: true,
      verdict: "up",
      responseTimeMs: 50,
    }));
    for (let start = 0; start < expired.length; start += 1_000) {
      await db
        .insert(monitorChecks)
        .values(expired.slice(start, start + 1_000));
    }
    const fresh = Array.from({ length: 25 }, (_, index) => ({
      monitorId: monitor.id,
      checkedAt: new Date(Date.now() - index * 60_000),
      ok: true,
      verdict: "up",
      responseTimeMs: 50,
    }));
    await db.insert(monitorChecks).values(fresh);

    await pruneOldChecks({ organizationId: actor.organizationId });

    const counted = await db.execute<{ remainingExpired: string }>(sql`
      select count(*) as "remainingExpired" from ${monitorChecks}
      where ${monitorChecks.monitorId} = ${monitor.id}::uuid
        and ${monitorChecks.checkedAt} < now() - interval '400 days'
    `);
    expect(Number(counted.rows[0]?.remainingExpired)).toBe(0);

    const kept = await db
      .select({ id: monitorChecks.id })
      .from(monitorChecks)
      .where(
        and(
          eq(monitorChecks.monitorId, monitor.id),
          lt(monitorChecks.responseTimeMs, 100),
        ),
      );
    expect(kept).toHaveLength(25);
  }, 60_000);
});
