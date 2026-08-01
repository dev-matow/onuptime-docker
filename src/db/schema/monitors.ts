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
  uniqueIndex,
  uuid,
  type AnyPgColumn,
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
    /**
     * The group this monitor belongs to, or null.
     *
     * Membership is stored on the member, not on the group, and the
     * direction is the whole design. A group holding a list of ids has
     * to be maintained by application code and is wrong the moment a
     * member is deleted; this way Postgres maintains it.
     *
     * `ON DELETE SET NULL`, never CASCADE. A self-referencing cascade
     * would make "delete this group" mean "delete every monitor in it",
     * recursively — the single most destructive misclick the product
     * could offer, and one whose blast radius is invisible from the
     * confirmation dialog. Deleting a group releases its members.
     */
    parentId: uuid().references((): AnyPgColumn => monitors.id, {
      onDelete: "set null",
    }),
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
    /**
     * Whether this monitor is probed by the high-frequency plane instead
     * of by the pg-boss queue. See `modules/monitors/highfreq/`.
     *
     * A separate flag rather than "interval_seconds below 2" because the
     * two planes are not the same mechanism with different numbers. One
     * enqueues a job per probe and survives a worker restart with the
     * queue intact; the other holds a shard lease, keeps its slots in
     * process memory and loses them on exit. An operator has to be able
     * to see which one they are on, and a validation constant would not
     * tell them.
     */
    highFrequency: boolean().notNull().default(false),
    /**
     * The cadence the high-frequency plane is asked for, in
     * milliseconds. Null when the monitor is not on that plane.
     *
     * Milliseconds and a second column, because `interval_seconds` is an
     * integer that half the product reads as a coverage horizon, a
     * heartbeat deadline and a group's cadence. Widening it to a
     * fractional second would change what all of those mean; this one is
     * read by the high-frequency scheduler and by nothing else.
     */
    highFrequencyIntervalMs: integer(),
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
    // Read on every observation a member records, to find the group
    // that has to be re-derived from it.
    index("monitors_parent_idx").on(t.parentId),
    // One token, one monitor — stated to Postgres rather than checked in
    // application code, because `/api/push/<token>` resolves a caller to
    // a monitor by this value and "the token matched two monitors" is
    // not a situation that endpoint can be written to survive. Partial
    // on the type so it costs nothing for the other sixteen, and an
    // expression index so the token stays in the config blob where
    // every other type's settings live.
    uniqueIndex("monitors_push_token_idx")
      .on(sql`(${t.config} ->> 'token')`)
      .where(sql`${t.checkType} = 'push'`),
    // The high-frequency plane reloads its whole monitor set every few
    // seconds, so the one predicate it runs must not be a sequential
    // scan of every monitor in the installation. Partial, because the
    // enabled set is a small minority by design.
    index("monitors_high_frequency_idx")
      .on(t.organizationId)
      .where(sql`${t.highFrequency} = true and ${t.paused} = false`),
  ],
);

/**
 * The last heartbeat a passive monitor received.
 *
 * One row per monitor, upserted by `/api/push/<token>`, and that is the
 * entire write the endpoint performs. It deliberately does *not* record
 * an observation: the endpoint is unauthenticated by construction —
 * anything holding the token may call it — and an unauthenticated
 * request that opens incidents, sends email and writes to the ledger is
 * an amplifier pointed at your own operators. The observation is made
 * by the scheduled evaluation instead, which reads this row, judges the
 * silence, and is subject to every rate the scheduler already governs.
 *
 * The cost is that a recovery is noticed on the next evaluation rather
 * than the instant the beat lands, which is exactly how every active
 * monitor behaves, and is the truth anyway: a job that reports in every
 * five minutes cannot be known to be healthy any sooner than that.
 *
 * `ON DELETE CASCADE` is right here, unlike on `monitor_checks`: this
 * is current state, not history, and a deleted monitor's last heartbeat
 * is not evidence of anything.
 */
export const monitorHeartbeats = pgTable("monitor_heartbeats", {
  monitorId: uuid()
    .primaryKey()
    .references(() => monitors.id, { onDelete: "cascade" }),
  receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /**
   * What the caller said about itself: `up`, or `down` for a job that
   * ran and failed. Text rather than an enum for the same reason
   * `check_type` is — a value a later version adds must be data, not a
   * failed column cast.
   */
  reportedStatus: text().notNull().default("up"),
  /** Optional message from the caller, shown on the timeline. */
  message: text(),
  /** How long the caller says its own work took. */
  responseTimeMs: integer(),
});

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

/**
 * What the high-frequency plane measured, at the rate it measured it.
 *
 * Deliberately NOT `monitor_checks`, and the separation is the whole
 * design. A row in `monitor_checks` is an observation of record: it
 * carries a ledger stamp, it is what uptime is computed from, it is what
 * the retention policy promises ninety days of. Writing one every 500ms
 * would multiply the largest table in the product by 120x per monitor
 * and put a per-actor sequence lock on the hot path — for evidence
 * nobody reads at that resolution.
 *
 * So a sample is the cheap thing: six columns, no chain, no foreign key
 * to an actor, written in micro-batches of many rows per statement, kept
 * for minutes rather than months. The plane promotes a sample into
 * `monitor_checks` when it says something new (see
 * `highfreq/plane.ts`), which is what keeps incidents, uptime and the
 * ledger reading exactly as they did before this plane existed.
 *
 * No primary key, on purpose. A surrogate key on an append-only buffer
 * that is truncated every hour buys nothing — nothing references a
 * sample, and nothing updates one — and costs a sequence bump plus a
 * second index to maintain at two thousand inserts a second. The one
 * index is the one every reader uses.
 */
export const monitorHfSamples = pgTable(
  "monitor_hf_samples",
  {
    monitorId: uuid()
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    /**
     * When the probe was issued, derived from the scheduler's monotonic
     * clock rather than read from `Date.now()` at write time — see
     * `highfreq/clock.ts`. Cadence is computed from consecutive values
     * of this column, and a clock step during the window would otherwise
     * show up as a negative gap.
     */
    observedAt: timestamp({ withTimezone: true }).notNull(),
    ok: boolean().notNull(),
    /** up | degraded | down | indeterminate, as judged by the same engine. */
    verdict: text().notNull(),
    responseTimeMs: integer(),
    /** Null when the sample passed. Truncated: this table is a buffer. */
    error: text(),
  },
  (t) => [
    index("monitor_hf_samples_monitor_idx").on(t.monitorId, t.observedAt),
  ],
);

/**
 * Samples, aggregated, so the raw buffer can be thrown away.
 *
 * Three granularities in one table rather than three tables: every
 * reader wants "the coarsest bucket that covers this window" and asking
 * that of one relation is a predicate, whereas asking it of three is a
 * union that each caller writes slightly differently. `granularity` is
 * `text` for the reason every other discriminator in this schema is —
 * Postgres will not use a new enum value in the transaction that adds
 * it, and Drizzle wraps each migration in one.
 *
 * `firstObservedAt`, `lastObservedAt` and `maxGapMs` are what make
 * ACHIEVED cadence survive the prune. Without them a rolled-up hour can
 * say how many samples there were but not whether they were evenly
 * spaced, and "2000 samples in an hour" is equally consistent with a
 * steady 1.8s cadence and with a 500ms cadence that stopped for forty
 * minutes.
 */
export const monitorHfRollups = pgTable(
  "monitor_hf_rollups",
  {
    monitorId: uuid()
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    /** minute | hour | day */
    granularity: text().notNull(),
    bucketStart: timestamp({ withTimezone: true }).notNull(),
    samples: integer().notNull(),
    okSamples: integer().notNull(),
    degradedSamples: integer().notNull(),
    downSamples: integer().notNull(),
    indeterminateSamples: integer().notNull(),
    minResponseMs: integer(),
    maxResponseMs: integer(),
    /** Sum, not mean: means do not re-aggregate into the coarser bucket. */
    sumResponseMs: bigint({ mode: "number" }),
    responseSamples: integer().notNull(),
    firstObservedAt: timestamp({ withTimezone: true }).notNull(),
    lastObservedAt: timestamp({ withTimezone: true }).notNull(),
    /** The largest gap between consecutive samples inside the bucket. */
    maxGapMs: integer(),
  },
  (t) => [
    // The bucket's identity, and the conflict target every rollup
    // upserts against. Recomputing a bucket must replace it rather than
    // append a second copy, or a rollup job that runs twice doubles
    // every count it wrote.
    uniqueIndex("monitor_hf_rollups_bucket_idx").on(
      t.monitorId,
      t.granularity,
      t.bucketStart,
    ),
  ],
);

/**
 * Which worker replica is probing which shard.
 *
 * The problem this solves does not exist on the pg-boss plane: there,
 * two replicas racing for the same job is settled by `SKIP LOCKED`
 * inside one queue table. The high-frequency plane has no per-probe
 * queue row to lock — that is the point of it — so exclusivity has to be
 * held over a *set* of monitors for a stretch of time instead.
 *
 * A shard rather than a monitor: leasing per monitor makes the lease
 * traffic scale with the monitor count, and at a thousand monitors that
 * is a thousand renewals per lease period spent proving nothing changed.
 * A monitor maps to a shard by a stable hash of its id, so the mapping
 * needs no storage and survives a restart.
 *
 * Rows are created on demand rather than seeded by the migration, so
 * changing the shard count is a constant and not a schema change.
 */
export const monitorHfLeases = pgTable("monitor_hf_leases", {
  shard: integer().primaryKey(),
  /** Stable per worker process — hostname plus pid. */
  ownerId: text().notNull(),
  acquiredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  renewedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /**
   * When another replica may take this shard. Held in the database
   * rather than computed from `renewed_at` plus a constant, so two
   * replicas running different builds — mid-deploy, which is exactly
   * when this matters — cannot disagree about when a lease expired.
   */
  expiresAt: timestamp({ withTimezone: true }).notNull(),
});
