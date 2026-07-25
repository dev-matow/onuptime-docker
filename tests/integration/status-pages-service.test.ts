import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditLogs, incidentEvents, organization } from "@/db/schema";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { createIncident } from "@/modules/incidents/service";
import type { CheckOutcome } from "@/modules/monitors/check";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import {
  createMonitor,
  recordCheckOutcome,
  setMonitorPaused,
  type Monitor,
} from "@/modules/monitors/service";
import {
  getOrCreateStatusPage,
  getPublicStatusPage,
  listStatusPageMonitors,
  setStatusPageMonitors,
  updateStatusPage,
} from "@/modules/status-pages/service";
import { postIncidentUpdate } from "@/modules/incidents/service";

import { createTestOrg, db, type TestActor } from "../helpers";

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
    failureThreshold: 3,
    ...overrides,
  };
}

function okOutcome(): CheckOutcome {
  return {
    ok: true,
    degraded: false,
    statusCode: 200,
    responseTimeMs: 90,
    error: null,
  };
}

function failOutcome(): CheckOutcome {
  return {
    ok: false,
    degraded: false,
    statusCode: 500,
    responseTimeMs: 300,
    error: "Unexpected status 500",
  };
}

function uniqueSlug(): string {
  return `page-${randomUUID().slice(0, 12)}`;
}

/** Publishes the org's status page under a fresh unique slug. */
async function publishPage(
  actor: TestActor,
  name = "Test Status",
): Promise<string> {
  const slug = uniqueSlug();
  await updateStatusPage(db, actor, {
    name,
    slug,
    published: true,
  });
  return slug;
}

async function upMonitor(actor: TestActor, name: string): Promise<Monitor> {
  const monitor = await createMonitor(db, actor, monitorInput({ name }));
  const { monitor: checked } = await recordCheckOutcome(
    db,
    monitor,
    okOutcome(),
  );
  return checked;
}

describe("getOrCreateStatusPage", () => {
  it("creates the page once and returns the same row on later calls", async () => {
    const actor = await createTestOrg();

    const first = await getOrCreateStatusPage(db, actor.organizationId);
    const second = await getOrCreateStatusPage(db, actor.organizationId);

    expect(second.id).toBe(first.id);
    expect(first.organizationId).toBe(actor.organizationId);
    expect(first.published).toBe(false);
  });

  it("defaults the slug to the organization slug and derives the name", async () => {
    const actor = await createTestOrg();
    const org = await db.query.organization.findFirst({
      where: eq(organization.id, actor.organizationId),
    });

    const page = await getOrCreateStatusPage(db, actor.organizationId);
    expect(page.slug).toBe(org?.slug);
    expect(page.name).toBe(`${org?.name} status`);
  });
});

describe("updateStatusPage", () => {
  it("changes name, slug and published, and writes an audit row", async () => {
    const actor = await createTestOrg();
    const slug = uniqueSlug();

    const updated = await updateStatusPage(db, actor, {
      name: "Acme Public Status",
      slug,
      published: true,
    });
    expect(updated).toMatchObject({
      name: "Acme Public Status",
      slug,
      published: true,
    });

    const audit = await db.query.auditLogs.findMany({
      where: and(
        eq(auditLogs.organizationId, actor.organizationId),
        eq(auditLogs.action, "status_page.updated"),
      ),
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: actor.userId,
      targetType: "status_page",
      targetId: updated.id,
      metadata: { slug, published: true },
    });
  });

  it("rejects a slug already used by another organization", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const slug = uniqueSlug();

    await updateStatusPage(db, orgA, {
      name: "A",
      slug,
      published: false,
    });

    await expect(
      updateStatusPage(db, orgB, {
        name: "B",
        slug,
        published: false,
      }),
    ).rejects.toThrow(ConflictError);
  });
});

describe("setStatusPageMonitors", () => {
  it("rejects monitor ids belonging to another organization", async () => {
    const owner = await createTestOrg();
    const intruder = await createTestOrg();
    const foreign = await createMonitor(db, owner, monitorInput());
    const own = await createMonitor(db, intruder, monitorInput());

    await expect(
      setStatusPageMonitors(db, intruder, {
        monitors: [{ monitorId: own.id }, { monitorId: foreign.id }],
      }),
    ).rejects.toThrow(NotFoundError);

    // The rejected transaction must not have written anything.
    const list = await listStatusPageMonitors(db, intruder.organizationId);
    expect(list).toEqual([]);
  });

  it("replaces the previous set and preserves the given order", async () => {
    const actor = await createTestOrg();
    const m1 = await createMonitor(db, actor, monitorInput({ name: "API" }));
    const m2 = await createMonitor(db, actor, monitorInput({ name: "Web" }));
    const m3 = await createMonitor(db, actor, monitorInput({ name: "CDN" }));

    await setStatusPageMonitors(db, actor, {
      monitors: [{ monitorId: m1.id }, { monitorId: m2.id }],
    });
    const initial = await listStatusPageMonitors(db, actor.organizationId);
    expect(initial.map((c) => c.monitorId)).toEqual([m1.id, m2.id]);

    await setStatusPageMonitors(db, actor, {
      monitors: [{ monitorId: m3.id }, { monitorId: m1.id }],
    });
    const replaced = await listStatusPageMonitors(db, actor.organizationId);
    expect(replaced.map((c) => c.monitorId)).toEqual([m3.id, m1.id]);
    expect(replaced.map((c) => c.internalName)).toEqual(["CDN", "API"]);
  });

  it("round-trips displayName and leaves it null when omitted", async () => {
    const actor = await createTestOrg();
    const m1 = await createMonitor(
      db,
      actor,
      monitorInput({ name: "internal-api" }),
    );
    const m2 = await createMonitor(
      db,
      actor,
      monitorInput({ name: "internal-web" }),
    );

    await setStatusPageMonitors(db, actor, {
      monitors: [
        { monitorId: m1.id, displayName: "Public API" },
        { monitorId: m2.id },
      ],
    });

    const list = await listStatusPageMonitors(db, actor.organizationId);
    expect(list).toEqual([
      {
        monitorId: m1.id,
        internalName: "internal-api",
        displayName: "Public API",
      },
      { monitorId: m2.id, internalName: "internal-web", displayName: null },
    ]);
  });
});

describe("getPublicStatusPage", () => {
  it("returns null for an unknown slug", async () => {
    const page = await getPublicStatusPage(db, `missing-${randomUUID()}`);
    expect(page).toBeNull();
  });

  it("returns null while the page is unpublished", async () => {
    const actor = await createTestOrg();
    const page = await getOrCreateStatusPage(db, actor.organizationId);
    expect(page.published).toBe(false);

    await expect(getPublicStatusPage(db, page.slug)).resolves.toBeNull();
  });

  it("shows components with displayName falling back to the monitor name", async () => {
    const actor = await createTestOrg();
    const api = await upMonitor(actor, "internal-api");
    const web = await upMonitor(actor, "Website");

    await setStatusPageMonitors(db, actor, {
      monitors: [
        { monitorId: api.id, displayName: "Public API" },
        { monitorId: web.id },
      ],
    });
    const slug = await publishPage(actor, "Acme Status");

    const page = await getPublicStatusPage(db, slug);
    expect(page).not.toBeNull();
    expect(page?.name).toBe("Acme Status");
    expect(page?.components.map((c) => c.name)).toEqual([
      "Public API",
      "Website",
    ]);
    expect(page?.components.map((c) => c.status)).toEqual(["up", "up"]);
    expect(page?.overall).toBe("operational");
    expect(page?.activeIncidents).toEqual([]);
  });

  it("reports an outage when a component monitor is down", async () => {
    const actor = await createTestOrg();
    const healthy = await upMonitor(actor, "Web");
    const failing = await createMonitor(
      db,
      actor,
      monitorInput({ name: "API", failureThreshold: 1 }),
    );
    const { monitor: down } = await recordCheckOutcome(
      db,
      failing,
      failOutcome(),
    );
    expect(down.currentStatus).toBe("down");

    await setStatusPageMonitors(db, actor, {
      monitors: [{ monitorId: healthy.id }, { monitorId: failing.id }],
    });
    const slug = await publishPage(actor);

    const page = await getPublicStatusPage(db, slug);
    expect(page?.components.map((c) => c.status)).toEqual(["up", "down"]);
    expect(page?.overall).toBe("outage");
  });

  it("includes active incidents with their timeline events", async () => {
    const actor = await createTestOrg();
    const monitor = await upMonitor(actor, "API");
    await setStatusPageMonitors(db, actor, {
      monitors: [{ monitorId: monitor.id }],
    });
    const incident = await createIncident(db, actor, {
      title: "Elevated error rates",
      severity: "major",
      message: "We are investigating elevated error rates.",
    });
    const slug = await publishPage(actor);

    const page = await getPublicStatusPage(db, slug);
    expect(page?.activeIncidents).toHaveLength(1);
    expect(page?.activeIncidents[0]).toMatchObject({
      id: incident.id,
      title: "Elevated error rates",
      status: "investigating",
      severity: "major",
      resolvedAt: null,
    });
    expect(page?.activeIncidents[0]?.events).toEqual([
      expect.objectContaining({
        type: "created",
        status: "investigating",
        message: "We are investigating elevated error rates.",
      }),
    ]);
    // An active incident degrades the page even with all components up.
    expect(page?.overall).toBe("degraded");
  });

  it("hides system events from the public timeline", async () => {
    const actor = await createTestOrg();
    const monitor = await upMonitor(actor, "API");
    await setStatusPageMonitors(db, actor, {
      monitors: [{ monitorId: monitor.id }],
    });
    const incident = await createIncident(db, actor, {
      title: "API is down",
      severity: "critical",
      message: "We are investigating.",
    });
    // `system` events are operator-only mechanics and must never reach
    // the public page.
    await db.insert(incidentEvents).values({
      incidentId: incident.id,
      type: "system",
      message: "Internal automation gave up — waiting for a human.",
    });
    const slug = await publishPage(actor);

    const page = await getPublicStatusPage(db, slug);
    const events = page?.activeIncidents[0]?.events ?? [];
    expect(events.every((event) => event.type !== "system")).toBe(true);
    expect(events.some((event) => /automation/i.test(event.message))).toBe(
      false,
    );
    // The customer-facing lifecycle event is still shown.
    expect(events.some((event) => event.type === "created")).toBe(true);
  });

  it("shows paused monitors as unknown", async () => {
    const actor = await createTestOrg();
    const monitor = await upMonitor(actor, "API");
    await setStatusPageMonitors(db, actor, {
      monitors: [{ monitorId: monitor.id }],
    });
    await setMonitorPaused(db, actor, monitor.id, true);
    const slug = await publishPage(actor);

    const page = await getPublicStatusPage(db, slug);
    expect(page?.components).toHaveLength(1);
    expect(page?.components[0]?.status).toBe("unknown");
    expect(page?.overall).toBe("operational");
  });
});

describe("internal notes", () => {
  it("hides internal notes from the public status page", async () => {
    const actor = await createTestOrg();
    const monitor = await upMonitor(actor, "API");
    await setStatusPageMonitors(db, actor, {
      monitors: [{ monitorId: monitor.id }],
    });
    const incident = await createIncident(db, actor, {
      title: "Incident",
      severity: "major",
      message: "Public: investigating.",
    });
    await postIncidentUpdate(db, actor, incident.id, "Public update", false);
    await postIncidentUpdate(
      db,
      actor,
      incident.id,
      "Internal: paged the DBA",
      true,
    );
    const slug = await publishPage(actor);

    const page = await getPublicStatusPage(db, slug);
    const messages = (page?.activeIncidents[0]?.events ?? []).map(
      (event) => event.message,
    );
    expect(messages).toContain("Public update");
    expect(messages).not.toContain("Internal: paged the DBA");
  });
});
