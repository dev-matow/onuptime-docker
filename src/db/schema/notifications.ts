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
 * One outbound webhook endpoint per organization. Deliveries are signed
 * with `secret` (HMAC-SHA-256) and sent for every notification event
 * while `enabled`. Kept minimal on purpose — the event set is fixed in
 * code (see modules/notifications/webhook.ts), so there is nothing to
 * store per event.
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    organizationId: text()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    url: text().notNull().default(""),
    /** Signing secret; generated on first access, rotatable by the user. */
    secret: text().notNull(),
    enabled: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex().on(t.organizationId)],
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
    /** Email address or webhook URL — what this row is addressed to. */
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
