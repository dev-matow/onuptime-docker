import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth";
import { ledgerColumns } from "./ledger";

export const monitorMethod = pgEnum("monitor_method", ["GET", "HEAD"]);

/**
 * `unknown` = not determined — never checked yet, or the probe cannot
 * run in this environment; `degraded` = up but slower than the
 * configured threshold, or carrying a warning such as a nearly expired
 * certificate. `paused` is intentionally not a status — pausing is an
 * operator setting, not an observed state.
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
    /** HTTP(S) endpoint, or — for every other type — a host or domain. */
    url: text().notNull(),
    /**
     * Which check type evaluates this monitor. `text`, not an enum, and
     * that is load-bearing: Postgres refuses to use a newly added enum
     * value in the transaction that adds it, and Drizzle wraps every
     * migration in one — so an enum would make "ship a new check type"
     * a two-deploy operation forever. Validation moved to the registry,
     * which is a better place for it anyway: an unknown value now reads
     * as a misconfigured monitor instead of a failed column cast.
     */
    checkType: text().notNull().default("http"),
    /** Port for the types that take one (tcp, tls-expiry). */
    port: integer(),
    /**
     * Type-specific settings for every check type added since 1.10.0.
     * The older types keep the flat columns below. Dual storage is
     * deliberate debt: collapsing it rewrites every monitor row, which
     * is a breaking change and belongs to 2.0, not to an additive minor.
     */
    config: jsonb(),
    /**
     * Bumped whenever the rule changes. Observations record the version
     * they were judged under, so "why did this not alert in March?"
     * stays answerable after the rule is edited — today the old rule
     * simply ceases to exist and the question is unanswerable.
     */
    specVersion: integer().notNull().default(1),
    method: monitorMethod().notNull().default("GET"),
    /**
     * Also check the TLS certificate expiry (https monitors only) and
     * report degraded when fewer than `tlsWarnDays` remain. Off by
     * default. `tlsDaysRemaining` is the last observed value.
     */
    tlsCheck: boolean().notNull().default(false),
    tlsWarnDays: integer().notNull().default(14),
    tlsDaysRemaining: integer(),
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
    /**
     * @deprecated since 1.10.0 — superseded by `failureWindowSeconds`.
     * Kept so the migration stays additive and a downgrade still works;
     * removed in 2.0. Nothing reads it.
     */
    failureThreshold: integer().notNull().default(3),
    /**
     * How long a monitor must be failing before an incident opens.
     *
     * Counting consecutive failures only means anything when every
     * check is the same distance apart. Once intervals adapt, "three
     * failures" is somewhere between three seconds and half an hour,
     * and the operator has no way to know which. Time is the thing they
     * actually meant.
     */
    failureWindowSeconds: integer().notNull().default(120),
    /**
     * When the current run of failures began, or null when the monitor
     * is not failing. This is the observed state the status controller
     * derives from — it holds a fact, not a count of events, so the
     * controller stays safe to run at any time having missed anything.
     */
    firstFailureAt: timestamp({ withTimezone: true }),
    paused: boolean().notNull().default(false),
    currentStatus: monitorStatus().notNull().default("unknown"),
    consecutiveFailures: integer().notNull().default(0),
    lastCheckedAt: timestamp({ withTimezone: true }),
    /**
     * When this monitor is next due, as decided by `nextEvaluationAt`.
     *
     * The point of storing a timestamp rather than deriving one is that
     * the selection query stops encoding the policy. `WHERE
     * last_checked_at + interval <= now()` hardcodes "fixed intervals"
     * into the scheduler; swapping the policy then means rewriting the
     * scheduler instead of swapping a function.
     */
    nextEvaluationAt: timestamp({ withTimezone: true }),
    createdBy: text().references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index().on(t.organizationId),
    // The scheduler's only selection predicate. Partial, because paused
    // monitors are never due and there is no reason to index them.
    index("monitors_next_evaluation_idx")
      .on(t.nextEvaluationAt)
      .where(sql`${t.paused} = false`),
  ],
);

/**
 * The observation record: one row per check, append-only, written by
 * exactly one code path.
 *
 * Since 1.10.0 it carries the ledger columns — who observed, at what
 * logical time, chained to that actor's previous observation, under
 * which spec version. It is still pruned by the retention job, which
 * means it is not yet a ledger; making it one is the 2.0 work
 * (run-length encoding plus signed compaction records, so that
 * compaction supersedes a range instead of deleting it). The fields are
 * here now because adding them later means rewriting the largest table
 * in the product.
 *
 * KNOWN, AND DELIBERATELY NOT FIXED IN 1.10.0 — `ON DELETE CASCADE`
 * below breaks chain continuity in a way the retention prune does not.
 *
 * One worker actor interleaves observations about every monitor in
 * every organization, so its chain is ordered by sequence, not by
 * subject. The nightly prune deletes a *prefix* of that chain and
 * everything after the cut still verifies. Deleting a monitor through
 * the ordinary UI button deletes rows from the *middle*, and every
 * surviving row after the gap fails a `prev_hash` check — including
 * other tenants' observations that nobody touched.
 *
 * Deferred rather than fixed because nothing calls `verifyChain` yet:
 * it is a unit-tested function with no product surface, so the damage
 * today is to a property no code depends on. Both real fixes are
 * structural and belong with the rest of the ledger work — per-(actor,
 * subject) chains, or a signed tombstone record superseding the deleted
 * range, the same shape compaction will need. `ON DELETE SET NULL` is
 * not an alternative: `monitorId` is NOT NULL and carries an index.
 *
 * Whichever lands, it must land before anything ships that asks a
 * customer to trust a verification result.
 */
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
    /** up | degraded | down | indeterminate — the judged verdict. */
    verdict: text(),
    /** transport | assertion | misconfigured, or null when passing. */
    failureClass: text(),
    /**
     * Everything the probe measured. Judgment is a pure function of
     * these plus the spec, so a stored observation can be re-judged
     * against a different spec version without re-probing anything.
     */
    facts: jsonb(),
    ...ledgerColumns(),
  },
  (t) => [index().on(t.monitorId, t.checkedAt.desc())],
);
