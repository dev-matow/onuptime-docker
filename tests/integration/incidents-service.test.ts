import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditLogs, incidentEvents } from "@/db/schema";
import { ConflictError, NotFoundError } from "@/lib/errors";
import {
  acknowledgeIncident,
  changeIncidentSeverity,
  changeIncidentStatus,
  createIncident,
  getIncidentDetail,
  listIncidents,
  openMonitorIncident,
  postIncidentUpdate,
  resolveMonitorIncidents,
  savePostmortem,
} from "@/modules/incidents/service";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import { createMonitor, type Monitor } from "@/modules/monitors/service";

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
    checkType: "http" as const,
    tlsCheck: false,
    tlsWarnDays: 14,
    failureWindowSeconds: 120,
    ...overrides,
  };
}

async function createResolvedIncident(actor: TestActor) {
  const incident = await createIncident(db, actor, {
    title: "Resolved incident",
    severity: "major",
  });
  await changeIncidentStatus(db, actor, incident.id, {
    status: "resolved",
    message: "All clear.",
  });
  return incident;
}

describe("createIncident", () => {
  it("starts investigating, writes a created timeline event and an audit row", async () => {
    const actor = await createTestOrg();

    const incident = await createIncident(db, actor, {
      title: "Elevated error rates",
      severity: "major",
      message: "Seeing 5xx spikes on checkout.",
    });

    expect(incident).toMatchObject({
      organizationId: actor.organizationId,
      title: "Elevated error rates",
      severity: "major",
      status: "investigating",
      source: "manual",
      createdBy: actor.userId,
      resolvedAt: null,
    });

    const detail = await getIncidentDetail(
      db,
      actor.organizationId,
      incident.id,
    );
    expect(detail.timeline).toHaveLength(1);
    expect(detail.timeline[0]).toMatchObject({
      type: "created",
      status: "investigating",
      message: "Seeing 5xx spikes on checkout.",
      createdBy: actor.userId,
    });

    const audit = await db.query.auditLogs.findMany({
      where: and(
        eq(auditLogs.organizationId, actor.organizationId),
        eq(auditLogs.action, "incident.created"),
      ),
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: actor.userId,
      targetType: "incident",
      targetId: incident.id,
    });
  });
});

describe("changeIncidentStatus", () => {
  it("moves investigating -> identified and records a status_change event", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "API latency",
      severity: "minor",
    });

    const updated = await changeIncidentStatus(db, actor, incident.id, {
      status: "identified",
      message: "Root cause: connection pool exhaustion.",
    });
    expect(updated.status).toBe("identified");
    expect(updated.resolvedAt).toBeNull();

    const detail = await getIncidentDetail(
      db,
      actor.organizationId,
      incident.id,
    );
    const statusEvents = detail.timeline.filter(
      (e) => e.type === "status_change",
    );
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]).toMatchObject({
      status: "identified",
      message: "Root cause: connection pool exhaustion.",
    });
  });

  it("resolving sets resolvedAt and writes an incident.resolved audit row", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "API latency",
      severity: "minor",
    });

    const resolved = await changeIncidentStatus(db, actor, incident.id, {
      status: "resolved",
      message: "Deployed a fix.",
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).toBeInstanceOf(Date);

    const audit = await db.query.auditLogs.findMany({
      where: and(
        eq(auditLogs.organizationId, actor.organizationId),
        eq(auditLogs.action, "incident.resolved"),
      ),
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.targetId).toBe(incident.id);
  });

  it("rejects any transition out of resolved", async () => {
    const actor = await createTestOrg();
    const incident = await createResolvedIncident(actor);

    await expect(
      changeIncidentStatus(db, actor, incident.id, {
        status: "investigating",
        message: "It broke again.",
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("rejects a transition to the same status", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Same-status test",
      severity: "minor",
    });

    await expect(
      changeIncidentStatus(db, actor, incident.id, {
        status: "investigating",
        message: "Still investigating.",
      }),
    ).rejects.toThrow(ConflictError);
  });
});

describe("postIncidentUpdate", () => {
  it("adds an update event to the timeline", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Slow dashboards",
      severity: "minor",
    });

    const event = await postIncidentUpdate(
      db,
      actor,
      incident.id,
      "Mitigation in progress.",
    );
    expect(event).toMatchObject({
      incidentId: incident.id,
      type: "update",
      message: "Mitigation in progress.",
      createdBy: actor.userId,
    });

    const detail = await getIncidentDetail(
      db,
      actor.organizationId,
      incident.id,
    );
    expect(detail.timeline.filter((e) => e.type === "update")).toHaveLength(1);
  });

  it("rejects updates on a resolved incident", async () => {
    const actor = await createTestOrg();
    const incident = await createResolvedIncident(actor);

    await expect(
      postIncidentUpdate(db, actor, incident.id, "Too late."),
    ).rejects.toThrow(ConflictError);
  });
});

describe("acknowledgeIncident", () => {
  it("stamps the acknowledgement, writes an internal event and an audit row", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Paging storm",
      severity: "critical",
    });

    const acked = await acknowledgeIncident(db, actor, incident.id);
    expect(acked.acknowledgedAt).toBeInstanceOf(Date);
    expect(acked.acknowledgedBy).toBe(actor.userId);

    const events = await db.query.incidentEvents.findMany({
      where: and(
        eq(incidentEvents.incidentId, incident.id),
        eq(incidentEvents.type, "system"),
      ),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      message: "Incident acknowledged — escalation stopped.",
      internal: true,
    });

    const audit = await db.query.auditLogs.findMany({
      where: and(
        eq(auditLogs.organizationId, actor.organizationId),
        eq(auditLogs.action, "incident.acknowledged"),
      ),
    });
    expect(audit).toHaveLength(1);
  });

  it("is idempotent: a second acknowledgement adds no event", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Double ack",
      severity: "major",
    });

    const first = await acknowledgeIncident(db, actor, incident.id);
    const second = await acknowledgeIncident(db, actor, incident.id);
    expect(second.acknowledgedAt?.getTime()).toBe(
      first.acknowledgedAt?.getTime(),
    );

    const events = await db.query.incidentEvents.findMany({
      where: and(
        eq(incidentEvents.incidentId, incident.id),
        eq(incidentEvents.type, "system"),
      ),
    });
    expect(events).toHaveLength(1);
  });

  it("rejects acknowledging a resolved incident", async () => {
    const actor = await createTestOrg();
    const incident = await createResolvedIncident(actor);

    await expect(acknowledgeIncident(db, actor, incident.id)).rejects.toThrow(
      ConflictError,
    );
  });
});

describe("changeIncidentSeverity", () => {
  it("records a severity_change event when the severity actually changes", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Severity test",
      severity: "minor",
    });

    const updated = await changeIncidentSeverity(
      db,
      actor,
      incident.id,
      "critical",
    );
    expect(updated.severity).toBe("critical");

    const detail = await getIncidentDetail(
      db,
      actor.organizationId,
      incident.id,
    );
    const severityEvents = detail.timeline.filter(
      (e) => e.type === "severity_change",
    );
    expect(severityEvents).toHaveLength(1);
    expect(severityEvents[0]?.message).toBe(
      "Severity changed from minor to critical",
    );
  });

  it("is a no-op for the same severity: no event is written", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Severity no-op",
      severity: "major",
    });

    const result = await changeIncidentSeverity(
      db,
      actor,
      incident.id,
      "major",
    );
    expect(result.severity).toBe("major");

    const events = await db.query.incidentEvents.findMany({
      where: and(
        eq(incidentEvents.incidentId, incident.id),
        eq(incidentEvents.type, "severity_change"),
      ),
    });
    expect(events).toEqual([]);
  });

  it("rejects severity changes on a resolved incident", async () => {
    const actor = await createTestOrg();
    const incident = await createResolvedIncident(actor);

    await expect(
      changeIncidentSeverity(db, actor, incident.id, "critical"),
    ).rejects.toThrow(ConflictError);
    // Even a no-op severity is rejected once resolved — terminal is terminal.
    await expect(
      changeIncidentSeverity(db, actor, incident.id, incident.severity),
    ).rejects.toThrow(ConflictError);
  });
});

describe("savePostmortem", () => {
  it("rejects a postmortem while the incident is still active", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Postmortem too early",
      severity: "major",
    });

    await expect(
      savePostmortem(db, actor, incident.id, "# What happened"),
    ).rejects.toThrow(ConflictError);
  });

  it("persists the content once the incident is resolved", async () => {
    const actor = await createTestOrg();
    const incident = await createResolvedIncident(actor);

    const updated = await savePostmortem(
      db,
      actor,
      incident.id,
      "# What happened\n\nA config change removed the cache.",
    );
    expect(updated.postmortem).toBe(
      "# What happened\n\nA config change removed the cache.",
    );

    const detail = await getIncidentDetail(
      db,
      actor.organizationId,
      incident.id,
    );
    expect(detail.incident.postmortem).toBe(
      "# What happened\n\nA config change removed the cache.",
    );
  });
});

describe("monitor-driven incidents", () => {
  async function createOrgMonitor(): Promise<{
    actor: TestActor;
    monitor: Monitor;
  }> {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ name: "Payments API", failureWindowSeconds: 0 }),
    );
    return { actor, monitor };
  }

  const RAW_ERROR = "connect ECONNREFUSED 10.0.0.5:443";

  it("opens a critical monitor-source incident with a sanitized system event", async () => {
    const { actor, monitor } = await createOrgMonitor();

    const incident = await openMonitorIncident(db, monitor, RAW_ERROR);
    expect(incident).not.toBeNull();
    expect(incident).toMatchObject({
      organizationId: actor.organizationId,
      title: "Payments API is down",
      severity: "critical",
      source: "monitor",
      monitorId: monitor.id,
      status: "investigating",
      createdBy: null,
    });

    const detail = await getIncidentDetail(
      db,
      actor.organizationId,
      incident!.id,
    );
    expect(detail.timeline).toHaveLength(1);
    const event = detail.timeline[0]!;
    expect(event.type).toBe("created");
    expect(event.createdBy).toBeNull();
    expect(event.message).toBe(
      "Payments API had been failing from its first failed check and was marked down.",
    );
    expect(event.message).not.toContain(RAW_ERROR);
    expect(event.message).not.toContain(monitor.url);
  });

  it("is idempotent while an auto-incident is still open", async () => {
    const { monitor } = await createOrgMonitor();

    const first = await openMonitorIncident(db, monitor, RAW_ERROR);
    expect(first).not.toBeNull();

    const second = await openMonitorIncident(db, monitor, RAW_ERROR);
    expect(second).toBeNull();
  });

  it("resolveMonitorIncidents resolves the open incident with a system event", async () => {
    const { actor, monitor } = await createOrgMonitor();
    const incident = await openMonitorIncident(db, monitor, RAW_ERROR);

    const resolved = await resolveMonitorIncidents(db, monitor);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ id: incident!.id, status: "resolved" });
    expect(resolved[0]?.resolvedAt).toBeInstanceOf(Date);

    const detail = await getIncidentDetail(
      db,
      actor.organizationId,
      incident!.id,
    );
    const systemResolve = detail.timeline.find(
      (e) => e.type === "status_change",
    );
    expect(systemResolve).toMatchObject({
      status: "resolved",
      message: "Payments API recovered — incident auto-resolved.",
      createdBy: null,
    });
  });

  it("returns an empty list when there is nothing to resolve", async () => {
    const { monitor } = await createOrgMonitor();
    await expect(resolveMonitorIncidents(db, monitor)).resolves.toEqual([]);
  });

  it("opens a fresh incident after the previous one was resolved", async () => {
    const { monitor } = await createOrgMonitor();

    const first = await openMonitorIncident(db, monitor, RAW_ERROR);
    await resolveMonitorIncidents(db, monitor);

    const second = await openMonitorIncident(db, monitor, RAW_ERROR);
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);
  });
});

describe("listIncidents", () => {
  it("activeOnly excludes resolved incidents", async () => {
    const actor = await createTestOrg();
    const active = await createIncident(db, actor, {
      title: "Active one",
      severity: "minor",
    });
    const resolved = await createResolvedIncident(actor);

    const activeList = await listIncidents(db, actor.organizationId, {
      activeOnly: true,
    });
    expect(activeList.map((i) => i.id)).toEqual([active.id]);

    const fullList = await listIncidents(db, actor.organizationId);
    expect(fullList.map((i) => i.id)).toContain(resolved.id);
  });

  it("sorts active incidents before resolved ones regardless of age", async () => {
    const actor = await createTestOrg();
    const older = await createIncident(db, actor, {
      title: "Older but active",
      severity: "minor",
    });
    const newer = await createIncident(db, actor, {
      title: "Newer but resolved",
      severity: "minor",
    });
    await changeIncidentStatus(db, actor, newer.id, {
      status: "resolved",
      message: "Done.",
    });

    const list = await listIncidents(db, actor.organizationId);
    expect(list.map((i) => i.id)).toEqual([older.id, newer.id]);
  });
});

describe("getIncidentDetail", () => {
  it("rejects an incident id belonging to another org", async () => {
    const owner = await createTestOrg();
    const intruder = await createTestOrg();
    const incident = await createIncident(db, owner, {
      title: "Private incident",
      severity: "major",
    });

    await expect(
      getIncidentDetail(db, intruder.organizationId, incident.id),
    ).rejects.toThrow(NotFoundError);
  });
});
