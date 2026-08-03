import { randomBytes } from "node:crypto";

import { and, desc, eq, ilike, inArray, like, or, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import {
  monitors,
  notificationChannelMonitors,
  notificationChannels,
  notificationOutbox,
} from "@/db/schema";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/modules/audit";
import { EgressBlockedError } from "@/modules/monitors/egress";
import { isForbiddenEgressUrl } from "@/modules/monitors/net";

import { classifyEvent, eventSeverity, EVENT_CLASS_IDS } from "./events";
import { enqueueMany, type DeliveryOutcome, type OutboxRow } from "./outbox";
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

/**
 * There is no cap on how many channels an organization may configure,
 * and no uniqueness rule on provider, endpoint, address or name: forty
 * Slack channels, one per client, all pointing at different workspaces,
 * is a supported configuration and so is two pointing at the same one.
 * Channels are identified by id and by nothing else.
 *
 * The cap that used to live here (20) was doing two jobs badly. As a
 * product limit it was arbitrary; as abuse control it was the wrong
 * instrument, because the thing worth bounding is how much a tenant can
 * *send*, not how many rows it can own. That bound is enforced where the
 * sending happens: the per-channel rate limit in the delivery tick and
 * the throttle on test deliveries.
 *
 * Uncapped is a statement about this application, not about physics.
 * Capacity still depends on the installation and on what each provider
 * accepts; `docs/NOTIFICATIONS.md` says so and publishes the measured
 * numbers rather than a promise.
 */

export interface ChannelInput {
  name: string;
  provider: string;
  config: Record<string, string>;
  /** Blank values mean "keep what is stored" on update. */
  secrets: Record<string, string>;
  events: string[];
  enabled: boolean;
  /**
   * Monitors this channel is scoped to. Empty means the organization
   * default: every monitor, plus the events that have no monitor at all.
   */
  monitorIds?: string[];
}

/**
 * One row of the settings list.
 *
 * Deliberately free of anything secret-derived, because building it must
 * not open a sealed envelope. `destination` is the column written at
 * save time, not a value computed from credentials on read.
 */
export interface ChannelSummary {
  id: string;
  name: string;
  provider: string;
  destination: string;
  events: string[];
  enabled: boolean;
  /** True when the operator scoped this channel to specific monitors. */
  scopedToMonitors: boolean;
  /** How many monitors this channel targets. Zero WITH `scopedToMonitors`
   * means every target was deleted, so the channel receives nothing. */
  targetCount: number;
  /** The most recent delivery on this channel, if there has been one. */
  lastResult: {
    state: string;
    error: string | null;
    at: Date;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The editor's view of ONE channel. This is the only read path that
 * opens a sealed envelope, and it opens exactly one — the list never
 * does. Secret values are still withheld; only the key names are
 * reported, so the editor can show "saved" without ever holding one.
 */
export interface ChannelView {
  id: string;
  name: string;
  provider: string;
  config: Record<string, string>;
  secretKeysSet: string[];
  events: string[];
  enabled: boolean;
  destination: string;
  scopedToMonitors: boolean;
  monitorIds: string[];
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

/**
 * The redacted destination line, computed from the provider. Called on
 * WRITE only; the result is stored on the row.
 */
function computeDestination(
  provider: string,
  config: Record<string, string>,
  secrets: SecretValues,
): string {
  return getProvider(provider)?.destinationSummary(config, secrets) ?? "";
}

export interface ListChannelsOptions {
  /** Case-insensitive match over name and destination. */
  search?: string;
  provider?: string;
  /** "enabled" | "disabled"; anything else means both. */
  status?: string;
  limit?: number;
  offset?: number;
}

export interface ChannelPage {
  rows: ChannelSummary[];
  /** Total matching the filters, for the pager. */
  total: number;
  /** Total this organization owns, ignoring filters. */
  totalUnfiltered: number;
}

/**
 * The settings list, filtered and paged in the database.
 *
 * Three properties this holds and the old implementation did not: it
 * never decrypts (the destination is a column), it never fetches the
 * secret blobs at all (the select names its columns), and it does a
 * fixed amount of work per page rather than per channel the tenant
 * owns. Those are what make an uncapped channel count survivable.
 */
export async function listChannels(
  db: DbClient,
  organizationId: string,
  options: ListChannelsOptions = {},
): Promise<ChannelPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const filters = [eq(notificationChannels.organizationId, organizationId)];
  if (options.provider) {
    filters.push(eq(notificationChannels.provider, options.provider));
  }
  if (options.status === "enabled" || options.status === "disabled") {
    filters.push(
      eq(notificationChannels.enabled, options.status === "enabled"),
    );
  }
  const search = options.search?.trim();
  if (search) {
    const term = `%${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    filters.push(
      or(
        ilike(notificationChannels.name, term),
        ilike(notificationChannels.destination, term),
      )!,
    );
  }
  const where = and(...filters);

  const [rows, [counted], [owned]] = await Promise.all([
    db
      .select({
        id: notificationChannels.id,
        name: notificationChannels.name,
        provider: notificationChannels.provider,
        destination: notificationChannels.destination,
        scopedToMonitors: notificationChannels.scopedToMonitors,
        events: notificationChannels.events,
        enabled: notificationChannels.enabled,
        createdAt: notificationChannels.createdAt,
        updatedAt: notificationChannels.updatedAt,
      })
      .from(notificationChannels)
      .where(where)
      .orderBy(notificationChannels.createdAt, notificationChannels.id)
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationChannels)
      .where(where),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationChannels)
      .where(eq(notificationChannels.organizationId, organizationId)),
  ]);

  const ids = rows.map((row) => row.id);
  const [targets, recent] = await Promise.all([
    targetCounts(db, ids),
    lastResults(db, ids),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      destination: row.destination,
      scopedToMonitors: row.scopedToMonitors,
      events: toStringArray(row.events),
      enabled: row.enabled,
      targetCount: targets.get(row.id) ?? 0,
      lastResult: recent.get(row.id) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    total: counted?.count ?? 0,
    totalUnfiltered: owned?.count ?? 0,
  };
}

/** How many monitors each of these channels targets. One query. */
async function targetCounts(
  db: DbClient,
  channelIds: string[],
): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();
  const rows = await db
    .select({
      channelId: notificationChannelMonitors.channelId,
      count: sql<number>`count(*)::int`,
    })
    .from(notificationChannelMonitors)
    .where(inArray(notificationChannelMonitors.channelId, channelIds))
    .groupBy(notificationChannelMonitors.channelId);
  return new Map(rows.map((row) => [row.channelId, row.count]));
}

/**
 * The newest outbox row per channel. `distinct on` rather than a
 * correlated subquery per row, so the cost is one indexed pass however
 * many channels are on the page.
 */
async function lastResults(
  db: DbClient,
  channelIds: string[],
): Promise<Map<string, { state: string; error: string | null; at: Date }>> {
  if (channelIds.length === 0) return new Map();
  const { rows } = await db.execute<{
    channel_id: string;
    state: string;
    last_error: string | null;
    created_at: string;
  }>(sql`
    select distinct on (${notificationOutbox.channelId})
      ${notificationOutbox.channelId} as channel_id,
      ${notificationOutbox.state} as state,
      ${notificationOutbox.lastError} as last_error,
      ${notificationOutbox.createdAt} as created_at
    from ${notificationOutbox}
    where ${inArray(notificationOutbox.channelId, channelIds)}
    order by ${notificationOutbox.channelId}, ${notificationOutbox.createdAt} desc
  `);
  return new Map(
    rows.map((row) => [
      row.channel_id,
      {
        state: row.state,
        // Already redacted when recorded; sliced so one row cannot
        // dominate the table.
        error: row.last_error ? row.last_error.slice(0, 200) : null,
        // `db.execute` hands back timestamptz as a STRING on this
        // driver, not a Date. Annotating it Date typechecks and then
        // fails at render time.
        at: new Date(row.created_at),
      },
    ]),
  );
}

/**
 * One channel, for the editor. The only read path that decrypts, and it
 * decrypts exactly one row.
 */
export async function getChannel(
  db: DbClient,
  organizationId: string,
  id: string,
): Promise<ChannelView | null> {
  const row = await db.query.notificationChannels.findFirst({
    where: and(
      eq(notificationChannels.id, id),
      eq(notificationChannels.organizationId, organizationId),
    ),
  });
  if (!row) return null;

  let secretKeys: string[] = [];
  try {
    secretKeys = Object.keys(openSecrets(row.secrets));
  } catch {
    // Undecryptable (rotated BETTER_AUTH_SECRET). The editor still
    // opens so the operator can re-enter credentials.
  }
  const targets = await db
    .select({ monitorId: notificationChannelMonitors.monitorId })
    .from(notificationChannelMonitors)
    .where(eq(notificationChannelMonitors.channelId, id));

  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    config: toStringRecord(row.config),
    secretKeysSet: secretKeys,
    events: toStringArray(row.events),
    enabled: row.enabled,
    destination: row.destination,
    scopedToMonitors: row.scopedToMonitors,
    monitorIds: targets.map((t) => t.monitorId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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
      // A select's value must be one of its own options. The type
      // implies that and nothing enforced it, and one provider uses the
      // chosen value as a JSON KEY in the request it builds - so an
      // arbitrary string posted here became an arbitrary field name on
      // the wire. Providers re-check what they care about; this is the
      // constraint the descriptor already declared.
      if (
        raw &&
        field.type === "select" &&
        field.options &&
        !field.options.some((option) => option.value === raw)
      ) {
        throw new AppError(`${field.label} is not one of the offered values.`);
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

/**
 * Replaces a channel's monitor targeting inside the caller's
 * transaction. Every id is checked against the actor's organization
 * first, so a target cannot be smuggled across a tenant boundary by
 * posting somebody else's monitor id.
 */
async function replaceTargets(
  tx: DbClient,
  organizationId: string,
  channelId: string,
  monitorIds: string[] | undefined,
): Promise<void> {
  if (monitorIds === undefined) return;
  await tx
    .delete(notificationChannelMonitors)
    .where(eq(notificationChannelMonitors.channelId, channelId));
  const wanted = [...new Set(monitorIds)];
  // The flag and the rows are written together, in the caller's
  // transaction, because they are one fact: an empty list means "this
  // channel is a workspace default", and a non-empty one means "scoped,
  // to these". Nothing later re-derives it from the row count.
  await tx
    .update(notificationChannels)
    .set({ scopedToMonitors: wanted.length > 0 })
    .where(eq(notificationChannels.id, channelId));
  if (wanted.length === 0) return;

  const owned = await tx
    .select({ id: monitors.id })
    .from(monitors)
    .where(
      and(
        eq(monitors.organizationId, organizationId),
        inArray(monitors.id, wanted),
      ),
    );
  if (owned.length !== wanted.length) {
    throw new AppError("A selected monitor does not exist in this workspace.");
  }
  await tx
    .insert(notificationChannelMonitors)
    .values(wanted.map((monitorId) => ({ channelId, monitorId })));
}

export async function createChannel(
  db: DbClient,
  actor: Actor,
  input: ChannelInput,
): Promise<ChannelView> {
  const { config, secrets } = validateInput(input, {});
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(notificationChannels)
      .values({
        organizationId: actor.organizationId,
        name: input.name.trim(),
        provider: input.provider,
        config,
        secrets: sealSecrets(secrets),
        destination: computeDestination(input.provider, config, secrets),
        events: input.events,
        enabled: input.enabled,
      })
      .returning({ id: notificationChannels.id });
    if (!row) throw new AppError("Channel creation returned no row.");
    await replaceTargets(tx, actor.organizationId, row.id, input.monitorIds);
    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "notification_channel.created",
      targetType: "notification_channel",
      targetId: row.id,
      metadata: {
        provider: input.provider,
        events: input.events,
        monitorTargets: input.monitorIds?.length ?? 0,
      },
    });
    return row.id;
  });
  const view = await getChannel(db, actor.organizationId, id);
  if (!view) throw new AppError("Channel disappeared after creation.");
  return view;
}

/**
 * Copies a channel, credentials included, under a new name.
 *
 * The point of the feature is a second destination that differs in one
 * field — the same Slack app posting to a different workspace, the same
 * SMTP relay with a different recipient list — so the copy carries the
 * sealed envelope across rather than making the operator re-enter a
 * credential they cannot read back out of the form.
 */
export async function duplicateChannel(
  db: DbClient,
  actor: Actor,
  id: string,
): Promise<ChannelView> {
  const current = await requireChannel(db, actor.organizationId, id);
  const newId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(notificationChannels)
      .values({
        organizationId: actor.organizationId,
        name: `${current.name} (copy)`.slice(0, 100),
        provider: current.provider,
        config: current.config,
        secrets: current.secrets,
        destination: current.destination,
        scopedToMonitors: current.scopedToMonitors,
        events: current.events,
        // A copy arrives disabled. Duplicating a live channel would
        // otherwise double every alert the instant it is saved, before
        // the operator has changed the one field they meant to change.
        enabled: false,
      })
      .returning({ id: notificationChannels.id });
    if (!row) throw new AppError("Channel duplication returned no row.");

    const targets = await tx
      .select({ monitorId: notificationChannelMonitors.monitorId })
      .from(notificationChannelMonitors)
      .where(eq(notificationChannelMonitors.channelId, id));
    if (targets.length > 0) {
      await tx
        .insert(notificationChannelMonitors)
        .values(
          targets.map((t) => ({ channelId: row.id, monitorId: t.monitorId })),
        );
    }

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "notification_channel.duplicated",
      targetType: "notification_channel",
      targetId: row.id,
      metadata: { provider: current.provider, copiedFrom: id },
    });
    return row.id;
  });
  const view = await getChannel(db, actor.organizationId, newId);
  if (!view) throw new AppError("Channel disappeared after duplication.");
  return view;
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
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(notificationChannels)
      .set({
        name: input.name.trim(),
        config,
        secrets: sealSecrets(secrets),
        destination: computeDestination(current.provider, config, secrets),
        events: input.events,
        enabled: input.enabled,
      })
      // Scoped to the organization as well as the id. `requireChannel`
      // already proved ownership, but this is the statement that
      // actually writes, and a predicate that cannot be satisfied by
      // another tenant's row is worth more than an earlier check.
      .where(
        and(
          eq(notificationChannels.id, id),
          eq(notificationChannels.organizationId, actor.organizationId),
        ),
      )
      .returning({ id: notificationChannels.id });
    if (!row) throw new AppError("Channel update returned no row.");
    await replaceTargets(tx, actor.organizationId, id, input.monitorIds);
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
        monitorTargets: input.monitorIds?.length ?? null,
      },
    });
  });
  const view = await getChannel(db, actor.organizationId, id);
  if (!view) throw new AppError("Channel disappeared after update.");
  return view;
}

/**
 * Enables or disables many channels at once, tenant-scoped in the
 * predicate. Returns how many rows actually changed.
 */
export async function setChannelsEnabled(
  db: DbClient,
  actor: Actor,
  ids: string[],
  enabled: boolean,
): Promise<number> {
  if (ids.length === 0) return 0;
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(notificationChannels)
      .set({ enabled })
      .where(
        and(
          eq(notificationChannels.organizationId, actor.organizationId),
          inArray(notificationChannels.id, ids),
        ),
      )
      .returning({ id: notificationChannels.id });
    if (rows.length > 0) {
      await writeAudit(tx, {
        organizationId: actor.organizationId,
        actorId: actor.userId,
        action: enabled
          ? "notification_channel.bulk_enabled"
          : "notification_channel.bulk_disabled",
        targetType: "notification_channel",
        targetId: rows[0]!.id,
        metadata: { count: rows.length, ids: rows.map((r) => r.id) },
      });
    }
    return rows.length;
  });
}

export async function deleteChannel(
  db: DbClient,
  actor: Actor,
  id: string,
): Promise<void> {
  const current = await requireChannel(db, actor.organizationId, id);
  await db.transaction(async (tx) => {
    // Tenant-scoped in the delete predicate itself, and inside a
    // transaction with the audit row, so a channel cannot vanish
    // without the record of who removed it. Routes in
    // `notification_channel_monitors` go with it by cascade; outbox
    // rows do not — `channel_id` is ON DELETE SET NULL, because the
    // ledger has to outlive the thing it describes. A delivery
    // in flight for this channel finds no row and is marked
    // permanently failed rather than retried forever.
    await tx
      .delete(notificationChannels)
      .where(
        and(
          eq(notificationChannels.id, id),
          eq(notificationChannels.organizationId, actor.organizationId),
        ),
      );
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
  /**
   * The monitor this event is about, if it is about one. Channels
   * scoped to specific monitors match only when it is theirs; channels
   * with no scoping match either way. An event with no monitor (a
   * manually reported incident) reaches organization defaults only,
   * because a channel that asked for one monitor did not ask for this.
   */
  monitorId?: string | null;
}

/**
 * The channels one event is addressed to.
 *
 * Resolved in a single statement, and every clause of it earns its
 * place now that the channel count is unbounded:
 *
 *  - the event class is matched in the heap after the tenant index has
 *    narrowed the set, not by fetching every channel and filtering in
 *    JavaScript. A GIN index on `events` was tried and measured slower
 *    on this product's shape; see the schema comment;
 *  - `secrets` is never selected, so a hundred matching channels move
 *    no credential material across the wire and decrypt nothing;
 *  - the scope test reads the channel's own `scoped_to_monitors` flag
 *    and, only for a scoped one, whether it names this monitor. It does
 *    NOT ask whether the channel has any targeting rows: those cascade
 *    when a monitor is deleted, and inferring scope from their absence
 *    made a client's channel silently inherit every other client's
 *    alerts the moment that client's monitors went. A channel matched
 *    by both a default and a target still comes back as ONE row, so
 *    deduplication is a property of the statement rather than a pass
 *    afterwards.
 */
export async function resolveRoutes(
  db: DbClient,
  input: Pick<
    DispatchInput,
    "organizationId" | "event" | "monitorType" | "monitorId"
  >,
): Promise<
  { id: string; provider: string; destination: string; name: string }[]
> {
  const cls = classifyEvent(input.event, input.monitorType);
  if (cls === "none") return [];
  const monitorId = input.monitorId ?? null;

  const { rows } = await db.execute<{
    id: string;
    provider: string;
    destination: string;
    name: string;
  }>(sql`
    select c.id, c.provider, c.destination, c.name
    from ${notificationChannels} c
    where c.organization_id = ${input.organizationId}
      and c.enabled = true
      and c.events @> ${JSON.stringify([cls])}::jsonb
      and (
        c.scoped_to_monitors = false
        or (
          ${monitorId}::uuid is not null
          and exists (
            select 1 from ${notificationChannelMonitors} m
            where m.channel_id = c.id and m.monitor_id = ${monitorId}::uuid
          )
        )
      )
    order by c.created_at, c.id
  `);
  return rows;
}

/** How many outbox rows one dispatch produced. */
export async function dispatchToChannels(
  db: DbClient,
  input: DispatchInput,
): Promise<number> {
  const matching = await resolveRoutes(db, input);
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

  // One insert for the whole fan-out rather than one per channel. At
  // the old cap that was twenty round trips and nobody noticed; with
  // the cap gone it would be one per channel per event, which is the
  // shape that turns a busy incident into a database problem.
  //
  // `enqueueMany` keeps the same conflict rule as `enqueue`, so a
  // replayed dispatch still inserts nothing and a channel matched
  // twice still gets one message. `destination` is the stored column,
  // so this path opens no envelope either.
  const queued = await enqueueMany(
    db,
    matching
      .filter((channel) => getProvider(channel.provider))
      .map((channel) => ({
        organizationId: input.organizationId,
        idempotencyKey: `${input.causeKey}:channel:${channel.id}`,
        channel: "channel" as const,
        channelId: channel.id,
        provider: channel.provider,
        event: input.event,
        destination: channel.destination || channel.name,
        payload: message as unknown as Record<string, unknown>,
      })),
  );
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
  // Scoped to the row's organization as well as its id. Nothing can
  // currently write a channelId from another tenant - `dispatchToChannels`
  // is the only writer and it is tenant-scoped - but this is the one
  // read in the file that did not carry the predicate, and every other
  // statement here argues for why it should.
  const channel = await db.query.notificationChannels.findFirst({
    where: and(
      eq(notificationChannels.id, row.channelId),
      eq(notificationChannels.organizationId, row.organizationId),
    ),
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

/**
 * Fills the `destination` column on rows written before 0024.
 *
 * This is the one place that decrypts in bulk, and it runs once per
 * upgrade rather than once per page view — which is the whole point of
 * the column. Migration 0024 could not do it: the key lives in the
 * process environment, not in the database.
 *
 * Until this has run the settings list shows the provider label instead
 * of a destination, which is why the read path can promise never to
 * decrypt: the fallback is a missing detail, not a decryption.
 */
export async function backfillChannelDestinations(
  db: DbClient,
): Promise<number> {
  const rows = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.destination, ""));
  let filled = 0;
  for (const row of rows) {
    try {
      const destination = computeDestination(
        row.provider,
        toStringRecord(row.config),
        openSecrets(row.secrets),
      );
      if (!destination) continue;
      await db
        .update(notificationChannels)
        .set({ destination })
        .where(eq(notificationChannels.id, row.id));
      filled++;
    } catch (error) {
      // An undecryptable row keeps an empty destination and renders as
      // its provider label. It cannot deliver either, and the delivery
      // error is the one that tells the operator why.
      logger.warn(
        { channelId: row.id, err: error },
        "could not backfill channel destination",
      );
    }
  }
  if (filled > 0) {
    logger.info({ filled }, "backfilled notification channel destinations");
  }
  return filled;
}
