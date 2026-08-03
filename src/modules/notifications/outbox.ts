import { and, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";

import type { DbClient } from "@/db";
import { env } from "@/lib/env";
import { notificationAttempts, notificationOutbox } from "@/db/schema";

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

/**
 * What a transport reports back. `void` was the old contract, and the bug.
 *
 * Four cases, not three, and the fourth is the honest one. `retryable`
 * used to carry every network failure including a timeout - but a DNS
 * failure and a timeout are not the same fact. Nothing was sent in the
 * first; in the second the bytes may have arrived, been acted on, and
 * the answer lost on the way back. Both are retried, because
 * at-least-once is the promise. Only one of them means the ledger
 * cannot rule out a second message at the far end, and an operator
 * chasing a duplicate page needs to be able to see which.
 */
export type DeliveryOutcome =
  | {
      status: "delivered";
      providerMessageId: string | null;
      httpStatus?: number;
    }
  /** The provider or network might succeed later, and NOTHING was sent
   * that could have taken effect: 429, 5xx, connection refused, DNS.
   * `retryAfterMs` carries the provider's own Retry-After when it sent
   * one; the backoff never schedules earlier than the provider asked,
   * up to `RETRY_AFTER_CAP_MS` - past that the cap wins, because an
   * unbounded Retry-After would park the message past its own horizon
   * and it would expire without ever being tried again. */
  | {
      status: "retryable";
      error: string;
      retryAfterMs?: number;
      httpStatus?: number;
    }
  /** It will never succeed: 400, an unroutable address, a rejected
   * credential. Retried, it would hide a configuration error behind a
   * queue that never drains. */
  | { status: "permanent"; error: string; httpStatus?: number }
  /** The request went out and its fate is unknown: a timeout after the
   * body was written, a reset mid-response, a worker that died between
   * the send and the record. Retried like `retryable`, recorded
   * differently, and it is the only case that can produce a duplicate
   * the provider did not collapse. */
  | { status: "unknown"; error: string; httpStatus?: number };

/** The outcomes that mean "try again later". */
export function isRetryable(outcome: DeliveryOutcome): boolean {
  return outcome.status === "retryable" || outcome.status === "unknown";
}

export interface OutboxMessage {
  organizationId: string;
  /**
   * The logical identity of this notification, derived from its cause —
   * `incident:<id>:opened:<recipient>`. Deriving rather than randomising
   * is the entire idempotency guarantee: a job delivered twice computes
   * the same key and the unique index rejects the second row.
   */
  idempotencyKey: string;
  channel: "email" | "webhook" | "channel";
  /** For `channel` rows: which configured channel delivers this. */
  channelId?: string;
  /** Provider registry id, denormalized for the history view. */
  provider?: string;
  /** Notification event name, e.g. "monitor.down". */
  event?: string;
  destination: string;
  payload: Record<string, unknown>;
  /** Set only by replay: the delivery this one repeats. */
  replayOf?: string;
}

/** The expiry deadline, from the database's clock and the configured
 * horizon. A caller's `new Date()` would drift between workers. */
function horizonSql() {
  return sql`now() + make_interval(hours => ${env.NOTIFICATION_RETRY_HORIZON_HOURS})`;
}

export type OutboxRow = typeof notificationOutbox.$inferSelect;

/**
 * The retry schedule, and the two bounds that end it.
 *
 * Until 1.18.0 this was six attempts over five backoffs of 2, 4, 8, 16
 * and 32 seconds - a total window of 31 to 62 seconds. That is a
 * schedule for a provider that hiccups, not for one that is down, and
 * a provider outage lasting longer than a minute ended with every
 * queued alert marked failed. The failure mode was quiet and total:
 * the ledger said "we tried", and it had, for a minute.
 *
 * Now the waits grow to a half-hour ceiling and the chain ends at
 * whichever of two bounds arrives first:
 *
 *  - `NOTIFICATION_MAX_ATTEMPTS` (20) - the message becomes
 *    `dead_letter`. It ran out of TRIES, which is what happens when a
 *    provider is answering fast and answering badly.
 *  - `NOTIFICATION_RETRY_HORIZON_HOURS` (6) - the message becomes
 *    `expired`. It ran out of TIME, which is what happens when a
 *    provider is unreachable, and it is also the point past which an
 *    alert about a finished outage is worse than no alert.
 *
 * Two bounds rather than one because they catch different providers,
 * and the terminal state names which one was hit.
 */

/** Waits stop growing here. Twenty attempts on this curve is about
 * five hours, which is inside the default horizon on purpose: the
 * horizon should be reachable, not decorative. */
const BACKOFF_CEILING_MS = 1_800_000;

/**
 * Exponential, capped, and jittered by a QUARTER either way.
 *
 * Jitter is not decoration: without it, an outage that queues a
 * thousand messages returns all thousand at the same instant and the
 * recovery attempt is the next outage. The old spread was 0.5 to 1.0 of
 * the base, which jitters hard enough that the published schedule stops
 * describing what actually happens - the tail of a 30-minute wait could
 * be 15. A quarter either way still spreads a thousand messages across
 * a fifteen-minute window at the ceiling, and leaves the schedule
 * something an operator can predict from the docs.
 */
export function backoffMs(attempts: number, random = Math.random): number {
  const base = Math.min(2 ** attempts * 1_000, BACKOFF_CEILING_MS);
  return Math.round(base * (0.75 + random() * 0.5));
}

/**
 * The published schedule, as milliseconds, for the first `n` waits.
 * Exported so the docs table and its guard read the same function the
 * worker does rather than a transcription of it.
 */
export function backoffSchedule(n: number): number[] {
  return Array.from({ length: n }, (_, i) =>
    Math.min(2 ** (i + 1) * 1_000, BACKOFF_CEILING_MS),
  );
}

export interface RetryPolicy {
  maxAttempts: number;
  horizonHours: number;
}

export function retryPolicy(): RetryPolicy {
  return {
    maxAttempts: env.NOTIFICATION_MAX_ATTEMPTS,
    horizonHours: env.NOTIFICATION_RETRY_HORIZON_HOURS,
  };
}

/**
 * Longest a provider's own `Retry-After` may push a message out.
 *
 * Honoured, because retrying into a stated rate limit burns an attempt
 * to learn nothing - but bounded, because `Retry-After: 86400` from a
 * misconfigured proxy would otherwise park an alert for a day inside a
 * six-hour horizon, and the message would expire without ever being
 * tried again. Beyond this the normal backoff applies and the provider
 * is simply asked again sooner than it wanted.
 */
export const RETRY_AFTER_CAP_MS = 3_600_000;

/**
 * How long a worker holds a claimed row before another may retry it.
 *
 * Must exceed the worst case for a whole batch, not for one message: a
 * row at the tail of a batch whose providers each burn the full 10s
 * timeout is still in flight minutes after the batch was claimed.
 *
 * The lease alone was never enough, and 1.18.0 stopped pretending it
 * was. A lease bounds how long a worker is TRUSTED; it cannot stop a
 * worker that was paused past its lease from waking and writing. That
 * is what `fence` is for - see the schema. The lease decides when a row
 * may be re-claimed; the fence decides whose result counts.
 */
const LEASE_MS = 600_000;

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
      channelId: message.channelId,
      provider: message.provider,
      event: message.event,
      destination: message.destination,
      payload: message.payload,
      // The deadline travels with the row from the moment it is
      // accepted, so a restart, a redeploy or a changed setting cannot
      // move it. Computed by the DATABASE for the same reason every
      // other timestamp here is.
      expiresAt: horizonSql(),
      ...(message.replayOf ? { replayOf: message.replayOf } : {}),
    })
    // The unique index is the arbiter, not a preceding SELECT: two
    // workers racing the same incident both find nothing and both
    // insert. Postgres decides, and the loser learns it lost.
    .onConflictDoNothing({ target: notificationOutbox.idempotencyKey })
    .returning();
  return row ?? null;
}

/**
 * Enqueues a batch in one statement, with the same conflict rule as
 * `enqueue`. Returns how many rows were actually new.
 *
 * The fan-out of one event to N channels was N inserts. That was
 * invisible while an organization could own at most twenty channels
 * and becomes the dominant cost the moment it cannot — a single
 * incident on a thousand-channel tenant is a thousand round trips
 * inside the transaction that opened it.
 */
export async function enqueueMany(
  db: DbClient,
  messages: OutboxMessage[],
): Promise<number> {
  if (messages.length === 0) return 0;
  const rows = await db
    .insert(notificationOutbox)
    .values(
      messages.map((message) => ({
        organizationId: message.organizationId,
        idempotencyKey: message.idempotencyKey,
        channel: message.channel,
        channelId: message.channelId,
        provider: message.provider,
        event: message.event,
        destination: message.destination,
        payload: message.payload,
        expiresAt: horizonSql(),
        ...(message.replayOf ? { replayOf: message.replayOf } : {}),
      })),
    )
    .onConflictDoNothing({ target: notificationOutbox.idempotencyKey })
    .returning({ id: notificationOutbox.id });
  return rows.length;
}

/**
 * The fair-selection ranking: which due messages go next, and in what
 * order.
 *
 * Exported so the benchmark and the fairness test drive the SAME
 * expression the worker does. The first version of that test rewrote
 * this query by hand, which meant it passed whatever `claimDue`
 * actually ordered by - a test that cannot fail for the reason it
 * exists. Sharing the expression costs one export and removes the
 * whole class of drift.
 *
 * Rank first: every tenant's oldest message before any tenant's
 * second. Then oldest across tenants, so the round-robin does not
 * reorder work that is genuinely older.
 */
export function dueRankingSql(limit: number, scope: SQL = sql``): SQL {
  return sql`
    select id from (
      select o.id,
             row_number() over (
               partition by o.organization_id
               order by o.next_attempt_at, o.id
             ) as rank,
             o.organization_id,
             o.next_attempt_at
      from ${notificationOutbox} o
      where o.next_attempt_at <= now()
        ${scope}
        -- Past the horizon, nothing is delivered - enforced here and
        -- not only by the expiry sweep. A row claimed a minute before
        -- its deadline by a worker that then dies stays in sending,
        -- which the sweep will only take once the lease has passed;
        -- without this predicate the next tick re-claimed and
        -- delivered it, and repeating on each crash that is bounded
        -- only by attempts x lease - over three hours past a deadline
        -- the docs justify on the grounds that a six-hour-late page
        -- is a false one.
        and (o.expires_at is null or o.expires_at > now())
        and (
          o.state = 'queued'
          or (
            o.state = 'sending'
            and (o.leased_until is null or o.leased_until <= now())
          )
        )
    ) ranked
    order by rank, next_attempt_at, organization_id
    limit ${limit}
  `;
}

/** A claimed row plus the fence it was claimed under. Every later
 * write from this delivery carries the fence, so a worker that was
 * superseded cannot commit over its replacement. */
export interface ClaimedRow {
  row: OutboxRow;
  fence: number;
  /** The attempt number this claim is, 1-based. */
  attempt: number;
}

/**
 * Takes up to `limit` due messages FAIRLY, leasing and fencing them.
 *
 * Two changes from the first-come version, and the first one is the
 * reason this function was rewritten.
 *
 * **Fairness.** `order by next_attempt_at limit N` is
 * first-come-first-served across every tenant at once, which is
 * starvation by construction. One organization fanning an incident out
 * to a thousand channels owns the head of the queue for four ticks, and
 * every other tenant's alerts - a single page about a single monitor -
 * wait behind all thousand of them. The selection now ranks each
 * organization's due work independently and takes the best rank from
 * each in turn, so the small tenant's one message rides in the first
 * tick beside the big tenant's first message. Within an organization it
 * is still oldest-first, which is what an operator expects.
 *
 * **Fencing.** The claim bumps `fence` and hands the new value back.
 * `for update skip locked` stops two workers claiming the same row at
 * the same instant; it does nothing about a worker that claimed a row,
 * was paused past its lease, and woke up to write. The fence does: its
 * write names a value that is no longer current and matches no row.
 *
 * Due-ness, the lease and the expiry are all the DATABASE's clock,
 * never a caller's. Two reasons, and the second bites long before the
 * first:
 *
 *  - With more than one worker, a client-side `new Date()` makes a row
 *    due at a different instant on each machine, and the lease it
 *    writes means something different to whoever reads it.
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
): Promise<ClaimedRow[]> {
  // Optionally scoped to one tenant - the inline drain after a dispatch
  // uses it so a server action cannot inherit the whole queue.
  const scope = organizationId
    ? sql`and o.organization_id = ${organizationId}`
    : sql``;

  return db.transaction(async (tx) => {
    // Three statements rather than one locking CTE: a window function
    // and `for update` cannot appear in the same query, and the ranking
    // is the whole point. Rank without locking, then lock exactly the
    // rows the ranking chose, then claim them.
    const { rows: due } = await tx.execute<{ id: string }>(
      dueRankingSql(limit, scope),
    );
    if (due.length === 0) return [];

    // Expanded into placeholders rather than passed as one array
    // parameter: the driver has no type for a bare JS array here and
    // sends it as a string Postgres refuses to parse as `uuid[]`.
    const ids = sql.join(
      due.map((row) => sql`${row.id}::uuid`),
      sql`, `,
    );
    // Re-checked under the lock: between the ranking and here another
    // worker may have taken any of them.
    const { rows: locked } = await tx.execute<{ id: string }>(sql`
      select id from ${notificationOutbox}
      where id in (${ids})
        and next_attempt_at <= now()
        and (expires_at is null or expires_at > now())
        and (
          state = 'queued'
          or (state = 'sending' and (leased_until is null or leased_until <= now()))
        )
      for update skip locked
    `);
    if (locked.length === 0) return [];

    const rows = await tx
      .update(notificationOutbox)
      .set({
        state: "sending",
        fence: sql`${notificationOutbox.fence} + 1`,
        // The attempt is spent HERE, not when an outcome arrives, and
        // the difference is a bug this ordering fixes rather than a
        // preference. Counting at the outcome meant a worker that died
        // holding the row spent nothing: the lease expired, the next
        // worker computed the same attempt number, and the row could
        // cycle between crash and re-claim forever without ever
        // reaching its budget. It also collided with the unique index
        // on (outbox_id, attempt), which is how it was found.
        //
        // Counting at the claim also makes `attempts` mean what an
        // operator reads it as: how many times this message has been
        // picked up and tried, including the times nobody came back.
        //
        // `greatest` against the evidence table, and it is not
        // defensive decoration. If a row's counter and its attempt rows
        // ever disagree - a hand-edited row, a restore that took one
        // table and not the other, a bug in some future writer - a
        // plain `+ 1` produces an attempt number that already exists,
        // the unique index rejects the INSERT, and the whole claim
        // transaction aborts. Not one message: the entire batch, every
        // tick, forever, because the poisoned row is always due and
        // always claimed first. One indexed lookup per claimed row buys
        // immunity from a permanently stuck queue.
        attempts: sql`greatest(
          ${notificationOutbox.attempts} + 1,
          (select coalesce(max(a.attempt), 0) + 1
             from ${notificationAttempts} a
            where a.outbox_id = ${notificationOutbox.id})
        )`,
        leasedUntil: sql`now() + make_interval(secs => ${LEASE_MS / 1000})`,
        lastClaimedAt: sql`now()`,
      })
      .where(
        inArray(
          notificationOutbox.id,
          locked.map((row) => row.id),
        ),
      )
      .returning();

    // The attempt rows, written in the SAME transaction as the claim.
    // That ordering is the guarantee: evidence that a worker took the
    // row exists before the worker can possibly have sent anything, so
    // a crash between the two cannot produce a send with no record.
    if (rows.length > 0) {
      await tx.insert(notificationAttempts).values(
        rows.map((row) => ({
          outboxId: row.id,
          organizationId: row.organizationId,
          // `attempts` was just incremented above, so this is the
          // number of the attempt starting now.
          attempt: row.attempts,
          fence: row.fence,
        })),
      );
    }

    return rows.map((row) => ({ row, fence: row.fence, attempt: row.attempts }));
  });
}

/**
 * Extends the lease on a row about to be delivered.
 *
 * Called immediately before each send, so the clock starts at the send
 * rather than at the batch claim. Without it the last row of a slow
 * batch inherits whatever is left of a lease the first row started.
 */
export async function renewLease(
  db: DbClient,
  rowId: string,
  fence: number,
): Promise<void> {
  // Fenced, like every other write from a claim. Extending a lease is
  // an assertion of ownership, and a worker that has already lost the
  // row asserting it would push the real owner's deadline out.
  await db
    .update(notificationOutbox)
    .set({
      leasedUntil: sql`now() + make_interval(secs => ${LEASE_MS / 1000})`,
    })
    .where(
      and(
        eq(notificationOutbox.id, rowId),
        eq(notificationOutbox.fence, fence),
      ),
    );
}

/** Where a delivery ended, and why. Returned so the caller can log and
 * count without re-deriving the decision. */
export interface RecordedOutcome {
  /** False when the fence had moved: another worker owns this row now,
   * and nothing was written. */
  committed: boolean;
  state: "queued" | "delivered" | "failed" | "expired" | "dead_letter";
  attempts: number;
  /** Set when the message is going round again. */
  nextAttemptAt?: Date;
}

/**
 * Writes what the provider actually said, under the fence that claimed
 * the row, and completes the attempt's evidence row.
 *
 * Three things happen here and they happen in one transaction, because
 * an outbox row and its attempt row disagreeing is precisely the state
 * an operator cannot reason about.
 *
 * **The fence is checked, not assumed.** Every update carries
 * `and fence = <claimed>`. A worker that was paused past its lease
 * finds zero rows updated, returns `committed: false`, and records its
 * own attempt as `unknown` - which is the truth: it does not know
 * whether its request arrived, and it must not overwrite the result of
 * the worker that replaced it.
 *
 * **A terminal state is chosen from four, not two.** `failed` is
 * reserved for a provider that will keep rejecting; `dead_letter` for
 * running out of attempts; `expired` for running out of horizon. An
 * operator seeing a hundred `expired` rows knows the provider was
 * unreachable; a hundred `failed` rows means a credential is wrong.
 * Collapsing them - which is what shipped until 1.18.0 - makes those
 * two look identical and leads to the wrong fix.
 *
 * **The expiry is checked before the retry is scheduled.** A message
 * whose next attempt would land past its deadline is expired now rather
 * than woken up once more to be expired then.
 */
export async function recordOutcome(
  db: DbClient,
  claimed: ClaimedRow,
  outcome: DeliveryOutcome,
  random: () => number = Math.random,
): Promise<RecordedOutcome> {
  const { row, fence, attempt } = claimed;
  // Already counted at the claim; `recordOutcome` reports it, never
  // increments it.
  const attempts = attempt;
  const policy = retryPolicy();

  // The fenced predicate, used by every branch below.
  const owned = and(
    eq(notificationOutbox.id, row.id),
    eq(notificationOutbox.fence, fence),
  );

  const attemptOutcome =
    outcome.status === "delivered"
      ? "delivered"
      : outcome.status === "permanent"
        ? "permanent"
        : outcome.status === "unknown"
          ? "unknown"
          : "retryable";

  return db.transaction(async (tx) => {
    // "retry" is not a stored state - it is this function's way of
    // saying "the database decides between queued and expired", which
    // it does below because only the database knows what time it is.
    let state: RecordedOutcome["state"] | "retry";
    let retryWaitMs = 0;

    if (outcome.status === "delivered") {
      state = "delivered";
    } else if (outcome.status === "permanent") {
      state = "failed";
    } else if (attempts >= policy.maxAttempts) {
      state = "dead_letter";
    } else {
      state = "retry";
    }

    if (state === "retry") {
      // A provider that said Retry-After gets at least that long,
      // bounded: retrying into a stated rate limit burns an attempt to
      // learn nothing, and an unbounded Retry-After from a broken proxy
      // would park the message past its own horizon.
      const asked =
        outcome.status === "retryable"
          ? Math.min(outcome.retryAfterMs ?? 0, RETRY_AFTER_CAP_MS)
          : 0;
      retryWaitMs = Math.max(backoffMs(attempts, random), asked);
    }

    // Every timestamp here is the DATABASE's, and this function used to
    // be the one exception. It computed `now + wait` in the worker and
    // wrote it straight into `next_attempt_at` - so a worker ten
    // minutes behind the database wrote a next attempt ten minutes in
    // the PAST, no backoff was ever served, and twenty attempts burned
    // in twenty minutes instead of five hours before dead-lettering.
    // An NTP step backwards does the same thing transiently. The whole
    // retry schedule turned on a clock nobody was checking.
    //
    // The horizon comparison moved into SQL with it, for the same
    // reason: comparing a worker-computed candidate against a
    // database-generated `expires_at` is the same bug wearing a
    // different hat.
    const wait = sql`make_interval(secs => ${retryWaitMs / 1000})`;
    const overHorizon = sql`${notificationOutbox.expiresAt} is not null
      and ${notificationOutbox.expiresAt} < now() + ${wait}`;

    const [updated] = await tx
      .update(notificationOutbox)
      .set({
        state:
          state === "retry"
            ? sql`(case when ${overHorizon} then 'expired' else 'queued' end)::notification_state`
            : state,
        leasedUntil: null,
        ...(outcome.status === "delivered"
          ? {
              deliveredAt: sql`now()`,
              providerMessageId: outcome.providerMessageId,
            }
          : { lastError: outcome.error.slice(0, 2_000) }),
        ...(state === "retry"
          ? {
              nextAttemptAt: sql`(case when ${overHorizon}
                then ${notificationOutbox.nextAttemptAt}
                else now() + ${wait} end)`,
            }
          : {}),
      })
      .where(owned)
      .returning({
        id: notificationOutbox.id,
        state: notificationOutbox.state,
        nextAttemptAt: notificationOutbox.nextAttemptAt,
      });

    if (!updated) {
      // Superseded. The row belongs to a newer claim; this worker must
      // not touch it. Its own attempt row is closed as `unknown`,
      // because from here it genuinely cannot tell whether the request
      // it made arrived - and a duplicate the ledger denies is worse
      // than a duplicate it admits.
      await tx
        .update(notificationAttempts)
        .set({
          outcome: "unknown",
          finishedAt: sql`now()`,
          error: "superseded: another worker reclaimed this delivery",
        })
        .where(
          and(
            eq(notificationAttempts.outboxId, row.id),
            eq(notificationAttempts.attempt, attempts),
            eq(notificationAttempts.fence, fence),
            eq(notificationAttempts.outcome, "claimed"),
          ),
        );
      return { committed: false, state: "queued", attempts };
    }

    await tx
      .update(notificationAttempts)
      .set({
        outcome: attemptOutcome,
        finishedAt: sql`now()`,
        ...(outcome.status === "delivered"
          ? { providerMessageId: outcome.providerMessageId }
          : { error: outcome.error.slice(0, 2_000) }),
        ...(outcome.httpStatus ? { httpStatus: outcome.httpStatus } : {}),
        ...(outcome.status === "retryable" && outcome.retryAfterMs
          ? { retryAfterMs: outcome.retryAfterMs }
          : {}),
        // The schedule the database actually wrote, read back rather
        // than recomputed, so the evidence and the queue cannot
        // disagree about when the next attempt is due.
        ...(updated.state === "queued"
          ? { nextAttemptAt: updated.nextAttemptAt }
          : {}),
      })
      .where(
        and(
          eq(notificationAttempts.outboxId, row.id),
          eq(notificationAttempts.attempt, attempts),
          eq(notificationAttempts.fence, fence),
        ),
      );

    return {
      committed: true,
      // What the database actually wrote, not what this function
      // proposed - the two differ exactly when the horizon bit.
      state: updated.state as RecordedOutcome["state"],
      attempts,
      ...(updated.state === "queued"
        ? { nextAttemptAt: updated.nextAttemptAt }
        : {}),
    };
  });
}

/**
 * Returns a leased row to the queue without spending an attempt.
 *
 * This is the rate limiter's verb, not the retry path's: a deferred
 * message did nothing wrong, so it must not creep toward MAX_ATTEMPTS,
 * it just was not this minute's turn. The delay is the database's
 * clock, like every other timestamp here.
 */
export async function deferRow(
  db: DbClient,
  claimed: ClaimedRow,
  delaySeconds: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    // The DELETE decides, and the order matters. The attempt row was
    // written at claim time and nothing was sent, so it is withdrawn
    // rather than left as evidence of a send that never happened -
    // this is the one delete in the evidence table, and it is safe
    // precisely because a deferred row never reached a provider.
    //
    // But the two statements must agree or the counter drifts. The
    // delete is narrower than the decrement: it also requires the
    // attempt to still read `claimed`, which the stale-claim sweep can
    // change underneath. Running the decrement unconditionally left
    // `attempts` one below the highest attempt number that still
    // existed - and the next claim would then compute an attempt
    // number that was already taken. So: withdraw first, and give the
    // attempt back only if there was one to withdraw.
    const withdrawn = await tx
      .delete(notificationAttempts)
      .where(
        and(
          eq(notificationAttempts.outboxId, claimed.row.id),
          eq(notificationAttempts.attempt, claimed.attempt),
          eq(notificationAttempts.fence, claimed.fence),
          eq(notificationAttempts.outcome, "claimed"),
        ),
      )
      .returning({ id: notificationAttempts.id });

    // Fenced like every other write from a claim: a deferral is still
    // this worker asserting something about a row it may no longer own.
    await tx
      .update(notificationOutbox)
      .set({
        state: "queued",
        nextAttemptAt: sql`now() + make_interval(secs => ${delaySeconds})`,
        leasedUntil: null,
        ...(withdrawn.length > 0
          ? {
              attempts: sql`greatest(${notificationOutbox.attempts} - 1, 0)`,
            }
          : {}),
      })
      .where(
        and(
          eq(notificationOutbox.id, claimed.row.id),
          eq(notificationOutbox.fence, claimed.fence),
        ),
      );
  });
}

/**
 * Expires rows whose deadline passed while they were waiting.
 *
 * `recordOutcome` expires a message when its NEXT attempt would land
 * past the horizon, which covers everything that is actively failing.
 * It does not cover a row parked behind a long backoff when the
 * deadline arrives first - that row would sit until its wait elapsed
 * and only then be told it was too late.
 *
 * The cost is a scan of the partial due index, linear in how deep the
 * live queue is - not a lookup, and worth knowing before the queue is
 * a hundred thousand rows deep. It is bounded per pass for the same
 * reason the retention sweep is: the first tick after a long outage
 * would otherwise expire an entire backlog in one transaction.
 *
 * `queued` rows, and `sending` rows whose lease has already passed -
 * those belong to nobody. A row whose lease is live belongs to a
 * worker, and expiring it underneath would be the fencing violation
 * this release exists to remove; the fence bump here covers the
 * abandoned case, so a worker waking up after its lease cannot commit
 * over the expiry.
 */
export async function expireOverdue(
  db: DbClient,
  organizationId?: string,
  limit = 5_000,
): Promise<number> {
  // Bounded, and by the same argument the retention sweep is bounded:
  // the first tick after a long outage would otherwise expire the
  // entire backlog in one transaction. Anything left is taken next
  // tick, a minute later.
  const result = await db.execute(sql`
    update ${notificationOutbox} set
      state = 'expired',
      leased_until = null,
      -- Bumped so a worker holding an abandoned lease cannot commit
      -- over this. Expiring a row underneath its owner would be the
      -- same violation the fence exists to remove, which is why only
      -- rows whose lease has already passed are taken.
      fence = fence + 1
    where id in (
      select id from ${notificationOutbox}
      where expires_at is not null
        and expires_at <= now()
        ${organizationId ? sql`and organization_id = ${organizationId}` : sql``}
        and (
          state = 'queued'
          or (state = 'sending' and leased_until is not null and leased_until <= now())
        )
      limit ${limit}
    )
  `);
  return result.rowCount ?? 0;
}

/**
 * Closes attempt rows whose worker never came back.
 *
 * An attempt row is written when a delivery is claimed and completed
 * when the worker learns an outcome. A worker killed between the two
 * leaves it reading `claimed` forever. That is not a gap in the
 * evidence - it is the most important evidence the system produces,
 * because it is the only state that means "a request may have gone out
 * and nobody knows what happened to it". Left as `claimed` it looks
 * like something still in flight; turned into `unknown` it reads as
 * what it is.
 *
 * The cutoff must exceed the lease, or this would close attempts that
 * are legitimately still running.
 */
export async function sweepStaleAttempts(
  db: DbClient,
  olderThan: Date,
): Promise<number> {
  const result = await db
    .update(notificationAttempts)
    .set({
      outcome: "unknown",
      finishedAt: sql`now()`,
      error: "the worker holding this attempt never reported an outcome",
    })
    .where(
      and(
        eq(notificationAttempts.outcome, "claimed"),
        lt(notificationAttempts.startedAt, olderThan),
      ),
    );
  // `rowCount`, not `.returning()`: this sweeps a table nobody bounds,
  // and shipping every id back to Node to call `.length` on it is the
  // shape of the problem `pruneNotificationHistory` is bounded to avoid.
  return result.rowCount ?? 0;
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

/* ------------------------------------------------------------------ */
/* Retention and the operator's view of the queue                      */
/* ------------------------------------------------------------------ */

/** Terminal states: nothing further will ever happen to these rows. */
export const TERMINAL_STATES = [
  "delivered",
  "failed",
  "expired",
  "dead_letter",
] as const;

export type TerminalState = (typeof TERMINAL_STATES)[number];

export interface PruneResult {
  deliveries: number;
  /** Attempt rows removed with them, by cascade. Counted before the
   * delete so the number is real rather than inferred. */
  attempts: number;
  /** True when the cap was hit and there is more to do next run. */
  more: boolean;
}

/**
 * Removes finished deliveries past the retention window, and their
 * evidence with them.
 *
 * Three properties, and each one is a rule this function exists to
 * keep rather than a detail of how it is written.
 *
 * **It cannot touch live work.** The predicate names the terminal
 * states explicitly instead of excluding the live ones, so a state
 * added later is retained by default rather than deleted by an
 * `not in` list nobody updated. A `queued` row is not old, however old
 * it is; it is late, and deleting it would silently drop a
 * notification the outbox promised to deliver.
 *
 * **It is bounded.** A first run on an installation that has never
 * pruned could otherwise be a single delete of millions of rows
 * holding a lock for minutes. `limit` caps each pass and `more` says
 * whether to come back, so the nightly job converges over a few nights
 * instead of stalling once.
 *
 * **It is one transaction.** The attempt rows go by cascade in the
 * same statement, so there is no window where evidence outlives the
 * delivery it describes or the reverse.
 */
export async function pruneNotificationHistory(
  db: DbClient,
  retentionDays: number,
  limit = 5_000,
): Promise<PruneResult> {
  return db.transaction(async (tx) => {
    const { rows: doomed } = await tx.execute<{ id: string }>(sql`
      select id from ${notificationOutbox}
      where state in ('delivered', 'failed', 'expired', 'dead_letter')
        and created_at < now() - make_interval(days => ${retentionDays})
      order by created_at
      limit ${limit}
    `);
    if (doomed.length === 0) {
      return { deliveries: 0, attempts: 0, more: false };
    }
    const ids = doomed.map((row) => row.id);
    const [counted] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationAttempts)
      .where(inArray(notificationAttempts.outboxId, ids));
    await tx
      .delete(notificationOutbox)
      .where(inArray(notificationOutbox.id, ids));
    return {
      deliveries: ids.length,
      attempts: counted?.count ?? 0,
      more: ids.length === limit,
    };
  });
}

/**
 * What the queue looks like right now, for one organization.
 *
 * Deliberately five numbers and one timestamp rather than a page of
 * rows: the question an operator asks during an outage is "is anything
 * stuck, and how far behind am I", and a table of two thousand queued
 * messages answers neither. `oldestQueuedAt` is the one that matters -
 * it is the actual delay a page is suffering, which no per-row status
 * can show.
 */
export interface QueueHealth {
  queued: number;
  sending: number;
  /** Terminal and unhappy, within the window below. */
  failed: number;
  expired: number;
  deadLettered: number;
  /** When the oldest still-undelivered message was decided. */
  oldestQueuedAt: Date | null;
  /** Attempts that never reported an outcome, in the window. The
   * duplicate-risk counter, and normally zero. */
  unknownAttempts: number;
  windowHours: number;
}

export async function queueHealth(
  db: DbClient,
  organizationId: string,
  windowHours = 24,
): Promise<QueueHealth> {
  const [{ rows: states }, { rows: unknowns }] = await Promise.all([
    db.execute<{
      state: string;
      count: number;
      oldest: string | null;
    }>(sql`
      select state, count(*)::int as count, min(created_at)::text as oldest
      from ${notificationOutbox}
      where organization_id = ${organizationId}
        and (
          state in ('queued', 'sending')
          or created_at >= now() - make_interval(hours => ${windowHours})
        )
      group by state
    `),
    db.execute<{ count: number }>(sql`
      select count(*)::int as count
      from ${notificationAttempts}
      where organization_id = ${organizationId}
        and outcome = 'unknown'
        and started_at >= now() - make_interval(hours => ${windowHours})
    `),
  ]);

  const by = new Map(states.map((row) => [row.state, row]));
  const oldest = ["queued", "sending"]
    .map((state) => by.get(state)?.oldest)
    .filter((value): value is string => Boolean(value))
    .sort()[0];

  return {
    queued: by.get("queued")?.count ?? 0,
    sending: by.get("sending")?.count ?? 0,
    failed: by.get("failed")?.count ?? 0,
    expired: by.get("expired")?.count ?? 0,
    deadLettered: by.get("dead_letter")?.count ?? 0,
    oldestQueuedAt: oldest ? new Date(oldest) : null,
    unknownAttempts: unknowns[0]?.count ?? 0,
    windowHours,
  };
}

/** The attempt timeline for one delivery, oldest first. */
export async function attemptsFor(
  db: DbClient,
  organizationId: string,
  outboxId: string,
): Promise<(typeof notificationAttempts.$inferSelect)[]> {
  return db
    .select()
    .from(notificationAttempts)
    .where(
      and(
        eq(notificationAttempts.outboxId, outboxId),
        // Tenant-scoped in the predicate, not by an earlier check: this
        // is the statement that actually reads, and a predicate another
        // tenant's row cannot satisfy is worth more than a guard above.
        eq(notificationAttempts.organizationId, organizationId),
      ),
    )
    .orderBy(notificationAttempts.attempt);
}
