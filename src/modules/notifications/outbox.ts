import { and, eq, gte, inArray, or, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { notificationOutbox } from "@/db/schema";

/**
 * The transactional outbox: deciding to notify, and actually notifying,
 * are two separate durable facts.
 *
 * Before 1.13.0 they were one call. `notifyIncidentOpened` rendered an
 * email and handed it to a transport that logged its own failures and
 * resolved successfully anyway, while `incidents.notified_at` had
 * already been stamped. A provider 500, a timeout, a crash between the
 * two — all produced an incident marked as notified with nobody
 * notified, and no row anywhere recording that anything had gone wrong.
 *
 * Enqueueing happens inside the caller's transaction, so the intent
 * commits with its cause or not at all. Delivery happens in a worker
 * that owns the retry, the backoff and the record of what the provider
 * actually said.
 */

/** What a transport reports back. `void` was the old contract, and the bug. */
export type DeliveryOutcome =
  | { status: "delivered"; providerMessageId: string | null }
  /** The provider or network might succeed later: 429, 5xx, timeout, DNS. */
  | { status: "retryable"; error: string }
  /** It will never succeed: 400, an unroutable address, a rejected domain. */
  | { status: "permanent"; error: string };

export interface OutboxMessage {
  organizationId: string;
  /**
   * The logical identity of this notification, derived from its cause —
   * `incident:<id>:opened:<recipient>`. Deriving rather than randomising
   * is the entire idempotency guarantee: a job delivered twice computes
   * the same key and the unique index rejects the second row.
   */
  idempotencyKey: string;
  channel: "email" | "webhook";
  destination: string;
  payload: Record<string, unknown>;
}

export type OutboxRow = typeof notificationOutbox.$inferSelect;

/**
 * Attempts after which a message is given up on.
 *
 * Six attempts over the backoff below is a little under half an hour.
 * Long enough to ride out a provider incident, short enough that a
 * genuinely undeliverable address is marked failed while the operator
 * still remembers configuring it.
 */
export const MAX_ATTEMPTS = 6;

/** How long a worker holds a claimed row before another may retry it. */
const LEASE_MS = 60_000;

/**
 * Exponential, capped, and jittered.
 *
 * Jitter is not decoration: without it, a provider outage that queues a
 * thousand messages returns all thousand to the queue at the same
 * instant, and the recovery attempt is itself the next outage.
 */
export function backoffMs(attempts: number, random = Math.random): number {
  const base = Math.min(2 ** attempts * 1_000, 300_000);
  return Math.round(base * (0.5 + random() * 0.5));
}

/**
 * Records the intent to notify. Call inside the transaction that decides
 * it, never after.
 *
 * Returns the row, or null when this exact notification was already
 * enqueued. Null is a success: it means the guarantee held.
 */
export async function enqueue(
  db: DbClient,
  message: OutboxMessage,
): Promise<OutboxRow | null> {
  const [row] = await db
    .insert(notificationOutbox)
    .values({
      organizationId: message.organizationId,
      idempotencyKey: message.idempotencyKey,
      channel: message.channel,
      destination: message.destination,
      payload: message.payload,
    })
    // The unique index is the arbiter, not a preceding SELECT: two
    // workers racing the same incident both find nothing and both
    // insert. Postgres decides, and the loser learns it lost.
    .onConflictDoNothing({ target: notificationOutbox.idempotencyKey })
    .returning();
  return row ?? null;
}

/**
 * Takes up to `limit` due messages, leasing them so a second worker
 * leaves them alone.
 *
 * `for update skip locked` rather than a plain select: without it, two
 * workers draining concurrently serialise behind each other's row locks
 * and the second one does nothing useful. Rows already in `sending`
 * whose lease has expired are picked up again — that is the crash
 * recovery path, and the reason `sending` is a timestamped lease rather
 * than a flag.
 *
 * Due-ness and the lease are both the DATABASE's clock, never a
 * caller's. Two reasons, and the second one bites long before the first:
 *
 *  - With more than one worker, a client-side `new Date()` makes a row
 *    due at a different instant on each machine, and the lease it writes
 *    means something different to whoever reads it.
 *  - `timestamptz` holds microseconds and a JavaScript `Date` holds
 *    milliseconds. A row stamped `…373340` by `now()` is not `<=` a
 *    client timestamp of `…373000`, so a message enqueued and drained
 *    inside the same millisecond is invisible to its own worker until
 *    the clock ticks over. That is a sub-millisecond race in production
 *    and a reliably failing test, which is how it was found.
 */
export async function claimDue(
  db: DbClient,
  limit: number,
  organizationId?: string,
): Promise<OutboxRow[]> {
  // Optionally scoped to one tenant. A global drain is the right default
  // — there is one worker and one provider budget — but a single
  // organization whose provider is timing out can otherwise fill every
  // batch with its own retries and starve everyone else's alerts. A
  // caller that wants to bound that runs a scoped pass.
  const scope = organizationId
    ? sql`and ${notificationOutbox.organizationId} = ${organizationId}`
    : sql``;
  // Two statements in one transaction rather than one statement with a
  // locking CTE: lock a bounded set, then claim exactly those rows.
  return db.transaction(async (tx) => {
    const { rows: due } = await tx.execute<{ id: string }>(sql`
      select ${notificationOutbox.id} as id
      from ${notificationOutbox}
      where ${notificationOutbox.nextAttemptAt} <= now()
        ${scope}
        and (
          ${notificationOutbox.state} = 'queued'
          or (
            ${notificationOutbox.state} = 'sending'
            and (
              ${notificationOutbox.leasedUntil} is null
              or ${notificationOutbox.leasedUntil} <= now()
            )
          )
        )
      order by ${notificationOutbox.nextAttemptAt}
      limit ${limit}
      for update skip locked
    `);
    if (due.length === 0) return [];

    return tx
      .update(notificationOutbox)
      .set({
        state: "sending",
        leasedUntil: sql`now() + make_interval(secs => ${LEASE_MS / 1000})`,
      })
      .where(
        inArray(
          notificationOutbox.id,
          due.map((row) => row.id),
        ),
      )
      .returning();
  });
}

/**
 * Writes what the provider actually said.
 *
 * A retryable failure that has exhausted `MAX_ATTEMPTS` becomes
 * `failed`, not `queued` forever: a message nobody will ever receive
 * should say so, so an operator can see it.
 */
export async function recordOutcome(
  db: DbClient,
  row: OutboxRow,
  outcome: DeliveryOutcome,
  now: Date = new Date(),
): Promise<void> {
  const attempts = row.attempts + 1;

  if (outcome.status === "delivered") {
    await db
      .update(notificationOutbox)
      .set({
        state: "delivered",
        attempts,
        deliveredAt: now,
        providerMessageId: outcome.providerMessageId,
        leasedUntil: null,
      })
      .where(eq(notificationOutbox.id, row.id));
    return;
  }

  const giveUp = outcome.status === "permanent" || attempts >= MAX_ATTEMPTS;

  await db
    .update(notificationOutbox)
    .set({
      state: giveUp ? "failed" : "queued",
      attempts,
      lastError: outcome.error.slice(0, 2_000),
      nextAttemptAt: giveUp
        ? row.nextAttemptAt
        : new Date(now.getTime() + backoffMs(attempts)),
      leasedUntil: null,
    })
    .where(eq(notificationOutbox.id, row.id));
}

/** Everything queued or in flight for an organization — the operator view. */
export async function pendingFor(
  db: DbClient,
  organizationId: string,
): Promise<OutboxRow[]> {
  return db
    .select()
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.organizationId, organizationId),
        or(
          eq(notificationOutbox.state, "queued"),
          eq(notificationOutbox.state, "sending"),
        ),
      ),
    );
}

/** Messages that will never be delivered. Surfaced, never swept up. */
export async function failedFor(
  db: DbClient,
  organizationId: string,
  since: Date,
): Promise<OutboxRow[]> {
  return db
    .select()
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.organizationId, organizationId),
        eq(notificationOutbox.state, "failed"),
        gte(notificationOutbox.createdAt, since),
      ),
    );
}
