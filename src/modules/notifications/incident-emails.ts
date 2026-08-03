import { and, eq, inArray } from "drizzle-orm";

import type { DbClient } from "@/db";
import { member, user } from "@/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { Incident } from "@/modules/incidents/service";
import { describeMonitorTarget } from "@/modules/monitors/spec";
import type { Monitor } from "@/modules/monitors/service";

import {
  renderIncidentOpenedEmail,
  renderIncidentResolvedEmail,
} from "./email-templates";
import { enqueue } from "./outbox";

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
 * Queues one message per recipient, in the caller's transaction.
 *
 * These used to be `Promise.allSettled` over a transport that could not
 * fail, counting rejections that could never happen. Nothing was durable:
 * a crash mid-fan-out lost the remaining recipients with no record, and
 * a provider 500 was a log line. Now the intent commits with its cause
 * and the outbox worker owns delivery.
 *
 * The idempotency key is derived from (incident, event, recipient), so a
 * job delivered twice — which pg-boss permits — enqueues nothing the
 * second time.
 */
async function enqueueIncidentEmails(
  db: DbClient,
  incident: Incident,
  event: "opened" | "resolved",
  email: { subject: string; text: string; html?: string },
): Promise<number> {
  const recipients = await recipientEmails(db, incident.organizationId);
  let queued = 0;
  for (const to of recipients) {
    const row = await enqueue(db, {
      organizationId: incident.organizationId,
      idempotencyKey: `incident:${incident.id}:${event}:${to}`,
      channel: "email",
      event: event === "opened" ? "incident.opened" : "incident.resolved",
      destination: to,
      payload: { ...email },
    });
    if (row) queued++;
  }
  if (recipients.length === 0) {
    // Not an error, but not nothing either: an organization whose only
    // members are viewers has nobody to page, and that is worth being
    // able to find in a log when someone asks why they heard nothing.
    logger.warn(
      { incidentId: incident.id, event },
      "no recipients to notify for incident",
    );
  }
  return queued;
}

export async function notifyIncidentOpened(
  db: DbClient,
  incident: Incident,
  monitor: Monitor,
): Promise<void> {
  await enqueueIncidentEmails(
    db,
    incident,
    "opened",
    renderIncidentOpenedEmail({
      monitorName: monitor.name,
      monitorUrl: describeMonitorTarget(monitor),
      failureWindowSeconds: monitor.failureWindowSeconds,
      incidentUrl: `${env.APP_URL}/incidents/${incident.id}`,
    }),
  );
}

export async function notifyIncidentResolved(
  db: DbClient,
  incident: Incident,
  monitor: Monitor,
): Promise<void> {
  await enqueueIncidentEmails(
    db,
    incident,
    "resolved",
    renderIncidentResolvedEmail({
      monitorName: monitor.name,
      monitorUrl: describeMonitorTarget(monitor),
      incidentUrl: `${env.APP_URL}/incidents/${incident.id}`,
    }),
  );
}
