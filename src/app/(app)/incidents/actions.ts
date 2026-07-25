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
import { requirePermission } from "@/lib/session";
import {
  createIncidentSchema,
  incidentUpdateSchema,
  postmortemSchema,
  severityChangeSchema,
  statusChangeSchema,
} from "@/modules/incidents/schemas";
import {
  changeIncidentSeverity,
  changeIncidentStatus,
  createIncident,
  getIncidentDetail,
  postIncidentUpdate,
  savePostmortem,
} from "@/modules/incidents/service";
import { sendIncidentWebhook } from "@/modules/notifications/webhook-service";
import type { WebhookEvent } from "@/modules/notifications/webhook";

/**
 * Fires the org webhook after a manual incident mutation has already
 * committed. Isolated in try/catch so a webhook problem can never turn a
 * successful action into a failed one.
 */
async function dispatchIncidentWebhook(
  organizationId: string,
  incidentId: string,
  event: WebhookEvent,
): Promise<void> {
  try {
    const detail = await getIncidentDetail(db, organizationId, incidentId);
    await sendIncidentWebhook(db, {
      event,
      incident: detail.incident,
      monitor: detail.monitor ?? undefined,
    });
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

function revalidateIncident(incidentId: string) {
  revalidatePath("/incidents");
  revalidatePath(`/incidents/${incidentId}`);
  revalidatePath("/dashboard");
}
