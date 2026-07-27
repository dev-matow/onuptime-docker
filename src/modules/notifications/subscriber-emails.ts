import { and, eq } from "drizzle-orm";

import type { DbClient } from "@/db";
import { statusPageMonitors, statusPages } from "@/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { Incident } from "@/modules/incidents/service";
import { signSubscriptionToken } from "@/modules/status-pages/access";
import { listConfirmedSubscribers } from "@/modules/status-pages/subscribers";

import { renderSubscriberIncidentEmail } from "./email-templates";
import { sendEmail } from "./index";

export type SubscriberEventKind = "opened" | "updated" | "resolved";

/**
 * Emails confirmed subscribers of EVERY published public page that lists
 * the incident's monitor. Private and password pages have no public
 * subscribers and are skipped. Mirrors the webhook seam: it is called after the
 * mutation commits and never throws — a mail problem can't fail an action.
 */
export async function notifyStatusPageSubscribers(
  db: DbClient,
  input: {
    incident: Pick<
      Incident,
      "id" | "organizationId" | "title" | "monitorId" | "source"
    >;
    kind: SubscriberEventKind;
    latestUpdate?: string;
  },
): Promise<void> {
  try {
    const pages = await db.query.statusPages.findMany({
      where: and(
        eq(statusPages.organizationId, input.incident.organizationId),
        eq(statusPages.published, true),
        eq(statusPages.visibility, "public"),
      ),
      columns: { id: true, slug: true, name: true },
    });
    if (pages.length === 0) return;

    // Every matching page, not the first. Until 0013 an organization had
    // exactly one status page and `findFirst` was correct; an
    // organization may now own several, and picking one would have
    // mailed that page's subscribers and silently skipped the rest —
    // a fan-out quietly collapsed to a single send. The listing rule is
    // applied per page for the same reason: a monitor may be on one page
    // and deliberately off another.
    const results: PromiseSettledResult<unknown>[] = [];
    for (const page of pages) {
      // The same rule the page itself follows, applied before the mail
      // leaves the building: a monitor the operator kept off the page
      // does not get its name mailed to that page's subscribers.
      //
      // Keyed on `source` for the same reason `publicIncidents` is —
      // `monitor_id` is `ON DELETE SET NULL`, so a NULL id means either
      // "hand-written announcement" or "the monitor has since been
      // deleted", and only the first may go out. A `monitor` incident
      // whose id is gone cannot be checked against any page's component
      // list, so it does not go out at all.
      if (input.incident.source !== "manual") {
        const { monitorId } = input.incident;
        if (monitorId === null) return;
        const listed = await db.query.statusPageMonitors.findFirst({
          where: and(
            eq(statusPageMonitors.statusPageId, page.id),
            eq(statusPageMonitors.monitorId, monitorId),
          ),
          columns: { monitorId: true },
        });
        if (!listed) continue;
      }

      const subscribers = await listConfirmedSubscribers(db, page.id);
      if (subscribers.length === 0) continue;

      const base = `${env.APP_URL}/status/${page.slug}`;
      results.push(
        ...(await Promise.allSettled(
          subscribers.map((subscriber) => {
            const email = renderSubscriberIncidentEmail({
              pageName: page.name,
              incidentTitle: input.incident.title,
              kind: input.kind,
              statusUrl: base,
              unsubscribeUrl: `${base}/unsubscribe?token=${signSubscriptionToken(subscriber.id)}`,
              latestUpdate: input.latestUpdate,
            });
            return sendEmail({ to: subscriber.email, ...email });
          }),
        )),
      );
    }

    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      logger.warn(
        { failed, incidentId: input.incident.id },
        "some subscriber notifications failed",
      );
    }
  } catch (error) {
    logger.warn(
      { err: error, incidentId: input.incident.id },
      "subscriber notification failed",
    );
  }
}
