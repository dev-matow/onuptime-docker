import { and, desc, eq, ne, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { incidentEvents, incidents, monitors, user } from "@/db/schema";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit";
import type { Monitor } from "@/modules/monitors/service";

import {
  canTransition,
  type IncidentSeverity,
  type IncidentStatus,
} from "./lifecycle";
import type { CreateIncidentInput } from "./schemas";

export type Incident = typeof incidents.$inferSelect;
export type IncidentEvent = typeof incidentEvents.$inferSelect;

interface Actor {
  organizationId: string;
  userId: string;
}

export interface IncidentListItem extends Incident {
  monitorName: string | null;
}

export async function listIncidents(
  db: DbClient,
  organizationId: string,
  options: { activeOnly?: boolean } = {},
): Promise<IncidentListItem[]> {
  const rows = await db
    .select({ incident: incidents, monitorName: monitors.name })
    .from(incidents)
    .leftJoin(monitors, eq(incidents.monitorId, monitors.id))
    .where(
      and(
        eq(incidents.organizationId, organizationId),
        options.activeOnly ? ne(incidents.status, "resolved") : undefined,
      ),
    )
    .orderBy(
      // Active incidents surface above resolved history.
      sql`case when ${incidents.status} = 'resolved' then 1 else 0 end`,
      desc(incidents.createdAt),
    );

  return rows.map(({ incident, monitorName }) => ({
    ...incident,
    monitorName,
  }));
}

export interface TimelineEvent extends IncidentEvent {
  authorName: string | null;
}

export interface IncidentDetail {
  incident: Incident;
  monitor: Pick<Monitor, "id" | "name" | "url"> | null;
  timeline: TimelineEvent[];
}

export async function getIncidentDetail(
  db: DbClient,
  organizationId: string,
  incidentId: string,
): Promise<IncidentDetail> {
  const incident = await findIncidentOrThrow(db, organizationId, incidentId);

  const monitor = incident.monitorId
    ? ((await db.query.monitors.findFirst({
        where: eq(monitors.id, incident.monitorId),
        columns: { id: true, name: true, url: true },
      })) ?? null)
    : null;

  const rows = await db
    .select({ event: incidentEvents, authorName: user.name })
    .from(incidentEvents)
    .leftJoin(user, eq(incidentEvents.createdBy, user.id))
    .where(eq(incidentEvents.incidentId, incidentId))
    .orderBy(desc(incidentEvents.createdAt));

  return {
    incident,
    monitor,
    timeline: rows.map(({ event, authorName }) => ({ ...event, authorName })),
  };
}

export async function createIncident(
  db: DbClient,
  actor: Actor,
  input: CreateIncidentInput,
): Promise<Incident> {
  return db.transaction(async (tx) => {
    const [incident] = await tx
      .insert(incidents)
      .values({
        organizationId: actor.organizationId,
        title: input.title,
        severity: input.severity,
        source: "manual",
        createdBy: actor.userId,
      })
      .returning();
    if (!incident) throw new Error("insert returned no row");

    await tx.insert(incidentEvents).values({
      incidentId: incident.id,
      type: "created",
      status: incident.status,
      message: input.message?.length
        ? input.message
        : `Incident opened: ${input.title}`,
      createdBy: actor.userId,
    });

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "incident.created",
      targetType: "incident",
      targetId: incident.id,
      metadata: { title: incident.title, severity: incident.severity },
    });
    return incident;
  });
}

export async function changeIncidentStatus(
  db: DbClient,
  actor: Actor,
  incidentId: string,
  input: { status: IncidentStatus; message: string },
): Promise<Incident> {
  return db.transaction(async (tx) => {
    const incident = await findIncidentOrThrow(
      tx,
      actor.organizationId,
      incidentId,
    );

    if (!canTransition(incident.status, input.status)) {
      throw new ConflictError(
        incident.status === "resolved"
          ? "Resolved incidents can't change status — open a new incident instead."
          : `Can't move from ${incident.status} to ${input.status}.`,
      );
    }

    const [updated] = await tx
      .update(incidents)
      .set({
        status: input.status,
        resolvedAt: input.status === "resolved" ? new Date() : null,
      })
      .where(eq(incidents.id, incidentId))
      .returning();
    if (!updated) throw new NotFoundError("Incident not found.");

    await tx.insert(incidentEvents).values({
      incidentId,
      type: "status_change",
      status: input.status,
      message: input.message,
      createdBy: actor.userId,
    });

    if (input.status === "resolved") {
      await writeAudit(tx, {
        organizationId: actor.organizationId,
        actorId: actor.userId,
        action: "incident.resolved",
        targetType: "incident",
        targetId: incidentId,
      });
    }
    return updated;
  });
}

export async function postIncidentUpdate(
  db: DbClient,
  actor: Actor,
  incidentId: string,
  message: string,
  internal = false,
): Promise<IncidentEvent> {
  return db.transaction(async (tx) => {
    const incident = await findIncidentOrThrow(
      tx,
      actor.organizationId,
      incidentId,
    );
    if (incident.status === "resolved") {
      throw new ConflictError(
        "This incident is resolved — the timeline is closed.",
      );
    }

    const [event] = await tx
      .insert(incidentEvents)
      .values({
        incidentId,
        type: "update",
        message,
        internal,
        createdBy: actor.userId,
      })
      .returning();
    if (!event) throw new Error("insert returned no row");
    return event;
  });
}

export async function changeIncidentSeverity(
  db: DbClient,
  actor: Actor,
  incidentId: string,
  severity: IncidentSeverity,
): Promise<Incident> {
  return db.transaction(async (tx) => {
    const incident = await findIncidentOrThrow(
      tx,
      actor.organizationId,
      incidentId,
    );
    if (incident.status === "resolved") {
      throw new ConflictError("Resolved incidents can't change severity.");
    }
    if (incident.severity === severity) return incident;

    const [updated] = await tx
      .update(incidents)
      .set({ severity })
      .where(eq(incidents.id, incidentId))
      .returning();
    if (!updated) throw new NotFoundError("Incident not found.");

    await tx.insert(incidentEvents).values({
      incidentId,
      type: "severity_change",
      message: `Severity changed from ${incident.severity} to ${severity}`,
      createdBy: actor.userId,
    });
    return updated;
  });
}

export async function savePostmortem(
  db: DbClient,
  actor: Actor,
  incidentId: string,
  content: string,
): Promise<Incident> {
  return db.transaction(async (tx) => {
    const incident = await findIncidentOrThrow(
      tx,
      actor.organizationId,
      incidentId,
    );
    if (incident.status !== "resolved") {
      throw new ConflictError(
        "Write the postmortem after the incident is resolved.",
      );
    }

    const [updated] = await tx
      .update(incidents)
      .set({ postmortem: content })
      .where(eq(incidents.id, incidentId))
      .returning();
    if (!updated) throw new NotFoundError("Incident not found.");

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "incident.postmortem_saved",
      targetType: "incident",
      targetId: incidentId,
    });
    return updated;
  });
}

/**
 * Called by the worker when a monitor crosses its failure threshold.
 * Idempotent: one open auto-incident per monitor at a time.
 */
export async function openMonitorIncident(
  db: DbClient,
  monitor: Monitor,
  failureDescription: string,
): Promise<Incident | null> {
  return db.transaction(async (tx) => {
    const existing = await tx.query.incidents.findFirst({
      where: and(
        eq(incidents.monitorId, monitor.id),
        eq(incidents.source, "monitor"),
        ne(incidents.status, "resolved"),
      ),
      columns: { id: true },
    });
    if (existing) return null;

    const [incident] = await tx
      .insert(incidents)
      .values({
        organizationId: monitor.organizationId,
        title: `${monitor.name} is down`,
        severity: "critical",
        source: "monitor",
        monitorId: monitor.id,
        createdBy: null,
      })
      .returning();
    if (!incident) throw new Error("insert returned no row");

    await tx.insert(incidentEvents).values({
      incidentId: incident.id,
      type: "created",
      status: incident.status,
      // Timeline events surface on the public status page — keep the
      // message generic. The raw error (which can embed the monitored
      // URL) stays internal: check history and audit metadata.
      message: `${monitor.name} failed ${monitor.failureThreshold} consecutive ${monitor.failureThreshold === 1 ? "check" : "checks"} and was marked down.`,
      createdBy: null,
    });

    await writeAudit(tx, {
      organizationId: monitor.organizationId,
      actorId: null,
      action: "incident.auto_opened",
      targetType: "incident",
      targetId: incident.id,
      metadata: {
        monitorId: monitor.id,
        monitorName: monitor.name,
        error: failureDescription,
      },
    });
    return incident;
  });
}

/** Auto-resolves open monitor incidents once the monitor recovers. */
export async function resolveMonitorIncidents(
  db: DbClient,
  monitor: Monitor,
): Promise<Incident[]> {
  return db.transaction(async (tx) => {
    const open = await tx.query.incidents.findMany({
      where: and(
        eq(incidents.monitorId, monitor.id),
        eq(incidents.source, "monitor"),
        ne(incidents.status, "resolved"),
      ),
    });
    if (open.length === 0) return [];

    const resolved: Incident[] = [];
    for (const incident of open) {
      const [updated] = await tx
        .update(incidents)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(eq(incidents.id, incident.id))
        .returning();
      if (!updated) continue;

      await tx.insert(incidentEvents).values({
        incidentId: incident.id,
        type: "status_change",
        status: "resolved",
        message: `${monitor.name} recovered — incident auto-resolved.`,
        createdBy: null,
      });

      await writeAudit(tx, {
        organizationId: monitor.organizationId,
        actorId: null,
        action: "incident.auto_resolved",
        targetType: "incident",
        targetId: incident.id,
        metadata: { monitorId: monitor.id },
      });
      resolved.push(updated);
    }
    return resolved;
  });
}

async function findIncidentOrThrow(
  db: DbClient,
  organizationId: string,
  incidentId: string,
): Promise<Incident> {
  const incident = await db.query.incidents.findFirst({
    where: and(
      eq(incidents.id, incidentId),
      eq(incidents.organizationId, organizationId),
    ),
  });
  if (!incident) throw new NotFoundError("Incident not found.");
  return incident;
}
