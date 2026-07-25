import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgEnum,
  pgTable,
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
    /** Markdown postmortem, written by the team after the fact. */
    postmortem: text(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),
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
     * events are withheld publicly too, but those stay visible to
     * operators; an internal note is hidden from public eyes by intent.
     */
    internal: boolean().notNull().default(false),
    /** Null for events emitted by the system (worker, auto-resolve). */
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.incidentId, t.createdAt)],
);
