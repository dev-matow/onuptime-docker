import { and, eq, inArray } from "drizzle-orm";

import type { DbClient } from "@/db";
import { member, user } from "@/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { Incident } from "@/modules/incidents/service";
import type { Monitor } from "@/modules/monitors/service";

import {
  renderIncidentOpenedEmail,
  renderIncidentResolvedEmail,
} from "./email-templates";
import { sendEmail } from "./index";

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

export async function notifyIncidentOpened(
  db: DbClient,
  incident: Incident,
  monitor: Monitor,
): Promise<void> {
  const recipients = await recipientEmails(db, incident.organizationId);
  const email = renderIncidentOpenedEmail({
    monitorName: monitor.name,
    monitorUrl: monitor.url,
    failureThreshold: monitor.failureThreshold,
    incidentUrl: `${env.APP_URL}/incidents/${incident.id}`,
  });

  const results = await Promise.allSettled(
    recipients.map((to) => sendEmail({ to, ...email })),
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) {
    logger.warn(
      { failed, incidentId: incident.id },
      "some incident notifications failed",
    );
  }
}

export async function notifyIncidentResolved(
  db: DbClient,
  incident: Incident,
  monitor: Monitor,
): Promise<void> {
  const recipients = await recipientEmails(db, incident.organizationId);
  const email = renderIncidentResolvedEmail({
    monitorName: monitor.name,
    monitorUrl: monitor.url,
    incidentUrl: `${env.APP_URL}/incidents/${incident.id}`,
  });

  await Promise.allSettled(recipients.map((to) => sendEmail({ to, ...email })));
}
