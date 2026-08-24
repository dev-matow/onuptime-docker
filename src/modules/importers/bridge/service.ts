import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";

import type { DbClient } from "@/db";
import {
  bridgeCutoverReports,
  bridgeImports,
  bridgeMonitors,
  bridgePolls,
  bridgeSourceIncidents,
  incidentEvents,
  incidents,
  migrationBridges,
  monitorChecks,
  monitors,
} from "@/db/schema";
import { AppError, NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit";
import {
  SecretboxError,
  openSecrets,
  sealSecrets,
} from "@/modules/notifications/secretbox";

import { setMonitorPaused } from "@/modules/monitors/service";

import { importSnapshot, type MigrationReport } from "../engine";
import { loadImportedMonitors } from "../provenance";
import { betterStackAdapter } from "../providers/betterstack";
import type { TransportOptions } from "../transport";
import {
  compareBridge,
  mergeCoverage,
  type ComparisonPair,
  type ComparisonReport,
  type SourceEvent,
} from "./compare";
import {
  betterStackTestFetcher,
  readIncidentById,
  readIncidentsWindow,
  readOpenIncidents,
  sourceHasRecord,
  verifyToken,
  type SourceIncident,
} from "./evidence";

/**
 * The migration bridge service: every mutation the bridge supports,
 * behind the same `(db, actor, input)` shape the rest of the product
 * uses, with the audit row inside the mutation's transaction.
 *
 * Better Stack only, on purpose. The import itself goes through the
 * generic engine and would carry any adapter, but the evidence side
 * reads an incident API whose shape, pagination and status vocabulary
 * are one vendor's, and pretending otherwise would mean inventing an
 * abstraction with a single implementation. If a second bridge is ever
 * built, what it actually shares with this one will be visible then.
 *
 * The credential is the one deliberate departure from the importers'
 * "never stored" rule, and it is bounded: sealed with the notification
 * secretbox, deleted outright on disconnect, unsealed only at the
 * moment of a read, and never returned by any function in this file.
 */

export const BRIDGE_PROVIDER = "betterstack";

/** How far back the first poll reaches. Evidence older than the bridge
 * cannot be compared against anything, so a day of slack is enough. */
const FIRST_POLL_BACK_DAYS = 1;

/** Overlap between consecutive poll windows, guarding the date-boundary
 * granularity of the source's `from`/`to` filters. */
const POLL_OVERLAP_MS = 24 * 3_600_000;

/**
 * How many stale open copies one poll will re-fetch individually. A
 * bound, because each is its own request against a third-party account;
 * anything past it waits for the next poll, fifteen minutes away.
 */
const STALE_REFETCH_CAP = 100;

export interface BridgeActor {
  organizationId: string;
  userId: string;
}

export type Bridge = typeof migrationBridges.$inferSelect;

/** What a page may know about a bridge. Never the credential. */
export interface BridgeView {
  id: string;
  provider: string;
  connected: boolean;
  createdAt: Date;
  lastPolledAt: Date | null;
  lastPollStatus: string | null;
  lastPollError: string | null;
  consecutivePollFailures: number;
  shadowMonitorCount: number;
  mapping: {
    total: number;
    imported: number;
    transformed: number;
    skipped: number;
    unsupported: number;
    compared: number;
  };
  coveredHours: number;
  sourceIncidentCount: number;
  imports: { id: string; createdAt: Date; totals: Record<string, number> }[];
  reports: { id: string; createdAt: Date; verdict: string }[];
}

async function bridgeOf(
  db: DbClient,
  organizationId: string,
): Promise<Bridge | null> {
  const row = await db.query.migrationBridges.findFirst({
    where: and(
      eq(migrationBridges.organizationId, organizationId),
      eq(migrationBridges.provider, BRIDGE_PROVIDER),
    ),
  });
  return row ?? null;
}

async function requireBridge(
  db: DbClient,
  organizationId: string,
): Promise<Bridge> {
  const bridge = await bridgeOf(db, organizationId);
  if (!bridge) throw new NotFoundError("No migration bridge is connected.");
  return bridge;
}

/**
 * The sealed token, opened for one read. Throws the operator-worded
 * error when the bridge is disconnected or the key has rotated.
 */
function openToken(bridge: Bridge): string {
  if (bridge.credentialSealed === null) {
    throw new AppError(
      "This bridge is disconnected. Reconnect it with a Better Stack API token to poll evidence or import.",
    );
  }
  let token: string | undefined;
  try {
    token = openSecrets(bridge.credentialSealed).token;
  } catch (error) {
    // The secretbox's own wording (rotated key, tampered row) is the
    // useful part; rethrown as AppError because that is the class whose
    // message the action envelope shows an operator.
    throw new AppError(
      error instanceof SecretboxError
        ? error.message
        : "The stored Better Stack token cannot be read.",
    );
  }
  if (token === undefined) {
    throw new AppError(
      "The stored Better Stack token cannot be read. Reconnect the bridge with a fresh token.",
    );
  }
  return token;
}

/** Transport options for a read, honouring the e2e/dev stub if set. */
function readTransport(overrides?: TransportOptions): TransportOptions {
  const fetcher = betterStackTestFetcher();
  return {
    ...(fetcher === undefined ? {} : { fetcher }),
    ...(overrides ?? {}),
  };
}

/**
 * A source read that fails tells the operator why, in the transport's
 * own already-redacted words. Rethrown as an AppError because that is
 * the class whose message the action envelope lets through; anything
 * else is masked to "Something went wrong", which for a 401 from the
 * source is worse than useless.
 */
async function readOrRefuse<T>(
  what: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(`${what}: ${message}`);
  }
}

/**
 * Connects (or reconnects) the organisation's Better Stack bridge.
 *
 * The token is verified with one authenticated read before anything is
 * stored, so what lands in the database is a credential that worked at
 * least once, sealed. Reconnecting replaces the credential and resets
 * the poll failure counter; it does not touch mappings or evidence,
 * because a rotated token does not invalidate history.
 */
export async function connectBridge(
  db: DbClient,
  actor: BridgeActor,
  input: { token: string; transport?: TransportOptions },
): Promise<BridgeView> {
  const token = input.token.trim();
  if (token.length === 0) {
    throw new AppError("A Better Stack API token is required.");
  }
  await readOrRefuse("Better Stack could not be read with this token", () =>
    verifyToken(token, { transport: readTransport(input.transport) }),
  );

  // A reconnect must be to the SAME account. A token that merely works
  // is not enough: a different workspace's token also works, its
  // record ids are plain integers that can collide with the stored
  // mapping, and the next poll would fabricate comparison rows out of
  // a stranger's incidents. Asking the new token for records this
  // bridge already mapped pins the identity; several are tried, so one
  // monitor deleted at the source since the import does not strand a
  // legitimate rotation.
  const priorBridge = await bridgeOf(db, actor.organizationId);
  if (priorBridge !== null) {
    const known = await db.query.bridgeMonitors.findMany({
      where: eq(bridgeMonitors.bridgeId, priorBridge.id),
      columns: { sourceId: true },
      orderBy: (t, { asc }) => [asc(t.sourceId)],
      limit: 3,
    });
    if (known.length > 0) {
      let visible = false;
      for (const row of known) {
        visible = await readOrRefuse(
          "Better Stack could not be read with this token",
          () =>
            sourceHasRecord(token, row.sourceId, {
              transport: readTransport(input.transport),
            }),
        );
        if (visible) break;
      }
      if (!visible) {
        throw new AppError(
          "This token works, but it cannot see any record this bridge mapped, so it looks like a token for a different Better Stack account or team. Reconnect with a token for the same account, or delete the bridge and start over if you meant to switch.",
        );
      }
    }
  }

  const sealed = sealSecrets({ token });
  await db.transaction(async (tx) => {
    const existing = await tx.query.migrationBridges.findFirst({
      where: and(
        eq(migrationBridges.organizationId, actor.organizationId),
        eq(migrationBridges.provider, BRIDGE_PROVIDER),
      ),
    });
    if (existing) {
      await tx
        .update(migrationBridges)
        .set({
          credentialSealed: sealed,
          consecutivePollFailures: 0,
          lastPollError: null,
        })
        .where(eq(migrationBridges.id, existing.id));
    } else {
      await tx.insert(migrationBridges).values({
        organizationId: actor.organizationId,
        provider: BRIDGE_PROVIDER,
        credentialSealed: sealed,
        createdBy: actor.userId,
      });
    }
    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: existing ? "bridge.reconnected" : "bridge.connected",
      targetType: "migration_bridge",
      targetId: existing?.id ?? BRIDGE_PROVIDER,
      metadata: { provider: BRIDGE_PROVIDER },
    });
  });
  return getBridgeView(db, actor.organizationId) as Promise<BridgeView>;
}

/**
 * Deletes the stored credential. The deletion model is the notification
 * channels': the ciphertext row value is gone, not flagged. Mappings,
 * evidence and reports stay, because they are the audit trail, and the
 * poller skips a disconnected bridge rather than failing it.
 */
export async function disconnectBridge(
  db: DbClient,
  actor: BridgeActor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const bridge = await requireBridge(tx, actor.organizationId);
    await tx
      .update(migrationBridges)
      .set({ credentialSealed: null })
      .where(eq(migrationBridges.id, bridge.id));
    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "bridge.disconnected",
      targetType: "migration_bridge",
      targetId: bridge.id,
      metadata: { provider: bridge.provider },
    });
  });
}

/** The page's read model. Null when no bridge was ever connected. */
export async function getBridgeView(
  db: DbClient,
  organizationId: string,
): Promise<BridgeView | null> {
  const bridge = await bridgeOf(db, organizationId);
  if (!bridge) return null;

  const [shadowCount] = await db
    .select({ value: count() })
    .from(monitors)
    .where(eq(monitors.shadowBridgeId, bridge.id));

  const mappingRows = await db
    .select({
      outcome: bridgeMonitors.outcome,
      compared: bridgeMonitors.compared,
      value: count(),
    })
    .from(bridgeMonitors)
    .where(eq(bridgeMonitors.bridgeId, bridge.id))
    .groupBy(bridgeMonitors.outcome, bridgeMonitors.compared);
  const mapping = {
    total: 0,
    imported: 0,
    transformed: 0,
    skipped: 0,
    unsupported: 0,
    compared: 0,
  };
  for (const row of mappingRows) {
    mapping.total += row.value;
    if (row.compared) mapping.compared += row.value;
    if (row.outcome === "imported") mapping.imported += row.value;
    else if (row.outcome === "transformed") mapping.transformed += row.value;
    else if (row.outcome === "skipped") mapping.skipped += row.value;
    else mapping.unsupported += row.value;
  }

  const coverage = mergeCoverage(
    (
      await db.query.bridgePolls.findMany({
        where: and(
          eq(bridgePolls.bridgeId, bridge.id),
          eq(bridgePolls.status, "ok"),
        ),
        columns: { windowFrom: true, windowTo: true },
      })
    ).map((p) => ({ from: p.windowFrom, to: p.windowTo })),
  );
  const coveredHours =
    coverage.reduce((acc, w) => acc + (w.to.getTime() - w.from.getTime()), 0) /
    3_600_000;

  const [incidentCount] = await db
    .select({ value: count() })
    .from(bridgeSourceIncidents)
    .where(eq(bridgeSourceIncidents.bridgeId, bridge.id));

  const imports = await db.query.bridgeImports.findMany({
    where: eq(bridgeImports.bridgeId, bridge.id),
    orderBy: [desc(bridgeImports.createdAt)],
    columns: { id: true, createdAt: true, totals: true },
    limit: 10,
  });
  const reports = await db.query.bridgeCutoverReports.findMany({
    where: eq(bridgeCutoverReports.bridgeId, bridge.id),
    orderBy: [desc(bridgeCutoverReports.createdAt)],
    columns: { id: true, createdAt: true, verdict: true },
    limit: 10,
  });

  return {
    id: bridge.id,
    provider: bridge.provider,
    connected: bridge.credentialSealed !== null,
    createdAt: bridge.createdAt,
    lastPolledAt: bridge.lastPolledAt,
    lastPollStatus: bridge.lastPollStatus,
    lastPollError: bridge.lastPollError,
    consecutivePollFailures: bridge.consecutivePollFailures,
    shadowMonitorCount: shadowCount?.value ?? 0,
    mapping,
    coveredHours: Math.round(coveredHours * 10) / 10,
    sourceIncidentCount: incidentCount?.value ?? 0,
    imports: imports.map((i) => ({
      id: i.id,
      createdAt: i.createdAt,
      totals: i.totals,
    })),
    reports,
  };
}

/** A stored report, for rendering past decisions exactly as made. */
export async function getCutoverReport(
  db: DbClient,
  organizationId: string,
  reportId: string,
): Promise<{
  id: string;
  createdAt: Date;
  verdict: string;
  reasons: string[];
  body: ComparisonReport;
} | null> {
  const row = await db.query.bridgeCutoverReports.findFirst({
    where: and(
      eq(bridgeCutoverReports.id, reportId),
      eq(bridgeCutoverReports.organizationId, organizationId),
    ),
  });
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    verdict: row.verdict,
    reasons: row.reasons,
    body: row.body as ComparisonReport,
  };
}

/** A stored import run's full report, for the mapping detail view. */
export async function getBridgeImport(
  db: DbClient,
  organizationId: string,
  importId: string,
): Promise<{
  id: string;
  createdAt: Date;
  facts: string[];
  entries: unknown[];
  totals: Record<string, number>;
} | null> {
  const row = await db.query.bridgeImports.findFirst({
    where: and(
      eq(bridgeImports.id, importId),
      eq(bridgeImports.organizationId, organizationId),
    ),
  });
  return row ?? null;
}

interface ReportEntryShape {
  kind: string;
  sourceId: string;
  label: string;
  outcome: "imported" | "transformed" | "skipped" | "unsupported";
  detail: string;
  monitorId: string | null;
}

/**
 * Runs an import through the bridge: the ordinary migration engine,
 * plus everything a one-time import deliberately does not do.
 *
 * On commit, in one transaction with the import itself:
 * - every monitor and group the run created is put into shadow mode;
 * - every source record gets a `bridge_monitors` mapping row, including
 *   the refused ones, because the cutover report has to count losses;
 * - the full report is persisted to `bridge_imports`.
 *
 * A dry run behaves exactly like the wizard's: everything validated
 * against the real constraints, all of it rolled back, nothing bridge-
 * side written either.
 *
 * Records a previous ONE-TIME import already created are mapped but
 * never put into shadow: those monitors are live, an operator may be
 * paging off them today, and a migration tool that silences a live
 * monitor as a side effect is the exact failure this feature exists to
 * prevent.
 */
export async function runBridgeImport(
  db: DbClient,
  actor: BridgeActor,
  options: { dryRun?: boolean; transport?: TransportOptions } = {},
): Promise<MigrationReport> {
  const bridge = await requireBridge(db, actor.organizationId);
  const token = openToken(bridge);
  const dryRun = options.dryRun === true;

  const snapshot = await readOrRefuse(
    "Better Stack could not be read, so nothing was imported",
    () =>
      betterStackAdapter.read({
        credentials: { token },
        transport: readTransport(options.transport),
      }),
  );

  // Heartbeats cannot be compared while the operator's jobs still ping
  // the source system; everything else the adapter maps can.
  const comparableTypes = new Set(
    betterStackAdapter.capabilities
      .filter((c) => c.becomes !== null && c.becomes !== "push")
      .map((c) => c.sourceType),
  );

  return db.transaction(async (tx) => {
    const report = await importSnapshot(tx, actor, snapshot, { dryRun });
    if (dryRun) return report;

    const entries = report.entries as ReportEntryShape[];
    const monitorEntries = entries.filter(
      (e) => e.kind === "monitor" || e.kind === "group",
    );

    // Shadow exactly what this run created. Groups too: a group derives
    // its state from shadow members and must be as silent as they are.
    const createdIds = monitorEntries
      .map((e) => e.monitorId)
      .filter((id): id is string => id !== null);
    if (createdIds.length > 0) {
      await tx
        .update(monitors)
        .set({ shadowBridgeId: bridge.id })
        .where(
          and(
            inArray(monitors.id, createdIds),
            eq(monitors.organizationId, actor.organizationId),
          ),
        );
    }

    // The mapping rows. A provenance-skipped record still maps: the
    // monitor exists from an earlier run and the comparison wants it.
    const imported = await loadImportedMonitors(
      tx,
      actor.organizationId,
      snapshot.provider,
    );
    // The failure windows as they stand at import time. Recorded on the
    // mapping row because the comparison must judge history against the
    // window the import chose, not whatever the operator tunes it to
    // later, and because the record has to survive the monitor.
    const linkedIds = snapshot.checks
      .map(
        (check) =>
          entries.find(
            (e) => e.kind === "monitor" && e.sourceId === check.sourceId,
          )?.monitorId ?? imported.get(check.sourceId)?.id,
      )
      .filter((id): id is string => id !== null && id !== undefined);
    const windows = new Map<string, number>(
      linkedIds.length === 0
        ? []
        : (
            await tx
              .select({
                id: monitors.id,
                failureWindowSeconds: monitors.failureWindowSeconds,
              })
              .from(monitors)
              .where(inArray(monitors.id, linkedIds))
          ).map((m) => [m.id, m.failureWindowSeconds]),
    );
    for (const check of snapshot.checks) {
      const entry = entries.find(
        (e) => e.kind === "monitor" && e.sourceId === check.sourceId,
      );
      if (entry === undefined) continue;
      const monitorId =
        entry.monitorId ?? imported.get(check.sourceId)?.id ?? null;
      const compared =
        monitorId !== null && comparableTypes.has(check.sourceType);
      const failureWindowSeconds =
        monitorId === null ? null : (windows.get(monitorId) ?? null);
      await tx
        .insert(bridgeMonitors)
        .values({
          bridgeId: bridge.id,
          organizationId: actor.organizationId,
          sourceId: check.sourceId,
          sourceName: check.name,
          sourceType: check.sourceType,
          monitorId,
          outcome: entry.outcome,
          detail: entry.detail,
          compared,
          failureWindowSeconds,
        })
        .onConflictDoUpdate({
          target: [bridgeMonitors.bridgeId, bridgeMonitors.sourceId],
          set: {
            sourceName: check.name,
            sourceType: check.sourceType,
            // COALESCE keeps an earlier run's monitor linkage when this
            // run skipped the record: "already imported" must not sever
            // the mapping that makes the comparison possible.
            monitorId: sql`coalesce(${monitorId}, ${bridgeMonitors.monitorId})`,
            outcome: entry.outcome,
            detail: entry.detail,
            compared: sql`${bridgeMonitors.compared} or ${compared}`,
            // The FIRST import's window stands: it is the one the
            // comparison's history was recorded under.
            failureWindowSeconds: sql`coalesce(${bridgeMonitors.failureWindowSeconds}, ${failureWindowSeconds})`,
            updatedAt: sql`now()`,
          },
        });
    }

    await tx.insert(bridgeImports).values({
      bridgeId: bridge.id,
      organizationId: actor.organizationId,
      facts: [...report.facts],
      entries: report.entries,
      totals: { ...report.totals },
      createdBy: actor.userId,
    });

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "bridge.imported",
      targetType: "migration_bridge",
      targetId: bridge.id,
      metadata: {
        provider: bridge.provider,
        monitorsCreated: report.totals.monitorsCreated,
        skipped: report.totals.skipped,
        unsupported: report.totals.unsupported,
      },
    });
    return report;
  });
}

export interface PollOutcome {
  status: "ok" | "partial" | "failed" | "skipped";
  incidentsSeen: number;
  detail: string | null;
}

/**
 * One evidence poll: the open incidents, plus the window since the last
 * successful poll, overlapped by a day. Every source incident seen is
 * upserted; the poll itself is recorded whatever happens, because a
 * failed poll is evidence about the evidence.
 *
 * Idempotent under duplicate delivery: the upsert key is the source's
 * incident id, and two overlapping ok windows merge into one coverage
 * span. Safe under restart mid-poll: incidents land per statement, and
 * an interrupted poll writes no `ok` row, so the next one re-covers the
 * same window.
 */
export async function pollBridgeEvidence(
  db: DbClient,
  bridge: Bridge,
  options: { transport?: TransportOptions; now?: Date } = {},
): Promise<PollOutcome> {
  if (bridge.credentialSealed === null) {
    return { status: "skipped", incidentsSeen: 0, detail: "disconnected" };
  }
  const now = options.now ?? new Date();

  // The window starts a day before the last proven coverage ended, or a
  // day before the bridge existed. Late polls self-heal: after three
  // days of failures the next success queries the whole span, because
  // the source's history is still there to be asked for.
  const [lastOk] = await db
    .select({ windowTo: bridgePolls.windowTo })
    .from(bridgePolls)
    .where(
      and(eq(bridgePolls.bridgeId, bridge.id), eq(bridgePolls.status, "ok")),
    )
    .orderBy(desc(bridgePolls.windowTo))
    .limit(1);
  const from = new Date(
    (lastOk?.windowTo ?? bridge.createdAt).getTime() -
      (lastOk ? POLL_OVERLAP_MS : FIRST_POLL_BACK_DAYS * 86_400_000),
  );

  let seen: SourceIncident[] = [];
  let requestCount = 0;
  let skipped = 0;
  let failure: string | null = null;
  const upsert = async (incident: SourceIncident) => {
    await db
      .insert(bridgeSourceIncidents)
      .values({
        bridgeId: bridge.id,
        organizationId: bridge.organizationId,
        sourceIncidentId: incident.id,
        resourceType: incident.resourceType,
        resourceId: incident.resourceId,
        cause: incident.cause,
        status: incident.status,
        startedAt: incident.startedAt,
        acknowledgedAt: incident.acknowledgedAt,
        resolvedAt: incident.resolvedAt,
      })
      .onConflictDoUpdate({
        target: [
          bridgeSourceIncidents.bridgeId,
          bridgeSourceIncidents.sourceIncidentId,
        ],
        set: {
          // The same no-regress rule for every field: a fresher read
          // may add a resolution, but a slower concurrent poll's stale
          // copy must not take an observed one away - the source never
          // un-resolves an incident, so an unresolved read against a
          // resolved copy is always the older fact, words included. A
          // resolved read wins outright.
          status:
            incident.resolvedAt !== null
              ? incident.status
              : sql`case when ${bridgeSourceIncidents.resolvedAt} is not null then ${bridgeSourceIncidents.status} else ${incident.status} end`,
          cause:
            incident.resolvedAt !== null
              ? incident.cause
              : sql`case when ${bridgeSourceIncidents.resolvedAt} is not null then ${bridgeSourceIncidents.cause} else ${incident.cause} end`,
          acknowledgedAt: sql`coalesce(${incident.acknowledgedAt?.toISOString() ?? null}, ${bridgeSourceIncidents.acknowledgedAt})`,
          resolvedAt: sql`coalesce(${incident.resolvedAt?.toISOString() ?? null}, ${bridgeSourceIncidents.resolvedAt})`,
          lastSeenAt: sql`now()`,
        },
      });
  };

  try {
    const token = openToken(bridge);
    const transport = readTransport(options.transport);
    const open = await readOpenIncidents(token, { transport });
    const window = await readIncidentsWindow(token, from, now, { transport });
    requestCount = open.requestCount + window.requestCount;
    skipped = open.skipped + window.skipped;
    const byId = new Map<string, SourceIncident>();
    for (const incident of [...window.incidents, ...open.incidents]) {
      byId.set(incident.id, incident);
    }
    seen = [...byId.values()];
    for (const incident of seen) await upsert(incident);

    // The list feeds cannot finish a long story: an incident that
    // opened days ago and resolved since is in neither the open sweep
    // nor the start-date window. Ask after every stored copy that is
    // still open but absent from both feeds, one request each, so a
    // multi-day outage's resolution is observed instead of the copy
    // going quietly stale as "still open".
    const openCopies = await db
      .select({ sourceIncidentId: bridgeSourceIncidents.sourceIncidentId })
      .from(bridgeSourceIncidents)
      .where(
        and(
          eq(bridgeSourceIncidents.bridgeId, bridge.id),
          isNull(bridgeSourceIncidents.resolvedAt),
        ),
      );
    const seenIds = new Set(seen.map((incident) => incident.id));
    const stale = openCopies
      .map((row) => row.sourceIncidentId)
      .filter((id) => !seenIds.has(id))
      .slice(0, STALE_REFETCH_CAP);
    for (const id of stale) {
      const result = await readIncidentById(token, id, { transport });
      requestCount += result.requestCount;
      // A 404 is a copy the source deleted; it stays exactly as last
      // seen, which the comparison reads as "end never observed".
      if (result.incident !== null) await upsert(result.incident);
    }
  } catch (error) {
    failure =
      error instanceof Error ? error.message : "The evidence read failed.";
  }

  // A page of unparseable rows is a blinded feed, not a quiet day. The
  // poll is recorded as partial and its window is NOT coverage, so the
  // verdict cannot mistake blindness for agreement.
  const status: "ok" | "partial" | "failed" =
    failure !== null ? "failed" : skipped > 0 ? "partial" : "ok";
  const detail =
    failure ??
    (skipped > 0
      ? `${skipped} source row(s) could not be parsed; this window is not counted as evidence coverage.`
      : null);

  await db.insert(bridgePolls).values({
    bridgeId: bridge.id,
    organizationId: bridge.organizationId,
    windowFrom: from,
    windowTo: now,
    status,
    detail,
    requestCount,
    incidentsSeen: seen.length,
  });
  await db
    .update(migrationBridges)
    .set({
      lastPolledAt: sql`now()`,
      lastPollStatus: status,
      lastPollError: detail,
      consecutivePollFailures:
        status === "failed"
          ? sql`${migrationBridges.consecutivePollFailures} + 1`
          : 0,
    })
    .where(eq(migrationBridges.id, bridge.id));

  return { status, incidentsSeen: seen.length, detail };
}

/** Poll on demand, for the settings page's refresh action. */
export async function pollBridgeNow(
  db: DbClient,
  actor: BridgeActor,
  options: { transport?: TransportOptions } = {},
): Promise<PollOutcome> {
  const bridge = await requireBridge(db, actor.organizationId);
  return pollBridgeEvidence(db, bridge, options);
}

/**
 * Whether a stored source-incident copy can be trusted about its end.
 *
 * An incident deleted upstream, or one the poller stopped seeing while
 * open, keeps its last-seen state forever. If the copy is unresolved
 * but was last refreshed before the latest successful poll, its true
 * end was never observed and the comparison must say "unknown" rather
 * than "still open".
 */
/**
 * The last instant a stored copy is known to have been accurate: its
 * observed resolution, or the last moment a poll refreshed it. What the
 * comparison builds its duration lower bounds from - a copy that went
 * stale while open (deleted upstream, or a paused bridge) stops
 * accruing known-open time at its last refresh rather than pretending
 * to be open forever.
 */
function observedUntilFor(
  row: typeof bridgeSourceIncidents.$inferSelect,
): Date {
  return row.resolvedAt ?? row.lastSeenAt;
}

/**
 * Generates a cutover report and persists it, frozen.
 *
 * Everything in the body is computed from stored rows: the mappings the
 * import recorded, the incidents the polls copied, the observations and
 * incidents Vigil itself wrote. Nothing here reads the source system,
 * so generating a report is possible, and identical, whether or not the
 * bridge can currently reach it.
 */
export async function generateCutoverReport(
  db: DbClient,
  actor: BridgeActor,
  options: { now?: Date } = {},
): Promise<{ id: string; report: ComparisonReport }> {
  const bridge = await requireBridge(db, actor.organizationId);
  const now = options.now ?? new Date();

  const mappings = await db.query.bridgeMonitors.findMany({
    where: eq(bridgeMonitors.bridgeId, bridge.id),
  });
  if (mappings.length === 0) {
    throw new AppError(
      "Nothing has been imported through this bridge yet, so there is nothing to compare. Run the import first.",
    );
  }

  const okPolls = await db.query.bridgePolls.findMany({
    where: and(
      eq(bridgePolls.bridgeId, bridge.id),
      eq(bridgePolls.status, "ok"),
    ),
    columns: { windowFrom: true, windowTo: true },
  });

  // The comparison window is the bridge's lifetime. A source incident
  // that both started and ended before the bridge existed has no Vigil
  // twin to be compared with, and a Vigil incident from a monitor's
  // pre-bridge history (a provenance-linked one from an old one-time
  // import) is not an "extra" the source failed to see - the polls were
  // never asked about that time. Events still open at the bridge's
  // creation stay in: both sides can see those.
  const windowOpensAt = bridge.createdAt;

  const sourceRows = await db.query.bridgeSourceIncidents.findMany({
    where: eq(bridgeSourceIncidents.bridgeId, bridge.id),
  });
  const sourceByResource = new Map<string, SourceEvent[]>();
  for (const row of sourceRows) {
    if (row.resourceId === null) continue;
    const observedUntil = observedUntilFor(row);
    if (observedUntil.getTime() < windowOpensAt.getTime()) continue;
    const key = `${row.resourceType ?? "monitor"}:${row.resourceId}`;
    const list = sourceByResource.get(key) ?? [];
    list.push({
      id: row.sourceIncidentId,
      resourceId: row.resourceId,
      start: row.startedAt,
      end: row.resolvedAt,
      observedUntil,
      cause: row.cause,
    });
    sourceByResource.set(key, list);
  }

  const monitorIds = mappings
    .map((m) => m.monitorId)
    .filter((id): id is string => id !== null);
  const monitorRows =
    monitorIds.length === 0
      ? []
      : await db.query.monitors.findMany({
          where: and(
            inArray(monitors.id, monitorIds),
            eq(monitors.organizationId, actor.organizationId),
          ),
          columns: { id: true, createdAt: true },
        });
  const monitorById = new Map(monitorRows.map((m) => [m.id, m]));

  const vigilIncidentRows =
    monitorIds.length === 0
      ? []
      : await db.query.incidents.findMany({
          where: and(
            inArray(incidents.monitorId, monitorIds),
            eq(incidents.organizationId, actor.organizationId),
            eq(incidents.source, "monitor"),
            // Overlaps the comparison window: still open, or resolved
            // after the bridge began.
            or(
              isNull(incidents.resolvedAt),
              gte(incidents.resolvedAt, windowOpensAt),
            ),
          ),
          columns: {
            id: true,
            monitorId: true,
            startedAt: true,
            resolvedAt: true,
          },
        });
  const vigilByMonitor = new Map<string, typeof vigilIncidentRows>();
  for (const row of vigilIncidentRows) {
    if (row.monitorId === null) continue;
    const list = vigilByMonitor.get(row.monitorId) ?? [];
    list.push(row);
    vigilByMonitor.set(row.monitorId, list);
  }

  const checkCounts =
    monitorIds.length === 0
      ? []
      : await db
          .select({ monitorId: monitorChecks.monitorId, value: count() })
          .from(monitorChecks)
          .where(
            and(
              inArray(monitorChecks.monitorId, monitorIds),
              // During the bridge, not ever: a provenance-linked monitor
              // from an old import carries months of history, and stale
              // observations must not satisfy "this pair was watched".
              gte(monitorChecks.checkedAt, windowOpensAt),
            ),
          )
          .groupBy(monitorChecks.monitorId);
  const checksByMonitor = new Map(
    checkCounts.map((c) => [c.monitorId, c.value]),
  );

  const pairs: ComparisonPair[] = mappings.map((m) => {
    const monitor = m.monitorId === null ? null : monitorById.get(m.monitorId);
    const resourceKind = m.sourceId.startsWith("heartbeat:")
      ? "heartbeat"
      : "monitor";
    const bareId = m.sourceId.startsWith("heartbeat:")
      ? m.sourceId.slice("heartbeat:".length)
      : m.sourceId;
    return {
      sourceId: m.sourceId,
      sourceName: m.sourceName,
      sourceType: m.sourceType,
      monitorId: monitor === undefined ? null : m.monitorId,
      outcome: m.outcome,
      detail: m.detail,
      compared: m.compared && monitor !== undefined,
      observedSince: monitor?.createdAt ?? null,
      // The window recorded at import, deliberately not the monitor's
      // current one: see the column's own comment.
      failureWindowSeconds: m.failureWindowSeconds,
      vigilChecks:
        m.monitorId === null ? 0 : (checksByMonitor.get(m.monitorId) ?? 0),
      sourceEvents: sourceByResource.get(`${resourceKind}:${bareId}`) ?? [],
      vigilEvents: (m.monitorId === null
        ? []
        : (vigilByMonitor.get(m.monitorId) ?? [])
      ).map((v) => ({ id: v.id, start: v.startedAt, end: v.resolvedAt })),
    };
  });

  // What the import itself said needs hands: the non-monitor report
  // lines of the latest run (status pages, escalation policies).
  const latestImport = await db.query.bridgeImports.findFirst({
    where: eq(bridgeImports.bridgeId, bridge.id),
    orderBy: [desc(bridgeImports.createdAt)],
  });
  const manualNotes = ((latestImport?.entries ?? []) as ReportEntryShape[])
    .filter(
      (e) =>
        e.kind !== "monitor" && e.kind !== "group" && e.outcome !== "imported",
    )
    .map((e) => `${e.label}: ${e.detail}`);

  const report = compareBridge({
    at: now,
    pairs,
    coverage: okPolls.map((p) => ({ from: p.windowFrom, to: p.windowTo })),
    manualNotes,
    consecutivePollFailures: bridge.consecutivePollFailures,
  });

  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(bridgeCutoverReports)
      .values({
        bridgeId: bridge.id,
        organizationId: actor.organizationId,
        verdict: report.verdict,
        reasons: report.reasons,
        body: report,
        windowFrom: report.window.from ?? bridge.createdAt,
        windowTo: report.window.to,
        generatedBy: actor.userId,
      })
      .returning({ id: bridgeCutoverReports.id });
    if (!row) throw new Error("insert returned no row");
    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "bridge.report_generated",
      targetType: "migration_bridge",
      targetId: bridge.id,
      metadata: {
        reportId: row.id,
        verdict: report.verdict,
        matched: report.totals.matched,
        missed: report.totals.missed,
        extra: report.totals.extra,
      },
    });
    return row.id;
  });

  return { id, report };
}

/**
 * Ends shadow mode, forwards: the imported monitors go live.
 *
 * Open shadow incidents are resolved with a timeline entry saying why,
 * not flipped loud: their whole history happened under the promise of
 * silence, and a page about an hour-old incident is worse than the page
 * the next check produces. A monitor that is still down opens a fresh,
 * live incident on its next evaluation, one check interval later, and
 * that one pages through every ordinary path.
 */
export async function cutOverBridge(
  db: DbClient,
  actor: BridgeActor,
): Promise<{ monitorsLive: number; incidentsClosed: number }> {
  return db.transaction(async (tx) => {
    const bridge = await requireBridge(tx, actor.organizationId);
    return endShadow(tx, actor, bridge, "cutover");
  });
}

/**
 * Ends shadow mode, backwards: the imported monitors are paused.
 *
 * For the operator who ran the comparison and decided not to switch.
 * Pausing rather than deleting, because deleting somebody's monitors is
 * not a thing a migration tool does on its own; the fleet is left
 * visible, silent, and cheap to delete or resume deliberately.
 */
export async function abandonBridge(
  db: DbClient,
  actor: BridgeActor,
): Promise<{ monitorsLive: number; incidentsClosed: number }> {
  return db.transaction(async (tx) => {
    const bridge = await requireBridge(tx, actor.organizationId);
    return endShadow(tx, actor, bridge, "abandon");
  });
}

async function endShadow(
  tx: DbClient,
  actor: BridgeActor,
  bridge: Bridge,
  mode: "cutover" | "abandon",
): Promise<{ monitorsLive: number; incidentsClosed: number }> {
  // Lock the shadow fleet in a stable order. `openMonitorIncident` and
  // `resolveMonitorIncidents` serialise on the same rows, so an
  // incident cannot be opening for one of these monitors while its
  // shadow status changes under it.
  const fleet = await tx
    .select({ id: monitors.id })
    .from(monitors)
    .where(
      and(
        eq(monitors.shadowBridgeId, bridge.id),
        eq(monitors.organizationId, actor.organizationId),
      ),
    )
    .orderBy(monitors.id)
    .for("update");
  const fleetIds = fleet.map((m) => m.id);

  let incidentsClosed = 0;
  if (fleetIds.length > 0) {
    const open = await tx.query.incidents.findMany({
      where: and(
        inArray(incidents.monitorId, fleetIds),
        eq(incidents.organizationId, actor.organizationId),
        eq(incidents.shadow, true),
        eq(incidents.source, "monitor"),
        ne(incidents.status, "resolved"),
      ),
      columns: { id: true },
    });
    for (const incident of open) {
      const [updated] = await tx
        .update(incidents)
        .set({
          status: "resolved",
          resolvedAt: new Date(),
          statusRevision: sql`${incidents.statusRevision} + 1`,
        })
        .where(
          and(eq(incidents.id, incident.id), ne(incidents.status, "resolved")),
        )
        .returning({ id: incidents.id });
      if (!updated) continue;
      incidentsClosed += 1;
      await tx.insert(incidentEvents).values({
        incidentId: incident.id,
        type: "system",
        message:
          mode === "cutover"
            ? "Shadow mode ended: this incident was recorded for migration comparison and is closed with it. If the target is still failing, the next check opens a live incident that pages normally."
            : "Shadow mode ended without cutover: the monitor was paused and this comparison incident is closed with it.",
        createdBy: null,
      });
    }

    await tx
      .update(monitors)
      .set({ shadowBridgeId: null })
      .where(inArray(monitors.id, fleetIds));

    // Abandon pauses through the one implementation of pausing, so the
    // fleet gets exactly the clean slate a hand-paused monitor gets:
    // `firstFailureAt` cleared (or the first failing check after a later
    // resume computes "failing for a week" and pages at once, skipping
    // the failure window), status back to unknown, the schedule reset.
    // A per-monitor call rather than a bulk UPDATE, because a second
    // copy of those semantics here would be the copy that forgets the
    // next field the real one learns about.
    if (mode === "abandon") {
      for (const id of fleetIds) {
        await setMonitorPaused(tx, actor, id, true);
      }
    }
  }

  await writeAudit(tx, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: mode === "cutover" ? "bridge.cutover" : "bridge.abandoned",
    targetType: "migration_bridge",
    targetId: bridge.id,
    metadata: { monitors: fleetIds.length, incidentsClosed },
  });

  return { monitorsLive: fleetIds.length, incidentsClosed };
}

/**
 * Deletes the bridge and, through cascades, its mappings, evidence,
 * polls and reports. Refused while any monitor still shadows under it,
 * by this check and by the database's RESTRICT both: ending shadow mode
 * is an explicit, audited act, never a cascade's side effect.
 */
export async function deleteBridge(
  db: DbClient,
  actor: BridgeActor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const bridge = await requireBridge(tx, actor.organizationId);
    const [shadowCount] = await tx
      .select({ value: count() })
      .from(monitors)
      .where(eq(monitors.shadowBridgeId, bridge.id));
    if ((shadowCount?.value ?? 0) > 0) {
      throw new AppError(
        `${shadowCount?.value} monitor(s) still run in this bridge's shadow mode. Cut over or abandon before deleting the bridge, so ending the comparison is a decision rather than a side effect.`,
      );
    }
    await tx.delete(migrationBridges).where(eq(migrationBridges.id, bridge.id));
    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "bridge.deleted",
      targetType: "migration_bridge",
      targetId: bridge.id,
      metadata: { provider: bridge.provider },
    });
  });
}

/** Every connected bridge, for the worker's poll fan-out. */
export async function listPollableBridges(db: DbClient): Promise<Bridge[]> {
  return db.query.migrationBridges.findMany({
    where: isNotNull(migrationBridges.credentialSealed),
  });
}
