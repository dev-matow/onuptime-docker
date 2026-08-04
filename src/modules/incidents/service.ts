import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { incidentEvents, incidents, monitors, user } from "@/db/schema";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit";
import type { Monitor } from "@/modules/monitors/service";
import { describeMonitorTarget } from "@/modules/monitors/spec";
import { describeFailureWindow } from "@/modules/notifications/email-templates";
import type { WebhookMonitor } from "@/modules/notifications/incident-payload";
import {
  operatorIntent,
  recordDispatchIntent,
  resolvedIntent,
} from "@/modules/notifications/intents";

import {
  canTransition,
  type IncidentSeverity,
  type IncidentStatus,
} from "./lifecycle";
import type { CreateIncidentInput } from "./schemas";

export type Incident = typeof incidents.$inferSelect;
export type IncidentEvent = typeof incidentEvents.$inferSelect;

/**
 * The monitor an incident is about, read inside the caller's
 * transaction so the notification describes the monitor as it was when
 * the transition happened.
 *
 * Null for a manually reported incident, and also for one whose monitor
 * has since been deleted — `monitor_id` is ON DELETE SET NULL, and a
 * notification about a monitor that no longer exists names the incident
 * instead.
 */
async function monitorForIncident(
  tx: DbClient,
  incident: Pick<Incident, "monitorId">,
): Promise<Monitor | null> {
  if (!incident.monitorId) return null;
  const row = await tx.query.monitors.findFirst({
    where: eq(monitors.id, incident.monitorId),
  });
  return row ?? null;
}

/** The subset a notification payload may describe. */
function webhookMonitor(monitor: Monitor): WebhookMonitor {
  return {
    id: monitor.id,
    name: monitor.name,
    url: monitor.url,
    currentStatus: monitor.currentStatus,
    checkType: monitor.checkType,
  };
}

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
    // Ordered by id, not by `created_at`.
    //
    // `created_at` defaults to `now()`, which in Postgres is the
    // TRANSACTION START time, not the commit time. Two concurrent
    // writers therefore appear on the timeline in the order they began,
    // which can be the reverse of the order they committed - measured:
    // the event written by the transaction that committed second
    // carried the earlier timestamp. `uuidv7()` uses the wall clock at
    // insert, so the id is strictly the better ordering key and needs
    // no column change.
    .orderBy(desc(incidentEvents.id));

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

    // Committed with the incident, not after it. The action used to
    // return, revalidate the page and only then re-read the incident to
    // work out who to tell; a crash in that gap announced nothing and
    // left no record that an announcement was owed.
    await recordDispatchIntent(tx, {
      organizationId: actor.organizationId,
      causeKey: `incident:${incident.id}:incident.opened`,
      kind: "incident",
      incidentId: incident.id,
      payload: operatorIntent({ incident, event: "incident.opened" }),
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
        and(
          eq(incidents.id, incidentId),
          eq(incidents.organizationId, actor.organizationId),
          isNull(incidents.acknowledgedAt),
          // The status guard above ran against a row read earlier in
          // this transaction. Without it here too, a worker resolving
          // the incident in between let this acknowledge a CLOSED
          // incident and append to its timeline - the same lost update
          // the status compare-and-swap was written to stop, in a
          // function that never got one.
          ne(incidents.status, "resolved"),
        ),
      )
      .returning();
    // Zero rows has two causes now, and they are not the same answer.
    // Somebody else acknowledged first: that is what the caller wanted,
    // so return the winner's row - an ack is idempotent by intent. The
    // incident was RESOLVED between the guard above and this write:
    // that is a conflict, and returning quietly would tell the operator
    // their acknowledgement stuck when it did not.
    if (!updated) {
      const current = await findIncidentOrThrow(
        tx,
        actor.organizationId,
        incidentId,
      );
      if (current.status === "resolved") {
        throw new ConflictError("This incident is already resolved.");
      }
      return current;
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
        // The generation background work fences itself against. Bumped
        // by status transitions and by nothing else, so an
        // acknowledgement or a severity change cannot cancel a recovery
        // chain that is still legitimately in flight.
        statusRevision: sql`${incidents.statusRevision} + 1`,
      })
      .where(
        and(
          eq(incidents.id, incidentId),
          // Tenant-scoped in the statement that WRITES, not only in the
          // read above it. `findIncidentOrThrow` already proved
          // ownership, but this is the predicate that actually decides,
          // and one another tenant's row cannot satisfy is worth more
          // than an earlier check - the same rule the notification
          // module states three times.
          eq(incidents.organizationId, actor.organizationId),
          eq(incidents.status, incident.status),
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictError(
        "Someone else changed this incident while you were looking at it, reload and try again.",
      );
    }

    const [event] = await tx
      .insert(incidentEvents)
      .values({
        incidentId,
        type: "status_change",
        status: input.status,
        message: input.message,
        createdBy: actor.userId,
      })
      .returning();
    if (!event) throw new Error("insert returned no row");

    if (input.status === "resolved") {
      await writeAudit(tx, {
        organizationId: actor.organizationId,
        actorId: actor.userId,
        action: "incident.resolved",
        targetType: "incident",
        targetId: incidentId,
      });
    }

    const monitor = await monitorForIncident(tx, updated);
    const resolving = input.status === "resolved";
    const payload = operatorIntent({
      incident: updated,
      ...(monitor ? { monitor: webhookMonitor(monitor) } : {}),
      event: resolving ? "incident.resolved" : "incident.updated",
      // The id of the timeline entry THIS transaction just wrote, not
      // the newest one visible afterwards.
      //
      // The action used to compute this key by re-reading the timeline
      // after the commit, and under two concurrent updates both callers
      // read the same newest entry, built the same key, and the outbox's
      // unique index dropped one of them. Two operator updates during an
      // outage produced ONE broadcast - carrying the first one's text
      // under a key naming the second one's event. Reproduced on two
      // connections against the live schema before this line was
      // written.
      ...(resolving ? {} : { transitionKey: event.id }),
    });
    if (resolving && monitor && updated.notifiedAt) {
      // The all-clear for the people who were paged.
      //
      // Only the automatic resolve path sent this. An operator closing
      // an incident by hand told the channels and the status page and
      // left every responder who had been paged at 3am with no message
      // saying it was over. `notifiedAt` is the test for "somebody was
      // paged", exactly as it is on the automatic path - an incident
      // nobody was alerted about resolves quietly here too.
      payload.memberEmail = resolvedIntent({
        incident: updated,
        monitor: webhookMonitor(monitor),
        monitorTarget: describeMonitorTarget(monitor),
      }).memberEmail;
    }
    await recordDispatchIntent(tx, {
      organizationId: actor.organizationId,
      causeKey: resolving
        ? `incident:${incidentId}:incident.resolved`
        : `incident:${incidentId}:incident.updated:${event.id}`,
      kind: "incident",
      incidentId,
      payload,
    });
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
    // Locked: the guard below is only worth anything if the status it
    // reads cannot change before the insert. An INSERT has no column to
    // compare-and-swap on, so the lock is the guard.
    const incident = await findIncidentOrThrow(
      tx,
      actor.organizationId,
      incidentId,
      { forUpdate: true },
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

    // Internal notes are operator-only — they don't broadcast. The
    // decision is made here rather than in the action so that "this
    // note is private" and "nothing was queued about it" are the same
    // transaction.
    if (!internal) {
      const monitor = await monitorForIncident(tx, incident);
      await recordDispatchIntent(tx, {
        organizationId: actor.organizationId,
        causeKey: `incident:${incidentId}:incident.updated:${event.id}`,
        kind: "incident",
        incidentId,
        payload: operatorIntent({
          incident,
          ...(monitor ? { monitor: webhookMonitor(monitor) } : {}),
          event: "incident.updated",
          transitionKey: event.id,
        }),
      });
    }
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
      .where(
        and(
          eq(incidents.id, incidentId),
          eq(incidents.organizationId, actor.organizationId),
          // `where id` alone, directly below the comment on
          // `changeIncidentStatus` explaining exactly this hazard: an
          // operator raising the severity of an incident a worker
          // resolved a moment ago changed a closed incident and wrote a
          // `severity_change` line onto a timeline the public status
          // page renders.
          ne(incidents.status, "resolved"),
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictError(
        "This incident was resolved while you were looking at it, reload and try again.",
      );
    }

    const [event] = await tx
      .insert(incidentEvents)
      .values({
        incidentId,
        type: "severity_change",
        message: `Severity changed from ${incident.severity} to ${severity}`,
        createdBy: actor.userId,
      })
      .returning();
    if (!event) throw new Error("insert returned no row");

    const monitor = await monitorForIncident(tx, updated);
    await recordDispatchIntent(tx, {
      organizationId: actor.organizationId,
      causeKey: `incident:${incidentId}:incident.updated:${event.id}`,
      kind: "incident",
      incidentId,
      payload: operatorIntent({
        incident: updated,
        ...(monitor ? { monitor: webhookMonitor(monitor) } : {}),
        event: "incident.updated",
        transitionKey: event.id,
      }),
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
      .where(
        and(
          eq(incidents.id, incidentId),
          // The one statement in this file that wrote by id alone,
          // directly beneath three comments arguing that the predicate
          // which DECIDES has to carry the tenant. `findIncidentOrThrow`
          // above already proved ownership and nothing could reach this
          // without it, which is exactly the argument that was wrong
          // everywhere else it was made.
          eq(incidents.organizationId, actor.organizationId),
        ),
      )
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
      // Serialise on the monitor row, and re-read the status under it.
      //
      // The check that decided to open this incident committed a moment
      // ago in its own transaction; the decision to open is made out
      // here, afterwards. So a recovery check for the same monitor can
      // land in between, resolve the open incident and mark the monitor
      // up - and this insert would then open a BRAND NEW incident for a
      // monitor that is currently fine, page for it, and resolve it on
      // the next check. One page-resolve-page flap per race, and it was
      // reproducible.
      //
      // `resolveMonitorIncidents` takes the same lock, so the two
      // serialise and whichever is second sees the other's committed
      // status. Refusing on `up` is the whole guard: an incident is
      // never opened for a monitor the database currently says is fine.
      const [current] = await tx
        .select({ status: monitors.currentStatus })
        .from(monitors)
        .where(eq(monitors.id, monitor.id))
        .for("update");
      if (!current || current.status === "up") return null;

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
/**
 * The open automatic incident for a monitor when nobody has acted on it
 * yet, so a later check can finish what an interrupted one started.
 *
 * `openMonitorIncident` returns null once the row exists - that is its
 * contract, and it is correct. What was wrong is what the caller did
 * with it: every consequence of an incident (the page, the recovery
 * job, the escalation ladder) hung off "I was the transaction that
 * inserted the row". A worker that committed the insert and then died -
 * evicted pod, dropped connection, a throw between the two - left an
 * incident open with nobody notified, and every later check took the
 * null path and skipped the block. Nobody was ever paged, and nothing
 * anywhere repaired it.
 *
 * Two conditions, and both are needed. `notified_at is null` means the
 * page has not gone out. No system event means no handler has recorded
 * a decision about this incident either - which is how a HELD incident
 * (recovery is handling it, the page deliberately deferred) is told
 * apart from one nobody has looked at. Without the second condition a
 * held incident would be re-handled on every check and would schedule
 * its recovery job again each time.
 */
export async function findUnhandledAutoIncident(
  db: DbClient,
  monitorId: string,
): Promise<Incident | null> {
  const [row] = await db
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.monitorId, monitorId),
        eq(incidents.source, "monitor"),
        ne(incidents.status, "resolved"),
        isNull(incidents.notifiedAt),
        sql`not exists (
          select 1 from ${incidentEvents} e
          where e.incident_id = ${incidents.id} and e.type = 'system'
        )`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Claims the exclusive right to page for this incident, AND records what
 * that page owes, in one transaction.
 *
 * The claim is exactly-once by design: `notified_at is null` is the
 * predicate, and whoever's UPDATE matches it is the sender. That was
 * correct and it was also, on its own, the single worst crash window in
 * the product. The claim committed in its own statement and the
 * notifications were worked out afterwards — resolve routes, fetch
 * members, walk status pages, insert rows — so a worker that died in
 * that tail left an incident open, `notified_at` already spent, and
 * nobody notified. `findUnhandledAutoIncident` requires `notified_at is
 * null`, so the repair path could no longer see it either. Nobody was
 * ever paged for that outage, by anything, and no counter anywhere went
 * up. Reproduced against the live schema before this was changed.
 *
 * `onClaim` runs inside the claim's transaction and is where the caller
 * writes its dispatch intent. If it throws, the claim rolls back with it
 * and the next caller can win it — which is the behaviour that makes the
 * exactly-once claim safe to spend.
 */
export async function claimIncidentNotification(
  db: DbClient,
  incidentId: string,
  onClaim?: (tx: DbClient, incident: Incident) => Promise<void>,
): Promise<Incident | null> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(incidents)
      .set({ notifiedAt: new Date() })
      .where(and(eq(incidents.id, incidentId), isNull(incidents.notifiedAt)))
      .returning();
    if (!claimed) return null;
    if (onClaim) await onClaim(tx, claimed);
    return claimed;
  });
}

/** Auto-resolves open monitor incidents once the monitor recovers. */
export async function resolveMonitorIncidents(
  db: DbClient,
  monitor: Monitor,
): Promise<Incident[]> {
  return db.transaction(async (tx) => {
    // The same monitor-row lock `openMonitorIncident` takes, so a check
    // opening an incident and a check resolving one cannot interleave.
    // Without it the resolver's read could miss an insert that had not
    // committed yet, leaving a live incident on a monitor that is up.
    await tx
      .select({ id: monitors.id })
      .from(monitors)
      .where(eq(monitors.id, monitor.id))
      .for("update");

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
        .set({
          status: "resolved",
          resolvedAt: new Date(),
          statusRevision: sql`${incidents.statusRevision} + 1`,
        })
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

      // The all-clear commits with the resolution.
      //
      // It used to be sent afterwards, from the caller, in four more
      // transactions. A crash in that tail was unrecoverable in the
      // worst way available: every repair predicate in this module reads
      // `status <> 'resolved'`, so a resolved incident is invisible to
      // all of them. Subscribers who were told an outage had started
      // were never told it had ended, and nothing would ever notice.
      //
      // An incident nobody was alerted about resolves quietly — the
      // timeline and the recovery record still tell the whole story.
      if (updated.notifiedAt) {
        await recordDispatchIntent(tx, {
          organizationId: monitor.organizationId,
          causeKey: `incident:${updated.id}:incident.resolved`,
          kind: "incident",
          incidentId: updated.id,
          payload: resolvedIntent({
            incident: updated,
            monitor: webhookMonitor(monitor),
            monitorTarget: describeMonitorTarget(monitor),
          }),
        });
      }
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

/**
 * The one read every mutating path starts from.
 *
 * `forUpdate` takes a row lock, and the paths that write take it. The
 * pattern without it is read-check-write across two statements, and
 * under READ COMMITTED that is a lost update waiting for a busy
 * afternoon: an operator posts a public update at the same moment a
 * worker resolves the incident, the read says `investigating`, the
 * guard passes, and a customer-facing line lands on a timeline the
 * status page has already closed. `changeIncidentStatus` avoids that
 * with a compare-and-swap because it has a column to swap on; an INSERT
 * of a timeline event has nothing to compare, so it locks instead.
 */
async function findIncidentOrThrow(
  db: DbClient,
  organizationId: string,
  incidentId: string,
  options: { forUpdate?: boolean } = {},
): Promise<Incident> {
  const query = db
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.id, incidentId),
        eq(incidents.organizationId, organizationId),
      ),
    )
    .limit(1);
  const [incident] = await (options.forUpdate ? query.for("update") : query);
  if (!incident) throw new NotFoundError("Incident not found.");
  return incident;
}
