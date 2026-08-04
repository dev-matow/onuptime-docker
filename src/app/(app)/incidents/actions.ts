"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db";
import {
  actionOk,
  actionError,
  toActionError,
  type ActionResult,
} from "@/lib/action-result";
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
import { dispatchIntentsNow } from "@/modules/notifications/flush";

/** Cost guard: 10 AI generations per organization per hour. */
const AI_RATE_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 };

/**
 * Nudges this organization's committed dispatch intents out of the door
 * without waiting for the worker's minute tick.
 *
 * This file used to build the notification itself, after the mutation
 * had committed: re-read the incident, work out the transition key from
 * the newest timeline entry, resolve the channels, mail the subscribers.
 * Two things were wrong with that and only one of them was the crash
 * window. The transition key was read AFTER the commit, so two operators
 * posting updates at the same moment both saw the same newest entry,
 * built the same key, and the outbox's unique index dropped one of them
 * — two updates during an outage, one broadcast, carrying the first
 * one's text under a key naming the second one's event. Reproduced on
 * two connections before it was moved.
 *
 * The service layer now writes the intent inside the transaction that
 * made the change, where the id of the row it just inserted is a fact
 * rather than a guess. All that is left out here is speed.
 */
async function flushIncidentDispatch(organizationId: string): Promise<void> {
  await dispatchIntentsNow(db, organizationId);
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
    await flushIncidentDispatch(ctx.organizationId);
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
    await flushIncidentDispatch(ctx.organizationId);
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
    // Whether an internal note broadcasts is decided inside the
    // transaction that writes it, not here: "this note is private" and
    // "nothing was queued about it" have to be the same commit.
    await flushIncidentDispatch(ctx.organizationId);
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
    await flushIncidentDispatch(ctx.organizationId);
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
