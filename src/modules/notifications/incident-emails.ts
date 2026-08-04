import { and, eq, inArray } from "drizzle-orm";

import type { DbClient } from "@/db";
import { member, user } from "@/db/schema";
import { logger } from "@/lib/logger";

import type { IntentEmail } from "./intents";
import { enqueueMany, type OutboxMessage } from "./outbox";

/** Roles that get paged. Viewers watch dashboards; they don't get email. */
const NOTIFIED_ROLES = ["owner", "admin", "responder"];

async function recipientEmails(
  db: DbClient,
  organizationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ email: user.email })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(member.role, NOTIFIED_ROLES),
      ),
    );
  return rows.map((row) => row.email);
}

/**
 * Queues the responder page: one message per member who gets paged.
 *
 * These used to be `Promise.allSettled` over a transport that could not
 * fail, counting rejections that could never happen. Nothing was
 * durable: a crash mid-fan-out lost the remaining recipients with no
 * record, and a provider 500 was a log line. Now the outbox owns
 * delivery and this only decides who.
 *
 * The message itself was rendered when the incident transitioned, not
 * here — see `intents.ts`. The RECIPIENTS are resolved here, at
 * expansion, and the difference matters in one direction: an operator
 * who joined the organization during an outage should hear how it ends.
 *
 * The idempotency key is derived from (incident, event, recipient), so
 * an expansion that runs twice — which a crash makes possible — enqueues
 * nothing the second time.
 */
export async function enqueueMemberEmails(
  db: DbClient,
  organizationId: string,
  email: IntentEmail,
): Promise<number> {
  const recipients = await recipientEmails(db, organizationId);
  if (recipients.length === 0) {
    // Not an error, but not nothing either: an organization whose only
    // members are viewers has nobody to page, and that is worth being
    // able to find in a log when someone asks why they heard nothing.
    logger.warn(
      { causeKey: email.causeKey },
      "no recipients to notify for incident",
    );
    return 0;
  }
  const messages: OutboxMessage[] = recipients.map((to) => ({
    organizationId,
    idempotencyKey: `${email.causeKey}:${to}`,
    channel: "email" as const,
    event: email.event,
    destination: to,
    payload: {
      subject: email.subject,
      text: email.text,
      ...(email.html ? { html: email.html } : {}),
    },
  }));
  return enqueueMany(db, messages);
}
