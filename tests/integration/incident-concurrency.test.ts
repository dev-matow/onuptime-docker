import { randomUUID } from "node:crypto";

import { and, eq, ne } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditLogs, incidentEvents, incidents } from "@/db/schema";
import { ConflictError } from "@/lib/errors";
import {
  acknowledgeIncident,
  changeIncidentStatus,
  createIncident,
  openMonitorIncident,
  resolveMonitorIncidents,
} from "@/modules/incidents/service";
import { createMonitor } from "@/modules/monitors/service";

import { createTestOrg, db, type TestActor } from "../helpers";

/**
 * Incident invariants under real concurrency.
 *
 * Every case here fails against the pre-1.13.0 code. They run genuinely
 * concurrent statements against the same Postgres — `Promise.all` over
 * separate service calls, each opening its own transaction — because a
 * sequential test cannot observe a lost update, and a mocked one cannot
 * observe what READ COMMITTED actually permits.
 */

async function monitorFor(actor: TestActor, name = "Checkout") {
  return createMonitor(db, actor, {
    name: `${name} ${randomUUID().slice(0, 8)}`,
    url: "https://concurrency.example.com/health",
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 10_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    checkType: "http",
    tlsCheck: false,
    tlsWarnDays: 14,
    failureWindowSeconds: 120,
    config: null,
  });
}

describe("one active automatic incident per monitor", () => {
  it("survives two workers opening at the same instant", async () => {
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);

    const results = await Promise.all([
      openMonitorIncident(db, monitor, "connection refused"),
      openMonitorIncident(db, monitor, "connection refused"),
      openMonitorIncident(db, monitor, "connection refused"),
    ]);

    const opened = results.filter((r) => r !== null);
    expect(opened).toHaveLength(1);

    const live = await db.query.incidents.findMany({
      where: and(
        eq(incidents.monitorId, monitor.id),
        ne(incidents.status, "resolved"),
      ),
    });
    expect(live).toHaveLength(1);
  });

  it("leaves no timeline or audit trace from the losing worker", async () => {
    // The loser's whole transaction rolls back, so it must not have
    // written a "created" event or an audit row for an incident it never
    // opened. Without that, an operator reading the audit log sees two
    // incidents opening for one outage.
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);

    await Promise.all([
      openMonitorIncident(db, monitor, "boom"),
      openMonitorIncident(db, monitor, "boom"),
    ]);

    const created = await db
      .select({ id: incidentEvents.id })
      .from(incidentEvents)
      .innerJoin(incidents, eq(incidentEvents.incidentId, incidents.id))
      .where(
        and(
          eq(incidents.monitorId, monitor.id),
          eq(incidentEvents.type, "created"),
        ),
      );
    expect(created).toHaveLength(1);

    const audited = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, actor.organizationId),
          eq(auditLogs.action, "incident.auto_opened"),
        ),
      );
    expect(audited).toHaveLength(1);
  });

  it("lets a monitor open a new incident once the old one is resolved", async () => {
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);

    const first = await openMonitorIncident(db, monitor, "down");
    expect(first).not.toBeNull();
    await resolveMonitorIncidents(db, monitor);

    const second = await openMonitorIncident(db, monitor, "down again");
    expect(second).not.toBeNull();
    expect(second?.id).not.toBe(first?.id);
  });

  it("is enforced by the database, not only by the service", async () => {
    // A direct insert bypassing every service guard must still be
    // refused. This is the constraint proof: if this test passes because
    // the service is careful, the invariant is not actually enforced.
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);
    await openMonitorIncident(db, monitor, "down");

    // Drizzle wraps driver errors, so the constraint name is on the
    // cause, not the thrown error.
    const rejection = await db
      .insert(incidents)
      .values({
        organizationId: actor.organizationId,
        title: "Smuggled duplicate",
        source: "monitor",
        monitorId: monitor.id,
        createdBy: null,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejection).not.toBeNull();
    const cause = (
      rejection as { cause?: { code?: string; constraint?: string } }
    ).cause;
    expect(cause?.code).toBe("23505");
    expect(cause?.constraint).toBe("incidents_one_active_per_monitor");
  });

  it("does not constrain manual incidents on the same monitor", async () => {
    // The invariant is about automatic incidents. An operator must stay
    // able to raise a manual incident against a monitor that already has
    // one open — they are describing something the prober cannot see.
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);
    await openMonitorIncident(db, monitor, "down");

    // Inserted directly with the monitor attached: `createIncident`
    // never links one, so going through it would prove nothing about the
    // partial index — the row would have a NULL monitor_id and fall
    // outside the invariant for the wrong reason.
    const [manual] = await db
      .insert(incidents)
      .values({
        organizationId: actor.organizationId,
        title: "Customer-reported checkout failure",
        severity: "major",
        source: "manual",
        monitorId: monitor.id,
        createdBy: actor.userId,
      })
      .returning();
    expect(manual?.source).toBe("manual");
    expect(manual?.monitorId).toBe(monitor.id);
    expect(manual?.status).not.toBe("resolved");
  });
});

describe("incident status transitions under concurrency", () => {
  it("does not let a late transition reopen a resolved incident", async () => {
    // The lost update this replaced: both callers read `investigating`,
    // one commits `resolved`, the other then commits `identified` over
    // it — reopening an incident the public status page had closed.
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Payments degraded",
      severity: "major",
      message: "Investigating.",
    });

    const outcomes = await Promise.allSettled([
      changeIncidentStatus(db, actor, incident.id, {
        status: "resolved",
        message: "Fixed.",
      }),
      changeIncidentStatus(db, actor, incident.id, {
        status: "identified",
        message: "Found it.",
      }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictError,
    );

    const [final] = await db
      .select()
      .from(incidents)
      .where(eq(incidents.id, incident.id));
    // Whichever won, the incident is in exactly one coherent state — and
    // if `resolved` won it stayed resolved.
    expect(["resolved", "identified"]).toContain(final?.status);
    if (final?.status === "resolved") expect(final.resolvedAt).not.toBeNull();
  });

  it("keeps resolved terminal against a sequential late writer", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Search outage",
      severity: "minor",
      message: "Investigating.",
    });
    await changeIncidentStatus(db, actor, incident.id, {
      status: "resolved",
      message: "Done.",
    });

    await expect(
      changeIncidentStatus(db, actor, incident.id, {
        status: "monitoring",
        message: "Actually still bad.",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("writes exactly one timeline event per winning transition", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Queue backlog",
      severity: "minor",
      message: "Investigating.",
    });

    await Promise.allSettled([
      changeIncidentStatus(db, actor, incident.id, {
        status: "identified",
        message: "A.",
      }),
      changeIncidentStatus(db, actor, incident.id, {
        status: "monitoring",
        message: "B.",
      }),
    ]);

    const changes = await db
      .select({ id: incidentEvents.id })
      .from(incidentEvents)
      .where(
        and(
          eq(incidentEvents.incidentId, incident.id),
          eq(incidentEvents.type, "status_change"),
        ),
      );
    expect(changes).toHaveLength(1);
  });
});

describe("acknowledgement is idempotent under concurrency", () => {
  it("records one acknowledgement when two operators race", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Paging storm",
      severity: "critical",
      message: "Investigating.",
    });

    const both = await Promise.all([
      acknowledgeIncident(db, actor, incident.id),
      acknowledgeIncident(db, actor, incident.id),
    ]);
    // Both callers get an acknowledged incident back — that is what they
    // asked for — but only one act was recorded.
    expect(both.every((i) => i.acknowledgedAt !== null)).toBe(true);

    const events = await db
      .select({ id: incidentEvents.id })
      .from(incidentEvents)
      .where(
        and(
          eq(incidentEvents.incidentId, incident.id),
          eq(incidentEvents.type, "system"),
        ),
      );
    expect(events).toHaveLength(1);

    const audited = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, actor.organizationId),
          eq(auditLogs.action, "incident.acknowledged"),
        ),
      );
    expect(audited).toHaveLength(1);
  });
});

describe("auto-resolution does not double-resolve", () => {
  it("resolves once when two recovery paths observe the same recovery", async () => {
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);
    await openMonitorIncident(db, monitor, "down");

    const [a, b] = await Promise.all([
      resolveMonitorIncidents(db, monitor),
      resolveMonitorIncidents(db, monitor),
    ]);
    expect((a?.length ?? 0) + (b?.length ?? 0)).toBe(1);

    const resolvedEvents = await db
      .select({ id: incidentEvents.id })
      .from(incidentEvents)
      .innerJoin(incidents, eq(incidentEvents.incidentId, incidents.id))
      .where(
        and(
          eq(incidents.monitorId, monitor.id),
          eq(incidentEvents.status, "resolved"),
        ),
      );
    expect(resolvedEvents).toHaveLength(1);

    const audited = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, actor.organizationId),
          eq(auditLogs.action, "incident.auto_resolved"),
        ),
      );
    expect(audited).toHaveLength(1);
  });
});
