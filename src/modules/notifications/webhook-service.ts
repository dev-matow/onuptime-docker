import { redactTargetCredentials } from "@/modules/monitors/spec";
import type { DbClient } from "@/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { Incident } from "@/modules/incidents/service";
import { runNotificationDelivery } from "@/worker/jobs/notification-delivery";

import { dispatchToChannels } from "./channel-service";
import type { WebhookEvent } from "./webhook";

/**
 * Incident and monitor event dispatch, fanned out to every subscribed
 * notification channel through the outbox.
 *
 * This file kept its name through 1.15.0 so its callers did not move,
 * but the single `webhook_endpoints` row it used to deliver to is gone:
 * migration 0022 turned those endpoints into notification channels, and
 * delivery for every provider - the signed webhook included - now goes
 * through the outbox worker with its leases, retries and ledger.
 *
 * `sendIncidentWebhook` therefore ENQUEUES rather than delivers, then
 * kicks an inline, organization-scoped drain so a chat alert still
 * lands within a second of the incident instead of on the next worker
 * tick. The drain is best-effort: if it dies with the process, the rows
 * are still queued and the worker's minute tick picks them up - that is
 * the outbox guarantee doing its job.
 */

/** Minimal monitor shape a dispatch needs — satisfied by both the full
 * worker Monitor and the trimmed monitor from getIncidentDetail. */
export interface WebhookMonitor {
  id: string;
  name: string;
  url: string;
  currentStatus?: string;
  /** Check type id; decides the expiry event class. */
  checkType?: string;
}

function incidentData(incident: Incident, monitor?: WebhookMonitor) {
  return {
    incident: {
      id: incident.id,
      title: incident.title,
      status: incident.status,
      severity: incident.severity,
      source: incident.source,
      startedAt: incident.startedAt.toISOString(),
      resolvedAt: incident.resolvedAt?.toISOString() ?? null,
      url: `${env.APP_URL}/incidents/${incident.id}`,
    },
    ...(monitor
      ? {
          monitor: {
            id: monitor.id,
            name: monitor.name,
            url: redactTargetCredentials(monitor.url),
            status: monitor.currentStatus ?? null,
          },
        }
      : {}),
  };
}

function describeDowntime(incident: Incident): string | null {
  if (!incident.resolvedAt) return null;
  const seconds = Math.round(
    (incident.resolvedAt.getTime() - incident.startedAt.getTime()) / 1_000,
  );
  if (seconds < 1) return null;
  if (seconds < 120) return `Down for ${seconds}s.`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `Down for ${minutes}m.`;
  return `Down for ${Math.round((minutes / 60) * 10) / 10}h.`;
}

/**
 * Fans an incident/monitor event out to the organization's channels.
 * Called after the triggering mutation has committed, so a provider
 * failure can never roll back or block incident processing. Resolves
 * regardless of channel health.
 */
export async function sendIncidentWebhook(
  db: DbClient,
  input: {
    event: WebhookEvent;
    incident: Incident;
    monitor?: WebhookMonitor;
  },
): Promise<void> {
  const { event, incident, monitor } = input;
  try {
    const queued = await dispatchToChannels(db, {
      organizationId: incident.organizationId,
      event,
      causeKey: `incident:${incident.id}:${event}`,
      subject: monitor?.name ?? incident.title,
      detail: [
        // When the subject is the monitor, the incident title is the
        // detail; when the subject IS the title, repeating it is noise.
        monitor ? incident.title : null,
        `Severity: ${incident.severity}.`,
        describeDowntime(incident),
      ],
      url: `${env.APP_URL}/incidents/${incident.id}`,
      data: incidentData(incident, monitor),
      monitorType: monitor?.checkType ?? null,
    });
    if (queued > 0) {
      await drainAfterDispatch(db, incident.organizationId, queued);
    }
  } catch (error) {
    // Dispatch failures must never affect incident processing; the
    // worker tick re-drains whatever did get enqueued.
    logger.warn(
      { event, incidentId: incident.id, err: error },
      "notification dispatch failed",
    );
  }
}

/**
 * The inline drain that makes alerts prompt. Scoped to the organization
 * so one tenant's slow provider cannot stall another's dispatch path,
 * and bounded to the number of rows the dispatch just queued so a
 * server action can never inherit the whole batch's worth of provider
 * timeouts. Anything it does not reach is still queued, and the
 * worker's minute tick takes it.
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
