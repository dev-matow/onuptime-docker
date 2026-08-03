import { randomBytes } from "node:crypto";

import { and, desc, eq, like } from "drizzle-orm";

import type { DbClient } from "@/db";
import { notificationChannels, notificationOutbox } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/modules/audit";
import { EgressBlockedError } from "@/modules/monitors/egress";
import { isForbiddenEgressUrl } from "@/modules/monitors/net";

import { classifyEvent, eventSeverity, EVENT_CLASS_IDS } from "./events";
import { enqueue, type DeliveryOutcome, type OutboxRow } from "./outbox";
import {
  getProvider,
  redactErrorText,
  type ChannelMessage,
  type ProviderNet,
} from "./providers";
import {
  isPlainEnvelope,
  openSecrets,
  sealSecrets,
  SecretboxError,
  type SecretValues,
} from "./secretbox";
import { eventLabel, type WebhookEvent } from "./webhook";

/**
 * Notification channels: the service layer over the provider registry.
 *
 * One registry, one pipeline, one routing model. A channel is a
 * provider id plus validated config, sealed secrets and a set of event
 * classes. Dispatch fans one event out to every subscribed channel as
 * outbox rows - so every provider inherits the outbox's durability,
 * retries, idempotency and ledger, and none of them has a queue of its
 * own. Delivery opens the channel's secrets at send time, so a rotated
 * credential applies to messages already queued.
 */

export type NotificationChannelRow = typeof notificationChannels.$inferSelect;

interface Actor {
  organizationId: string;
  userId: string;
}

/** Fan-out bound. Also the abuse bound: channels are the only way this
 * product can be told to POST somewhere, and 20 per tenant is plenty. */
export const MAX_CHANNELS_PER_ORG = 20;

export interface ChannelInput {
  name: string;
  provider: string;
  config: Record<string, string>;
  /** Blank values mean "keep what is stored" on update. */
  secrets: Record<string, string>;
  events: string[];
  enabled: boolean;
}

/** What the browser may see: no secrets, only which keys are set. */
export interface ChannelView {
  id: string;
  name: string;
  provider: string;
  config: Record<string, string>;
  secretKeysSet: string[];
  events: string[];
  enabled: boolean;
  destination: string;
  createdAt: Date;
  updatedAt: Date;
}

function toStringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function channelView(row: NotificationChannelRow): ChannelView {
  const config = toStringRecord(row.config);
  let secretKeys: string[] = [];
  let destination = "";
  try {
    const secrets = openSecrets(row.secrets);
    secretKeys = Object.keys(secrets);
    destination =
      getProvider(row.provider)?.destinationSummary(config, secrets) ?? "";
  } catch {
    // Undecryptable secrets (rotated BETTER_AUTH_SECRET). The view
    // still renders; delivery reports the real error.
    destination = "credentials need re-entering";
  }
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    config,
    secretKeysSet: secretKeys,
    events: toStringArray(row.events),
    enabled: row.enabled,
    destination,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listChannels(
  db: DbClient,
  organizationId: string,
): Promise<ChannelView[]> {
  const rows = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.organizationId, organizationId))
    .orderBy(notificationChannels.createdAt);
  return rows.map(channelView);
}

/**
 * Validates an input against its provider. Returns the normalized
 * config and the merged secret set. `stored` carries the existing
 * secrets on update so blank fields keep their values.
 */
function validateInput(
  input: ChannelInput,
  stored: SecretValues,
): { config: Record<string, string>; secrets: SecretValues } {
  const provider = getProvider(input.provider);
  if (!provider) throw new AppError(`Unknown provider "${input.provider}".`);
  if (!input.name.trim() || input.name.length > 100) {
    throw new AppError("The channel needs a name (at most 100 characters).");
  }
  if (input.events.length === 0) {
    throw new AppError("Pick at least one event class.");
  }
  for (const cls of input.events) {
    if (!EVENT_CLASS_IDS.includes(cls)) {
      throw new AppError(`Unknown event class "${cls}".`);
    }
  }

  const config: Record<string, string> = {};
  const secrets: SecretValues = { ...stored };
  for (const field of provider.fields) {
    const raw = (
      field.secret ? input.secrets[field.key] : input.config[field.key]
    )?.trim();
    if (field.secret) {
      if (raw) secrets[field.key] = raw;
      if (field.required && !secrets[field.key]) {
        throw new AppError(`${field.label} is required.`);
      }
    } else {
      if (field.required && !raw) {
        throw new AppError(`${field.label} is required.`);
      }
      if (raw) config[field.key] = raw;
    }
  }

  // The generic webhook signs every delivery; a blank secret gets a
  // generated one so "unsigned because nobody typed a secret" cannot
  // happen. Same prefix the old endpoint used.
  if (provider.id === "webhook" && !secrets.secret) {
    secrets.secret = `whsec_${randomBytes(24).toString("hex")}`;
  }

  const problem = provider.check(config, secrets);
  if (problem) throw new AppError(problem);

  // Save-time egress refusal for operator-typed URLs, mirroring the old
  // webhook form: delivery re-checks authoritatively, but an operator
  // who pastes a metadata URL should hear it now.
  for (const field of provider.fields) {
    const value = field.secret ? secrets[field.key] : config[field.key];
    if (
      (field.type === "url" || field.key === "url") &&
      value &&
      isForbiddenEgressUrl(value)
    ) {
      throw new EgressBlockedError("This host cannot be used as a target.");
    }
  }

  return { config, secrets };
}

export async function createChannel(
  db: DbClient,
  actor: Actor,
  input: ChannelInput,
): Promise<ChannelView> {
  const { config, secrets } = validateInput(input, {});
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: notificationChannels.id })
      .from(notificationChannels)
      .where(eq(notificationChannels.organizationId, actor.organizationId));
    if (existing.length >= MAX_CHANNELS_PER_ORG) {
      throw new AppError(
        `An organization can have at most ${MAX_CHANNELS_PER_ORG} channels.`,
      );
    }
    const [row] = await tx
      .insert(notificationChannels)
      .values({
        organizationId: actor.organizationId,
        name: input.name.trim(),
        provider: input.provider,
        config,
        secrets: sealSecrets(secrets),
        events: input.events,
        enabled: input.enabled,
      })
      .returning();
    if (!row) throw new AppError("Channel creation returned no row.");
    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "notification_channel.created",
      targetType: "notification_channel",
      targetId: row.id,
      metadata: { provider: input.provider, events: input.events },
    });
    return channelView(row);
  });
}

async function requireChannel(
  db: DbClient,
  organizationId: string,
  id: string,
): Promise<NotificationChannelRow> {
  const row = await db.query.notificationChannels.findFirst({
    where: and(
      eq(notificationChannels.id, id),
      eq(notificationChannels.organizationId, organizationId),
    ),
  });
  if (!row) throw new AppError("Channel not found.");
  return row;
}

export async function updateChannel(
  db: DbClient,
  actor: Actor,
  id: string,
  input: ChannelInput,
): Promise<ChannelView> {
  const current = await requireChannel(db, actor.organizationId, id);
  if (input.provider !== current.provider) {
    // Changing provider invalidates both config and secrets; the editor
    // creates a new channel instead, and history keeps the provider it
    // recorded. Refusing beats silently reinterpreting credentials.
    throw new AppError("A channel cannot change provider; create a new one.");
  }
  let stored: SecretValues = {};
  try {
    stored = openSecrets(current.secrets);
  } catch {
    // Undecryptable stored secrets: the update must supply fresh ones.
  }
  const { config, secrets } = validateInput(input, stored);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(notificationChannels)
      .set({
        name: input.name.trim(),
        config,
        secrets: sealSecrets(secrets),
        events: input.events,
        enabled: input.enabled,
      })
      .where(eq(notificationChannels.id, id))
      .returning();
    if (!row) throw new AppError("Channel update returned no row.");
    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "notification_channel.updated",
      targetType: "notification_channel",
      targetId: id,
      metadata: {
        provider: current.provider,
        events: input.events,
        enabled: input.enabled,
      },
    });
    return channelView(row);
  });
}

export async function deleteChannel(
  db: DbClient,
  actor: Actor,
  id: string,
): Promise<void> {
  const current = await requireChannel(db, actor.organizationId, id);
  await db.transaction(async (tx) => {
    await tx
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, id));
    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "notification_channel.deleted",
      targetType: "notification_channel",
      targetId: id,
      metadata: { provider: current.provider, name: current.name },
    });
  });
}

/* ------------------------------------------------------------------ */
/* Test deliveries                                                     */
/* ------------------------------------------------------------------ */

export interface TestResult {
  delivered: boolean;
  error?: string;
}

/**
 * One immediate delivery of a synthetic test event, straight through
 * the provider - not the outbox, because the operator is watching and
 * wants the answer now, not a retry schedule. Not recorded in the
 * ledger for the same reason the old test webhook was not.
 *
 * Works before the channel is saved (the editor's Send test) and on a
 * saved channel, where blank secret fields fall back to what is stored.
 */
export async function testChannel(
  db: DbClient,
  actor: Actor,
  input: Omit<ChannelInput, "enabled" | "events"> & { channelId?: string },
  net: ProviderNet = {},
): Promise<TestResult> {
  let stored: SecretValues = {};
  if (input.channelId) {
    const current = await requireChannel(
      db,
      actor.organizationId,
      input.channelId,
    );
    try {
      stored = openSecrets(current.secrets);
    } catch {
      stored = {};
    }
  }
  let config: Record<string, string>;
  let secrets: SecretValues;
  try {
    ({ config, secrets } = validateInput(
      { ...input, events: ["monitor"], enabled: true },
      stored,
    ));
  } catch (error) {
    return {
      delivered: false,
      error: error instanceof Error ? error.message : "Invalid channel.",
    };
  }
  const provider = getProvider(input.provider);
  if (!provider) return { delivered: false, error: "Unknown provider." };

  const message: ChannelMessage = {
    kind: "channel",
    event: "webhook.test",
    title: `${eventLabel("webhook.test")} - ${input.name.trim() || provider.label}`,
    text: "If you can read this, the channel is wired correctly.",
    severity: "info",
    organizationId: actor.organizationId,
    data: { message: "This is a test delivery from Vigil." },
    timestamp: new Date().toISOString(),
  };
  const outcome = await provider.deliver({
    config,
    secrets,
    message,
    rowId: `test-${randomBytes(8).toString("hex")}`,
    net,
  });
  if (outcome.status === "delivered") return { delivered: true };
  return { delivered: false, error: redactErrorText(outcome.error, secrets) };
}

/* ------------------------------------------------------------------ */
/* Dispatch: one event, one outbox row per subscribed channel          */
/* ------------------------------------------------------------------ */

export interface DispatchInput {
  organizationId: string;
  event: WebhookEvent;
  /** The logical cause, e.g. `incident:<id>:monitor.down`. Combined
   * with the channel id it is the idempotency key, so replaying the
   * dispatch cannot double-notify any channel. */
  causeKey: string;
  /** One line after the event label: the monitor or incident name. */
  subject: string;
  /** A few detail lines; empty entries are dropped. */
  detail: (string | null | undefined)[];
  /** Deep link for chat providers and the signed payload. */
  url?: string;
  /** Native payload data for the signed generic webhook. */
  data: Record<string, unknown>;
  /** Check type id, for the expiry carve-out. */
  monitorType?: string | null;
}

/** How many outbox rows one dispatch produced. */
export async function dispatchToChannels(
  db: DbClient,
  input: DispatchInput,
): Promise<number> {
  const cls = classifyEvent(input.event, input.monitorType);
  const channels = await db
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.organizationId, input.organizationId),
        eq(notificationChannels.enabled, true),
      ),
    );
  const matching = channels.filter((c) =>
    toStringArray(c.events).includes(cls),
  );
  if (matching.length === 0) return 0;

  const message: ChannelMessage = {
    kind: "channel",
    event: input.event,
    title: `${eventLabel(input.event)} - ${input.subject}`.slice(0, 300),
    text: input.detail
      .filter((line): line is string => Boolean(line))
      .join("\n")
      .slice(0, 4_000),
    ...(input.url ? { url: input.url } : {}),
    severity: eventSeverity(input.event),
    organizationId: input.organizationId,
    data: input.data,
    timestamp: new Date().toISOString(),
  };

  let queued = 0;
  for (const channel of matching) {
    const provider = getProvider(channel.provider);
    if (!provider) continue;
    let destination = channel.name;
    try {
      destination = provider.destinationSummary(
        toStringRecord(channel.config),
        openSecrets(channel.secrets),
      );
    } catch {
      // Undecryptable secrets still queue; delivery reports the error.
    }
    const row = await enqueue(db, {
      organizationId: input.organizationId,
      idempotencyKey: `${input.causeKey}:channel:${channel.id}`,
      channel: "channel",
      channelId: channel.id,
      provider: channel.provider,
      event: input.event,
      destination,
      payload: message as unknown as Record<string, unknown>,
    });
    if (row) queued++;
  }
  return queued;
}

/* ------------------------------------------------------------------ */
/* Delivery of a claimed outbox row                                    */
/* ------------------------------------------------------------------ */

export async function deliverChannelRow(
  db: DbClient,
  row: OutboxRow,
  net: ProviderNet = {},
): Promise<DeliveryOutcome> {
  if (!row.channelId) {
    return { status: "permanent", error: "The channel was deleted." };
  }
  const channel = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, row.channelId),
  });
  if (!channel) {
    return { status: "permanent", error: "The channel was deleted." };
  }
  if (!channel.enabled) {
    // Disabled between enqueue and delivery: the operator said stop.
    return { status: "permanent", error: "The channel is disabled." };
  }
  const provider = getProvider(channel.provider);
  if (!provider) {
    return {
      status: "permanent",
      error: `No provider "${channel.provider}" in this build.`,
    };
  }
  let secrets: SecretValues;
  try {
    secrets = openSecrets(channel.secrets);
  } catch (error) {
    return {
      status: "permanent",
      error:
        error instanceof SecretboxError
          ? error.message
          : "Channel credentials cannot be read.",
    };
  }
  const message = row.payload as unknown as ChannelMessage;
  if (message?.kind !== "channel" || !message.event) {
    return { status: "permanent", error: "The stored payload is not usable." };
  }
  return provider.deliver({
    config: toStringRecord(channel.config),
    secrets,
    message,
    rowId: row.id,
    net,
  });
}

/* ------------------------------------------------------------------ */
/* Ledger view and boot maintenance                                    */
/* ------------------------------------------------------------------ */

export interface DeliveryHistoryEntry {
  id: string;
  provider: string;
  event: string | null;
  destination: string;
  state: string;
  attempts: number;
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

/** The most recent deliveries for an organization - the history table. */
export async function deliveryHistory(
  db: DbClient,
  organizationId: string,
  limit = 30,
): Promise<DeliveryHistoryEntry[]> {
  const rows = await db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.organizationId, organizationId))
    .orderBy(desc(notificationOutbox.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider ?? (row.channel === "email" ? "email" : row.channel),
    event: row.event,
    destination: row.destination,
    state: row.state,
    attempts: row.attempts,
    // Errors are redacted before recording; sliced here anyway so a
    // pre-0022 row cannot leak more than a line.
    lastError: row.lastError ? row.lastError.slice(0, 300) : null,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
  }));
}

/**
 * Seals `plain:` envelopes left by migration 0022, which could not
 * encrypt from SQL because the key lives in the process environment.
 * Runs at worker boot; idempotent and cheap when there is nothing to do.
 */
export async function sealPlainChannelSecrets(db: DbClient): Promise<number> {
  const rows = await db
    .select()
    .from(notificationChannels)
    .where(like(notificationChannels.secrets, "plain:%"));
  let sealed = 0;
  for (const row of rows) {
    if (!isPlainEnvelope(row.secrets)) continue;
    try {
      const secrets = openSecrets(row.secrets);
      await db
        .update(notificationChannels)
        .set({ secrets: sealSecrets(secrets) })
        .where(eq(notificationChannels.id, row.id));
      sealed++;
    } catch (error) {
      logger.warn(
        { channelId: row.id, err: error },
        "could not seal migrated channel secrets",
      );
    }
  }
  if (sealed > 0) {
    logger.info({ sealed }, "sealed migrated notification channel secrets");
  }
  return sealed;
}
