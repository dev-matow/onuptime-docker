import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  incidentEvents,
  incidents,
  migrationBridges,
  monitors,
  notificationIntents,
  notificationOutbox,
  statusPageMonitors,
} from "@/db/schema";
import { ConflictError } from "@/lib/errors";
import {
  cutOverBridge,
  abandonBridge,
  deleteBridge,
} from "@/modules/importers/bridge/service";
import { openMonitorIncident } from "@/modules/incidents/service";
import { evaluateMonitor } from "@/modules/monitors/evaluate";
import { applyOutcome } from "@/modules/monitors/outcome";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import {
  cloneMonitor,
  createMonitor,
  type Monitor,
} from "@/modules/monitors/service";
import {
  createStatusPage,
  getPublicStatusPage,
  setStatusPageMonitors,
  updateStatusPage,
} from "@/modules/status-pages/service";

import {
  createTestOrg,
  db,
  failResult,
  okResult,
  withRowLocked,
  type TestActor,
} from "../helpers";

/**
 * Shadow mode's whole promise, proven at the seam that keeps it: a
 * monitor imported by a migration bridge detects and records everything
 * and announces nothing. Every test here drives the REAL outcome path -
 * `applyOutcome`, the same function the worker, the probes and the
 * manual-run button call - and then asserts on what landed in the
 * database, because "nothing was sent" is a fact about rows, not about
 * mocks.
 */

function monitorInput(
  overrides: Partial<CreateMonitorInput> = {},
): CreateMonitorInput {
  return {
    name: `Monitor ${randomUUID().slice(0, 8)}`,
    url: "https://vigil-tests.example.com/health",
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 10_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    checkType: "http" as const,
    tlsCheck: false,
    tlsWarnDays: 14,
    // Zero: the first failing check crosses the window, so a test does
    // not have to replay a timeline to open an incident.
    failureWindowSeconds: 0,
    ...overrides,
  };
}

async function createBridge(actor: TestActor): Promise<string> {
  const [bridge] = await db
    .insert(migrationBridges)
    .values({
      organizationId: actor.organizationId,
      provider: "betterstack",
      credentialSealed: "",
      createdBy: actor.userId,
    })
    .returning({ id: migrationBridges.id });
  return bridge!.id;
}

async function shadowMonitor(
  actor: TestActor,
  bridgeId: string,
  overrides: Partial<CreateMonitorInput> = {},
): Promise<Monitor> {
  const monitor = await createMonitor(db, actor, monitorInput(overrides));
  const [updated] = await db
    .update(monitors)
    .set({ shadowBridgeId: bridgeId })
    .where(eq(monitors.id, monitor.id))
    .returning();
  return updated!;
}

async function intentsOf(organizationId: string) {
  return db.query.notificationIntents.findMany({
    where: eq(notificationIntents.organizationId, organizationId),
  });
}

async function outboxOf(organizationId: string) {
  return db.query.notificationOutbox.findMany({
    where: eq(notificationOutbox.organizationId, organizationId),
  });
}

async function openIncidentOf(monitorId: string) {
  return db.query.incidents.findFirst({
    where: and(
      eq(incidents.monitorId, monitorId),
      eq(incidents.source, "monitor"),
    ),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}

describe("shadow mode suppression", () => {
  it("records a shadow incident without paging, notifying, or claiming", async () => {
    const actor = await createTestOrg();
    const bridgeId = await createBridge(actor);
    const monitor = await shadowMonitor(actor, bridgeId);

    await applyOutcome(monitor, failResult());

    const incident = await openIncidentOf(monitor.id);
    expect(incident).toBeDefined();
    expect(incident!.shadow).toBe(true);
    expect(incident!.status).not.toBe("resolved");
    // Never claimed: the exactly-once notification claim was never spent.
    expect(incident!.notifiedAt).toBeNull();

    // The system event is the handled-marker, and it says what happened.
    const events = await db.query.incidentEvents.findMany({
      where: eq(incidentEvents.incidentId, incident!.id),
    });
    const system = events.filter((e) => e.type === "system");
    expect(system).toHaveLength(1);
    expect(system[0]!.message).toContain("shadow mode");
    expect(system[0]!.message).toContain("nobody was paged");

    // Nothing owed, nothing queued: no intent, no outbox row, for the
    // whole organisation.
    expect(await intentsOf(actor.organizationId)).toHaveLength(0);
    expect(await outboxOf(actor.organizationId)).toHaveLength(0);
  });

  it("does not re-decide a shadow incident on every later check", async () => {
    const actor = await createTestOrg();
    const bridgeId = await createBridge(actor);
    const monitor = await shadowMonitor(actor, bridgeId);

    let current = await applyOutcome(monitor, failResult());
    current = await applyOutcome(current, failResult());
    await applyOutcome(current, failResult());

    const incident = await openIncidentOf(monitor.id);
    const events = await db.query.incidentEvents.findMany({
      where: eq(incidentEvents.incidentId, incident!.id),
    });
    // One created event, one system marker; the second and third checks
    // added nothing because the marker made the incident "handled".
    expect(events.filter((e) => e.type === "system")).toHaveLength(1);
    expect(await intentsOf(actor.organizationId)).toHaveLength(0);
  });

  it("repairs the crash window: a shadow incident with no marker gets one, silently", async () => {
    const actor = await createTestOrg();
    const bridgeId = await createBridge(actor);
    const monitor = await shadowMonitor(actor, bridgeId);

    // First check opens and marks. Simulate the worker dying between
    // the insert and the marker by deleting the marker.
    const afterFail = await applyOutcome(monitor, failResult());
    const incident = await openIncidentOf(monitor.id);
    await db
      .delete(incidentEvents)
      .where(
        and(
          eq(incidentEvents.incidentId, incident!.id),
          eq(incidentEvents.type, "system"),
        ),
      );

    await applyOutcome(afterFail, failResult());

    const events = await db.query.incidentEvents.findMany({
      where: eq(incidentEvents.incidentId, incident!.id),
    });
    expect(events.filter((e) => e.type === "system")).toHaveLength(1);
    expect(await intentsOf(actor.organizationId)).toHaveLength(0);
    const repaired = await openIncidentOf(monitor.id);
    expect(repaired!.notifiedAt).toBeNull();
  });

  it("resolves a shadow incident as quietly as it opened", async () => {
    const actor = await createTestOrg();
    const bridgeId = await createBridge(actor);
    const monitor = await shadowMonitor(actor, bridgeId);

    const down = await applyOutcome(monitor, failResult());
    await applyOutcome(down, okResult());

    const incident = await openIncidentOf(monitor.id);
    expect(incident!.status).toBe("resolved");
    expect(incident!.shadow).toBe(true);
    expect(await intentsOf(actor.organizationId)).toHaveLength(0);
    expect(await outboxOf(actor.organizationId)).toHaveLength(0);
  });

  it("control: a live monitor in the same organisation still pages", async () => {
    const actor = await createTestOrg();
    const bridgeId = await createBridge(actor);
    const shadow = await shadowMonitor(actor, bridgeId);
    const live = await createMonitor(db, actor, monitorInput());

    await applyOutcome(shadow, failResult());
    await applyOutcome(live, failResult());

    const liveIncident = await openIncidentOf(live.id);
    expect(liveIncident!.shadow).toBe(false);
    expect(liveIncident!.notifiedAt).not.toBeNull();

    const intents = await intentsOf(actor.organizationId);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.causeKey).toBe(
      `incident:${liveIncident!.id}:incident.opened`,
    );
  });

  it("keeps shadow incidents off the public status page, belt and braces", async () => {
    const actor = await createTestOrg();
    const bridgeId = await createBridge(actor);
    const shadow = await shadowMonitor(actor, bridgeId, {
      name: "Shadowed API",
    });
    const live = await createMonitor(
      db,
      actor,
      monitorInput({ name: "Live API" }),
    );

    const slug = `bridge-${randomUUID().slice(0, 8)}`;
    const page = await createStatusPage(db, actor, {
      name: "Public",
      slug,
    });
    await updateStatusPage(db, actor, {
      statusPageId: page.id,
      name: "Public",
      slug,
      published: true,
      showBranding: true,
      visibility: "public",
    });
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: live.id, displayName: null }],
    });
    // The write guard refuses shadow monitors, so plant the membership
    // directly: the read side must hold on its own.
    await db.insert(statusPageMonitors).values({
      statusPageId: page.id,
      monitorId: shadow.id,
      displayName: null,
      sortOrder: 99,
    });

    await applyOutcome(shadow, failResult());
    await applyOutcome(live, okResult());

    const view = await getPublicStatusPage(db, slug);
    expect(view).not.toBeNull();
    expect(view!.components.map((c) => c.name)).toEqual(["Live API"]);
    expect(view!.activeIncidents).toHaveLength(0);
    // The shadow monitor's outage does not touch the headline.
    expect(view!.overall).toBe("operational");
  });

  it("refuses to put a shadow monitor on a status page", async () => {
    const actor = await createTestOrg();
    const bridgeId = await createBridge(actor);
    const shadow = await shadowMonitor(actor, bridgeId);
    const page = await createStatusPage(db, actor, {
      name: "Public",
      slug: `bridge-${randomUUID().slice(0, 8)}`,
    });

    await expect(
      setStatusPageMonitors(db, actor, {
        statusPageId: page.id,
        monitors: [{ monitorId: shadow.id, displayName: null }],
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("keeps a shadow member out of a live group's derivation", async () => {
    const actor = await createTestOrg();
    const bridgeId = await createBridge(actor);
    const group = await createMonitor(
      db,
      actor,
      monitorInput({ checkType: "group", name: "Fleet", url: "Fleet" }),
    );
    const liveMember = await createMonitor(
      db,
      actor,
      monitorInput({ parentId: group.id }),
    );
    const shadowMember = await shadowMonitor(actor, bridgeId, {
      parentId: group.id,
    });

    await applyOutcome(liveMember, okResult());
    await applyOutcome(shadowMember, failResult());

    const groupRow = await db.query.monitors.findFirst({
      where: eq(monitors.id, group.id),
    });
    const outcome = await evaluateMonitor(db, groupRow!);
    // The live member is up; the shadow member's down must not reach
    // the group, or the group would page for the silent fleet.
    expect(outcome.verdict).toBe("up");
  });

  it("cutover takes the fleet live, closes shadow incidents, and the next failure pages", async () => {
    const actor = await createTestOrg();
    const bridgeId = await createBridge(actor);
    const monitor = await shadowMonitor(actor, bridgeId);

    const down = await applyOutcome(monitor, failResult());
    const before = await openIncidentOf(monitor.id);
    expect(before!.shadow).toBe(true);

    const outcome = await cutOverBridge(db, actor);
    expect(outcome.monitorsLive).toBe(1);
    expect(outcome.incidentsClosed).toBe(1);

    const closed = await openIncidentOf(monitor.id);
    expect(closed!.status).toBe("resolved");
    const events = await db.query.incidentEvents.findMany({
      where: eq(incidentEvents.incidentId, closed!.id),
    });
    expect(
      events.some(
        (e) => e.type === "system" && e.message.includes("Shadow mode ended"),
      ),
    ).toBe(true);

    // Still down: the next check opens a LIVE incident that pages.
    const cleared = await db.query.monitors.findFirst({
      where: eq(monitors.id, monitor.id),
    });
    expect(cleared!.shadowBridgeId).toBeNull();
    await applyOutcome({ ...down, shadowBridgeId: null }, failResult());

    const fresh = await openIncidentOf(monitor.id);
    expect(fresh!.id).not.toBe(before!.id);
    expect(fresh!.shadow).toBe(false);
    expect(fresh!.notifiedAt).not.toBeNull();
    const intents = await intentsOf(actor.organizationId);
    expect(intents.map((i) => i.causeKey)).toContain(
      `incident:${fresh!.id}:incident.opened`,
    );
  });

  it("abandon pauses the fleet instead of taking it live", async () => {
    const actor = await createTestOrg();
    const bridgeId = await createBridge(actor);
    const monitor = await shadowMonitor(actor, bridgeId);
    await applyOutcome(monitor, failResult());

    const outcome = await abandonBridge(db, actor);
    expect(outcome.monitorsLive).toBe(1);

    const row = await db.query.monitors.findFirst({
      where: eq(monitors.id, monitor.id),
    });
    expect(row!.paused).toBe(true);
    expect(row!.shadowBridgeId).toBeNull();
    expect(await intentsOf(actor.organizationId)).toHaveLength(0);
  });

  it("cutover racing an opening check leaves no silent live incident and no loud shadow one", async () => {
    const actor = await createTestOrg();
    const bridgeId = await createBridge(actor);
    const monitor = await shadowMonitor(actor, bridgeId);
    // First failure: the monitor is down with an open shadow incident,
    // which is the state a cutover most plausibly races a check in.
    const down = await applyOutcome(monitor, failResult());

    // Both contenders serialise on the monitor row: the check path's
    // conditional UPDATE and the cutover's SELECT FOR UPDATE. Whichever
    // wins, the end state must be consistent - that is the invariant,
    // not the ordering.
    await withRowLocked("monitors", monitor.id, 2, async () => {
      await Promise.all([
        applyOutcome(down, failResult()),
        cutOverBridge(db, actor),
      ]);
    });

    const cleared = await db.query.monitors.findFirst({
      where: eq(monitors.id, monitor.id),
    });
    expect(cleared!.shadowBridgeId).toBeNull();

    const all = await db.query.incidents.findMany({
      where: eq(incidents.monitorId, monitor.id),
    });
    for (const incident of all) {
      if (incident.shadow) {
        // A shadow incident may survive only resolved: cutover closes
        // what it found open, and nothing may reopen it.
        expect(incident.status).toBe("resolved");
        expect(incident.notifiedAt).toBeNull();
      } else {
        // A live incident exists only if the check ran after cutover,
        // and then it must have been paged, not orphaned.
        expect(incident.notifiedAt).not.toBeNull();
      }
    }
  });

  it("refuses to open an incident for a monitor that was paused mid-flight", async () => {
    // The check that decides to open commits before openMonitorIncident
    // locks the row, so an abandon (or a hand pause) can land in the
    // gap. An incident born then would page for a silenced monitor and
    // sit open forever, because paused monitors are never checked and
    // auto-resolve is driven by checks.
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    await db
      .update(monitors)
      .set({ currentStatus: "down", paused: true })
      .where(eq(monitors.id, monitor.id));
    const fresh = (await db.query.monitors.findFirst({
      where: eq(monitors.id, monitor.id),
    }))!;

    const incident = await openMonitorIncident(db, fresh, "late failure");
    expect(incident).toBeNull();
    expect(await openIncidentOf(monitor.id)).toBeUndefined();
  });

  it("a clone of a shadow monitor is a live monitor", async () => {
    const actor = await createTestOrg();
    const bridgeId = await createBridge(actor);
    const shadow = await shadowMonitor(actor, bridgeId);

    const clone = await cloneMonitor(db, actor, shadow.id);
    expect(clone.shadowBridgeId).toBeNull();
    // And therefore outside the bridge's cutover sweep.
    const outcome = await cutOverBridge(db, actor);
    expect(outcome.monitorsLive).toBe(1);
  });

  it("refuses to delete a bridge that still shadows monitors", async () => {
    const actor = await createTestOrg();
    const bridgeId = await createBridge(actor);
    await shadowMonitor(actor, bridgeId);

    await expect(deleteBridge(db, actor)).rejects.toThrow(
      /still run in this bridge's shadow mode/,
    );

    await cutOverBridge(db, actor);
    await deleteBridge(db, actor);
    const gone = await db.query.migrationBridges.findFirst({
      where: eq(migrationBridges.id, bridgeId),
    });
    expect(gone).toBeUndefined();
  });
});
