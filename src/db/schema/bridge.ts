import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth";
import { monitors } from "./monitors";

/**
 * The migration bridge: a standing, read-only connection to the system
 * an organisation is migrating away from, kept alive long enough to
 * prove the migration is safe.
 *
 * The one-time importers read an account once and forget the credential
 * before the response is rendered. A bridge is the other trade: the
 * credential is stored, sealed with the same secretbox the notification
 * channels use, so a worker can keep reading the source's incident
 * history for days and compare it against what Vigil observed over the
 * same period. Everything else about the importers' posture is kept:
 * the bridge only ever issues GET requests, it never writes to the
 * source system, and nothing it stores contains a value the source
 * treats as secret.
 *
 * One bridge per organisation per provider. A bridge is not a sync: it
 * imports through the same engine the one-time path uses, records what
 * mapped and what did not, and adds the two things a one-time import
 * cannot have - evidence, and a verdict.
 */
export const migrationBridges = pgTable(
  "migration_bridges",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The provider adapter id this bridge reads through. */
    provider: text().notNull(),
    /**
     * The source API token, sealed by the notification secretbox
     * (AES-256-GCM under a key derived from BETTER_AUTH_SECRET). Null
     * means disconnected: the ciphertext is deleted outright, the same
     * deletion model notification channels use. Nothing else anywhere
     * stores this credential, and no read path returns it.
     */
    credentialSealed: text(),
    lastPolledAt: timestamp({ withTimezone: true }),
    /** `ok`, `partial` or `failed` - the last evidence poll's outcome. */
    lastPollStatus: text(),
    /** Already redacted by the provider transport before it is thrown. */
    lastPollError: text(),
    consecutivePollFailures: integer().notNull().default(0),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("migration_bridges_org_provider_idx").on(
      t.organizationId,
      t.provider,
    ),
  ],
);

/**
 * One row per record the bridge saw in the source account: the mapping
 * table the cutover report is built from.
 *
 * `sourceId` is the source system's own id, stored verbatim - unlike
 * `monitors.import_source_id`, which is a one-way digest. The digest is
 * right for provenance, where the value is only ever compared for
 * equality; it is useless here, because the poller must hand the id
 * back to the source's incident API to ask about it. Better Stack ids
 * are opaque integers with no secret in them, which is what makes the
 * verbatim copy safe for this provider.
 */
export const bridgeMonitors = pgTable(
  "bridge_monitors",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    bridgeId: uuid()
      .notNull()
      .references(() => migrationBridges.id, { onDelete: "cascade" }),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The id in the source system. `heartbeat:` prefixed for heartbeats. */
    sourceId: text().notNull(),
    sourceName: text().notNull(),
    /** The provider's own type name, verbatim. */
    sourceType: text().notNull(),
    /**
     * The Vigil monitor this record became, when it became one. SET
     * NULL rather than cascade: deleting a monitor must not erase the
     * bridge's record that the source had one - the cutover report has
     * to be able to say "this was imported and then deleted here".
     */
    monitorId: uuid().references(() => monitors.id, { onDelete: "set null" }),
    /** The import report vocabulary: imported, transformed, skipped, unsupported. */
    outcome: text().notNull(),
    /** The report line, redaction-safe by construction of the model. */
    detail: text().notNull(),
    /**
     * Whether incident comparison applies to this pair. Stored at import
     * time, not inferred later: a heartbeat monitor is not comparable
     * because the operator's cron job reports to the source system, not
     * to Vigil, until they repoint it at cutover - so Vigil's silence is
     * a fact about the migration, not about the job.
     */
    compared: boolean().notNull().default(false),
    /**
     * The failure window the monitor was imported with, seconds. The
     * comparison judges a source outage's duration against THIS value,
     * never the monitor's current one: widening the window after the
     * import must not retroactively excuse a recorded miss, and the
     * value has to survive the monitor's own deletion for the report to
     * keep telling the truth about it.
     */
    failureWindowSeconds: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("bridge_monitors_source_idx").on(t.bridgeId, t.sourceId),
    index("bridge_monitors_monitor_idx").on(t.monitorId),
  ],
);

/**
 * One committed import run through the bridge, report and all.
 *
 * The one-time importers deliberately keep reports ephemeral; a bridge
 * cannot, because the cutover report has to cite what was migrated and
 * what was lost, and "the operator remembers the preview" is not
 * evidence. The entries are the same `ReportEntry` rows the wizard
 * renders, and they are safe to store for the same reason they are safe
 * to render: the model they are built from has no field that can hold a
 * secret.
 */
export const bridgeImports = pgTable(
  "bridge_imports",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    bridgeId: uuid()
      .notNull()
      .references(() => migrationBridges.id, { onDelete: "cascade" }),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** What the adapter said about the read. Never a credential. */
    facts: jsonb().$type<string[]>().notNull(),
    entries: jsonb().$type<unknown[]>().notNull(),
    totals: jsonb().$type<Record<string, number>>().notNull(),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("bridge_imports_bridge_idx").on(t.bridgeId, t.createdAt.desc()),
  ],
);

/**
 * One evidence poll: which window of the source's incident history was
 * asked for, and whether the answer arrived.
 *
 * Coverage is the union of the `ok` windows and nothing else. A failed
 * poll is a row too, because a gap the report cannot see is a gap the
 * verdict would silently vouch for - "unknown" has to be a thing this
 * table can prove, not a thing the poller forgot.
 */
export const bridgePolls = pgTable(
  "bridge_polls",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    bridgeId: uuid()
      .notNull()
      .references(() => migrationBridges.id, { onDelete: "cascade" }),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    windowFrom: timestamp({ withTimezone: true }).notNull(),
    windowTo: timestamp({ withTimezone: true }).notNull(),
    /** `ok`, `partial` or `failed`. Only `ok` windows count as coverage. */
    status: text().notNull(),
    /** Error summary; the transport redacts before it throws. */
    detail: text(),
    requestCount: integer().notNull().default(0),
    incidentsSeen: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("bridge_polls_bridge_idx").on(t.bridgeId, t.createdAt.desc())],
);

/**
 * An incident the source system reported, copied read-only.
 *
 * Selected fields only, never the raw payload: the response body a
 * source attaches to an incident is the customer's page content and has
 * no business in a second database. Upserted by `sourceIncidentId`, so
 * an incident that resolves after it was first seen updates in place;
 * `firstSeenAt`/`lastSeenAt` record the observation itself, which is
 * what lets the comparator treat a copy that stopped being refreshed as
 * unknown rather than as still open.
 */
export const bridgeSourceIncidents = pgTable(
  "bridge_source_incidents",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    bridgeId: uuid()
      .notNull()
      .references(() => migrationBridges.id, { onDelete: "cascade" }),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sourceIncidentId: text().notNull(),
    /** What the incident is about: `monitor`, `heartbeat`, or another resource. */
    resourceType: text(),
    /** The source's id for that resource, matching `bridge_monitors.sourceId`. */
    resourceId: text(),
    cause: text(),
    /** The source's own status word, verbatim. */
    status: text().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    acknowledgedAt: timestamp({ withTimezone: true }),
    resolvedAt: timestamp({ withTimezone: true }),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("bridge_source_incidents_source_idx").on(
      t.bridgeId,
      t.sourceIncidentId,
    ),
    index("bridge_source_incidents_resource_idx").on(t.bridgeId, t.resourceId),
  ],
);

/**
 * A cutover report, frozen at the moment it was generated.
 *
 * Immutable by convention: nothing updates these rows, and generating
 * again writes a new one. The verdict is `safe` or `not-safe` with the
 * reasons alongside, and `body` is the full structured comparison so
 * the page can re-render exactly what the operator was shown when they
 * decided - a verdict whose evidence can be regenerated differently is
 * not an audit record.
 */
export const bridgeCutoverReports = pgTable(
  "bridge_cutover_reports",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    bridgeId: uuid()
      .notNull()
      .references(() => migrationBridges.id, { onDelete: "cascade" }),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    verdict: text().notNull(),
    reasons: jsonb().$type<string[]>().notNull(),
    body: jsonb().notNull(),
    windowFrom: timestamp({ withTimezone: true }).notNull(),
    windowTo: timestamp({ withTimezone: true }).notNull(),
    generatedBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("bridge_cutover_reports_bridge_idx").on(
      t.bridgeId,
      t.createdAt.desc(),
    ),
  ],
);
