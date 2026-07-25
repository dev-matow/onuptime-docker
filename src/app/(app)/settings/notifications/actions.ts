"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import {
  actionOk,
  actionError,
  toActionError,
  type ActionResult,
} from "@/lib/action-result";
import { requirePermission } from "@/lib/session";
import {
  sendTestWebhook,
  updateWebhook,
} from "@/modules/notifications/webhook-service";

const webhookSchema = z.object({
  url: z.union([z.literal(""), z.url({ protocol: /^https?$/ }).max(2048)]),
  enabled: z.boolean(),
  regenerateSecret: z.boolean().optional(),
});

export async function updateWebhookAction(
  input: unknown,
): Promise<ActionResult> {
  try {
    const ctx = await requirePermission({ notification: ["update"] });
    const parsed = webhookSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    if (parsed.data.enabled && !parsed.data.url) {
      return actionError("Set a webhook URL before enabling delivery.");
    }
    await updateWebhook(db, ctx, parsed.data);
    revalidatePath("/settings/notifications");
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

export async function testWebhookAction(): Promise<
  ActionResult<{ status?: number; attempts: number }>
> {
  try {
    const ctx = await requirePermission({ notification: ["update"] });
    const result = await sendTestWebhook(db, ctx.organizationId);
    if (!result.delivered) {
      return actionError(
        result.error ??
          `Delivery failed${result.status ? ` (${result.status})` : ""}.`,
      );
    }
    return actionOk({ status: result.status, attempts: result.attempts });
  } catch (error) {
    return toActionError(error);
  }
}
