import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { incidentEvents, incidents, monitors, user } from "@/db/schema";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit";
import type { Monitor } from "@/modules/monitors/service";
import { describeFailureWindow } from "@/modules/notifications/email-templates";

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

/**
 * Acknowledges an active incident. Idempotent — the first ack wins and
 * records who/when; later calls return the existing ack. Acknowledgement
 * halts escalation (the escalation worker checks `acknowledgedAt`).
 */
export async function acknowledgeIncident(
  db: DbClient,
  actor: Actor,
  incidentId: string,
): Promise<Incident> {
  return db.transaction(async (tx) => {
    const incident = await findIncidentOrThrow(
      tx,
      actor.organizationId,
      incidentId,
    );
    if (incident.status === "resolved") {
      throw new ConflictError("This incident is already resolved.");
    }
    if (incident.acknowledgedAt) return incident;

    // Claim the acknowledgement, don't just assert it. Two operators
    // hitting Ack at once both read `acknowledgedAt` null, and an update
    // by id alone lets both write — producing two "acknowledged" timeline
    // entries and two audit rows for one act, with the second operator
    // recorded as the acker.
    const [updated] = await tx
      .update(incidents)
      .set({ acknowledgedAt: new Date(), acknowledgedBy: actor.userId })
      .where(
        and(eq(incidents.id, incidentId), isNull(incidents.acknowledgedAt)),
      )
      .returning();
    // Lost the race — the incident is acknowledged, which is what the
    // caller wanted. Return the winner's row rather than raising: an ack
    // is idempotent by intent.
    if (!updated) {
      return findIncidentOrThrow(tx, actor.organizationId, incidentId);
    }

    await tx.insert(incidentEvents).values({
      incidentId,
      type: "system",
      message: "Incident acknowledged, escalation stopped.",
      internal: true,
      createdBy: actor.userId,
    });
    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "incident.acknowledged",
      targetType: "incident",
      targetId: incidentId,
    });
    return updated;
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
          ? "Resolved incidents can't change status, open a new incident instead."
          : `Can't move from ${incident.status} to ${input.status}.`,
      );
    }

    // Compare-and-swap on the status we validated, not just on the id.
    //
    // `canTransition` ran against a row read earlier in this transaction,
    // and under READ COMMITTED another transaction can commit a
    // different status in between. Updating by id alone would let two
    // concurrent callers each pass a check against a state neither of
    // them ends up writing from — the classic outcome being one writing
    // `resolved` and the other then writing `identified` over it,
    // reopening an incident the public status page has already closed.
    //
    // Zero rows back means the row moved under us. That is a conflict,
    // not a missing incident: the caller decided against a state of the
    // world that no longer holds and has to look again.
    const [updated] = await tx
      .update(incidents)
      .set({
        status: input.status,
        resolvedAt: input.status === "resolved" ? new Date() : null,
      })
      .where(
        and(
          eq(incidents.id, incidentId),
          eq(incidents.status, incident.status),
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictError(
        "Someone else changed this incident while you were looking at it, reload and try again.",
      );
    }

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
        "This incident is resolved. The timeline is closed.",
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
 *
 * The idempotence is the database's, not this function's. Reading first
 * and inserting second is a check-then-act, and two workers — or one
 * worker whose job was delivered twice — can both read "none open" and
 * both insert, giving one outage two incidents and two escalation
 * chains. `incidents_one_active_per_monitor` makes the second insert
 * fail; this catches that failure and reports it as "already open",
 * which is what the caller means by idempotent.
 */
export async function openMonitorIncident(
  db: DbClient,
  monitor: Monitor,
  failureDescription: string,
): Promise<Incident | null> {
  try {
    return await db.transaction(async (tx) => {
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
        // The insert is the claim. Postgres rejects the loser, and the
        // whole transaction — timeline event and audit row included —
        // rolls back with it, so a losing worker leaves no trace of an
        // incident it did not open.
        .returning();
      if (!incident) throw new Error("insert returned no row");

      await tx.insert(incidentEvents).values({
        incidentId: incident.id,
        type: "created",
        status: incident.status,
        // Timeline events surface on the public status page — keep the
        // message generic. The raw error (which can embed the monitored
        // URL) stays internal: check history and audit metadata.
        message: `${monitor.name} had been failing ${describeFailureWindow(monitor.failureWindowSeconds)} and was marked down.`,
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
  } catch (error) {
    if (isUniqueViolation(error, "incidents_one_active_per_monitor")) {
      return null;
    }
    throw error;
  }
}

/**
 * Whether a driver error is Postgres rejecting a specific unique index.
 *
 * Named, not just code-checked: `23505` on any other constraint is a
 * real bug and must keep propagating. Swallowing every unique violation
 * here would turn, say, a duplicate primary key into a silent "already
 * open" and hide the actual fault.
 *
 * Walks the `cause` chain because Drizzle wraps driver errors in a
 * `DrizzleQueryError` carrying the SQL and params. Matching only the
 * outermost error silently never matches, which is the worst possible
 * failure for this function: the guard reads as present and does
 * nothing.
 */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let cursor = error, depth = 0; cursor && depth < 5; depth++) {
    if (
      typeof cursor === "object" &&
      (cursor as { code?: unknown }).code === "23505" &&
      (cursor as { constraint?: unknown }).constraint === constraint
    ) {
      return true;
    }
    cursor =
      typeof cursor === "object" && cursor !== null && "cause" in cursor
        ? (cursor as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

/**
 * Claims the exclusive right to send this incident's opened
 * notifications. Exactly one caller wins — the open path when alerts
 * aren't held, or recovery exhaustion / the escalation failsafe when
 * they are. Postgres arbitrates the race via the conditional update.
 */
export async function claimIncidentNotification(
  db: DbClient,
  incidentId: string,
): Promise<Incident | null> {
  const [claimed] = await db
    .update(incidents)
    .set({ notifiedAt: new Date() })
    .where(and(eq(incidents.id, incidentId), isNull(incidents.notifiedAt)))
    .returning();
  return claimed ?? null;
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
      // `status <> 'resolved'` is the whole guard. Two recovery paths
      // can observe the same monitor come back — the check worker and
      // the recovery verification probe — and without the predicate the
      // second one rewrites `resolvedAt` to a later time and appends a
      // second "recovered" line to a timeline the public page renders.
      // Resolved is terminal; the predicate is what makes that true
      // rather than merely intended.
      const [updated] = await tx
        .update(incidents)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(
          and(eq(incidents.id, incident.id), ne(incidents.status, "resolved")),
        )
        .returning();
      if (!updated) continue;

      await tx.insert(incidentEvents).values({
        incidentId: incident.id,
        type: "status_change",
        status: "resolved",
        message: `${monitor.name} recovered, incident auto-resolved.`,
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

/**
 * Append a machine-authored line to an incident's timeline.
 *
 * `type: "system"` is the marker the public status page filters on, so
 * anything written here stays internal — see `publicIncidents`. Writing
 * a timeline entry is an incident-module capability; it lived in the
 * recovery module only because recovery happened to be its first caller.
 */
export async function recordSystemEvent(
  db: DbClient,
  incidentId: string,
  message: string,
): Promise<void> {
  await db.insert(incidentEvents).values({
    incidentId,
    type: "system",
    message,
    createdBy: null,
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
