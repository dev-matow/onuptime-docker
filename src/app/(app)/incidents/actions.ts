"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db";
import {
  actionOk,
  actionError,
  toActionError,
  type ActionResult,
} from "@/lib/action-result";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { requirePermission } from "@/lib/session";
import { draftPostmortem, suggestStatusUpdate } from "@/modules/ai/incident-ai";
import {
  createIncidentSchema,
  incidentUpdateSchema,
  postmortemSchema,
  severityChangeSchema,
  statusChangeSchema,
} from "@/modules/incidents/schemas";
import {
  acknowledgeIncident,
  changeIncidentSeverity,
  changeIncidentStatus,
  createIncident,
  getIncidentDetail,
  postIncidentUpdate,
  savePostmortem,
} from "@/modules/incidents/service";
import { sendIncidentWebhook } from "@/modules/notifications/webhook-service";
import { notifyStatusPageSubscribers } from "@/modules/notifications/subscriber-emails";
import type { WebhookEvent } from "@/modules/notifications/webhook";

/** Cost guard: 10 AI generations per organization per hour. */
const AI_RATE_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 };

/**
 * Fires the org webhook after a manual incident mutation has already
 * committed. Isolated in try/catch so a webhook problem can never turn a
 * successful action into a failed one.
 */
const SUBSCRIBER_KIND: Record<
  WebhookEvent,
  "opened" | "updated" | "resolved" | null
> = {
  "incident.opened": "opened",
  "incident.updated": "updated",
  "incident.resolved": "resolved",
  "monitor.down": null,
  "monitor.up": null,
  "webhook.test": null,
  "recovery.execute": null,
  "recovery.test": null,
};

async function dispatchIncidentWebhook(
  organizationId: string,
  incidentId: string,
  event: WebhookEvent,
): Promise<void> {
  try {
    const detail = await getIncidentDetail(db, organizationId, incidentId);
    // The newest timeline entry identifies this transition, so a second
    // update on the same incident is a second notification rather than
    // one the outbox's idempotency key silently swallows. The timeline
    // is ordered newest-first by `getIncidentDetail`.
    const transitionKey =
      event === "incident.updated" ? detail.timeline[0]?.id : undefined;
    await sendIncidentWebhook(db, {
      event,
      incident: detail.incident,
      monitor: detail.monitor ?? undefined,
      ...(transitionKey ? { transitionKey } : {}),
    });
    // Status-page subscribers hear about the same public lifecycle events.
    const kind = SUBSCRIBER_KIND[event];
    if (kind) {
      await notifyStatusPageSubscribers(db, {
        incident: detail.incident,
        kind,
      });
    }
  } catch (error) {
    logger.warn(
      { err: error, incidentId, event },
      "incident webhook dispatch failed",
    );
  }
}

export async function createIncidentAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission({ incident: ["create"] });
    const parsed = createIncidentSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    const incident = await createIncident(db, ctx, parsed.data);
    revalidatePath("/incidents");
    await dispatchIncidentWebhook(
      ctx.organizationId,
      incident.id,
      "incident.opened",
    );
    return actionOk({ id: incident.id });
  } catch (error) {
    return toActionError(error);
  }
}

export async function changeIncidentStatusAction(
  incidentId: string,
  input: unknown,
): Promise<ActionResult> {
  try {
    const parsed = statusChangeSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    const ctx = await requirePermission(
      parsed.data.status === "resolved"
        ? { incident: ["resolve"] }
        : { incident: ["update"] },
    );
    await changeIncidentStatus(db, ctx, incidentId, parsed.data);
    revalidateIncident(incidentId);
    await dispatchIncidentWebhook(
      ctx.organizationId,
      incidentId,
      parsed.data.status === "resolved"
        ? "incident.resolved"
        : "incident.updated",
    );
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

export async function acknowledgeIncidentAction(
  incidentId: string,
): Promise<ActionResult> {
  try {
    const ctx = await requirePermission({ incident: ["update"] });
    await acknowledgeIncident(db, ctx, incidentId);
    revalidateIncident(incidentId);
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

export async function postIncidentUpdateAction(
  incidentId: string,
  input: unknown,
): Promise<ActionResult> {
  try {
    const ctx = await requirePermission({ incident: ["update"] });
    const parsed = incidentUpdateSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    await postIncidentUpdate(
      db,
      ctx,
      incidentId,
      parsed.data.message,
      parsed.data.internal,
    );
    revalidateIncident(incidentId);
    // Internal notes are operator-only — they don't broadcast.
    if (!parsed.data.internal) {
      await dispatchIncidentWebhook(
        ctx.organizationId,
        incidentId,
        "incident.updated",
      );
    }
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

export async function changeIncidentSeverityAction(
  incidentId: string,
  input: unknown,
): Promise<ActionResult> {
  try {
    const ctx = await requirePermission({ incident: ["update"] });
    const parsed = severityChangeSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    await changeIncidentSeverity(db, ctx, incidentId, parsed.data.severity);
    revalidateIncident(incidentId);
    await dispatchIncidentWebhook(
      ctx.organizationId,
      incidentId,
      "incident.updated",
    );
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

export async function savePostmortemAction(
  incidentId: string,
  input: unknown,
): Promise<ActionResult> {
  try {
    const ctx = await requirePermission({ incident: ["postmortem"] });
    const parsed = postmortemSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    await savePostmortem(db, ctx, incidentId, parsed.data.content);
    revalidateIncident(incidentId);
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

export async function draftPostmortemAction(
  incidentId: string,
): Promise<ActionResult<{ draft: string }>> {
  try {
    const ctx = await requirePermission({ incident: ["postmortem"] });
    if (!checkRateLimit(`ai:${ctx.organizationId}`, AI_RATE_LIMIT)) {
      return actionError("AI limit reached for this hour, try again later.");
    }
    const detail = await getIncidentDetail(db, ctx.organizationId, incidentId);
    const draft = await draftPostmortem(detail);
    return actionOk({ draft });
  } catch (error) {
    return toActionError(error);
  }
}

export async function suggestStatusUpdateAction(
  incidentId: string,
): Promise<ActionResult<{ suggestion: string }>> {
  try {
    const ctx = await requirePermission({ incident: ["update"] });
    if (!checkRateLimit(`ai:${ctx.organizationId}`, AI_RATE_LIMIT)) {
      return actionError("AI limit reached for this hour, try again later.");
    }
    const detail = await getIncidentDetail(db, ctx.organizationId, incidentId);
    const suggestion = await suggestStatusUpdate(detail);
    return actionOk({ suggestion });
  } catch (error) {
    return toActionError(error);
  }
}

function revalidateIncident(incidentId: string) {
  revalidatePath("/incidents");
  revalidatePath(`/incidents/${incidentId}`);
  revalidatePath("/dashboard");
}
