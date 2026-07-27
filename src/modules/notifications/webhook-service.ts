import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { redactTargetCredentials } from "@/modules/monitors/spec";
import type { DbClient } from "@/db";
import { webhookEndpoints } from "@/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/modules/audit";
import type { Incident } from "@/modules/incidents/service";

import {
  buildWebhookPayload,
  deliverWebhook,
  type DeliveryResult,
  type WebhookEvent,
} from "./webhook";

export type WebhookEndpointConfig = typeof webhookEndpoints.$inferSelect;

interface Actor {
  organizationId: string;
  userId: string;
}

function newSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

/** One endpoint per org, created lazily with a fresh secret. */
export async function getOrCreateWebhook(
  db: DbClient,
  organizationId: string,
): Promise<WebhookEndpointConfig> {
  const existing = await db.query.webhookEndpoints.findFirst({
    where: eq(webhookEndpoints.organizationId, organizationId),
  });
  if (existing) return existing;

  const [created] = await db
    .insert(webhookEndpoints)
    .values({ organizationId, secret: newSecret() })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const winner = await db.query.webhookEndpoints.findFirst({
    where: eq(webhookEndpoints.organizationId, organizationId),
  });
  if (!winner) throw new Error("webhook endpoint disappeared mid-create");
  return winner;
}

export async function updateWebhook(
  db: DbClient,
  actor: Actor,
  input: { url: string; enabled: boolean; regenerateSecret?: boolean },
): Promise<WebhookEndpointConfig> {
  return db.transaction(async (tx) => {
    const endpoint = await getOrCreateWebhook(tx, actor.organizationId);
    const [updated] = await tx
      .update(webhookEndpoints)
      .set({
        url: input.url,
        enabled: input.enabled,
        ...(input.regenerateSecret ? { secret: newSecret() } : {}),
      })
      .where(eq(webhookEndpoints.id, endpoint.id))
      .returning();
    if (!updated) throw new Error("webhook update returned no row");

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "webhook.updated",
      targetType: "webhook",
      targetId: endpoint.id,
      metadata: {
        enabled: input.enabled,
        secretRotated: Boolean(input.regenerateSecret),
      },
    });
    return updated;
  });
}

/** Minimal monitor shape a webhook needs — satisfied by both the full
 * worker Monitor and the trimmed monitor from getIncidentDetail. */
export interface WebhookMonitor {
  id: string;
  name: string;
  url: string;
  currentStatus?: string;
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

/**
 * Fires the org's webhook for an incident/monitor event, if enabled.
 * Called after the triggering mutation has committed, so a webhook
 * failure can never roll back or block incident processing. Awaited by
 * callers, but self-contained: it resolves regardless of endpoint health.
 */
export async function sendIncidentWebhook(
  db: DbClient,
  input: {
    event: WebhookEvent;
    incident: Incident;
    monitor?: WebhookMonitor;
  },
): Promise<void> {
  const endpoint = await db.query.webhookEndpoints.findFirst({
    where: eq(webhookEndpoints.organizationId, input.incident.organizationId),
  });
  if (!endpoint || !endpoint.enabled || !endpoint.url) return;

  const payload = buildWebhookPayload({
    event: input.event,
    organizationId: input.incident.organizationId,
    data: incidentData(input.incident, input.monitor),
  });

  const result = await deliverWebhook(
    { url: endpoint.url, secret: endpoint.secret },
    payload,
  );
  if (result.delivered) {
    logger.debug(
      {
        event: input.event,
        incidentId: input.incident.id,
        attempts: result.attempts,
      },
      "webhook delivered",
    );
  }
}

/** Delivers a `webhook.test` event on demand; returns the result for the UI. */
export async function sendTestWebhook(
  db: DbClient,
  organizationId: string,
): Promise<DeliveryResult> {
  const endpoint = await getOrCreateWebhook(db, organizationId);
  if (!endpoint.url) {
    return { delivered: false, attempts: 0, error: "No webhook URL set." };
  }

  const payload = buildWebhookPayload({
    event: "webhook.test",
    organizationId,
    data: { message: "This is a test delivery from Vigil." },
  });
  return deliverWebhook(
    { url: endpoint.url, secret: endpoint.secret },
    payload,
    { attempts: 1 },
  );
}
