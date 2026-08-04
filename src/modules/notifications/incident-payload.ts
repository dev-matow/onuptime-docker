import { env } from "@/lib/env";
import { redactTargetCredentials } from "@/modules/monitors/spec";

import type { WebhookEvent } from "./webhook";

/**
 * What an incident event SAYS, rendered once, at the moment it happens.
 *
 * These functions used to live inside `sendIncidentWebhook`, which ran
 * after the incident had already committed and built its message from
 * whatever the incident looked like by then. That was invisible while
 * the two were milliseconds apart and wrong the moment they were not: a
 * dispatch retried after a crash re-read the row and described the
 * incident's CURRENT state, so a "monitor is down" page could go out
 * carrying `"status": "resolved"` because the outage had ended while the
 * notification was owed.
 *
 * Now the transition renders its own message and commits it with the
 * decision. Nothing downstream reads the incident again, so nothing
 * downstream can disagree about what happened.
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

/** The incident fields a notification is allowed to describe. Narrower
 * than the row on purpose: a payload builder that accepted the whole
 * incident would be free to leak the postmortem into a chat message. */
export interface WebhookIncident {
  id: string;
  organizationId: string;
  title: string;
  status: string;
  severity: string;
  source: string;
  startedAt: Date;
  resolvedAt: Date | null;
}

/** One rendered channel fan-out, ready to be stored in an intent. */
export interface IntentDispatch {
  event: WebhookEvent;
  /** The logical cause. Combined with a channel id it becomes an outbox
   * idempotency key, so the same transition never notifies twice. */
  causeKey: string;
  subject: string;
  detail: (string | null)[];
  url?: string;
  data: Record<string, unknown>;
  monitorType?: string | null;
  monitorId?: string | null;
}

function incidentData(incident: WebhookIncident, monitor?: WebhookMonitor) {
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

function describeDowntime(incident: WebhookIncident): string | null {
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
 * Renders one incident/monitor event for every channel it will reach.
 *
 * `transitionKey` is what happened, for the events one incident can
 * produce more than once. Only `incident.updated` needs it, and without
 * it that event fired at most ONCE PER INCIDENT, ever: the outbox's
 * unique index saw the same key for the second update and dropped it,
 * so a team posting four updates during an outage broadcast the first
 * and nothing after it, with no error anywhere. `monitor.down`,
 * `incident.opened` and `incident.resolved` happen once per incident by
 * nature and are correct with the plain key.
 */
export function incidentDispatch(input: {
  event: WebhookEvent;
  incident: WebhookIncident;
  monitor?: WebhookMonitor;
  transitionKey?: string;
}): IntentDispatch {
  const { event, incident, monitor } = input;
  return {
    event,
    causeKey: input.transitionKey
      ? `incident:${incident.id}:${event}:${input.transitionKey}`
      : `incident:${incident.id}:${event}`,
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
    monitorId: monitor?.id ?? null,
  };
}
