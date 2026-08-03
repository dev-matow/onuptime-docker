import "dotenv/config";

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { member, notificationOutbox, organization, user } from "@/db/schema";
import {
  createChannel,
  dispatchToChannels,
  listChannels,
  resolveRoutes,
} from "@/modules/notifications/channel-service";

/**
 * What an unbounded channel count actually costs.
 *
 *   npx tsx scripts/bench/channel-fanout.ts
 *
 * Measures the three paths that scale with the number of configured
 * channels — rendering the settings list, planning a dispatch, and
 * fanning one event out into the outbox — at 0, 1, 10, 100 and 1000
 * channels on one organization. No provider is contacted: nothing here
 * delivers, it only enqueues, so the numbers are Vigil's own work and
 * not somebody's rate limiter.
 *
 * Writes docs/evidence/channel-bench/channel-fanout.json — its own
 * directory because the shape differs from the high-frequency
 * artefacts, and `scripts/bench-check.mjs` validates each shape
 * separately. Any figure a public page quotes has to come from this
 * file or not be published.
 */

const SIZES = [0, 1, 10, 100, 1000];

function ms(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/** Median of several runs; a single sample of a database call is noise. */
async function timed(
  runs: number,
  fn: () => Promise<unknown>,
): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    await fn();
    samples.push(ms(start));
  }
  samples.sort((a, b) => a - b);
  return Number((samples[Math.floor(samples.length / 2)] ?? 0).toFixed(2));
}

async function makeOrg() {
  const suffix = randomUUID().slice(0, 8);
  const userId = `bench-user-${suffix}`;
  const organizationId = `bench-org-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: `Bench ${suffix}`,
    email: `bench-${suffix}@example.com`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: organizationId,
    name: `Bench ${suffix}`,
    slug: `bench-${suffix}`,
    createdAt: new Date(),
  });
  await db.insert(member).values({
    id: `bench-member-${suffix}`,
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  return { organizationId, userId };
}

async function main() {
  const results: Record<string, unknown>[] = [];

  for (const size of SIZES) {
    const actor = await makeOrg();

    for (let i = 0; i < size; i++) {
      // A realistic mix rather than a thousand of one thing: several
      // providers, and many instances of the same provider, which is
      // the configuration the cap used to forbid.
      const provider = i % 3;
      if (provider === 0) {
        await createChannel(db, actor, {
          name: `Slack - Client ${i}`,
          provider: "slack",
          config: {},
          secrets: {
            webhookUrl: `https://hooks.slack.com/services/T00/B00/${randomUUID()}`,
          },
          events: ["monitor", "incident"],
          enabled: true,
        });
      } else if (provider === 1) {
        await createChannel(db, actor, {
          name: `Telegram - Team ${i}`,
          provider: "telegram",
          config: { chatId: `-100${1000000000 + i}` },
          secrets: {
            botToken: `${1000000000 + i}:AAfake-token-abcdefghijklmnopqrs`,
          },
          events: ["monitor", "incident"],
          enabled: true,
        });
      } else {
        await createChannel(db, actor, {
          name: `Webhook - System ${i}`,
          provider: "webhook",
          config: { url: `https://ops.example.com/hooks/${i}` },
          secrets: {},
          events: ["monitor", "incident"],
          enabled: true,
        });
      }
    }

    const listMs = await timed(5, () =>
      listChannels(db, actor.organizationId, { limit: 25 }),
    );
    const planMs = await timed(5, () =>
      resolveRoutes(db, {
        organizationId: actor.organizationId,
        event: "monitor.down",
        monitorType: "http",
        monitorId: null,
      }),
    );
    // A fresh causeKey each run, so every one is a real fan-out rather
    // than the idempotency index rejecting duplicates.
    const dispatchMs = await timed(5, () =>
      dispatchToChannels(db, {
        organizationId: actor.organizationId,
        event: "monitor.down",
        causeKey: `bench:${randomUUID()}:monitor.down`,
        subject: "Checkout API",
        detail: ["Bench event."],
        data: {},
        monitorType: "http",
        monitorId: null,
      }),
    );

    const counted = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    const queued = counted[0]?.count ?? 0;

    const heapMb =
      Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;

    results.push({
      channels: size,
      listPageMs: listMs,
      resolveRoutesMs: planMs,
      dispatchMs,
      outboxRowsPerEvent: size,
      outboxRowsTotal: queued,
      workerHeapMb: heapMb,
    });
    console.log(
      `${String(size).padStart(4)} channels  list ${String(listMs).padStart(7)}ms  plan ${String(planMs).padStart(7)}ms  dispatch ${String(dispatchMs).padStart(7)}ms  heap ${heapMb}MB`,
    );

    // Leave nothing behind; the bench database is shared with the tests.
    await db
      .delete(organization)
      .where(eq(organization.id, actor.organizationId));
    await db.delete(user).where(eq(user.id, actor.userId));
  }

  const pgVersion = (
    await db.execute<{ version: string }>(sql`select version() as version`)
  ).rows[0]?.version;

  const artefact = {
    _: "Generated by scripts/bench/channel-fanout.ts. Do not edit by hand.",
    what: "Cost of the three paths that scale with the number of configured notification channels: rendering one page of the settings list, planning a dispatch, and fanning one event into the outbox.",
    method:
      "One organization per size, a mix of slack/telegram/webhook channels including many instances of the same provider, median of 5 runs each, list page size 25.",
    sizes: results,
    environment: {
      commit:
        process.env.VIGIL_SOURCE_COMMIT ??
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      node: process.version,
      postgres: pgVersion?.split(" ").slice(0, 2).join(" ") ?? "unknown",
      cpuModel: cpus()[0]?.model ?? "unknown",
    },
    caveats: [
      "No provider is contacted. These are the costs of Vigil's own query, fan-out and ledger work, not of delivery.",
      "Delivery throughput is bounded by three things this does not measure: Vigil's own drain of 250 messages per minute (the binding limit for a fan-out wider than 250), the per-channel limit of 10 per tick, and each provider's own limits.",
      "dispatchMs grows with the channel count by construction: one event addressed to N channels is N outbox rows, and that is the durability guarantee, not an inefficiency.",
      "listPageMs is flat because the page is paged and the destination is a stored column; it is not evidence that any other page is flat.",
      "One machine, one Postgres, no concurrent tenants.",
    ],
  };
  mkdirSync("docs/evidence/channel-bench", { recursive: true });
  writeFileSync(
    "docs/evidence/channel-bench/channel-fanout.json",
    `${JSON.stringify(artefact, null, 2)}\n`,
  );
  console.log("\nwrote docs/evidence/channel-bench/channel-fanout.json");
  process.exit(0);
}

void main();
