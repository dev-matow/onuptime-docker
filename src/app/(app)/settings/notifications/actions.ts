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
import { checkRateLimit } from "@/lib/rate-limit";
import { requirePermission } from "@/lib/session";
import {
  createChannel,
  deleteChannel,
  testChannel,
  updateChannel,
  type ChannelView,
} from "@/modules/notifications/channel-service";

/**
 * Server actions for notification channels. Validation here is shape
 * only; the channel service owns provider validation, secret sealing
 * and the egress refusal, and its errors surface verbatim.
 *
 * Secret values arrive write-only: they go INTO these actions and are
 * never in any action's return value. `ChannelView` carries only which
 * secret keys are set.
 */

const stringMap = z.record(z.string().max(100), z.string().max(2_048));

const channelSchema = z.object({
  name: z.string().min(1).max(100),
  provider: z.string().min(1).max(40),
  config: stringMap,
  secrets: stringMap,
  events: z.array(z.string().max(40)).max(10),
  enabled: z.boolean(),
});

const idSchema = z.uuid();

export async function createChannelAction(
  input: unknown,
): Promise<ActionResult<ChannelView>> {
  try {
    const ctx = await requirePermission({ notification: ["update"] });
    const parsed = channelSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    const view = await createChannel(db, ctx, parsed.data);
    revalidatePath("/settings/notifications");
    return actionOk(view);
  } catch (error) {
    return toActionError(error);
  }
}

export async function updateChannelAction(
  input: unknown,
): Promise<ActionResult<ChannelView>> {
  try {
    const ctx = await requirePermission({ notification: ["update"] });
    const parsed = z
      .object({ id: idSchema, channel: channelSchema })
      .safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    const view = await updateChannel(
      db,
      ctx,
      parsed.data.id,
      parsed.data.channel,
    );
    revalidatePath("/settings/notifications");
    return actionOk(view);
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteChannelAction(
  input: unknown,
): Promise<ActionResult> {
  try {
    const ctx = await requirePermission({ notification: ["update"] });
    const parsed = z.object({ id: idSchema }).safeParse(input);
    if (!parsed.success) return actionError("Invalid channel id.");
    await deleteChannel(db, ctx, parsed.data.id);
    revalidatePath("/settings/notifications");
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Test deliveries bypass the outbox on purpose - the operator is
 * watching and wants the answer now - which also means they bypass the
 * per-channel rate limit that bounds every other send. Unbounded, the
 * button is a send-on-demand primitive against any address the egress
 * policy allows. Thirty an hour per organization is more than a person
 * configuring channels will ever press.
 */
const TEST_RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };

export async function testChannelAction(input: unknown): Promise<ActionResult> {
  try {
    const ctx = await requirePermission({ notification: ["update"] });
    if (
      !checkRateLimit(`channel-test:${ctx.organizationId}`, TEST_RATE_LIMIT)
    ) {
      return actionError(
        "Too many test deliveries this hour. Try again shortly.",
      );
    }
    const parsed = z
      .object({
        name: z.string().max(100),
        provider: z.string().min(1).max(40),
        config: stringMap,
        secrets: stringMap,
        channelId: idSchema.optional(),
      })
      .safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    const result = await testChannel(db, ctx, parsed.data);
    if (!result.delivered) {
      return actionError(result.error ?? "Test delivery failed.");
    }
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}
