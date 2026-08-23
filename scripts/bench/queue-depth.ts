import "dotenv/config";

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

import { eq, sql } from "drizzle-orm";

import { db, poolStats } from "@/db";
import { member, notificationOutbox, organization, user } from "@/db/schema";
import { claimDue, recordOutcome } from "@/modules/notifications/outbox";
import { runNotificationDelivery } from "@/worker/jobs/notification-delivery";

/**
 * What a DEEP queue costs.
 *
 *   npx tsx scripts/bench/queue-depth.ts
 *
 * The other notification benchmark measures the cost of many CHANNELS.
 * This one measures the cost of many QUEUED MESSAGES, which is the
 * shape a provider outage produces and the one 1.18.0 changed: fair
 * selection ranks within each tenant instead of taking the globally
 * oldest, and that ranking is the thing worth measuring before it is
 * published.
 *
 * Nothing is delivered. The transport is a stub that returns
 * `delivered` without a socket, so every number here is Vigil's own
 * work - the ranking, the claim, the fence, the evidence rows and the
 * outcome. **How fast messages actually leave is a different number
 * entirely**, governed by the providers' own limits, and this
 * benchmark says nothing about it.
 *
 * Writes docs/evidence/channel-bench/queue-depth.json.
 */

/** Queue depths, and the spread of tenants they are spread across. */
const CASES = [
  { queued: 1, tenants: 1 },
  { queued: 100, tenants: 4 },
  { queued: 1_000, tenants: 10 },
  { queued: 10_000, tenants: 25 },
];

function ms(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

async function timed(runs: number, fn: () => Promise<unknown>) {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    await fn();
    samples.push(ms(start));
  }
  samples.sort((a, b) => a - b);
  return Number((samples[Math.floor(samples.length / 2)] ?? 0).toFixed(2));
}

async function makeOrg(index: number) {
  const suffix = `${index}-${randomUUID().slice(0, 8)}`;
  const userId = `qbench-user-${suffix}`;
  const organizationId = `qbench-org-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: `Queue bench ${suffix}`,
    email: `qbench-${suffix}@example.com`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: organizationId,
    name: `Queue bench ${suffix}`,
    slug: `qbench-${suffix}`,
    createdAt: new Date(),
  });
  await db.insert(member).values({
    id: `qbench-member-${suffix}`,
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  return { organizationId, userId };
}

/** Seeds `queued` due messages spread across `tenants` organizations. */
async function seed(orgIds: string[], queued: number, ageSpreadMs: number) {
  const rows = Array.from({ length: queued }, (_, i) => ({
    organizationId: orgIds[i % orgIds.length]!,
    idempotencyKey: `qbench:${randomUUID()}`,
    channel: "email" as const,
    destination: "ops@example.com",
    event: "monitor.down",
    payload: { subject: "Monitor down", text: "Bench message." },
    // Spread over the window so the ranking has real work to order
    // rather than a single timestamp it can return in any order.
    nextAttemptAt: new Date(Date.now() - ageSpreadMs + i),
    createdAt: new Date(Date.now() - ageSpreadMs + i),
  }));
  // Chunked: one 10,000-row insert is a different measurement from the
  // enqueue path and would dominate the setup time.
  for (let i = 0; i < rows.length; i += 1_000) {
    await db.insert(notificationOutbox).values(rows.slice(i, i + 1_000));
  }
}

async function main() {
  // Refuses to run against a queue that already has work in it, and
  // does NOT clear it. A drain tick is global by design, so leftover
  // rows from another tenant land in the batch being measured - the
  // first version of this script reported 240 delivered out of 250
  // because ten of the claimed rows belonged to an old test fixture
  // with undecryptable credentials. An artefact that depends on what
  // else happened to be in the database is not reproducible, and
  // silently deleting somebody's queue to get a clean number would be
  // worse than refusing.
  const [existing] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notificationOutbox);
  if ((existing?.count ?? 0) > 0) {
    console.error(
      `refusing to measure: ${existing?.count} rows already in notification_outbox.\n` +
        "This benchmark needs an empty queue, and will not clear one for you.\n" +
        "Point DATABASE_URL at a scratch database, or empty the table there first.",
    );
    process.exit(1);
  }

  const results: Record<string, unknown>[] = [];
  const stub = async () =>
    ({ status: "delivered", providerMessageId: null }) as const;

  for (const testCase of CASES) {
    const orgs = [];
    for (let i = 0; i < testCase.tenants; i++) orgs.push(await makeOrg(i));
    const orgIds = orgs.map((o) => o.organizationId);
    const ageSpreadMs = 60_000;
    await seed(orgIds, testCase.queued, ageSpreadMs);

    // 1. Planning: how long it takes to decide WHICH messages go next.
    //    This is the fair-selection ranking, and the number that had to
    //    be measured before the round-robin could be published.
    const planMs = await timed(5, async () => {
      await db.execute(sql`
        select id from (
          select o.id,
                 row_number() over (
                   partition by o.organization_id
                   order by o.next_attempt_at, o.id
                 ) as rank,
                 o.organization_id,
                 o.next_attempt_at
          from ${notificationOutbox} o
          where o.next_attempt_at <= now()
            and (
              o.state = 'queued'
              or (o.state = 'sending' and (o.leased_until is null or o.leased_until <= now()))
            )
        ) ranked
        order by rank, next_attempt_at, organization_id
        limit 250
      `);
    });

    // 2. Claiming: the ranking plus the lock, the fence bump and the
    //    evidence rows, which is what a tick actually pays before it
    //    sends anything.
    const claimStart = process.hrtime.bigint();
    const claimed = await claimDue(db, 250);
    const claimMs = Number(ms(claimStart).toFixed(2));
    // Put them back so the depth is unchanged for the next measurement.
    for (const claim of claimed) {
      await recordOutcome(db, claim, {
        status: "retryable",
        error: "bench: returned to the queue",
      });
    }
    await db
      .update(notificationOutbox)
      .set({ nextAttemptAt: sql`now() - interval '1 second'` })
      .where(
        sql`organization_id in (${sql.join(
          orgIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );

    // 3. A whole drain tick against a stub transport: claim, deliver,
    //    record, for one batch.
    const poolBefore = poolStats();
    const tickStart = process.hrtime.bigint();
    const tick = await runNotificationDelivery(db, { send: stub });
    const tickMs = ms(tickStart);
    const poolPeak = poolStats();

    // 4. How far behind the oldest still-undelivered message is - the
    //    number an operator actually feels.
    const [{ rows: oldest }] = [
      await db.execute<{ age_seconds: number }>(sql`
        select extract(epoch from (now() - min(created_at)))::float as age_seconds
        from ${notificationOutbox}
        where state in ('queued', 'sending')
          and organization_id in (${sql.join(
            orgIds.map((id) => sql`${id}`),
            sql`, `,
          )})
      `),
    ];

    const heapMb =
      Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;

    const drainRate = tick.delivered / (tickMs / 1_000);
    const ticksToClear = Math.ceil(testCase.queued / 250);

    results.push({
      queued: testCase.queued,
      tenants: testCase.tenants,
      planMs,
      claimBatchMs: claimMs,
      tickMs: Number(tickMs.toFixed(2)),
      tickClaimed: tick.claimed,
      tickDelivered: tick.delivered,
      drainPerSecond: Number(drainRate.toFixed(1)),
      ticksToClearBatchesOf250: ticksToClear,
      minutesToClearAtOneTickPerMinute: ticksToClear,
      oldestQueuedSeconds: Number((oldest[0]?.age_seconds ?? 0).toFixed(1)),
      workerHeapMb: heapMb,
      poolMax: poolPeak.max,
      poolTotalBefore: poolBefore.total,
      poolTotalAfter: poolPeak.total,
      poolWaitingAfter: poolPeak.waiting,
    });
    console.log(
      `${String(testCase.queued).padStart(6)} queued / ${String(testCase.tenants).padStart(2)} tenants  ` +
        `plan ${String(planMs).padStart(7)}ms  claim ${String(claimMs).padStart(7)}ms  ` +
        `tick ${tickMs.toFixed(0).padStart(5)}ms (${tick.delivered} delivered)  ` +
        `heap ${heapMb}MB  pool waiting ${poolPeak.waiting}`,
    );

    for (const org of orgs) {
      await db
        .delete(organization)
        .where(eq(organization.id, org.organizationId));
      await db.delete(user).where(eq(user.id, org.userId));
    }
  }

  const pgVersion = (
    await db.execute<{ version: string }>(sql`select version() as version`)
  ).rows[0]?.version;

  const artefact = {
    _: "Generated by scripts/bench/queue-depth.ts. Do not edit by hand.",
    what: "Cost of a DEEP notification queue: fair-selection planning, one claim batch, one full drain tick, and how far behind the oldest message is - at 1, 100, 1,000 and 10,000 queued deliveries.",
    method:
      "Messages spread across several tenants and over a 60-second window so the ranking has real ordering work. The transport is a stub that returns `delivered` without a socket, so nothing is sent and no provider limit is involved. Median of 5 runs for planning; one measured run for the claim and the tick.",
    doesNotMeasure:
      "Provider throughput. The transport here is a stub that returns `delivered` without opening a socket, so these figures are Vigil's own work only - how fast messages actually reach a provider is governed by that provider's limits, by the per-channel cap of 10 per tick, and by the batch size.",
    cases: results,
    environment: {
      commit:
        process.env.VIGIL_SOURCE_COMMIT ??
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      node: process.version,
      postgres: pgVersion?.split(" ").slice(0, 2).join(" ") ?? "unknown",
      poolMax: poolStats().max,
    },
  };

  mkdirSync("docs/evidence/channel-bench", { recursive: true });
  writeFileSync(
    "docs/evidence/channel-bench/queue-depth.json",
    `${JSON.stringify(artefact, null, 2)}\n`,
  );
  console.log("\nwrote docs/evidence/channel-bench/queue-depth.json");
  process.exit(0);
}

void main();
