import { and, eq } from "drizzle-orm";

import type { DbClient } from "@/db";
import {
  statusPageMonitors,
  statusPages,
  statusPageSubscribers,
} from "@/db/schema";
import { env } from "@/lib/env";
import { signSubscriptionToken } from "@/modules/status-pages/access";
import { listConfirmedSubscribers } from "@/modules/status-pages/subscribers";

import { renderSubscriberIncidentEmail } from "./email-templates";
import type { IntentSubscribers } from "./intents";
import type { EmailTransport } from "./index";
import {
  enqueueMany,
  type DeliveryOutcome,
  type OutboxMessage,
  type OutboxRow,
} from "./outbox";

export type SubscriberEventKind = "opened" | "updated" | "resolved";

/**
 * What a queued subscriber email stores. Deliberately NOT the rendered
 * message: see `deliverSubscriberEmail`.
 */
export interface SubscriberEmailPayload {
  kind: "subscriber-incident";
  subscriberId: string;
  pageId: string;
  pageName: string;
  pageSlug: string;
  incidentTitle: string;
  event: SubscriberEventKind;
  latestUpdate?: string;
}

export function isSubscriberPayload(
  payload: unknown,
): payload is SubscriberEmailPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { kind?: unknown }).kind === "subscriber-incident"
  );
}

/**
 * What the delivery ledger is allowed to show for a subscriber row.
 *
 * The other email rows in this table are addressed to staff of the
 * organization reading the ledger, and their addresses are on the
 * members page anyway. A status-page subscriber is somebody else
 * entirely — a customer of the customer, who gave an address to a public
 * page and not to an operator console. Storing it in a column the
 * operator UI renders verbatim would put an audience list nobody asked
 * for into the product, and into every backup. The real address is read
 * at delivery from the row that owns it.
 */
function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "subscriber";
  const local = address.slice(0, at);
  const domain = address.slice(at);
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(local.length - 1, 1))}${domain}`;
}

/** Which outbox `event` a public lifecycle kind is recorded under, so
 * subscriber mail sits in the same ledger, filtered the same way, as
 * everything else the incident produced. */
const EVENT_OF: Record<SubscriberEventKind, string> = {
  opened: "incident.opened",
  updated: "incident.updated",
  resolved: "incident.resolved",
};

/**
 * Queues one message per confirmed subscriber of every published public
 * page that lists the incident's monitor.
 *
 * **This used to be the last direct mail transport in the product.** It
 * called `sendEmail` in a `Promise.allSettled` and counted the
 * rejections, which bought exactly nothing: a transport failure was a
 * log line, a crash mid-fan-out lost every remaining subscriber with no
 * record they were owed anything, and there was no retry, no attempt
 * evidence, no dead letter and no ledger entry - for the one audience
 * in this product that is not staff. Customers of the customer heard
 * about an outage or did not, and nobody could tell which.
 *
 * Now it enqueues, in the expansion transaction, and the outbox owns
 * delivery: the same retry schedule, the same fencing, the same
 * append-only attempts, the same redaction and retention, the same dead
 * letter. One subscriber's provider rejection cannot affect another's,
 * because they are separate rows by construction rather than separate
 * promises in one fan-out.
 *
 * Recipient selection is unchanged and is deliberately resolved HERE
 * rather than stored in the intent: a subscriber who confirmed while
 * the outage was being processed is a subscriber, and a page unpublished
 * in that window is not one.
 */
export async function enqueueSubscriberEmails(
  tx: DbClient,
  organizationId: string,
  input: IntentSubscribers,
): Promise<number> {
  // A monitor incident whose monitor id is gone cannot be checked
  // against any page's component list, so it reaches nobody.
  //
  // Keyed on `source` for the same reason `publicIncidents` is:
  // `monitor_id` is ON DELETE SET NULL, so a null id means either
  // "hand-written announcement" or "the monitor has since been
  // deleted", and only the first may go out.
  const listedMonitorId = input.source === "manual" ? null : input.monitorId;
  if (input.source !== "manual" && listedMonitorId === null) return 0;

  const pages = await tx.query.statusPages.findMany({
    where: and(
      eq(statusPages.organizationId, organizationId),
      eq(statusPages.published, true),
      eq(statusPages.visibility, "public"),
    ),
    columns: { id: true, slug: true, name: true },
  });
  if (pages.length === 0) return 0;

  const messages: OutboxMessage[] = [];
  // Every matching page, not the first. Until 0013 an organization had
  // exactly one status page and `findFirst` was correct; an
  // organization may now own several, and picking one would have mailed
  // that page's subscribers and silently skipped the rest. The listing
  // rule is applied per page for the same reason: a monitor may be on
  // one page and deliberately off another.
  for (const page of pages) {
    if (listedMonitorId !== null) {
      const listed = await tx.query.statusPageMonitors.findFirst({
        where: and(
          eq(statusPageMonitors.statusPageId, page.id),
          eq(statusPageMonitors.monitorId, listedMonitorId),
        ),
        columns: { monitorId: true },
      });
      if (!listed) continue;
    }

    const subscribers = await listConfirmedSubscribers(tx, page.id);
    if (subscribers.length === 0) continue;

    for (const subscriber of subscribers) {
      const payload: SubscriberEmailPayload = {
        kind: "subscriber-incident",
        subscriberId: subscriber.id,
        pageId: page.id,
        pageName: page.name,
        pageSlug: page.slug,
        incidentTitle: input.incidentTitle,
        event: input.kind,
        ...(input.latestUpdate ? { latestUpdate: input.latestUpdate } : {}),
      };
      messages.push({
        organizationId,
        // Per page AND per subscriber: one address confirmed on two of
        // an organization's pages is subscribed twice and hears twice,
        // which is what it asked for, and a re-expansion must not
        // collapse those into one.
        idempotencyKey: `${input.causeKey}:page:${page.id}:sub:${subscriber.id}`,
        channel: "email",
        event: EVENT_OF[input.kind],
        destination: maskEmail(subscriber.email),
        payload: payload as unknown as Record<string, unknown>,
      });
    }
  }

  return enqueueMany(tx, messages);
}

/**
 * Renders and sends one queued subscriber email.
 *
 * The message is built here rather than at enqueue, which is the
 * opposite of every other row in the outbox and is deliberate for three
 * reasons that all come from the same fact: a queued row is durable, and
 * this one would otherwise carry a credential.
 *
 *  - The unsubscribe link is a non-expiring bearer token. Stored in
 *    `payload` it would sit in the delivery ledger, in the operator UI
 *    and in every backup, for anyone with read access to either.
 *  - Minting it here means the link honours a `BETTER_AUTH_SECRET`
 *    rotation instead of shipping a signature that no longer verifies.
 *  - `unsubscribeByToken` DELETEs the subscriber row. Between enqueue
 *    and delivery — milliseconds before this was a queue, up to the
 *    retry horizon now — somebody can unsubscribe, and a message that
 *    renders from the row cannot be sent to a row that is gone.
 *
 * Everything else about the message was decided at the transition and is
 * in the payload, so this reads exactly one row and renders.
 */
export async function deliverSubscriberEmail(
  db: DbClient,
  row: OutboxRow,
  send: EmailTransport["send"],
): Promise<DeliveryOutcome> {
  const payload = row.payload as unknown as SubscriberEmailPayload;
  const subscriber = await db.query.statusPageSubscribers.findFirst({
    where: and(
      eq(statusPageSubscribers.id, payload.subscriberId),
      eq(statusPageSubscribers.statusPageId, payload.pageId),
    ),
    columns: { id: true, email: true, confirmedAt: true },
  });
  if (!subscriber || !subscriber.confirmedAt) {
    // Unsubscribed, or the page was deleted, between the incident and
    // now. Permanent rather than a retry: there is nobody to deliver to,
    // and the ledger should say so rather than count six hours of
    // attempts against an address that withdrew consent.
    return {
      status: "permanent",
      error: "The subscriber unsubscribed before this could be delivered.",
    };
  }

  const base = `${env.APP_URL}/status/${payload.pageSlug}`;
  const email = renderSubscriberIncidentEmail({
    pageName: payload.pageName,
    incidentTitle: payload.incidentTitle,
    kind: payload.event,
    statusUrl: base,
    unsubscribeUrl: `${base}/unsubscribe?token=${signSubscriptionToken(subscriber.id)}`,
    ...(payload.latestUpdate ? { latestUpdate: payload.latestUpdate } : {}),
  });
  return send({
    to: subscriber.email,
    subject: email.subject,
    text: email.text,
    html: email.html,
    idempotencyKey: row.id,
  });
}
