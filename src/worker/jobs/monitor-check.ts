import { eq } from "drizzle-orm";

import { db } from "@/db";
import { monitors } from "@/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  openMonitorIncident,
  resolveMonitorIncidents,
  type Incident,
} from "@/modules/incidents/service";
import { performHttpCheck } from "@/modules/monitors/check";
import { recordCheckOutcome, type Monitor } from "@/modules/monitors/service";
import {
  notifyIncidentOpened,
  notifyIncidentResolved,
} from "@/modules/notifications/incident-emails";
import { sendIncidentWebhook } from "@/modules/notifications/webhook-service";

const log = logger.child({ job: "monitor-check" });

export interface MonitorCheckDeps {
  fetchImpl?: typeof fetch;
  allowPrivateTargets?: boolean;
}

/**
 * Webhooks + the human page for a newly opened monitor incident: the
 * signed webhook (which also carries the Slack/Discord formatting) and
 * an email to the team.
 */
export async function sendOpenedNotifications(
  incident: Incident,
  monitor: Monitor,
): Promise<void> {
  await sendIncidentWebhook(db, { event: "monitor.down", incident, monitor });
  await sendIncidentWebhook(db, {
    event: "incident.opened",
    incident,
    monitor,
  });
  await notifyIncidentOpened(db, incident, monitor);
}

/**
 * Runs one monitor's HTTP probe and applies the consequences: persist
 * the check, advance monitor state, open/resolve incidents and notify.
 * Never throws for per-monitor problems — the next tick re-enqueues,
 * so a retry here would only double-probe a struggling target.
 */
export async function runMonitorCheck(
  monitorId: string,
  deps: MonitorCheckDeps = {},
): Promise<void> {
  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, monitorId),
  });
  if (!monitor || monitor.paused) return;

  const outcome = await performHttpCheck(
    {
      url: monitor.url,
      method: monitor.method,
      timeoutMs: monitor.timeoutMs,
      degradedThresholdMs: monitor.degradedThresholdMs,
      expectedStatusCode: monitor.expectedStatusCode,
      bodyKeyword: monitor.bodyKeyword,
      keywordAbsent: monitor.keywordAbsent,
    },
    {
      allowPrivateTargets:
        deps.allowPrivateTargets ?? env.ALLOW_PRIVATE_MONITOR_TARGETS,
      fetchImpl: deps.fetchImpl,
    },
  );

  const {
    monitor: updated,
    becameDown,
    becameUp,
  } = await recordCheckOutcome(db, monitor, outcome);

  log.debug(
    {
      monitorId,
      ok: outcome.ok,
      statusCode: outcome.statusCode,
      responseTimeMs: outcome.responseTimeMs,
      status: updated.currentStatus,
    },
    "check completed",
  );

  if (becameDown) {
    const incident = await openMonitorIncident(
      db,
      updated,
      outcome.error ?? "check failed",
    );
    if (incident) {
      log.warn({ monitorId, incidentId: incident.id }, "incident opened");
      await sendOpenedNotifications(incident, updated);
    }
  } else if (becameUp) {
    const resolved = await resolveMonitorIncidents(db, updated);
    for (const incident of resolved) {
      log.info(
        { monitorId, incidentId: incident.id },
        "incident auto-resolved",
      );
      await notifyIncidentResolved(db, incident, updated);
      await sendIncidentWebhook(db, {
        event: "monitor.up",
        incident,
        monitor: updated,
      });
      await sendIncidentWebhook(db, {
        event: "incident.resolved",
        incident,
        monitor: updated,
      });
    }
  }
}
