import type { DbClient } from "@/db";
import { logger } from "@/lib/logger";
import { runNotificationDelivery } from "@/worker/jobs/notification-delivery";

/**
 * Making queued work leave now rather than on the next tick.
 *
 * Everything a transition owes is durable the moment that transition
 * commits — a dispatch intent, and then outbox rows. The worker's minute
 * tick expands and drains both, and that is the guarantee. This file is
 * only what makes an alert land in Slack within a second of the incident
 * instead of up to a minute later, and it is best-effort by
 * construction: if it dies with the process, the rows are still there.
 *
 * Scoped to one organization for the same reason the drain is: one
 * tenant's slow provider must not stall another tenant's dispatch, and a
 * server action must never inherit the whole installation's backlog of
 * provider timeouts.
 *
 * This file was `webhook-service.ts` and owned `sendIncidentWebhook` —
 * the function every incident path called AFTER committing its state.
 * That function is gone. Enqueueing a notification is now something a
 * transition does inside its own transaction, so there is nothing left
 * here to send, only a nudge.
 */

/**
 * Expands this organization's pending dispatch intents and delivers what
 * they produce, without waiting for the worker.
 *
 * Bounded by what the expansion actually created: a transition that
 * queued three messages drains three, not a whole batch. Zero drained is
 * normal and means the worker tick got there first.
 */
export async function dispatchIntentsNow(
  db: DbClient,
  organizationId: string,
): Promise<void> {
  try {
    await runNotificationDelivery(db, { organizationId, inlineBound: true });
  } catch (error) {
    logger.warn(
      { organizationId, err: error },
      "inline dispatch failed; the worker tick will retry",
    );
  }
}

/**
 * The inline drain for the paths that enqueue outbox rows directly
 * rather than through an intent — today only the remote-probe quorum
 * events, whose cause is a settled probe round rather than an incident
 * transition.
 */
export async function drainAfterDispatch(
  db: DbClient,
  organizationId: string,
  limit: number,
): Promise<void> {
  try {
    await runNotificationDelivery(db, { organizationId, limit });
  } catch (error) {
    logger.warn(
      { organizationId, err: error },
      "inline notification drain failed; the worker tick will retry",
    );
  }
}
