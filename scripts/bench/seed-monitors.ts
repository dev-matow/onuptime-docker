/**
 * Creates N high-frequency monitors pointed at a local target.
 *
 * Part of the benchmark, not a fixture: Section 21 asks for a
 * reproducible script, and "then create a thousand monitors somehow" is
 * the step every unreproducible benchmark leaves out.
 *
 * The target is deliberately local. Benchmarking against a public URL
 * measures somebody else's network and their rate limiter, and the
 * number it produces cannot be repeated on another machine or defended
 * on this one.
 *
 *   npx tsx scripts/bench/seed-monitors.ts 100 [intervalMs]
 */
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { member, monitors, organization, user } from "@/db/schema";
import { setHighFrequency } from "@/modules/monitors/highfreq";

const count = Number(process.argv[2] ?? "1");
const intervalMs = Number(process.argv[3] ?? "500");
/**
 * Monitors are spread across a range of ports rather than all pointed at
 * one address.
 *
 * The per-target fairness cap allows two probes in flight to any single
 * host:port, which is the right production behaviour — a hundred
 * monitors on one host must not become a hundred concurrent requests to
 * it. But a hundred monitors watching *one* target is not a shape any
 * real deployment has, and benchmarking it measures that cap rather than
 * the scheduler. Spreading them is what makes the number about the thing
 * under test.
 */
const targetHost = process.env.BENCH_TARGET_HOST ?? "127.0.0.1";
const basePort = Number(process.env.BENCH_TARGET_PORT ?? "38080");
const portSpread = Number(process.env.BENCH_TARGET_PORTS ?? "20");

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

  const actor = { organizationId, userId };
  for (let index = 0; index < count; index += 1) {
    const [monitor] = await db
      .insert(monitors)
      .values({
        organizationId,
        name: `bench-${index}`,
        url: `http://${targetHost}:${basePort + (index % portSpread)}/`,
        checkType: "http",
        // The ordinary cadence a monitor falls back to if high-frequency
        // is switched off. Irrelevant while the plane holds it, but it
        // has to be a legal value.
        intervalSeconds: 2,
        timeoutMs: 1_000,
        createdBy: userId,
      })
      .returning();
    if (!monitor) throw new Error("insert returned no row");
    await setHighFrequency(db, actor, monitor.id, {
      enabled: true,
      intervalMs,
    });
  }

  console.log(
    `seeded ${count} monitors at ${intervalMs}ms across ${portSpread} ports from ${basePort} in ${organizationId}`,
  );
}

// `.then`, not top-level await: tsx transforms these scripts to CJS and
// refuses one, and the other bench scripts in this directory are plain
// ESM only because they are `.mjs`.
void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
