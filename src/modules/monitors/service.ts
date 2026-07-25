import { and, asc, desc, eq, gte, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { monitorChecks, monitors } from "@/db/schema";
import { NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit";

import type { CheckOutcome } from "./check";
import type { CreateMonitorInput, UpdateMonitorInput } from "./schemas";

export type Monitor = typeof monitors.$inferSelect;
export type MonitorCheck = typeof monitorChecks.$inferSelect;

interface Actor {
  organizationId: string;
  userId: string;
}

export interface MonitorListItem extends Monitor {
  uptime24hPct: number | null;
  avgResponseMs: number | null;
}

export async function listMonitors(
  db: DbClient,
  organizationId: string,
): Promise<MonitorListItem[]> {
  const stats = db.$with("stats").as(
    db
      .select({
        monitorId: monitorChecks.monitorId,
        uptime24hPct: sql<number>`
          round(count(*) filter (where ${monitorChecks.ok}) * 100.0 / count(*), 2)
        `.as("uptime_24h_pct"),
        avgResponseMs: sql<number>`
          round(avg(${monitorChecks.responseTimeMs}) filter (where ${monitorChecks.ok}))
        `.as("avg_response_ms"),
      })
      .from(monitorChecks)
      .where(gte(monitorChecks.checkedAt, sql`now() - interval '24 hours'`))
      .groupBy(monitorChecks.monitorId),
  );

  const rows = await db
    .with(stats)
    .select({
      monitor: monitors,
      uptime24hPct: stats.uptime24hPct,
      avgResponseMs: stats.avgResponseMs,
    })
    .from(monitors)
    .leftJoin(stats, eq(stats.monitorId, monitors.id))
    .where(eq(monitors.organizationId, organizationId))
    .orderBy(asc(monitors.createdAt));

  return rows.map(({ monitor, uptime24hPct, avgResponseMs }) => ({
    ...monitor,
    uptime24hPct: uptime24hPct === null ? null : Number(uptime24hPct),
    avgResponseMs: avgResponseMs === null ? null : Number(avgResponseMs),
  }));
}

export interface UptimeWindow {
  label: "24h" | "7d" | "30d";
  uptimePct: number | null;
  avgResponseMs: number | null;
}

export interface MonitorDetail {
  monitor: Monitor;
  windows: UptimeWindow[];
  recentChecks: MonitorCheck[];
}

export async function getMonitorDetail(
  db: DbClient,
  organizationId: string,
  monitorId: string,
): Promise<MonitorDetail> {
  const monitor = await findMonitorOrThrow(db, organizationId, monitorId);

  const [aggregate] = await db
    .select({
      ok24h: sql<number>`count(*) filter (where ${okWithin("24 hours")})`,
      total24h: sql<number>`count(*) filter (where ${within("24 hours")})`,
      avg24h: sql<
        number | null
      >`round(avg(${monitorChecks.responseTimeMs}) filter (where ${okWithin("24 hours")}))`,
      ok7d: sql<number>`count(*) filter (where ${okWithin("7 days")})`,
      total7d: sql<number>`count(*) filter (where ${within("7 days")})`,
      avg7d: sql<
        number | null
      >`round(avg(${monitorChecks.responseTimeMs}) filter (where ${okWithin("7 days")}))`,
      ok30d: sql<number>`count(*) filter (where ${okWithin("30 days")})`,
      total30d: sql<number>`count(*) filter (where ${within("30 days")})`,
      avg30d: sql<
        number | null
      >`round(avg(${monitorChecks.responseTimeMs}) filter (where ${okWithin("30 days")}))`,
    })
    .from(monitorChecks)
    .where(eq(monitorChecks.monitorId, monitorId));

  const recentChecks = await db.query.monitorChecks.findMany({
    where: eq(monitorChecks.monitorId, monitorId),
    orderBy: [desc(monitorChecks.checkedAt)],
    limit: 60,
  });

  const windows: UptimeWindow[] = [
    window("24h", aggregate?.ok24h, aggregate?.total24h, aggregate?.avg24h),
    window("7d", aggregate?.ok7d, aggregate?.total7d, aggregate?.avg7d),
    window("30d", aggregate?.ok30d, aggregate?.total30d, aggregate?.avg30d),
  ];

  return { monitor, windows, recentChecks };
}

function within(interval: string) {
  return sql`${monitorChecks.checkedAt} > now() - ${sql.raw(`interval '${interval}'`)}`;
}

function okWithin(interval: string) {
  return sql`${within(interval)} and ${monitorChecks.ok}`;
}

function window(
  label: UptimeWindow["label"],
  ok: number | undefined,
  total: number | undefined,
  avg: number | null | undefined,
): UptimeWindow {
  const totalCount = Number(total ?? 0);
  return {
    label,
    uptimePct:
      totalCount === 0
        ? null
        : Math.round((Number(ok ?? 0) / totalCount) * 10_000) / 100,
    avgResponseMs: avg === null || avg === undefined ? null : Number(avg),
  };
}

export async function createMonitor(
  db: DbClient,
  actor: Actor,
  input: CreateMonitorInput,
): Promise<Monitor> {
  return db.transaction(async (tx) => {
    const [monitor] = await tx
      .insert(monitors)
      .values({
        organizationId: actor.organizationId,
        createdBy: actor.userId,
        name: input.name,
        url: input.url,
        method: input.method,
        intervalSeconds: input.intervalSeconds,
        timeoutMs: input.timeoutMs,
        degradedThresholdMs: input.degradedThresholdMs,
        expectedStatusCode: input.expectedStatusCode ?? null,
        bodyKeyword: input.bodyKeyword ?? null,
        keywordAbsent: input.keywordAbsent,
        failureThreshold: input.failureThreshold,
      })
      .returning();
    if (!monitor) throw new Error("insert returned no row");

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "monitor.created",
      targetType: "monitor",
      targetId: monitor.id,
      metadata: { name: monitor.name, url: monitor.url },
    });
    return monitor;
  });
}

export async function updateMonitor(
  db: DbClient,
  actor: Actor,
  monitorId: string,
  input: UpdateMonitorInput,
): Promise<Monitor> {
  return db.transaction(async (tx) => {
    await findMonitorOrThrow(tx, actor.organizationId, monitorId);

    const [updated] = await tx
      .update(monitors)
      .set({
        ...input,
        expectedStatusCode:
          input.expectedStatusCode === undefined
            ? undefined
            : (input.expectedStatusCode ?? null),
      })
      .where(eq(monitors.id, monitorId))
      .returning();
    if (!updated) throw new NotFoundError("Monitor not found.");

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "monitor.updated",
      targetType: "monitor",
      targetId: monitorId,
      metadata: { fields: Object.keys(input) },
    });
    return updated;
  });
}

export async function setMonitorPaused(
  db: DbClient,
  actor: Actor,
  monitorId: string,
  paused: boolean,
): Promise<Monitor> {
  return db.transaction(async (tx) => {
    await findMonitorOrThrow(tx, actor.organizationId, monitorId);

    const [updated] = await tx
      .update(monitors)
      // Unpausing starts from a clean slate: stale failure counts from
      // before the pause must not open an incident on the first check.
      .set({ paused, consecutiveFailures: 0, currentStatus: "unknown" })
      .where(eq(monitors.id, monitorId))
      .returning();
    if (!updated) throw new NotFoundError("Monitor not found.");

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: paused ? "monitor.paused" : "monitor.resumed",
      targetType: "monitor",
      targetId: monitorId,
    });
    return updated;
  });
}

export async function deleteMonitor(
  db: DbClient,
  actor: Actor,
  monitorId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const monitor = await findMonitorOrThrow(
      tx,
      actor.organizationId,
      monitorId,
    );

    await tx.delete(monitors).where(eq(monitors.id, monitorId));
    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "monitor.deleted",
      targetType: "monitor",
      targetId: monitorId,
      metadata: { name: monitor.name, url: monitor.url },
    });
  });
}

export interface RecordedCheck {
  monitor: Monitor;
  becameDown: boolean;
  becameUp: boolean;
}

/**
 * Persists a check outcome and advances the monitor's cached state.
 * Returns transition flags so the caller (worker) can open or resolve
 * incidents — incident policy deliberately lives outside this module.
 */
export async function recordCheckOutcome(
  db: DbClient,
  monitor: Monitor,
  outcome: CheckOutcome,
): Promise<RecordedCheck> {
  const consecutiveFailures = outcome.ok ? 0 : monitor.consecutiveFailures + 1;
  const newStatus = outcome.ok
    ? outcome.degraded
      ? "degraded"
      : "up"
    : consecutiveFailures >= monitor.failureThreshold
      ? "down"
      : monitor.currentStatus;

  const [updated] = await db.transaction(async (tx) => {
    await tx.insert(monitorChecks).values({
      monitorId: monitor.id,
      ok: outcome.ok,
      statusCode: outcome.statusCode,
      responseTimeMs: outcome.responseTimeMs,
      error: outcome.error,
    });
    return tx
      .update(monitors)
      .set({
        consecutiveFailures,
        currentStatus: newStatus,
        lastCheckedAt: new Date(),
      })
      .where(eq(monitors.id, monitor.id))
      .returning();
  });
  if (!updated) throw new NotFoundError("Monitor disappeared mid-check.");

  return {
    monitor: updated,
    becameDown:
      monitor.currentStatus !== "down" && updated.currentStatus === "down",
    becameUp: monitor.currentStatus === "down" && outcome.ok,
  };
}

/**
 * The tick runs once a minute, but checks complete a few seconds after
 * the tick that scheduled them. Without slack, a 60s monitor checked at
 * :00:22 isn't "due" at the :01:00 tick and drifts to a 2-minute
 * cadence. Half a tick period of grace keeps intervals aligned.
 */
const TICK_GRACE_SECONDS = 30;

/**
 * Monitors due for a probe: never checked, or past their interval.
 * Most-overdue first so a batch `limit` can never starve a monitor —
 * anything skipped this tick sorts even earlier on the next one.
 */
export async function findDueMonitors(
  db: DbClient,
  limit = 500,
): Promise<Monitor[]> {
  return db.query.monitors.findMany({
    where: and(
      eq(monitors.paused, false),
      sql`(
        ${monitors.lastCheckedAt} is null
        or ${monitors.lastCheckedAt} + make_interval(secs => ${monitors.intervalSeconds} - ${TICK_GRACE_SECONDS}) <= now()
      )`,
    ),
    orderBy: [sql`${monitors.lastCheckedAt} asc nulls first`],
    limit,
  });
}

async function findMonitorOrThrow(
  db: DbClient,
  organizationId: string,
  monitorId: string,
): Promise<Monitor> {
  const monitor = await db.query.monitors.findFirst({
    where: and(
      eq(monitors.id, monitorId),
      eq(monitors.organizationId, organizationId),
    ),
  });
  if (!monitor) throw new NotFoundError("Monitor not found.");
  return monitor;
}
