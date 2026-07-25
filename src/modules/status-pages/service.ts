import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import {
  incidentEvents,
  incidents,
  monitorChecks,
  monitors,
  organization,
  statusPageMonitors,
  statusPages,
} from "@/db/schema";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit";

import type { StatusPageMonitorsInput, UpdateStatusPageInput } from "./schemas";

export type StatusPage = typeof statusPages.$inferSelect;

interface Actor {
  organizationId: string;
  userId: string;
}

/**
 * Every organization gets exactly one status page, created lazily the
 * first time someone opens the settings screen.
 */
export async function getOrCreateStatusPage(
  db: DbClient,
  organizationId: string,
): Promise<StatusPage> {
  const existing = await db.query.statusPages.findFirst({
    where: eq(statusPages.organizationId, organizationId),
  });
  if (existing) return existing;

  const org = await db.query.organization.findFirst({
    where: eq(organization.id, organizationId),
    columns: { name: true, slug: true },
  });
  if (!org) throw new NotFoundError("Organization not found.");

  const [created] = await db
    .insert(statusPages)
    .values({
      organizationId,
      name: `${org.name} status`,
      slug: org.slug,
    })
    .onConflictDoNothing()
    .returning();

  if (created) return created;
  // Lost a race with a concurrent request — fetch the winner's row.
  const winner = await db.query.statusPages.findFirst({
    where: eq(statusPages.organizationId, organizationId),
  });
  if (!winner) throw new ConflictError("The status page slug is taken.");
  return winner;
}

export async function updateStatusPage(
  db: DbClient,
  actor: Actor,
  input: UpdateStatusPageInput,
): Promise<StatusPage> {
  return db.transaction(async (tx) => {
    const page = await getOrCreateStatusPage(tx, actor.organizationId);

    const slugTaken = await tx.query.statusPages.findFirst({
      where: and(eq(statusPages.slug, input.slug), ne(statusPages.id, page.id)),
      columns: { id: true },
    });
    if (slugTaken) throw new ConflictError("That slug is already in use.");

    const [updated] = await tx
      .update(statusPages)
      .set({
        name: input.name,
        slug: input.slug,
        published: input.published,
      })
      .where(eq(statusPages.id, page.id))
      .returning();
    if (!updated) throw new NotFoundError("Status page not found.");

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "status_page.updated",
      targetType: "status_page",
      targetId: page.id,
      metadata: {
        slug: input.slug,
        published: input.published,
      },
    });
    return updated;
  });
}

/** Replaces the set of monitors shown publicly, preserving given order. */
export async function setStatusPageMonitors(
  db: DbClient,
  actor: Actor,
  input: StatusPageMonitorsInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    const page = await getOrCreateStatusPage(tx, actor.organizationId);

    const monitorIds = input.monitors.map((m) => m.monitorId);
    if (monitorIds.length > 0) {
      const owned = await tx.query.monitors.findMany({
        where: and(
          inArray(monitors.id, monitorIds),
          eq(monitors.organizationId, actor.organizationId),
        ),
        columns: { id: true },
      });
      if (owned.length !== monitorIds.length) {
        throw new NotFoundError("Monitor not found.");
      }
    }

    await tx
      .delete(statusPageMonitors)
      .where(eq(statusPageMonitors.statusPageId, page.id));
    if (input.monitors.length > 0) {
      await tx.insert(statusPageMonitors).values(
        input.monitors.map((m, index) => ({
          statusPageId: page.id,
          monitorId: m.monitorId,
          displayName: m.displayName ?? null,
          sortOrder: index,
        })),
      );
    }

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "status_page.monitors_updated",
      targetType: "status_page",
      targetId: page.id,
      metadata: { count: input.monitors.length },
    });
  });
}

export interface StatusPageComponentConfig {
  monitorId: string;
  internalName: string;
  displayName: string | null;
}

export async function listStatusPageMonitors(
  db: DbClient,
  organizationId: string,
): Promise<StatusPageComponentConfig[]> {
  const page = await getOrCreateStatusPage(db, organizationId);
  const rows = await db
    .select({
      monitorId: statusPageMonitors.monitorId,
      internalName: monitors.name,
      displayName: statusPageMonitors.displayName,
    })
    .from(statusPageMonitors)
    .innerJoin(monitors, eq(statusPageMonitors.monitorId, monitors.id))
    .where(eq(statusPageMonitors.statusPageId, page.id))
    .orderBy(asc(statusPageMonitors.sortOrder));
  return rows;
}

// ---------------------------------------------------------------------------
// Public read model
// ---------------------------------------------------------------------------

export interface DailyUptime {
  /** ISO date (YYYY-MM-DD). */
  day: string;
  uptimePct: number;
}

export interface PublicComponent {
  name: string;
  status: "up" | "down" | "degraded" | "unknown";
  uptime90dPct: number | null;
  dailyUptime: DailyUptime[];
}

export interface PublicIncidentEvent {
  type: string;
  status: string | null;
  message: string;
  createdAt: Date;
}

export interface PublicIncident {
  id: string;
  title: string;
  status: "investigating" | "identified" | "monitoring" | "resolved";
  severity: "critical" | "major" | "minor";
  startedAt: Date;
  resolvedAt: Date | null;
  events: PublicIncidentEvent[];
}

export interface PublicStatusPage {
  name: string;
  organizationName: string;
  components: PublicComponent[];
  activeIncidents: PublicIncident[];
  recentIncidents: PublicIncident[];
  overall: "operational" | "degraded" | "outage";
}

/**
 * The whole public page in one call. Only published pages resolve;
 * everything returned here is safe for allowed eyes (no URLs, no
 * internal notes — timeline messages on a status page are written to be
 * public).
 */
export async function getPublicStatusPage(
  db: DbClient,
  slug: string,
): Promise<PublicStatusPage | null> {
  const page = await db.query.statusPages.findFirst({
    where: and(eq(statusPages.slug, slug), eq(statusPages.published, true)),
  });
  if (!page) return null;

  const org = await db.query.organization.findFirst({
    where: eq(organization.id, page.organizationId),
    columns: { name: true },
  });

  const componentRows = await db
    .select({
      monitorId: monitors.id,
      internalName: monitors.name,
      displayName: statusPageMonitors.displayName,
      status: monitors.currentStatus,
      paused: monitors.paused,
    })
    .from(statusPageMonitors)
    .innerJoin(monitors, eq(statusPageMonitors.monitorId, monitors.id))
    .where(eq(statusPageMonitors.statusPageId, page.id))
    .orderBy(asc(statusPageMonitors.sortOrder));

  const monitorIds = componentRows.map((row) => row.monitorId);
  const uptimeByMonitor = await dailyUptime(db, monitorIds);

  const components: PublicComponent[] = componentRows.map((row) => {
    const daily = uptimeByMonitor.get(row.monitorId) ?? [];
    const total = daily.reduce((sum, d) => sum + d.uptimePct, 0);
    return {
      name: row.displayName ?? row.internalName,
      status: row.paused ? "unknown" : row.status,
      uptime90dPct:
        daily.length > 0
          ? Math.round((total / daily.length) * 100) / 100
          : null,
      dailyUptime: daily,
    };
  });

  const activeIncidents = await publicIncidents(db, page.organizationId, {
    active: true,
  });
  const recentIncidents = await publicIncidents(db, page.organizationId, {
    active: false,
  });

  const overall: PublicStatusPage["overall"] = components.some(
    (c) => c.status === "down",
  )
    ? "outage"
    : components.some((c) => c.status === "degraded") ||
        activeIncidents.length > 0
      ? "degraded"
      : "operational";

  return {
    name: page.name,
    organizationName: org?.name ?? page.name,
    components,
    activeIncidents,
    recentIncidents,
    overall,
  };
}

async function dailyUptime(
  db: DbClient,
  monitorIds: string[],
): Promise<Map<string, DailyUptime[]>> {
  if (monitorIds.length === 0) return new Map();

  // Bucket by UTC day: the UI builds its day keys with toISOString(),
  // so bucketing in server-local time would desync the two after local
  // midnight and today's bar would silently render as "no data".
  const dayExpr = sql`date_trunc('day', ${monitorChecks.checkedAt} at time zone 'utc')`;
  const rows = await db
    .select({
      monitorId: monitorChecks.monitorId,
      day: sql<string>`to_char(${dayExpr}, 'YYYY-MM-DD')`.as("day"),
      uptimePct: sql<number>`round(count(*) filter (where ${monitorChecks.ok}) * 100.0 / count(*), 2)`,
    })
    .from(monitorChecks)
    .where(
      and(
        inArray(monitorChecks.monitorId, monitorIds),
        gte(monitorChecks.checkedAt, sql`now() - interval '90 days'`),
      ),
    )
    .groupBy(monitorChecks.monitorId, dayExpr)
    .orderBy(dayExpr);

  const map = new Map<string, DailyUptime[]>();
  for (const row of rows) {
    const list = map.get(row.monitorId) ?? [];
    list.push({ day: row.day, uptimePct: Number(row.uptimePct) });
    map.set(row.monitorId, list);
  }
  return map;
}

async function publicIncidents(
  db: DbClient,
  organizationId: string,
  options: { active: boolean },
): Promise<PublicIncident[]> {
  const rows = await db.query.incidents.findMany({
    where: and(
      eq(incidents.organizationId, organizationId),
      options.active
        ? ne(incidents.status, "resolved")
        : and(
            eq(incidents.status, "resolved"),
            gte(incidents.resolvedAt, sql`now() - interval '14 days'`),
          ),
    ),
    orderBy: [desc(incidents.startedAt)],
    limit: options.active ? 10 : 20,
  });
  if (rows.length === 0) return [];

  // `system` events are internal recovery mechanics ("attempt 2 did not
  // restore …", "exhausted — waiting for a human"). They belong on the
  // operator's incident timeline, never on the customer-facing status
  // page — the public view shows the lifecycle (opened, human updates,
  // status changes, resolution), not how recovery was attempted.
  // Internal notes are withheld for the same reason.
  const events = await db.query.incidentEvents.findMany({
    where: and(
      inArray(
        incidentEvents.incidentId,
        rows.map((incident) => incident.id),
      ),
      ne(incidentEvents.type, "system"),
      eq(incidentEvents.internal, false),
    ),
    orderBy: [desc(incidentEvents.createdAt)],
  });

  return rows.map((incident) => ({
    id: incident.id,
    title: incident.title,
    status: incident.status,
    severity: incident.severity,
    startedAt: incident.startedAt,
    resolvedAt: incident.resolvedAt,
    events: events
      .filter((event) => event.incidentId === incident.id)
      .map((event) => ({
        type: event.type,
        status: event.status,
        message: event.message,
        createdAt: event.createdAt,
      })),
  }));
}
