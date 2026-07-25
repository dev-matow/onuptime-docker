import "dotenv/config";
import "./_force-non-demo";

import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import {
  auditLogs,
  incidentEvents,
  incidents,
  member,
  monitorChecks,
  monitors,
  organization,
  statusPageMonitors,
  statusPages,
  user,
} from "@/db/schema";
import { auth } from "@/lib/auth";
import { DEMO_ORG, DEMO_PASSWORD, DEMO_USERS } from "@/lib/demo";

/**
 * Seeds a realistic sample team so a fresh install has something to look
 * at: five production-style monitors with 90 days of check history, one
 * resolved incident with a full timeline and postmortem, one ongoing
 * outage, and a published status page.
 *
 * Idempotent — re-running wipes and recreates the sample organization,
 * so it also works as the reset for a public read-only demo (DEMO_MODE,
 * see docs/DEMO.md).
 *
 *   npm run db:seed
 */

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

/** Deterministic pseudo-random so re-seeds produce comparable charts. */
function mulberry32(seed: number) {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260702);

interface MonitorSeed {
  name: string;
  url: string;
  method?: "GET" | "HEAD";
  intervalSeconds: number;
  expectedStatusCode?: number;
  bodyKeyword?: string;
  baseMs: number;
  publicName: string;
  /** UTC ms outage windows: checks inside fail. */
  outages?: [number, number][];
}

async function wipe(): Promise<void> {
  const existing = await db.query.organization.findFirst({
    where: eq(organization.slug, DEMO_ORG.slug),
    columns: { id: true },
  });
  if (existing) {
    await db.delete(organization).where(eq(organization.id, existing.id));
  }
  const emails = Object.values(DEMO_USERS).map((u) => u.email);
  await db.delete(user).where(inArray(user.email, emails));
}

async function createTeam() {
  const ids: Record<keyof typeof DEMO_USERS, string> = {
    owner: "",
    admin: "",
    responder: "",
    viewer: "",
  };
  for (const [key, profile] of Object.entries(DEMO_USERS)) {
    const result = await auth.api.signUpEmail({
      body: {
        name: profile.name,
        email: profile.email,
        password: DEMO_PASSWORD,
      },
    });
    ids[key as keyof typeof DEMO_USERS] = result.user.id;
  }

  const organizationId = randomUUID();
  await db.insert(organization).values({
    id: organizationId,
    name: DEMO_ORG.name,
    slug: DEMO_ORG.slug,
    createdAt: new Date(Date.now() - 92 * DAY),
  });
  await db.insert(member).values(
    Object.entries(DEMO_USERS).map(([key, profile]) => ({
      id: randomUUID(),
      organizationId,
      userId: ids[key as keyof typeof DEMO_USERS],
      role: profile.role,
      createdAt: new Date(Date.now() - 91 * DAY),
    })),
  );
  return { organizationId, ids };
}

function checkRowsFor(
  monitorId: string,
  seed: MonitorSeed,
  now: number,
): (typeof monitorChecks.$inferInsert)[] {
  const rows: (typeof monitorChecks.$inferInsert)[] = [];
  const start = now - 90 * DAY;

  const push = (ts: number) => {
    const inOutage = seed.outages?.some(([from, to]) => ts >= from && ts <= to);
    const responseTimeMs = Math.round(seed.baseMs * (0.8 + rand() * 0.6));
    rows.push({
      monitorId,
      checkedAt: new Date(ts),
      ok: !inOutage,
      statusCode: inOutage ? 502 : (seed.expectedStatusCode ?? 200),
      responseTimeMs: inOutage ? Math.round(seed.baseMs * 3) : responseTimeMs,
      error: inOutage ? "Unexpected status 502" : null,
    });
  };

  // 90 days of history at ~3h resolution, denser over the last 24h.
  for (let ts = start; ts < now - DAY; ts += 3 * 60 * MIN + rand() * 10 * MIN) {
    push(ts);
  }
  for (let ts = now - DAY; ts < now; ts += 12 * MIN) {
    push(ts);
  }
  return rows;
}

async function main() {
  console.log("Seeding sample data…");
  await wipe();

  const now = Date.now();
  const { organizationId, ids } = await createTeam();

  // The resolved incident: a 70-minute API outage two weeks ago.
  const gatewayOutage: [number, number] = [
    now - 14 * DAY,
    now - 14 * DAY + 70 * MIN,
  ];
  // The ongoing one: checkout has been failing for ~40 minutes.
  const checkoutOutage: [number, number] = [now - 40 * MIN, now + DAY];

  const monitorSeeds: MonitorSeed[] = [
    {
      name: "Marketing site",
      url: "https://altitude.example.com/",
      intervalSeconds: 300,
      baseMs: 180,
      publicName: "Website",
    },
    {
      name: "API gateway",
      url: "https://api.altitude.example.com/health",
      intervalSeconds: 60,
      bodyKeyword: "ok",
      baseMs: 95,
      publicName: "API",
      outages: [gatewayOutage],
    },
    {
      name: "Checkout service",
      url: "https://api.altitude.example.com/checkout/health",
      intervalSeconds: 60,
      baseMs: 140,
      publicName: "Checkout",
      outages: [checkoutOutage],
    },
    {
      name: "Auth service",
      url: "https://auth.altitude.example.com/health",
      intervalSeconds: 60,
      bodyKeyword: "healthy",
      baseMs: 65,
      publicName: "Sign-in",
    },
    {
      name: "Docs",
      url: "https://docs.altitude.example.com/",
      method: "HEAD",
      intervalSeconds: 600,
      baseMs: 210,
      publicName: "Documentation",
    },
  ];

  const monitorIds: string[] = [];
  for (const seed of monitorSeeds) {
    const down = seed.outages?.some(([from, to]) => now >= from && now <= to);
    const [row] = await db
      .insert(monitors)
      .values({
        organizationId,
        createdBy: ids.owner,
        name: seed.name,
        url: seed.url,
        method: seed.method ?? "GET",
        intervalSeconds: seed.intervalSeconds,
        expectedStatusCode: seed.expectedStatusCode ?? null,
        bodyKeyword: seed.bodyKeyword ?? null,
        currentStatus: down ? "down" : "up",
        consecutiveFailures: down ? 4 : 0,
        lastCheckedAt: new Date(now - 2 * MIN),
        createdAt: new Date(now - 90 * DAY),
      })
      .returning();
    if (!row) throw new Error(`failed to insert monitor ${seed.name}`);
    monitorIds.push(row.id);

    const rows = checkRowsFor(row.id, seed, now);
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(monitorChecks).values(rows.slice(i, i + 500));
    }
  }

  // ---- Resolved incident, with the timeline a real team would leave ----
  const [resolved] = await db
    .insert(incidents)
    .values({
      organizationId,
      title: "Elevated 502s on the API gateway",
      status: "resolved",
      severity: "critical",
      source: "monitor",
      monitorId: monitorIds[1],
      startedAt: new Date(gatewayOutage[0]),
      resolvedAt: new Date(gatewayOutage[1]),
      createdAt: new Date(gatewayOutage[0]),
      postmortem: `## Summary

A routine deploy of the gateway rolled out a connection-pool setting that was
too small for peak traffic. Requests queued, then timed out as 502s for 70
minutes until the change was rolled back.

## Impact

API and checkout returned errors for roughly 8% of requests between 09:12 and
10:22 UTC. No data was lost.

## Root cause

POOL_MAX was lowered from 40 to 10 in the deploy that shipped the new rate
limiter. Under normal load the smaller pool is fine; at peak it starves.

## What we changed

- Rolled back the pool setting and pinned it in the base config.
- Added a load test at peak concurrency to the release checklist.
- Added a keyword assertion on /health so a degraded gateway is caught
  before customers see it.`,
    })
    .returning();
  if (!resolved) throw new Error("failed to insert resolved incident");

  await db.insert(incidentEvents).values([
    {
      incidentId: resolved.id,
      type: "created",
      message: "Monitor API gateway failed 3 consecutive checks.",
      createdAt: new Date(gatewayOutage[0]),
    },
    {
      incidentId: resolved.id,
      type: "update",
      message:
        "Seeing 502s from the gateway. Investigating — checkout is affected too.",
      createdBy: ids.responder,
      createdAt: new Date(gatewayOutage[0] + 6 * MIN),
    },
    {
      incidentId: resolved.id,
      type: "status_change",
      status: "identified",
      message: "Traced to this morning's gateway deploy. Rolling back.",
      createdBy: ids.responder,
      createdAt: new Date(gatewayOutage[0] + 24 * MIN),
    },
    {
      incidentId: resolved.id,
      type: "update",
      message: "Rollback is deploying — error rate already falling.",
      createdBy: ids.admin,
      createdAt: new Date(gatewayOutage[0] + 47 * MIN),
    },
    {
      incidentId: resolved.id,
      type: "status_change",
      status: "resolved",
      message: "Error rates are back to normal. Postmortem to follow.",
      createdBy: ids.owner,
      createdAt: new Date(gatewayOutage[1]),
    },
  ]);

  // ---- Ongoing incident ----
  const [ongoing] = await db
    .insert(incidents)
    .values({
      organizationId,
      title: "Checkout service is down",
      status: "investigating",
      severity: "critical",
      source: "monitor",
      monitorId: monitorIds[2],
      startedAt: new Date(checkoutOutage[0]),
      createdAt: new Date(checkoutOutage[0]),
    })
    .returning();
  if (!ongoing) throw new Error("failed to insert ongoing incident");

  await db.insert(incidentEvents).values([
    {
      incidentId: ongoing.id,
      type: "created",
      message: "Monitor Checkout service failed 3 consecutive checks.",
      createdAt: new Date(checkoutOutage[0]),
    },
    {
      incidentId: ongoing.id,
      type: "update",
      message:
        "Checkout is returning 502. The gateway itself is healthy, so this looks specific to the checkout upstream.",
      createdBy: ids.responder,
      createdAt: new Date(checkoutOutage[0] + 9 * MIN),
    },
    {
      incidentId: ongoing.id,
      type: "update",
      message:
        "Paging the payments vendor — their status page is quiet but our requests time out.",
      internal: true,
      createdBy: ids.admin,
      createdAt: new Date(checkoutOutage[0] + 21 * MIN),
    },
  ]);

  // ---- Public status page ----
  const [page] = await db
    .insert(statusPages)
    .values({
      organizationId,
      slug: DEMO_ORG.slug,
      name: `${DEMO_ORG.name} status`,
      published: true,
      createdAt: new Date(now - 80 * DAY),
    })
    .returning();
  if (!page) throw new Error("failed to insert status page");

  await db.insert(statusPageMonitors).values(
    monitorSeeds.map((seed, index) => ({
      statusPageId: page.id,
      monitorId: monitorIds[index]!,
      displayName: seed.publicName,
      sortOrder: index,
    })),
  );

  await db.insert(auditLogs).values([
    {
      organizationId,
      actorId: ids.owner,
      action: "status_page.updated",
      targetType: "status_page",
      targetId: page.id,
      metadata: { slug: page.slug, published: true },
      createdAt: new Date(now - 80 * DAY),
    },
  ]);

  console.log(`
Seeded ${DEMO_ORG.name}:
  ${monitorSeeds.length} monitors with 90 days of history
  1 resolved incident (timeline + postmortem), 1 ongoing outage
  public status page at /status/${DEMO_ORG.slug}

Sign in with (password: ${DEMO_PASSWORD}):
${Object.values(DEMO_USERS)
  .map((u) => `  ${u.email.padEnd(24)} ${u.role}`)
  .join("\n")}
`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
