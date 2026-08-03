import { sql } from "drizzle-orm";
import {
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
} from "drizzle-orm/pg-core";

import { organization } from "./auth";

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
    /** Event class ids this channel receives (see EVENT_CLASSES). */
    events: jsonb().notNull().default([]),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index().on(t.organizationId)],
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
  "queued",
  "sending",
  "delivered",
  "failed",
]);

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
  ],
);
