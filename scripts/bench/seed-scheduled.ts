/**
 * Creates N ORDINARY monitors pointed at a local target.
 *
 * The sibling of `seed-monitors.ts`, which seeds the high-frequency
 * plane. This one seeds the plane every installation actually runs: the
 * pg-boss tick, `find_due_monitors`, one job per check. That is the
 * plane whose capacity nobody had measured, and whose limit was a
 * default argument nobody had read.
 *
 * The target is deliberately local and spread across ports, for the same
 * two reasons the other seeder says: benchmarking against a public URL
 * measures somebody else's rate limiter, and pointing a thousand
 * monitors at one host:port measures the per-target fairness cap rather
 * than the scheduler.
 *
 *   npx tsx scripts/bench/seed-scheduled.ts 1000 [intervalSeconds]
 */
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { member, monitors, organization, user } from "@/db/schema";

const count = Number(process.argv[2] ?? "10");
const intervalSeconds = Number(process.argv[3] ?? "60");

const targetHost = process.env.BENCH_TARGET_HOST ?? "127.0.0.1";
const basePort = Number(process.env.BENCH_TARGET_PORT ?? "38080");
const portSpread = Number(process.env.BENCH_TARGET_PORTS ?? "20");

/**
 * How many rows go in one INSERT.
 *
 * A thousand round trips to seed a thousand monitors is a minute of
 * setup before the measurement starts, and on a slow disk it is longer
 * than the measurement. The seeder is not the thing under test.
 */
const INSERT_BATCH = 500;

async function main(): Promise<void> {
  const suffix = randomUUID().slice(0, 8);
  const userId = `bench-${suffix}`;
  const organizationId = `bench-org-${suffix}`;

  await db.insert(user).values({
    id: userId,
    name: "Bench",
    email: `${userId}@bench.invalid`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: organizationId,
    name: "Bench",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(member).values({
    id: `member-${suffix}`,
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });

  const rows = Array.from({ length: count }, (_, index) => ({
    organizationId,
    name: `bench-${index}`,
    url: `http://${targetHost}:${basePort + (index % portSpread)}/`,
    checkType: "http",
    intervalSeconds,
    timeoutMs: 1_000,
    createdBy: userId,
    // Due immediately, all of them, which is the shape the scheduler is
    // worst at and therefore the one worth measuring. A staggered seed
    // would flatter the tick by spreading its own work for it.
    nextEvaluationAt: new Date(),
  }));

  for (let start = 0; start < rows.length; start += INSERT_BATCH) {
    await db.insert(monitors).values(rows.slice(start, start + INSERT_BATCH));
  }

  console.log(
    `seeded ${count} monitors at ${intervalSeconds}s across ${portSpread} ports from ${basePort} in ${organizationId}`,
  );
  console.log(organizationId);
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
