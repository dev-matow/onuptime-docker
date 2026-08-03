import type { DbClient } from "@/db";
import { logger } from "@/lib/logger";
import { sendEmail, type EmailTransport } from "@/modules/notifications";
import { deliverChannelRow } from "@/modules/notifications/channel-service";
import {
  claimDue,
  deferRow,
  MAX_ATTEMPTS,
  recordOutcome,
  renewLease,
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
 * How many messages one tick takes.
 *
 * Bounded rather than "everything due": an unbounded drain after a long
 * provider outage would open a thousand concurrent HTTP requests and
 * turn the recovery into a second outage.
 *
 * The number went up with the channel cap. At 25 a minute, an event
 * fanned out to a thousand channels finished paging forty minutes after
 * the incident, and one tenant's fan-out sat in front of every other
 * tenant's alerts, because the scheduled pass is global and ordered by
 * due time. That was survivable when an organization could own twenty
 * channels and is not now that it can own any number.
 *
 * 250 with a concurrency of 8 rather than 250 sequential: the batch is
 * the unit of work, and the bound that matters for a provider is the
 * per-channel limit below, not the size of the batch. `docs/
 * NOTIFICATIONS.md` publishes the resulting rate rather than implying
 * the only limits are the providers' own.
 */
const BATCH_SIZE = 250;

/**
 * How many deliveries are in flight at once within a batch.
 *
 * Sequential was the old shape and it made the batch size a latency
 * multiplier: 25 rows against a provider taking its full timeout was
 * four minutes of wall clock for 25 messages.
 *
 * Four, and the number is tied to the connection pool rather than
 * chosen for throughput. Each delivery takes a connection three times
 * (renew the lease, load the channel, record the outcome) and the pool
 * is `max: 10`, shared with the web application and every other worker
 * job. At eight this loop could hold most of the pool at once; the
 * first full-suite run after raising it produced an unrelated test
 * failing to get a connection, which is the same starvation an operator
 * would see as a slow dashboard during a large fan-out. Four leaves
 * more than half the pool for everything else and still drains a batch
 * four times faster than sequentially.
 *
 * Raise this only together with the pool.
 */
const DELIVERY_CONCURRENCY = 4;

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
  failed: number;
  deferred: number;
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
}

export async function runNotificationDelivery(
  db: DbClient,
  options: DeliveryOptions = {},
): Promise<DeliveryTickResult> {
  const send = options.send ?? sendEmail;
  const limit = Math.max(1, Math.min(options.limit ?? BATCH_SIZE, BATCH_SIZE));
  const claimed = await claimDue(db, limit, options.organizationId);
  const result: DeliveryTickResult = {
    claimed: claimed.length,
    delivered: 0,
    retrying: 0,
    failed: 0,
    deferred: 0,
  };

  // The per-channel limit is decided up front, over the whole batch,
  // because it is a property of the batch and not of whichever order
  // the workers happen to pick rows up in.
  const perChannel = new Map<string, number>();
  const sendable: OutboxRow[] = [];
  for (const row of claimed) {
    if (row.channelId) {
      const sent = perChannel.get(row.channelId) ?? 0;
      if (sent >= CHANNEL_RATE_LIMIT_PER_TICK) {
        await deferRow(db, row, DEFER_SECONDS);
        result.deferred++;
        continue;
      }
      perChannel.set(row.channelId, sent + 1);
    }
    sendable.push(row);
  }

  async function deliverOne(row: OutboxRow): Promise<void> {
    let outcome: DeliveryOutcome;
    try {
      // Restart the lease clock at the send, so a row waiting behind
      // seven slow ones does not inherit what is left of a lease taken
      // when the batch was claimed.
      await renewLease(db, row.id);
      outcome = await deliver(db, row, send, options.net ?? {});
    } catch (error) {
      // A transport that throws instead of returning an outcome is a
      // bug, but it must not take the batch down with it — the other
      // messages in this tick are unrelated.
      outcome = {
        status: "retryable",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    await recordOutcome(db, row, outcome);

    if (outcome.status === "delivered") {
      result.delivered++;
      return;
    }

    // Mirrors `recordOutcome`'s rule: a retryable failure that has used
    // its last attempt is just as final as a permanent one, and an
    // operator reading this tally needs it counted that way.
    const attempts = row.attempts + 1;
    const givenUp = outcome.status === "permanent" || attempts >= MAX_ATTEMPTS;
    if (givenUp) result.failed++;
    else result.retrying++;

    logger.warn(
      {
        outboxId: row.id,
        channel: row.channel,
        destination: row.destination,
        attempts,
        status: givenUp ? "failed" : "retrying",
        error: outcome.error,
      },
      "notification delivery attempt failed",
    );
  }

  // A fixed pool rather than `Promise.all` over the batch: the point of
  // the bound is that a recovering provider sees a civil number of
  // connections, and `all` over 250 rows is exactly the flood the batch
  // size exists to prevent.
  const queue = [...sendable];
  const workers = Array.from(
    { length: Math.min(DELIVERY_CONCURRENCY, queue.length) },
    async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        await deliverOne(row);
      }
    },
  );
  await Promise.all(workers);

  return result;
}
