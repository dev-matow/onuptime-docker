import { and, asc, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";

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

import { hashStatusPagePassword, verifyStatusPagePassword } from "./access";
import type {
  CreateStatusPageInput,
  StatusPageMonitorsInput,
  UpdateStatusPageInput,
} from "./schemas";

export type StatusPage = typeof statusPages.$inferSelect;

interface Actor {
  organizationId: string;
  userId: string;
}

/**
 * Every status page an organization owns, oldest first.
 *
 * An organization may own many: one per client, per product, per
 * audience. Nothing here picks "the" page — anything that needs one has
 * to name it, which is why `getOrCreateStatusPage` is gone rather than
 * kept as a convenience. A convenience that silently picks a row is how
 * a fan-out becomes a single notification.
 */
export async function listStatusPages(
  db: DbClient,
  organizationId: string,
): Promise<StatusPage[]> {
  return db.query.statusPages.findMany({
    where: eq(statusPages.organizationId, organizationId),
    orderBy: [asc(statusPages.createdAt), asc(statusPages.id)],
  });
}

/** Resolves a page id inside the caller's organization, or throws. */
async function requireOwnedPage(
  db: DbClient,
  organizationId: string,
  statusPageId: string,
): Promise<StatusPage> {
  const page = await db.query.statusPages.findFirst({
    where: and(
      eq(statusPages.id, statusPageId),
      eq(statusPages.organizationId, organizationId),
    ),
  });
  if (!page) throw new NotFoundError("Status page not found.");
  return page;
}

export async function createStatusPage(
  db: DbClient,
  actor: Actor,
  input: CreateStatusPageInput,
): Promise<StatusPage> {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(statusPages)
      .values({
        organizationId: actor.organizationId,
        name: input.name,
        slug: input.slug,
      })
      .onConflictDoNothing()
      .returning();
    // The slug is globally unique because it is the public URL, so a
    // clash may be with another tenant's page. Say "taken", never whose.
    if (!created) throw new ConflictError("That slug is already in use.");

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "status_page.created",
      targetType: "status_page",
      targetId: created.id,
      metadata: { slug: created.slug },
    });
    return created;
  });
}

export async function deleteStatusPage(
  db: DbClient,
  actor: Actor,
  statusPageId: string,
): Promise<StatusPage> {
  return db.transaction(async (tx) => {
    const page = await requireOwnedPage(tx, actor.organizationId, statusPageId);
    await tx.delete(statusPages).where(eq(statusPages.id, page.id));
    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "status_page.deleted",
      targetType: "status_page",
      targetId: page.id,
      metadata: { slug: page.slug },
    });
    return page;
  });
}

export async function updateStatusPage(
  db: DbClient,
  actor: Actor,
  input: UpdateStatusPageInput,
): Promise<StatusPage> {
  return db.transaction(async (tx) => {
    const page = await requireOwnedPage(
      tx,
      actor.organizationId,
      input.statusPageId,
    );

    const slugTaken = await tx.query.statusPages.findFirst({
      where: and(eq(statusPages.slug, input.slug), ne(statusPages.id, page.id)),
      columns: { id: true },
    });
    if (slugTaken) throw new ConflictError("That slug is already in use.");

    // Password protection needs a password on first enable. Switching
    // away from password clears the hash; an empty password keeps the
    // existing one.
    let passwordHash: string | null | undefined;
    if (input.visibility === "password") {
      if (input.password) {
        passwordHash = hashStatusPagePassword(input.password);
      } else if (!page.passwordHash) {
        throw new ConflictError(
          "Set a password to enable password protection.",
        );
      } else {
        passwordHash = undefined; // keep existing
      }
    } else {
      passwordHash = null; // clear when not password-protected
    }

    const [updated] = await tx
      .update(statusPages)
      .set({
        name: input.name,
        slug: input.slug,
        published: input.published,
        visibility: input.visibility,
        showBranding: input.showBranding,
        ...(passwordHash === undefined ? {} : { passwordHash }),
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
        visibility: input.visibility,
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
): Promise<StatusPage> {
  return db.transaction(async (tx) => {
    const page = await requireOwnedPage(
      tx,
      actor.organizationId,
      input.statusPageId,
    );

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
    return page;
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
  statusPageId: string,
): Promise<StatusPageComponentConfig[]> {
  const page = await requireOwnedPage(db, organizationId, statusPageId);
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
  /**
   * Null when the day holds observations but none of them measured
   * anything — the strip renders that as "no data", which is the truth,
   * rather than as 0%.
   */
  uptimePct: number | null;
}

export interface PublicComponent {
  name: string;
  status: "up" | "down" | "degraded" | "unknown";
  /**
   * Carried separately because `status` collapses two different
   * `unknown`s: a monitor the operator switched off, and one Vigil
   * cannot currently measure. The headline has to distinguish them —
   * paused is a decision, unmeasured is an absence of evidence.
   */
  paused: boolean;
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
  /** False when the operator turned the footer off — free, both editions. */
  showBranding: boolean;
  components: PublicComponent[];
  activeIncidents: PublicIncident[];
  recentIncidents: PublicIncident[];
  overall: "operational" | "degraded" | "outage";
}

export interface StatusPageAccess {
  id: string;
  organizationId: string;
  visibility: "public" | "private" | "password";
}

/**
 * The gate: published page's id, owner and visibility, or null when the
 * slug doesn't resolve to a published page. The route uses this to
 * decide access before rendering anything.
 */
export async function getStatusPageAccess(
  db: DbClient,
  slug: string,
): Promise<StatusPageAccess | null> {
  const page = await db.query.statusPages.findFirst({
    where: and(eq(statusPages.slug, slug), eq(statusPages.published, true)),
    columns: { id: true, organizationId: true, visibility: true },
  });
  return page ?? null;
}

/**
 * Verifies a submitted password against the page's stored hash. Returns
 * the page id on success (for minting the unlock token), else null.
 */
export async function unlockStatusPage(
  db: DbClient,
  slug: string,
  password: string,
): Promise<string | null> {
  const page = await db.query.statusPages.findFirst({
    where: and(eq(statusPages.slug, slug), eq(statusPages.published, true)),
    columns: { id: true, visibility: true, passwordHash: true },
  });
  if (!page || page.visibility !== "password") return null;
  return verifyStatusPagePassword(password, page.passwordHash) ? page.id : null;
}

/**
 * The whole public page in one call. Only published pages resolve;
 * everything returned here is safe for allowed eyes (no URLs, no
 * internal notes — timeline messages on a status page are written to be
 * public). Access gating happens in the route via getStatusPageAccess.
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
    // Days that measured nothing are skipped rather than averaged in as
    // zero — the same rule the strip follows, applied to the headline
    // number so the two cannot disagree.
    const measuredDays = daily.filter(
      (d): d is DailyUptime & { uptimePct: number } => d.uptimePct !== null,
    );
    const total = measuredDays.reduce((sum, d) => sum + d.uptimePct, 0);
    return {
      name: row.displayName ?? row.internalName,
      status: row.paused ? "unknown" : row.status,
      paused: row.paused,
      uptime90dPct:
        measuredDays.length > 0
          ? Math.round((total / measuredDays.length) * 100) / 100
          : null,
      dailyUptime: daily,
    };
  });

  const activeIncidents = await publicIncidents(
    db,
    page.organizationId,
    monitorIds,
    { active: true },
  );
  const recentIncidents = await publicIncidents(
    db,
    page.organizationId,
    monitorIds,
    { active: false },
  );

  // A component Vigil cannot currently measure must not sit under a
  // green headline. `unknown` used to fall through to "operational",
  // so a ping monitor on a host without ICMP — or any probe that
  // stopped being able to run — published "All systems operational"
  // above its own "No data" chip. A paused monitor is excluded: that
  // one is an operator's decision, not a gap in what we know.
  //
  // But `unknown` is not one thing, and not all of it is evidence. Four
  // states reach it: never checked, latest verdict `indeterminate`,
  // latest verdict `down` inside the failure window (`deriveStatus`
  // returns the previous status, which is `unknown` for a monitor that
  // never succeeded), and just resumed. Holding a customer's headline
  // amber over an *absence* is the same mistake in the other direction,
  // so the stored status is not enough on its own — but neither is
  // `indeterminate` alone, which publishes green over a probe that just
  // failed. The question is what the monitor's latest observation said.
  const unknownIds = componentRows
    .filter((row) => !row.paused && row.status === "unknown")
    .map((row) => row.monitorId);
  const unmeasured =
    unknownIds.length > 0 && (await anyLatestUnhealthy(db, unknownIds));

  const overall: PublicStatusPage["overall"] = components.some(
    (c) => c.status === "down",
  )
    ? "outage"
    : components.some((c) => c.status === "degraded") ||
        unmeasured ||
        activeIncidents.length > 0
      ? "degraded"
      : "operational";

  return {
    name: page.name,
    organizationName: org?.name ?? page.name,
    showBranding: page.showBranding,
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
  // Observations that measured nothing are excluded from both halves of
  // the ratio. Counting them as downtime would paint a 90-day red strip
  // on a customer-facing page because the worker cannot open a raw
  // socket — an operator problem rendered as an outage, on the one
  // surface where that is least forgivable.
  //
  // `is distinct from`, never `<>`: `verdict` is NULL on every row
  // written before 1.10.0, and `<>` would silently drop all of them.
  const measured = sql`${monitorChecks.verdict} is distinct from 'indeterminate'`;
  const rows = await db
    .select({
      monitorId: monitorChecks.monitorId,
      day: sql<string>`to_char(${dayExpr}, 'YYYY-MM-DD')`.as("day"),
      uptimePct: sql<number>`round(
        count(*) filter (where ${monitorChecks.ok} and ${measured}) * 100.0
        / nullif(count(*) filter (where ${measured}), 0),
        2
      )`,
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
    list.push({
      day: row.day,
      // Preserved as null, not coerced: `Number(null)` is 0, which is
      // the red bar this whole change exists to stop drawing.
      uptimePct: row.uptimePct === null ? null : Number(row.uptimePct),
    });
    map.set(row.monitorId, list);
  }
  return map;
}

/**
 * Whether any of these monitors' latest observation was unhealthy —
 * `indeterminate` (could not measure) or `down` (measured, failing).
 *
 * Both are `unknown` on the row and both are evidence. `down` is here
 * because `deriveStatus` returns `previousStatus` for a failing check
 * inside the failure window, and that previous status is `unknown` for
 * a monitor that has never succeeded, has just been resumed, or was
 * last indeterminate. Requiring `indeterminate` alone published green
 * over a monitor whose probe had just failed — and moved the headline
 * the wrong way on new evidence, since a ping monitor going from "no
 * ICMP" to "reached it, and it is down" turned the banner from amber
 * to green.
 *
 * `verdict` is NULL on every row written before 1.10.0 — migration 0010
 * added the column without a backfill — so those rows have to be read
 * through `ok`, which has always been NOT NULL. That did not matter
 * while this only looked for `indeterminate`, since a pre-1.10.0 row is
 * never indeterminate. It matters the moment `down` counts: without it
 * a monitor whose whole history predates the upgrade and which has
 * never succeeded reads as healthy, and the headline goes green where
 * 1.10.0 showed amber.
 */
async function anyLatestUnhealthy(
  db: DbClient,
  monitorIds: string[],
): Promise<boolean> {
  const latest = await db
    .selectDistinctOn([monitorChecks.monitorId], {
      verdict: monitorChecks.verdict,
      ok: monitorChecks.ok,
    })
    .from(monitorChecks)
    .where(inArray(monitorChecks.monitorId, monitorIds))
    .orderBy(
      monitorChecks.monitorId,
      desc(monitorChecks.checkedAt),
      desc(monitorChecks.id),
    );
  return latest.some((row) =>
    row.verdict === null
      ? !row.ok
      : row.verdict === "indeterminate" || row.verdict === "down",
  );
}

/**
 * Incidents this page is allowed to show.
 *
 * The organization predicate on its own is not the boundary. An
 * auto-opened incident is titled `${monitor.name} is down`, and monitor
 * names are internal hostnames in practice — so every monitor the
 * operator deliberately left *off* the page was publishing its name to
 * an unauthenticated reader the moment it failed.
 *
 * Not a join: a manual, org-wide announcement ("scheduled maintenance")
 * names no monitor, and joining through `status_page_monitors` would
 * silently suppress exactly the incidents an operator writes by hand
 * for this audience.
 *
 * Keyed on `source`, not on `monitorId IS NULL`. Those look equivalent
 * and are not: `incidents.monitor_id` is `ON DELETE SET NULL`, so
 * deleting a monitor — the ordinary end of a monitor's life — turns
 * every incident it ever opened into a NULL-monitor row. Reading that
 * as "manual announcement" republishes `${monitor.name} is down` to
 * unauthenticated readers, which is the disclosure this filter exists
 * to close, reached by a delete instead of by a failure. `source` is
 * `NOT NULL`, written once at insert and never updated, so it still
 * says what opened the incident after the id is gone.
 *
 * The consequence, stated because it is a real behaviour change:
 * deleting a monitor removes its incidents from the public page, even
 * one that *was* a listed component. `status_page_monitors` cascades on
 * the same delete, so after it there is nothing left that could tell
 * "was published" from "was excluded" — and between those two, this
 * fails closed.
 */
async function publicIncidents(
  db: DbClient,
  organizationId: string,
  monitorIds: string[],
  options: { active: boolean },
): Promise<PublicIncident[]> {
  const manualAnnouncement = eq(incidents.source, "manual");
  const onThisPage =
    monitorIds.length > 0
      ? or(manualAnnouncement, inArray(incidents.monitorId, monitorIds))
      : manualAnnouncement;

  const rows = await db.query.incidents.findMany({
    where: and(
      eq(incidents.organizationId, organizationId),
      onThisPage,
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
