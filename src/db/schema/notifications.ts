import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";
import { monitors } from "./monitors";

/**
 * One configured notification destination: a provider id from the
 * registry (modules/notifications/providers), its non-secret settings,
 * its encrypted credentials, and which event classes it receives.
 *
 * Replaces `webhook_endpoints`, which allowed exactly one webhook per
 * organization with a fixed event set. Migration 0022 moved every
 * configured endpoint in here, classifying it by host (a
 * hooks.slack.com URL becomes a slack channel, discord.com a discord
 * channel, anything else a generic webhook) so nothing an operator had
 * wired stopped firing.
 *
 * `secrets` is a sealed envelope (modules/notifications/secretbox), or
 * `plain:<json>` briefly after migration until the worker's boot pass
 * re-seals it, or `""` for providers with no credential. Secret values
 * never appear in `config`, are never returned to the browser, and are
 * scrubbed from delivery errors before they are stored.
 */
export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** Registry id, e.g. "slack". Text, not an enum: the registry is the
     * validator, and adding a provider must not need a migration. */
    provider: text().notNull(),
    /** Non-secret provider settings, validated by the provider's schema. */
    config: jsonb().notNull().default({}),
    /** Sealed credential envelope; see module docs on the formats. */
    secrets: text().notNull().default(""),
    /**
     * The redacted "where does this go" line, computed at write time.
     *
     * Denormalized on purpose. It used to be derived on read by opening
     * the sealed envelope and asking the provider, which meant listing
     * N channels cost N AES-GCM decrypts — fine at the old cap of 20,
     * and the reason the cap looked harmless. With the cap gone, the
     * settings page for a thousand channels would have decrypted a
     * thousand credentials to draw a table. Writing it once at save
     * means the read path never touches a secret at all.
     *
     * Empty on rows written before 0024; the worker backfills them at
     * boot and the list shows the provider label until it does.
     */
    destination: text().notNull().default(""),
    /**
     * Whether this channel is scoped to specific monitors.
     *
     * Stored rather than inferred from "does it have any rows in
     * notification_channel_monitors", and the difference is a real bug
     * this column exists to have fixed. Those rows cascade when a
     * monitor is deleted, so a channel scoped to one client's monitors
     * had its last row removed by an unrelated admin action and, under
     * the inferred rule, silently became an organization default -
     * that client's Slack then received every other client's alerts.
     * An alert audience must never widen because something else was
     * deleted.
     *
     * With the flag, the same event leaves the channel matching
     * nothing, which is visible in the list and fixable, rather than
     * wrong and quiet.
     */
    scopedToMonitors: boolean().notNull().default(false),
    /** Event class ids this channel receives (see EVENT_CLASSES). */
    events: jsonb().notNull().default([]),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // The dispatch predicate starts here: one tenant's channels.
    //
    // There is deliberately NO index on `events`. A GIN index over it
    // was added with this feature and then measured, which is the only
    // reason this comment can say anything: on the shape this product
    // actually has - many organizations owning a few channels each -
    // it made routing SLOWER (3.99 ms against 1.11 ms at 500 tenants),
    // because the planner bitmap-ands a whole-index GIN scan across
    // every tenant against this one, reintroducing the cost per
    // channel that the index was supposed to remove. It wins only when
    // a single organization owns a very large number of channels, and
    // it charges write amplification on every save either way.
    //
    // A tenant owns few channels, so filtering the class in the heap
    // after this index has narrowed to the tenant is cheap.
    index().on(t.organizationId),
  ],
);

/**
 * Which monitors a channel is scoped to. Read together with
 * `notification_channels.scoped_to_monitors`, which says whether the
 * scoping is meant at all: no rows and the flag false is a workspace
 * default, no rows and the flag TRUE is a channel whose monitors have
 * all been deleted and which therefore receives nothing.
 *
 * A join table rather than a column on either side because the relation
 * is genuinely many-to-many: one channel can watch several monitors, and
 * one monitor can notify several channels. Both foreign keys cascade, so
 * deleting a monitor or a channel cannot leave a route pointing at
 * nothing — the dangling-route case is prevented by the database rather
 * than by remembering to clean up.
 *
 * The other two scopes in the product need no storage. An organization
 * IS the workspace/client boundary (the agency edition gives each client
 * its own organization), and channels are already organization-scoped;
 * event classes live on the channel row.
 */
export const notificationChannelMonitors = pgTable(
  "notification_channel_monitors",
  {
    channelId: uuid()
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    monitorId: uuid()
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.monitorId] }),
    // The dispatch side asks "which channels target this monitor".
    index("notification_channel_monitors_monitor_idx").on(t.monitorId),
  ],
);

/**
 * How far a queued notification has actually got.
 *
 * Four states because three of them used to be indistinguishable. The
 * old path set `incidents.notified_at` before calling a transport that
 * swallowed its own errors, so "we decided to alert", "we handed it to a
 * provider", "a provider accepted it" and "it will never be delivered"
 * were all the same timestamp. An operator asking "was I paged?" could
 * not be answered from the database.
 *
 * `sending` is a lease, not a wish: it records that a worker took the
 * row, so a second worker leaves it alone until the lease expires.
 */
export const notificationState = pgEnum("notification_state", [
  /** Decided, not yet in flight. `next_attempt_at` says when it is due. */
  "queued",
  /** A worker holds a lease on it right now. Not a wish: a timestamp. */
  "sending",
  /* ---- terminal, and four of them because they are four different
   * operational facts. `failed` used to mean all three of the ones
   * below it, so an operator reading the ledger could not tell a typo
   * in a credential from a provider that was down all afternoon, and
   * the two need opposite responses. ---- */
  /** A provider accepted it; `provider_message_id` is the receipt. */
  "delivered",
  /** The provider rejected it and will keep rejecting it: a bad
   * credential, an address that does not exist, a malformed payload.
   * Retrying is pointless and hides the configuration error. */
  "failed",
  /** The retry horizon passed while it was still retryable. The
   * provider never came back in time, and an alert this old is no
   * longer worth delivering - see NOTIFICATION_RETRY_HORIZON_HOURS. */
  "expired",
  /** Attempts were exhausted while it was still retryable. Distinct
   * from `expired`: this one ran out of tries, not out of time, which
   * points at a provider failing fast rather than being unreachable. */
  "dead_letter",
]);

/**
 * What one attempt did.
 *
 * `claimed` is written when a worker takes the row and is REPLACED by
 * the outcome when it learns one. A row still saying `claimed` long
 * after its lease expired is the evidence of a worker that died
 * mid-flight, and it is exactly the case where a duplicate may exist:
 * the nightly sweep turns those into `unknown` rather than guessing.
 *
 * `unknown` is not a synonym for `retryable`. It means the request may
 * have arrived - a timeout after the bytes went out, a connection reset
 * mid-response - so a retry can produce a second message at the far
 * end. Both are retried, because at-least-once is the promise; only
 * `unknown` says the ledger cannot rule out a duplicate.
 */
export const notificationAttemptOutcome = pgEnum(
  "notification_attempt_outcome",
  ["claimed", "delivered", "retryable", "permanent", "unknown"],
);

export const notificationChannel = pgEnum("notification_channel", [
  "email",
  "webhook",
  // A configured notification channel; the row's channelId names which
  // one and the provider registry owns delivery. "webhook" remains only
  // for rows written before 0022.
  "channel",
]);

/**
 * The transactional outbox: one row per logical notification.
 *
 * Rows are written in the SAME transaction as the decision that caused
 * them — the incident opening, the escalation step firing. That is the
 * whole point. A crash between "the incident is open" and "someone was
 * told" used to lose the notification entirely and leave the incident
 * marked as notified; now the intent is committed with the cause, and a
 * worker that comes back finds it still queued.
 *
 * Delivery is at-least-once, and the product says so rather than
 * claiming better. The unavoidable window is a crash after a provider
 * accepted the message but before this row records it — the outbox
 * cannot know the difference between that and a request that never
 * arrived. What it can do is make the retry harmless, which is what
 * `idempotency_key` is for: it is sent to the provider as an
 * `Idempotency-Key` header, so a provider that honours one collapses the
 * duplicate on its side. `docs/NOTIFICATIONS.md` states the guarantee
 * per transport.
 */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * The logical identity of this notification — "incident X opened,
     * told ada@example.com". Unique, so retrying the job that enqueues
     * it cannot produce a second user-visible message. Derived from the
     * cause rather than random, because a random key would make every
     * retry a new notification, which is exactly the bug.
     */
    idempotencyKey: text().notNull(),
    channel: notificationChannel().notNull(),
    /**
     * Which configured channel this row delivers through, for `channel`
     * rows. SET NULL on delete: the delivery history outlives the
     * channel that produced it, which is the point of a ledger.
     */
    channelId: uuid().references(() => notificationChannels.id, {
      onDelete: "set null",
    }),
    /** Provider registry id at enqueue time, kept for the history view
     * after the channel row is gone. Null on plain email rows. */
    provider: text(),
    /** Notification event, e.g. "monitor.down". Null on rows enqueued
     * before 0022 and on member emails, which predate event routing. */
    event: text(),
    /** Email address, or the provider's redacted destination summary —
     * what this row is addressed to, safe to render. */
    destination: text().notNull(),
    /** The rendered message. Stored so a retry re-sends what was decided,
     * not what the templates would render today. */
    payload: jsonb().notNull(),
    state: notificationState().notNull().default("queued"),
    attempts: integer().notNull().default(0),
    /**
     * When this row is next eligible. Backoff writes a future value;
     * the claim query never sees a row before then.
     */
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Set while a worker holds the row; the lease expires with it. */
    leasedUntil: timestamp({ withTimezone: true }),
    /**
     * The fencing token. Incremented on every claim, and carried by the
     * worker that claimed it.
     *
     * This is what makes a lease safe rather than hopeful. A lease
     * bounds how long a worker is TRUSTED, but nothing stopped a worker
     * whose lease had expired - paused by GC, swapping, a slow provider
     * - from waking up and writing its result over the newer worker's.
     * The ledger would then show the loser's outcome for the winner's
     * send, which is the same class of lie as the duplicate the lease
     * exists to prevent.
     *
     * Every write from a delivery carries `and fence = <the value it
     * claimed with>`. A superseded worker's update matches no row, it
     * learns that immediately, and its attempt is recorded as
     * `unknown` - because it genuinely does not know whether its own
     * request arrived.
     *
     * `bigint`, and it only ever goes up. Wrapping is not a scenario:
     * one claim a millisecond for three hundred million years.
     */
    fence: bigint({ mode: "number" }).notNull().default(0),
    /** When the current lease was taken. Read by the queue-health view
     * to show how long the oldest in-flight message has been in flight. */
    lastClaimedAt: timestamp({ withTimezone: true }),
    /**
     * The moment this message stops being worth delivering.
     *
     * Stamped at enqueue from the retry horizon, so it survives a
     * restart, a redeploy and a configuration change: a message already
     * in the queue keeps the deadline it was accepted under. An alert
     * is a perishable thing - a monitor-down page delivered six hours
     * after the fact is noise arriving in the shape of an emergency -
     * so the horizon is a product decision, not a resource limit.
     */
    expiresAt: timestamp({ withTimezone: true }),
    /**
     * The delivery this one replays, if an operator asked for it.
     *
     * A replay is NEW work, never a mutation of the row it came from:
     * the original keeps its state, its attempts and its final reason,
     * and this column is the only link between them. Rewinding a
     * terminal row in place would destroy the record of what actually
     * happened, which is the one thing the ledger is for.
     */
    replayOf: uuid(),
    /** The provider's receipt. Without it, success is indistinguishable
     * from a silent no-op — which is what the old transport produced. */
    providerMessageId: text(),
    /** Why the last attempt failed. Kept on delivered rows too: a
     * message that succeeded on the fourth try is worth knowing about. */
    lastError: text(),
    deliveredAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("notification_outbox_idempotency_key").on(t.idempotencyKey),
    // The drain query's only predicate. Partial, because delivered and
    // permanently failed rows are never claimed again and there is no
    // reason to keep them in the index the worker hits every tick.
    index("notification_outbox_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.state} in ('queued', 'sending')`),
    index().on(t.organizationId, t.createdAt.desc()),
    // "What happened last on this channel", which the settings list
    // shows per row. Without it that column is a sort of the tenant's
    // whole delivery history once per page render.
    index("notification_outbox_channel_recent_idx").on(
      t.channelId,
      t.createdAt.desc(),
    ),
    // Fair selection reads this: due work, partitioned by tenant.
    //
    // The drain used to be `order by next_attempt_at limit N` over
    // every tenant at once, which is first-come-first-served and
    // therefore starvation by construction - one organization fanning
    // an incident out to a thousand channels owns the head of the queue
    // for four ticks, and every other tenant's alerts wait behind it
    // however small they are. The selection now ranks within each
    // organization and takes the best rank from each, which this index
    // makes an ordered walk rather than a sort of the whole queue.
    index("notification_outbox_fair_idx")
      .on(t.organizationId, t.nextAttemptAt)
      .where(sql`${t.state} in ('queued', 'sending')`),
  ],
);

/**
 * One row per delivery attempt. Append-only, and the reason it exists
 * is that the outbox row alone cannot answer "did this go twice?".
 *
 * The outbox row holds the CURRENT state of a message. It is updated in
 * place - a retry overwrites `last_error`, a success overwrites
 * `attempts` - which is right for a queue and useless as evidence: the
 * fourth attempt's error replaces the third's, and a worker that sent
 * the message and then died leaves nothing behind at all. Every one of
 * those is invisible in a single mutable row.
 *
 * So each attempt writes its own row when it is CLAIMED, before
 * anything is sent, and that row is completed in place exactly once by
 * the worker that owns the fence. Nothing here is ever overwritten by a
 * later attempt, and a row still reading `claimed` after its lease
 * expired is not missing data - it is the strongest evidence the system
 * has that a duplicate may exist.
 *
 * Append-only with exactly one exception, stated rather than glossed:
 * a claim WITHDRAWN before anything was sent is deleted (see
 * `deferRow`). A message deferred by the per-channel rate limit
 * reached no provider, so leaving a row behind would be evidence of a
 * send that never happened - and the attempt number is returned to the
 * pool with it, so the timeline has no gap. Nothing that reached a
 * provider is ever removed except by retention, with its delivery.
 */
export const notificationAttempts = pgTable(
  "notification_attempts",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    /** Cascades: the evidence belongs to the delivery, and a delivery
     * removed by retention takes its attempts with it in one statement
     * rather than leaving orphans for a second sweep to find. */
    outboxId: uuid()
      .notNull()
      .references(() => notificationOutbox.id, { onDelete: "cascade" }),
    /** Denormalized so the tenant-scoped read and the retention sweep
     * never have to join back to the outbox. */
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** 1-based, and unique per delivery - see the index below. */
    attempt: integer().notNull(),
    /** The outbox fence this attempt was claimed under. Two rows with
     * the same attempt number cannot exist, but a superseded worker and
     * its replacement carry different fences, which is what identifies
     * whose write won. */
    fence: bigint({ mode: "number" }).notNull(),
    outcome: notificationAttemptOutcome().notNull().default("claimed"),
    /** The provider's own status line, when there was one. Null for a
     * transport that never answered, which is itself the signal. */
    httpStatus: integer(),
    /** Already redacted when written; never a raw provider body. */
    error: text(),
    providerMessageId: text(),
    /** What the provider asked for, when it asked. Kept so an operator
     * can see the schedule was the provider's choice, not Vigil's. */
    retryAfterMs: integer(),
    /** When this attempt scheduled the next one. Null on a terminal
     * outcome, which is how the timeline shows where the chain ended. */
    nextAttemptAt: timestamp({ withTimezone: true }),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // One row per attempt number per delivery. This is the constraint
    // that makes the table append-only in practice: a worker cannot
    // write a second row for an attempt another worker already claimed,
    // so a re-claim after a lease expiry takes the NEXT number and both
    // are visible.
    uniqueIndex("notification_attempts_unique").on(t.outboxId, t.attempt),
    index("notification_attempts_timeline_idx").on(t.outboxId, t.startedAt),
    // The retention sweep and the tenant's history view.
    index("notification_attempts_org_idx").on(
      t.organizationId,
      t.startedAt.desc(),
    ),
    // The stale-claim sweep: rows that never finished.
    index("notification_attempts_unfinished_idx")
      .on(t.startedAt)
      .where(sql`${t.outcome} = 'claimed'`),
  ],
);
