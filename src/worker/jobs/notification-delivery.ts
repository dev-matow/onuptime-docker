import type { DbClient } from "@/db";
import { logger } from "@/lib/logger";
import { sendEmail, type EmailTransport } from "@/modules/notifications";
import {
  claimDue,
  MAX_ATTEMPTS,
  recordOutcome,
  type DeliveryOutcome,
  type OutboxRow,
} from "@/modules/notifications/outbox";

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
 * turn the recovery into a second outage. Sequential within the batch
 * for the same reason — one slow provider must not be amplified.
 */
const BATCH_SIZE = 25;

export interface DeliveryTickResult {
  claimed: number;
  delivered: number;
  retrying: number;
  failed: number;
}

async function deliver(
  row: OutboxRow,
  send: EmailTransport["send"],
): Promise<DeliveryOutcome> {
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
}

export async function runNotificationDelivery(
  db: DbClient,
  options: DeliveryOptions = {},
): Promise<DeliveryTickResult> {
  const send = options.send ?? sendEmail;
  const claimed = await claimDue(db, BATCH_SIZE, options.organizationId);
  const result: DeliveryTickResult = {
    claimed: claimed.length,
    delivered: 0,
    retrying: 0,
    failed: 0,
  };

  for (const row of claimed) {
    let outcome: DeliveryOutcome;
    try {
      outcome = await deliver(row, send);
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
      continue;
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

  return result;
}
