import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth";

export const monitorMethod = pgEnum("monitor_method", ["GET", "HEAD"]);

/**
 * `unknown` = never checked yet; `degraded` = up but slower than the
 * configured threshold. `paused` is intentionally not a status — pausing
 * is an operator setting, not an observed state.
 */
export const monitorStatus = pgEnum("monitor_status", [
  "up",
  "down",
  "degraded",
  "unknown",
]);

export const monitors = pgTable(
  "monitors",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** HTTP(S) endpoint to probe. */
    url: text().notNull(),
    method: monitorMethod().notNull().default("GET"),
    intervalSeconds: integer().notNull().default(60),
    timeoutMs: integer().notNull().default(10_000),
    /** Response slower than this is reported as degraded. */
    degradedThresholdMs: integer().notNull().default(3_000),
    /** Exact status code to expect; null accepts any 2xx/3xx. */
    expectedStatusCode: integer(),
    /**
     * Optional keyword/content assertion on the response body (GET only).
     * When set, the body must contain this string — or must NOT, when
     * `keywordAbsent` is true (e.g. catch a "Database error" page that
     * still returns HTTP 200).
     */
    bodyKeyword: text(),
    keywordAbsent: boolean().notNull().default(false),
    /** Consecutive failed checks before an incident is opened. */
    failureThreshold: integer().notNull().default(3),
    paused: boolean().notNull().default(false),
    currentStatus: monitorStatus().notNull().default("unknown"),
    consecutiveFailures: integer().notNull().default(0),
    lastCheckedAt: timestamp({ withTimezone: true }),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index().on(t.organizationId)],
);

/** Append-only check results; pruned by a retention job. */
export const monitorChecks = pgTable(
  "monitor_checks",
  {
    id: bigint({ mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    monitorId: uuid()
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    checkedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ok: boolean().notNull(),
    statusCode: integer(),
    responseTimeMs: integer(),
    error: text(),
  },
  (t) => [index().on(t.monitorId, t.checkedAt.desc())],
);
