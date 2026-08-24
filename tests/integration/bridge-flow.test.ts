import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  auditLogs,
  bridgeImports,
  bridgeMonitors,
  bridgePolls,
  bridgeSourceIncidents,
  incidents,
  migrationBridges,
  monitors,
} from "@/db/schema";
import {
  connectBridge,
  disconnectBridge,
  generateCutoverReport,
  getBridgeView,
  getCutoverReport,
  pollBridgeEvidence,
  runBridgeImport,
} from "@/modules/importers/bridge/service";
import { openMonitorIncident } from "@/modules/incidents/service";
import { pruneOldChecks } from "@/worker/jobs/retention";

import { fakeTransport, type Route } from "../fixtures/migrations/fetcher";
import { BETTERSTACK, FIXTURE_SECRET } from "../fixtures/migrations/accounts";
import { createTestOrg, db, type TestActor } from "../helpers";

/**
 * The bridge's whole lifecycle against a fixture account: connect,
 * import into shadow, poll evidence, compare, report. The verdict
 * logic's edge cases live in the unit suite; what this file proves is
 * that the pieces hold together against a real database, that tenancy
 * is airtight, and that the one stored credential never appears
 * anywhere a SELECT can reach it in the clear.
 */

const TEST_TOKEN = "bridge-flow-token-do-not-leak";

/**
 * When the fixture's source incidents happened: inside the bridge's
 * comparison window, which opens at the bridge's creation. Relative
 * rather than literal dates, because the comparison rightly discards
 * events that came and went before the bridge existed.
 */
const MONITOR_INCIDENT_START = new Date(Date.now() - 20 * 60_000);
const MONITOR_INCIDENT_END = new Date(Date.now() - 5 * 60_000);
const HEARTBEAT_INCIDENT_START = new Date(Date.now() - 40 * 60_000);
const HEARTBEAT_INCIDENT_END = new Date(Date.now() - 30 * 60_000);

/** The account fixture plus a v3 incident history for it. */
function routesWithIncidents(): Route[] {
  return [
    ...BETTERSTACK,
    {
      path: "/api/v3/incidents",
      query: { resolved: "false" },
      body: { data: [], pagination: { next: null } },
    },
    {
      path: "/api/v3/incidents",
      body: {
        data: [
          {
            id: "9001",
            type: "incident",
            attributes: {
              name: "Homepage keyword absence",
              cause: "Keyword found",
              status: "Resolved",
              started_at: MONITOR_INCIDENT_START.toISOString(),
              acknowledged_at: null,
              resolved_at: MONITOR_INCIDENT_END.toISOString(),
            },
            relationships: { monitor: { data: { id: "2", type: "monitor" } } },
          },
          {
            id: "9002",
            type: "incident",
            attributes: {
              name: "Nightly backup",
              cause: "Missed heartbeat",
              status: "Resolved",
              started_at: HEARTBEAT_INCIDENT_START.toISOString(),
              resolved_at: HEARTBEAT_INCIDENT_END.toISOString(),
            },
            relationships: {
              heartbeat: { data: { id: "2", type: "heartbeat" } },
            },
          },
        ],
        pagination: { next: null },
      },
    },
  ];
}

async function connectedBridge(
  actor: TestActor,
  routes: Route[] = routesWithIncidents(),
) {
  const { options } = fakeTransport(routes);
  await connectBridge(db, actor, { token: TEST_TOKEN, transport: options });
  const bridge = await db.query.migrationBridges.findFirst({
    where: eq(migrationBridges.organizationId, actor.organizationId),
  });
  return { bridge: bridge!, transport: options };
}

describe("bridge lifecycle", () => {
  it("connects after verifying the token, and never stores it readably", async () => {
    const actor = await createTestOrg();
    const { bridge } = await connectedBridge(actor);

    expect(bridge.provider).toBe("betterstack");
    expect(bridge.credentialSealed).not.toBeNull();
    // Sealed, not stored: the ciphertext must not contain the token.
    expect(JSON.stringify(bridge)).not.toContain(TEST_TOKEN);

    const audit = await db.query.auditLogs.findMany({
      where: and(
        eq(auditLogs.organizationId, actor.organizationId),
        eq(auditLogs.action, "bridge.connected"),
      ),
    });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(TEST_TOKEN);
  });

  it("rejects a token the source rejects, storing nothing", async () => {
    const actor = await createTestOrg();
    const { options } = fakeTransport([
      {
        path: "/api/v2/monitors",
        status: 401,
        body: { errors: "Unauthorized" },
      },
    ]);
    await expect(
      connectBridge(db, actor, { token: "bad", transport: options }),
    ).rejects.toThrow(/401/);
    expect(await getBridgeView(db, actor.organizationId)).toBeNull();
  });

  it("imports into shadow mode and records the whole mapping", async () => {
    const actor = await createTestOrg();
    const { bridge, transport } = await connectedBridge(actor);

    const preview = await runBridgeImport(db, actor, {
      dryRun: true,
      transport,
    });
    expect(preview.status).toBe("preview");
    // A dry run writes nothing bridge-side either.
    expect(
      await db.query.bridgeMonitors.findMany({
        where: eq(bridgeMonitors.bridgeId, bridge.id),
      }),
    ).toHaveLength(0);
    expect(
      await db.query.monitors.findMany({
        where: eq(monitors.organizationId, actor.organizationId),
      }),
    ).toHaveLength(0);

    const report = await runBridgeImport(db, actor, { transport });
    expect(report.status).toBe("completed");
    // 3 monitors, 2 heartbeats-as-push, 2 groups.
    expect(report.totals.monitorsCreated).toBe(7);

    // Everything created is shadowed, groups included.
    const fleet = await db.query.monitors.findMany({
      where: eq(monitors.organizationId, actor.organizationId),
    });
    expect(fleet).toHaveLength(7);
    expect(fleet.every((m) => m.shadowBridgeId === bridge.id)).toBe(true);

    // One mapping row per source record, refused ones included.
    const mappings = await db.query.bridgeMonitors.findMany({
      where: eq(bridgeMonitors.bridgeId, bridge.id),
    });
    expect(mappings).toHaveLength(10);
    const bySource = new Map(mappings.map((m) => [m.sourceId, m]));
    expect(bySource.get("2")!.compared).toBe(true);
    expect(bySource.get("2")!.monitorId).not.toBeNull();
    expect(bySource.get("3")!.compared).toBe(true);
    expect(bySource.get("4")!.compared).toBe(true);
    // Heartbeats import but cannot be compared from here.
    expect(bySource.get("heartbeat:2")!.monitorId).not.toBeNull();
    expect(bySource.get("heartbeat:2")!.compared).toBe(false);
    // Refused records map with their reason and no monitor.
    expect(bySource.get("6")!.outcome).toBe("unsupported");
    expect(bySource.get("6")!.monitorId).toBeNull();

    // The full report is persisted, and holds no secret.
    const stored = await db.query.bridgeImports.findMany({
      where: eq(bridgeImports.bridgeId, bridge.id),
    });
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(FIXTURE_SECRET);
    expect(JSON.stringify(stored)).not.toContain(TEST_TOKEN);
  });

  it("a second import creates nothing new and keeps the mapping linked", async () => {
    const actor = await createTestOrg();
    const { bridge, transport } = await connectedBridge(actor);

    await runBridgeImport(db, actor, { transport });
    const second = await runBridgeImport(db, actor, { transport });
    expect(second.totals.monitorsCreated).toBe(0);

    const fleet = await db.query.monitors.findMany({
      where: eq(monitors.organizationId, actor.organizationId),
    });
    expect(fleet).toHaveLength(7);

    // The re-import reported "skipped", but the mapping keeps pointing
    // at the monitor the first run created.
    const mappings = await db.query.bridgeMonitors.findMany({
      where: eq(bridgeMonitors.bridgeId, bridge.id),
    });
    const homepage = mappings.find((m) => m.sourceId === "2")!;
    expect(homepage.outcome).toBe("skipped");
    expect(homepage.monitorId).not.toBeNull();
    expect(homepage.compared).toBe(true);
  });

  it("polls evidence: upserts incidents, records coverage, self-heals", async () => {
    const actor = await createTestOrg();
    const { bridge, transport } = await connectedBridge(actor);
    await runBridgeImport(db, actor, { transport });

    const first = await pollBridgeEvidence(db, bridge, { transport });
    expect(first.status).toBe("ok");
    expect(first.incidentsSeen).toBe(2);

    const copies = await db.query.bridgeSourceIncidents.findMany({
      where: eq(bridgeSourceIncidents.bridgeId, bridge.id),
    });
    expect(copies).toHaveLength(2);
    const monitorIncident = copies.find((c) => c.sourceIncidentId === "9001")!;
    expect(monitorIncident.resourceType).toBe("monitor");
    expect(monitorIncident.resourceId).toBe("2");
    expect(monitorIncident.status).toBe("Resolved");
    expect(monitorIncident.resolvedAt).not.toBeNull();
    const heartbeatIncident = copies.find(
      (c) => c.sourceIncidentId === "9002",
    )!;
    expect(heartbeatIncident.resourceType).toBe("heartbeat");

    // A duplicate poll upserts rather than duplicating.
    const again = await pollBridgeEvidence(db, bridge, { transport });
    expect(again.status).toBe("ok");
    expect(
      await db.query.bridgeSourceIncidents.findMany({
        where: eq(bridgeSourceIncidents.bridgeId, bridge.id),
      }),
    ).toHaveLength(2);

    const polls = await db.query.bridgePolls.findMany({
      where: eq(bridgePolls.bridgeId, bridge.id),
    });
    expect(polls).toHaveLength(2);
    expect(polls.every((p) => p.status === "ok")).toBe(true);
  });

  it("records a failed poll as a failed poll, and counts the streak", async () => {
    const actor = await createTestOrg();
    const { transport } = await connectedBridge(actor);
    await runBridgeImport(db, actor, { transport });

    const broken = fakeTransport([
      ...BETTERSTACK,
      { path: "/api/v3/incidents", status: 500, body: "upstream broke" },
    ]);
    let bridge = (await db.query.migrationBridges.findFirst({
      where: eq(migrationBridges.organizationId, actor.organizationId),
    }))!;
    const outcome = await pollBridgeEvidence(db, bridge, {
      transport: broken.options,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("500");
    expect(outcome.detail).not.toContain(TEST_TOKEN);

    bridge = (await db.query.migrationBridges.findFirst({
      where: eq(migrationBridges.id, bridge.id),
    }))!;
    expect(bridge.lastPollStatus).toBe("failed");
    expect(bridge.consecutivePollFailures).toBe(1);

    const polls = await db.query.bridgePolls.findMany({
      where: eq(bridgePolls.bridgeId, bridge.id),
    });
    expect(polls.filter((p) => p.status === "failed")).toHaveLength(1);

    // A working poll clears the streak.
    const fixed = await pollBridgeEvidence(db, bridge, { transport });
    expect(fixed.status).toBe("ok");
    bridge = (await db.query.migrationBridges.findFirst({
      where: eq(migrationBridges.id, bridge.id),
    }))!;
    expect(bridge.consecutivePollFailures).toBe(0);
  });

  it("records a feed it cannot parse as partial, never as coverage", async () => {
    const actor = await createTestOrg();
    const { transport } = await connectedBridge(actor);
    await runBridgeImport(db, actor, { transport });

    // A format change that blinds the parser: rows with no readable
    // start. Recording this window as `ok` would let quiet-because-
    // blind read as quiet-because-agreeing.
    const blinded = fakeTransport([
      ...BETTERSTACK,
      {
        path: "/api/v3/incidents",
        body: {
          data: [
            { id: "9901", type: "incident", attributes: { started_at: "??" } },
          ],
          pagination: { next: null },
        },
      },
    ]);
    const bridge = (await db.query.migrationBridges.findFirst({
      where: eq(migrationBridges.organizationId, actor.organizationId),
    }))!;
    const outcome = await pollBridgeEvidence(db, bridge, {
      transport: blinded.options,
    });
    expect(outcome.status).toBe("partial");
    expect(outcome.detail).toContain("could not be parsed");

    const polls = await db.query.bridgePolls.findMany({
      where: eq(bridgePolls.bridgeId, bridge.id),
    });
    expect(polls.filter((p) => p.status === "partial")).toHaveLength(1);
    expect(polls.filter((p) => p.status === "ok")).toHaveLength(0);
  });

  it("re-fetches a stale open copy so a long outage's resolution is observed", async () => {
    const actor = await createTestOrg();
    const base = new Date();
    const start = new Date(base.getTime() - 60_000);
    // Poll 1: the incident is open and in the open feed.
    const openRoutes: Route[] = [
      ...BETTERSTACK,
      {
        path: "/api/v3/incidents",
        query: { resolved: "false" },
        body: {
          data: [
            {
              id: "7001",
              type: "incident",
              attributes: {
                name: "Long outage",
                status: "Started",
                started_at: start.toISOString(),
                resolved_at: null,
              },
              relationships: {
                monitor: { data: { id: "2", type: "monitor" } },
              },
            },
          ],
          pagination: { next: null },
        },
      },
      {
        path: "/api/v3/incidents",
        body: { data: [], pagination: { next: null } },
      },
    ];
    const { bridge } = await connectedBridge(actor, openRoutes);
    const first = fakeTransport(openRoutes);
    await pollBridgeEvidence(db, bridge, { transport: first.options });

    let copy = (await db.query.bridgeSourceIncidents.findFirst({
      where: eq(bridgeSourceIncidents.bridgeId, bridge.id),
    }))!;
    expect(copy.resolvedAt).toBeNull();

    // Poll 2: it has left BOTH feeds (resolved days after it started,
    // outside the window's start-date filter). Only the per-id fetch
    // can finish the story.
    const resolved = new Date(base.getTime() + 3_600_000);
    const goneRoutes: Route[] = [
      ...BETTERSTACK,
      {
        path: "/api/v3/incidents",
        query: { resolved: "false" },
        body: { data: [], pagination: { next: null } },
      },
      {
        path: "/api/v3/incidents",
        body: { data: [], pagination: { next: null } },
      },
      {
        path: "/api/v3/incidents/7001",
        body: {
          data: {
            id: "7001",
            type: "incident",
            attributes: {
              name: "Long outage",
              status: "Resolved",
              started_at: start.toISOString(),
              resolved_at: resolved.toISOString(),
            },
            relationships: { monitor: { data: { id: "2", type: "monitor" } } },
          },
        },
      },
    ];
    const second = fakeTransport(goneRoutes);
    const outcome = await pollBridgeEvidence(db, bridge, {
      transport: second.options,
    });
    expect(outcome.status).toBe("ok");
    expect(second.api.countOf("/api/v3/incidents/7001")).toBe(1);

    copy = (await db.query.bridgeSourceIncidents.findFirst({
      where: eq(bridgeSourceIncidents.bridgeId, bridge.id),
    }))!;
    expect(copy.resolvedAt?.toISOString()).toBe(resolved.toISOString());
    expect(copy.status).toBe("Resolved");
  });

  it("never lets a stale concurrent read un-resolve a copy", async () => {
    const actor = await createTestOrg();
    const { bridge, transport } = await connectedBridge(actor);
    await pollBridgeEvidence(db, bridge, { transport });

    // The default fixture's incident 9001 is resolved. A slower poll's
    // stale read hands the same incident back WITHOUT its resolution;
    // the copy must keep the observed one.
    const stale = fakeTransport([
      ...BETTERSTACK,
      {
        path: "/api/v3/incidents",
        query: { resolved: "false" },
        body: {
          data: [
            {
              id: "9001",
              type: "incident",
              attributes: {
                name: "Homepage keyword absence",
                status: "Started",
                started_at: MONITOR_INCIDENT_START.toISOString(),
                resolved_at: null,
              },
              relationships: {
                monitor: { data: { id: "2", type: "monitor" } },
              },
            },
          ],
          pagination: { next: null },
        },
      },
      {
        path: "/api/v3/incidents",
        body: { data: [], pagination: { next: null } },
      },
    ]);
    await pollBridgeEvidence(db, bridge, { transport: stale.options });

    const copy = (await db.query.bridgeSourceIncidents.findFirst({
      where: and(
        eq(bridgeSourceIncidents.bridgeId, bridge.id),
        eq(bridgeSourceIncidents.sourceIncidentId, "9001"),
      ),
    }))!;
    expect(copy.resolvedAt).not.toBeNull();
    // The words must not regress either: a copy whose resolution stands
    // must not read "Started" beside it.
    expect(copy.status).toBe("Resolved");
  });

  it("refuses a reconnect whose token cannot see the mapped records", async () => {
    const actor = await createTestOrg();
    const { transport } = await connectedBridge(actor);
    await runBridgeImport(db, actor, { transport });
    await disconnectBridge(db, actor);

    // A token from another workspace verifies fine (it can list its own
    // monitors) but answers 404 for every record THIS bridge mapped.
    const stranger = fakeTransport([
      {
        path: "/api/v2/monitors",
        body: {
          data: [{ id: "77", attributes: {} }],
          pagination: { next: null },
        },
      },
    ]);
    await expect(
      connectBridge(db, actor, {
        token: "other-workspace-token",
        transport: stranger.options,
      }),
    ).rejects.toThrow(/different Better Stack account/);

    // The bridge stays disconnected: the stranger's token was not kept.
    const view = (await getBridgeView(db, actor.organizationId))!;
    expect(view.connected).toBe(false);

    // A token for the same account answers 200 for a mapped record and
    // reconnects; one deleted-at-the-source record must not strand it,
    // so the first two probes 404 here and the third answers.
    const sameAccount = fakeTransport([
      {
        path: "/api/v2/monitors",
        body: { data: [], pagination: { next: null } },
      },
      {
        path: "/api/v2/monitors/4",
        body: { data: { id: "4", attributes: {} } },
      },
    ]);
    await connectBridge(db, actor, {
      token: "rotated-same-account-token",
      transport: sameAccount.options,
    });
    expect((await getBridgeView(db, actor.organizationId))!.connected).toBe(
      true,
    );
    expect(sameAccount.api.countOf("/api/v2/monitors/2")).toBe(1);
    expect(sameAccount.api.countOf("/api/v2/monitors/3")).toBe(1);
    expect(sameAccount.api.countOf("/api/v2/monitors/4")).toBe(1);
  });

  it("retention keeps the source copies and prunes only old polls, per tenant", async () => {
    const actor = await createTestOrg();
    const { bridge, transport } = await connectedBridge(actor);
    await pollBridgeEvidence(db, bridge, { transport });

    const ancient = new Date(Date.now() - 120 * 86_400_000);
    await db
      .update(bridgeSourceIncidents)
      .set({ resolvedAt: ancient, startedAt: ancient })
      .where(eq(bridgeSourceIncidents.bridgeId, bridge.id));
    await db
      .update(bridgePolls)
      .set({ createdAt: ancient })
      .where(eq(bridgePolls.bridgeId, bridge.id));

    // Another tenant's sweep must not reach this bridge's rows.
    const stranger = await createTestOrg();
    await pruneOldChecks({ organizationId: stranger.organizationId });
    expect(
      await db.query.bridgePolls.findMany({
        where: eq(bridgePolls.bridgeId, bridge.id),
      }),
    ).toHaveLength(1);

    await pruneOldChecks({ organizationId: actor.organizationId });
    // Old polls go; the copies stay, because a recorded miss is source
    // evidence plus Vigil's absence, and a verdict must never improve
    // because time passed.
    expect(
      await db.query.bridgePolls.findMany({
        where: eq(bridgePolls.bridgeId, bridge.id),
      }),
    ).toHaveLength(0);
    expect(
      (
        await db.query.bridgeSourceIncidents.findMany({
          where: eq(bridgeSourceIncidents.bridgeId, bridge.id),
        })
      ).length,
    ).toBeGreaterThan(0);
  });

  it("skips a disconnected bridge and deletes the ciphertext", async () => {
    const actor = await createTestOrg();
    const { transport } = await connectedBridge(actor);
    await disconnectBridge(db, actor);

    const bridge = (await db.query.migrationBridges.findFirst({
      where: eq(migrationBridges.organizationId, actor.organizationId),
    }))!;
    expect(bridge.credentialSealed).toBeNull();

    const outcome = await pollBridgeEvidence(db, bridge, { transport });
    expect(outcome.status).toBe("skipped");
  });

  it("generates and freezes a cutover report from stored rows only", async () => {
    const actor = await createTestOrg();
    // The comparison window opens when the bridge is created, so the
    // fixture's outage has to happen AFTER that: the test simulates two
    // hours of shadow by handing the poll and the report explicit
    // clocks, exactly the seam the worker uses.
    const base = new Date();
    const sourceStart = new Date(base.getTime() + 10 * 60_000);
    const sourceEnd = new Date(base.getTime() + 30 * 60_000);
    const routes: Route[] = [
      ...BETTERSTACK,
      {
        path: "/api/v3/incidents",
        query: { resolved: "false" },
        body: { data: [], pagination: { next: null } },
      },
      {
        path: "/api/v3/incidents",
        body: {
          data: [
            {
              id: "9001",
              type: "incident",
              attributes: {
                name: "Homepage keyword absence",
                cause: "Keyword found",
                status: "Resolved",
                started_at: sourceStart.toISOString(),
                resolved_at: sourceEnd.toISOString(),
              },
              relationships: {
                monitor: { data: { id: "2", type: "monitor" } },
              },
            },
          ],
          pagination: { next: null },
        },
      },
    ];
    const { bridge, transport } = await connectedBridge(actor, routes);
    await runBridgeImport(db, actor, { transport });
    await pollBridgeEvidence(db, bridge, {
      transport,
      now: new Date(base.getTime() + 2 * 3_600_000),
    });

    // Give the "Homepage keyword absence" pair a matching Vigil-side
    // incident so the comparison has one matched event.
    const mapping = await db.query.bridgeMonitors.findFirst({
      where: and(
        eq(bridgeMonitors.bridgeId, bridge.id),
        eq(bridgeMonitors.sourceId, "2"),
      ),
    });
    const monitor = (await db.query.monitors.findFirst({
      where: eq(monitors.id, mapping!.monitorId!),
    }))!;
    await db
      .update(monitors)
      .set({ currentStatus: "down" })
      .where(eq(monitors.id, monitor.id));
    const incident = await openMonitorIncident(db, monitor, "keyword found");
    await db
      .update(incidents)
      .set({
        startedAt: new Date(sourceStart.getTime() + 2 * 60_000),
        resolvedAt: new Date(sourceEnd.getTime() + 60_000),
        status: "resolved",
      })
      .where(eq(incidents.id, incident!.id));

    const { id, report } = await generateCutoverReport(db, actor, {
      now: new Date(base.getTime() + 3 * 3_600_000),
    });
    expect(report.totals.sourceRecords).toBe(10);
    expect(report.totals.comparedPairs).toBe(3);
    expect(report.totals.matched).toBe(1);
    expect(report.totals.missed).toBe(0);
    // Fresh bridge: nowhere near 24h of evidence, unsupported records
    // exist, heartbeats need repointing. The verdict must say no.
    expect(report.verdict).toBe("not-safe");
    expect(report.reasons.length).toBeGreaterThan(0);
    expect(report.manualWork.length).toBeGreaterThan(0);

    // Persisted, immutable, tenant-scoped.
    const stored = await getCutoverReport(db, actor.organizationId, id);
    expect(stored).not.toBeNull();
    expect(stored!.verdict).toBe("not-safe");
    expect(stored!.body.totals.matched).toBe(1);
    expect(JSON.stringify(stored)).not.toContain(TEST_TOKEN);

    const stranger = await createTestOrg();
    expect(await getCutoverReport(db, stranger.organizationId, id)).toBeNull();
  });

  it("keeps tenants apart: a bridge, its view and its evidence are one org's", async () => {
    const actorA = await createTestOrg();
    const actorB = await createTestOrg();
    const { bridge, transport } = await connectedBridge(actorA);
    await runBridgeImport(db, actorA, { transport });
    await pollBridgeEvidence(db, bridge, { transport });

    expect(await getBridgeView(db, actorB.organizationId)).toBeNull();
    await expect(runBridgeImport(db, actorB, { transport })).rejects.toThrow(
      /No migration bridge/,
    );

    // Rows written by A's bridge all carry A's organisation.
    const evidence = await db.query.bridgeSourceIncidents.findMany({
      where: eq(bridgeSourceIncidents.bridgeId, bridge.id),
    });
    expect(
      evidence.every((row) => row.organizationId === actorA.organizationId),
    ).toBe(true);
  });

  it("summarises the bridge for its settings page", async () => {
    const actor = await createTestOrg();
    const { bridge, transport } = await connectedBridge(actor);
    await runBridgeImport(db, actor, { transport });
    await pollBridgeEvidence(db, bridge, { transport });
    await generateCutoverReport(db, actor);

    const view = (await getBridgeView(db, actor.organizationId))!;
    expect(view.connected).toBe(true);
    expect(view.shadowMonitorCount).toBe(7);
    expect(view.mapping.total).toBe(10);
    expect(view.mapping.compared).toBe(3);
    expect(view.sourceIncidentCount).toBe(2);
    expect(view.lastPollStatus).toBe("ok");
    expect(view.imports).toHaveLength(1);
    expect(view.reports).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain(TEST_TOKEN);
  });
});
