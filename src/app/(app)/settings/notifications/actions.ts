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
  duplicateChannel,
  getChannel,
  setChannelsEnabled,
  replayDeliveries,
  testChannel,
  updateChannel,
  type ChannelView,
} from "@/modules/notifications/channel-service";
import { attemptsFor } from "@/modules/notifications/outbox";

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
  // Absent means "leave targeting alone"; an empty array means "make
  // this an organization default". The service distinguishes the two.
  monitorIds: z.array(z.uuid()).max(500).optional(),
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

export async function duplicateChannelAction(
  input: unknown,
): Promise<ActionResult<ChannelView>> {
  try {
    const ctx = await requirePermission({ notification: ["update"] });
    const parsed = z.object({ id: idSchema }).safeParse(input);
    if (!parsed.success) return actionError("Invalid channel id.");
    const view = await duplicateChannel(db, ctx, parsed.data.id);
    revalidatePath("/settings/notifications");
    return actionOk(view);
  } catch (error) {
    return toActionError(error);
  }
}

export async function setChannelsEnabledAction(
  input: unknown,
): Promise<ActionResult<{ changed: number }>> {
  try {
    const ctx = await requirePermission({ notification: ["update"] });
    const parsed = z
      .object({ ids: z.array(idSchema).min(1).max(500), enabled: z.boolean() })
      .safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    const changed = await setChannelsEnabled(
      db,
      ctx,
      parsed.data.ids,
      parsed.data.enabled,
    );
    revalidatePath("/settings/notifications");
    return actionOk({ changed });
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Loads one channel for the editor. Separate from the list on purpose:
 * this is the only read that opens a sealed envelope, and it opens one.
 * The reply still carries no secret VALUE, only which keys are set.
 */
export async function getChannelAction(
  input: unknown,
): Promise<ActionResult<ChannelView>> {
  try {
    const ctx = await requirePermission({ notification: ["update"] });
    const parsed = z.object({ id: idSchema }).safeParse(input);
    if (!parsed.success) return actionError("Invalid channel id.");
    const view = await getChannel(db, ctx.organizationId, parsed.data.id);
    if (!view) return actionError("Channel not found.");
    return actionOk(view);
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Replays finished deliveries.
 *
 * `notification:update` rather than a read permission: a replay sends
 * real messages to real people. A viewer may read the ledger and may
 * not press this.
 *
 * Rate limited on top of the permission, because "replay" against a
 * bounded selection is still a send-on-demand primitive and the button
 * is one click from a list.
 */
export async function replayDeliveriesAction(
  input: unknown,
): Promise<ActionResult<{ replayed: number; skipped: number }>> {
  try {
    const ctx = await requirePermission({ notification: ["update"] });
    const parsed = z
      .object({ ids: z.array(idSchema).min(1).max(100) })
      .safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    if (
      !checkRateLimit(`notification-replay:${ctx.organizationId}`, {
        limit: 20,
        windowMs: 60 * 60 * 1_000,
      })
    ) {
      return actionError(
        "Too many replays this hour. Wait before replaying more.",
      );
    }
    const result = await replayDeliveries(db, ctx, parsed.data.ids);
    revalidatePath("/settings/notifications");
    return actionOk(result);
  } catch (error) {
    return toActionError(error);
  }
}

/** The attempt timeline for one delivery. Read-only, tenant-scoped in
 * the query, and free of anything secret: an attempt row carries a
 * redacted error and a provider receipt, never a payload. */
export async function deliveryAttemptsAction(
  input: unknown,
): Promise<ActionResult<AttemptView[]>> {
  try {
    // `notification:update` is the only permission this resource
    // declares, and the timeline carries a redacted error and a
    // provider receipt - nothing a viewer is being kept from. Gating it
    // with the permission that exists beats inventing a second one for
    // a read, which would be a permissions change wearing a UI change's
    // clothes.
    const ctx = await requirePermission({ notification: ["update"] });
    const parsed = z.object({ id: idSchema }).safeParse(input);
    if (!parsed.success) return actionError("Invalid delivery id.");
    const rows = await attemptsFor(db, ctx.organizationId, parsed.data.id);
    return actionOk(
      rows.map((row) => ({
        attempt: row.attempt,
        outcome: row.outcome,
        httpStatus: row.httpStatus,
        error: row.error ? row.error.slice(0, 300) : null,
        providerMessageId: row.providerMessageId,
        retryAfterMs: row.retryAfterMs,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        nextAttemptAt: row.nextAttemptAt,
      })),
    );
  } catch (error) {
    return toActionError(error);
  }
}

export interface AttemptView {
  attempt: number;
  outcome: string;
  httpStatus: number | null;
  error: string | null;
  providerMessageId: string | null;
  retryAfterMs: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  nextAttemptAt: Date | null;
}
