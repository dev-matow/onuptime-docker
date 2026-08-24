import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  uniqueIndex,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth";
import { monitors } from "./monitors";

export const incidentStatus = pgEnum("incident_status", [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
]);

export const incidentSeverity = pgEnum("incident_severity", [
  "critical",
  "major",
  "minor",
]);

export const incidentSource = pgEnum("incident_source", ["manual", "monitor"]);

export const incidents = pgTable(
  "incidents",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    title: text().notNull(),
    status: incidentStatus().notNull().default("investigating"),
    severity: incidentSeverity().notNull().default("major"),
    source: incidentSource().notNull().default("manual"),
    /** Monitor that opened this incident, when source = monitor. */
    monitorId: uuid().references(() => monitors.id, { onDelete: "set null" }),
    /** Markdown; drafted by AI, edited by humans. */
    postmortem: text(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),
    /**
     * When opened-notifications went out. Null while a recovery action
     * holds alerts; whoever claims it (open path, recovery exhaustion,
     * or the escalation failsafe) sends exactly once.
     */
    notifiedAt: timestamp({ withTimezone: true }),
    /**
     * How many times this incident's STATUS has moved. The generation
     * token background work fences itself against.
     *
     * A recovery chain observes an incident, then probes a target for
     * up to the check's full timeout, then writes. An operator
     * resolving the incident inside that window used to change nothing:
     * the job came back and finalised its attempt, notified channels
     * about a recovery of an incident that was already closed, and
     * scheduled the next attempt against it. Re-reading the row is not
     * enough on its own either - "still not resolved" is true again if
     * the monitor flapped down a second time, and that is a DIFFERENT
     * outage than the one the job was scheduled for.
     *
     * So a job carries the revision it saw, and a write that finds a
     * different one stands down. Bumped by status transitions only -
     * not by acknowledgement, severity or the notification claim -
     * because those do not make an in-flight recovery wrong, and a
     * token that moves for unrelated reasons is a token that cancels
     * legitimate work.
     *
     * Zero on every row written before 0027, which is correct: nothing
     * scheduled before the upgrade carries a fence to compare it to.
     */
    statusRevision: integer().notNull().default(0),
    /**
     * True when this incident was opened by a monitor running in a
     * migration bridge's shadow mode. Written once at creation, from the
     * monitor row the opening transaction already holds locked, and
     * never updated: a shadow incident that outlives its monitor's
     * shadow period stays shadow, because what the flag records is the
     * condition under which it was opened, not the monitor's current
     * setting.
     *
     * The open path reads this column to skip the page and the incident
     * hooks, and the public status page reads it to exclude the row.
     * Maintenance release never needs to ask: a hold row exists only
     * for incidents the hooks were asked about, and the shadow branch
     * returns before asking them. Suppression keyed on a stored fact
     * cannot change meaning when a bridge row is deleted or a cutover
     * lands mid-flight.
     */
    shadow: boolean().notNull().default(false),
    /** Acknowledgement halts escalation. Set by the acking operator. */
    acknowledgedAt: timestamp({ withTimezone: true }),
    acknowledgedBy: text().references(() => user.id, { onDelete: "set null" }),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index().on(t.organizationId, t.createdAt.desc()),
    index().on(t.monitorId),
    /**
     * One active automatic incident per monitor, enforced by Postgres.
     *
     * `openMonitorIncident` used to guarantee this by reading first and
     * inserting second. Under READ COMMITTED — which is what every
     * transaction here runs at — two workers can both read "no open
     * incident" and both insert, and the monitor ends up with two live
     * incidents paging two sets of people about one outage. There is no
     * arrangement of application code that fixes a check-then-act race;
     * only the database can arbitrate it.
     *
     * `monitor_id is not null` is stated rather than left to the fact
     * that NULLs never collide in a unique index. The intent is real: an
     * incident orphaned by `ON DELETE SET NULL` when its monitor was
     * deleted must not block a later monitor from opening one, and
     * saying so is cheaper than making the next reader derive it.
     */
    uniqueIndex("incidents_one_active_per_monitor")
      .on(t.monitorId)
      .where(
        sql`${t.source} = 'monitor' and ${t.status} <> 'resolved' and ${t.monitorId} is not null`,
      ),
  ],
);

export const incidentEventType = pgEnum("incident_event_type", [
  "created",
  "status_change",
  "severity_change",
  "update",
  "system",
]);

/** Immutable timeline of everything that happened during an incident. */
export const incidentEvents = pgTable(
  "incident_events",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    incidentId: uuid()
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    type: incidentEventType().notNull(),
    /** New status when type = status_change. */
    status: incidentStatus(),
    message: text().notNull(),
    /**
     * Operator-only note: kept off the public status page. `system`
     * recovery events are also withheld publicly, but those stay
     * visible to operators; an internal note is hidden from public
     * eyes by intent.
     */
    internal: boolean().notNull().default(false),
    /** Null for events emitted by the system (worker, auto-resolve). */
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.incidentId, t.createdAt)],
);
