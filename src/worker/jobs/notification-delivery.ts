import type { DbClient } from "@/db";
import { poolStats } from "@/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { sendEmail, type EmailTransport } from "@/modules/notifications";
import { deliverChannelRow } from "@/modules/notifications/channel-service";
import { expandPendingIntents } from "@/modules/notifications/intent-expansion";
import {
  deliverSubscriberEmail,
  isSubscriberPayload,
} from "@/modules/notifications/subscriber-emails";
import {
  claimDue,
  deferRow,
  expireOverdue,
  recordOutcome,
  renewLease,
  type ClaimedRow,
  type DeliveryOutcome,
  type OutboxRow,
} from "@/modules/notifications/outbox";
import type { ProviderNet } from "@/modules/notifications/providers";

/**
 * Drains the notification outbox.
 *
 * Separate from the job that decided to notify, and that separation is
 * the point: the decision commits with its cause, and delivery is a
 * retryable, observable, restartable thing that happens afterwards. A
 * crash here loses nothing — the rows are still queued, their leases
 * expire, and the next tick picks them up.
 *
 * Not a pg-boss job payload, because there is nothing to put in one.
 * The queue is the table, and pg-boss's own retry semantics are exactly
 * what this replaces: a pg-boss retry re-runs the whole enqueueing job,
 * which is how "retrying the job pages everyone a second time" happened.
 */

/**
 * How many messages one tick takes, and how many go at once.
 *
 * Both are configurable now (`NOTIFICATION_BATCH_SIZE`,
 * `NOTIFICATION_DELIVERY_CONCURRENCY`) because the right value depends
 * on the installation, and because a limit nobody can see or change is
 * indistinguishable from a bug when it bites.
 *
 * Bounded rather than "everything due": an unbounded drain after a long
 * provider outage would open thousands of concurrent requests and turn
 * the recovery into a second outage.
 *
 * The concurrency DEFAULT is derived from the connection pool rather
 * than typed as a constant, because that is what actually constrains
 * it. Each delivery takes a connection several times - claim, load the
 * channel, record the outcome - and the pool is shared with the web
 * application and every other worker job. Forty per cent of the pool
 * leaves more than half for everything else; at the shipped pool of ten
 * that is four, which is the number this was hard-coded to after a
 * raise to eight made an unrelated test fail to get a connection. The
 * difference is that it now moves with the pool instead of silently
 * becoming wrong when somebody raises it.
 */
function batchSize(): number {
  return env.NOTIFICATION_BATCH_SIZE;
}

function deliveryConcurrency(): number {
  if (env.NOTIFICATION_DELIVERY_CONCURRENCY) {
    return env.NOTIFICATION_DELIVERY_CONCURRENCY;
  }
  return Math.max(2, Math.floor(poolStats().max * 0.4));
}

/**
 * At most this many messages per configured channel per tick. A
 * provider outage that queued a burst then drains at a civil pace
 * instead of hammering the provider the moment it recovers, and one
 * noisy channel cannot monopolize the batch. Deferred rows spend no
 * attempt - see `deferRow`.
 */
const CHANNEL_RATE_LIMIT_PER_TICK = 10;
const DEFER_SECONDS = 60;

export interface DeliveryTickResult {
  claimed: number;
  delivered: number;
  retrying: number;
  /** Terminal and unhappy: permanent, dead-lettered or expired. */
  failed: number;
  deferred: number;
  /** Retired by the horizon before anything was attempted this tick. */
  expired: number;
  /** Claims whose fence had moved by the time they reported. Normally
   * zero; above zero means leases are expiring under live work. */
  superseded: number;
  /** Dispatch intents turned into outbox rows before the drain. */
  expanded: number;
  /** Intents that could not be expanded. Never normal: an expansion
   * touches nothing but this database, so a failure is a bug or an
   * outage, not a provider. */
  intentsFailed: number;
}

async function deliver(
  db: DbClient,
  row: OutboxRow,
  send: EmailTransport["send"],
  net: ProviderNet,
): Promise<DeliveryOutcome> {
  if (row.channel === "channel") {
    return deliverChannelRow(db, row, net);
  }
  if (row.channel === "email") {
    // Status-page subscriber mail is rendered at DELIVERY, not at
    // enqueue, and it is the only email that is. Two reasons, both about
    // what a queued row is allowed to contain: the unsubscribe link is a
    // non-expiring bearer token, and a row sits in this table for up to
    // the retention period, is rendered in the operator's delivery
    // history and is in every backup. Minting it here also means the
    // link honours a secret rotation instead of shipping a signature
    // that will no longer verify.
    //
    // The re-read is not only about the token. `unsubscribeByToken`
    // DELETEs the row, so between enqueue and delivery - milliseconds
    // before this was a queue, up to six hours now - somebody can
    // unsubscribe. Rendering here is what makes that stick.
    if (isSubscriberPayload(row.payload)) {
      return deliverSubscriberEmail(db, row, send);
    }
    const payload = row.payload as {
      subject?: string;
      text?: string;
      html?: string;
    };
    if (!payload.subject || !payload.text) {
      // A row that cannot be rendered will never become deliverable, so
      // it is permanent rather than a retry loop that never converges.
      return {
        status: "permanent",
        error: "outbox payload is missing subject or text",
      };
    }
    return send({
      to: row.destination,
      subject: payload.subject,
      text: payload.text,
      ...(payload.html ? { html: payload.html } : {}),
      // The row id, not the logical key: Resend dedupes on this, and
      // the logical key is already unique per row, so either works —
      // the id is the one that stays stable if a key format ever changes.
      idempotencyKey: row.id,
    });
  }

  // `webhook` rows are enqueued by the webhook service, which owns its
  // own signing and its own egress policy. Routing them from here would
  // duplicate both.
  return {
    status: "permanent",
    error: `no transport for channel ${row.channel}`,
  };
}

export interface DeliveryOptions {
  /** Drain one tenant only — see `claimDue` on why that exists. */
  organizationId?: string;
  /**
   * The transport to deliver with.
   *
   * Passed rather than reached for. `sendEmail` resolves a module-level
   * singleton, which is fine for the one worker process that runs in
   * production but makes the transport ambient — anything that swaps it
   * changes the behaviour of every caller, including concurrently.
   * Taking it as an argument makes the dependency visible and the tick
   * independently drivable.
   */
  send?: EmailTransport["send"];
  /** Network seams for provider deliveries, for tests. */
  net?: ProviderNet;
  /**
   * How many messages this pass may take, capped at `BATCH_SIZE`.
   *
   * The scheduled tick wants the whole batch. The inline drain that
   * follows a dispatch does not: it runs inside a server action, and a
   * full batch of rows each allowed a ten-second provider timeout is
   * four minutes of synchronous work in somebody's request. It asks
   * only for the budget its own dispatch created.
   */
  limit?: number;
  /**
   * Bound this pass to whatever its own intent expansion produced, when
   * the caller cannot know that number in advance.
   *
   * The inline path after a transition is the only user: it commits an
   * intent, then asks for the messages that intent turns into and
   * nothing else. Without it the request would inherit the tenant's
   * whole backlog; with a fixed number it would either truncate a large
   * fan-out or over-claim a small one.
   */
  inlineBound?: boolean;
}

export async function runNotificationDelivery(
  db: DbClient,
  options: DeliveryOptions = {},
): Promise<DeliveryTickResult> {
  const send = options.send ?? sendEmail;
  const cap = batchSize();

  // First: turn committed dispatch intents into outbox rows. A tick
  // that drained without expanding would deliver everything except the
  // notifications whose transitions committed since the last one.
  const expansion = await expandPendingIntents(db, {
    ...(options.organizationId
      ? { organizationId: options.organizationId }
      : {}),
  });

  // An inline pass takes only what its own expansion produced. That is
  // the path running inside a server action or a check worker: it asks
  // for the budget its own transition created and leaves the rest of the
  // tenant's backlog to the tick, which is what stops one request
  // inheriting a batch of ten-second provider timeouts.
  //
  // Stated by the caller rather than inferred from `organizationId`
  // being set. Inferring it made every scoped drain in the product
  // silently take one row.
  const claimBudget =
    options.limit ??
    (options.inlineBound ? Math.max(expansion.queued, 1) : cap);
  const limit = Math.max(1, Math.min(claimBudget, cap));

  // Before claiming anything: retire whatever ran out of horizon while
  // it was waiting. Cheap, indexed, and it keeps the deadline honest
  // for rows parked behind a long backoff - see `expireOverdue`.
  const expired = await expireOverdue(db, options.organizationId);

  const claimed = await claimDue(db, limit, options.organizationId);
  const result: DeliveryTickResult = {
    claimed: claimed.length,
    delivered: 0,
    retrying: 0,
    failed: 0,
    deferred: 0,
    expired,
    superseded: 0,
    expanded: expansion.expanded,
    intentsFailed: expansion.failed,
  };

  // The per-channel limit is decided up front, over the whole batch,
  // because it is a property of the batch and not of whichever order
  // the workers happen to pick rows up in.
  const perChannel = new Map<string, number>();
  const sendable: ClaimedRow[] = [];
  for (const claim of claimed) {
    const { row } = claim;
    if (row.channelId) {
      const sent = perChannel.get(row.channelId) ?? 0;
      if (sent >= CHANNEL_RATE_LIMIT_PER_TICK) {
        await deferRow(db, claim, DEFER_SECONDS);
        result.deferred++;
        continue;
      }
      perChannel.set(row.channelId, sent + 1);
    }
    sendable.push(claim);
  }

  async function deliverOne(claim: ClaimedRow): Promise<void> {
    const { row } = claim;
    let outcome: DeliveryOutcome;
    try {
      // Restart the lease clock at the send, so a row waiting behind
      // seven slow ones does not inherit what is left of a lease taken
      // when the batch was claimed. Fenced: a worker that already lost
      // the row does not get to extend a lease it no longer holds.
      //
      // And if it has lost it, it does not get to SEND either. The fence
      // decides whose result counts, which is a rule about the ledger; a
      // second copy of a page has already reached the human by the time
      // the ledger refuses it. This is the only place that can tell in
      // time, because it is the last thing that happens before the send.
      if (!(await renewLease(db, row.id, claim.fence))) {
        result.superseded++;
        logger.warn(
          { outboxId: row.id, fence: claim.fence, attempt: claim.attempt },
          "notification lease was lost before the send; not delivering",
        );
        return;
      }
      outcome = await deliver(db, row, send, options.net ?? {});
    } catch (error) {
      // A transport that throws instead of returning an outcome is a
      // bug, but it must not take the batch down with it - the other
      // messages in this tick are unrelated. `unknown` rather than
      // `retryable`: a throw from inside a transport can happen after
      // the request went out, and this path cannot tell.
      outcome = {
        status: "unknown",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const recorded = await recordOutcome(db, claim, outcome);

    if (!recorded.committed) {
      // The fence had moved: another worker owns this delivery now, and
      // this one wrote nothing but its own `unknown` attempt. Counted
      // and logged, because a non-zero number here means leases are
      // expiring under live work and the operator should know.
      result.superseded++;
      logger.warn(
        { outboxId: row.id, fence: claim.fence, attempt: claim.attempt },
        "notification delivery was superseded by another worker",
      );
      return;
    }

    if (recorded.state === "delivered") {
      result.delivered++;
      return;
    }
    if (recorded.state === "queued") {
      result.retrying++;
    } else {
      result.failed++;
    }

    logger.warn(
      {
        outboxId: row.id,
        channel: row.channel,
        destination: row.destination,
        attempts: recorded.attempts,
        status: recorded.state,
        nextAttemptAt: recorded.nextAttemptAt,
        error: "error" in outcome ? outcome.error : undefined,
      },
      "notification delivery attempt failed",
    );
  }

  // A fixed pool rather than `Promise.all` over the batch: the point of
  // the bound is that a recovering provider sees a civil number of
  // connections, and `all` over a full batch is exactly the flood the
  // batch size exists to prevent.
  const queue = [...sendable];
  const workers = Array.from(
    { length: Math.min(deliveryConcurrency(), queue.length) },
    async () => {
      for (;;) {
        const claim = queue.shift();
        if (!claim) return;
        await deliverOne(claim);
      }
    },
  );
  await Promise.all(workers);

  return result;
}
