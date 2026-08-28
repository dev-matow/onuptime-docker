import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";

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
import { uptimeByMonitor } from "@/modules/monitors/service";
import { round2, uptimeSegments } from "@/modules/monitors/uptime";

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
        columns: { id: true, name: true, shadowBridgeId: true },
      });
      if (owned.length !== monitorIds.length) {
        throw new NotFoundError("Monitor not found.");
      }
      // Refused loudly rather than filtered quietly: an operator who
      // asked for a component deserves to hear "not while it shadows",
      // not to count the page and find one missing.
      const shadowed = owned.find((m) => m.shadowBridgeId !== null);
      if (shadowed) {
        throw new ConflictError(
          `"${shadowed.name}" runs in a migration bridge's shadow mode and cannot appear on a status page. Cut the bridge over, or leave the monitor off the page until you do.`,
        );
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
  /** At most the two newest public-safe issues observed on this Bangkok day. */
  issues: PublicCheckSnapshot[];
}

export interface PublicCheckSnapshot {
  checkedAt: string;
  verdict: "up" | "down" | "degraded" | "indeterminate";
  statusCode: number | null;
  responseTimeMs: number | null;
  /** A deliberately coarse description that cannot expose the target. */
  summary: string;
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
  lastCheck: PublicCheckSnapshot | null;
  recentIssues: PublicCheckSnapshot[];
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

export interface PublicHalfHourSlot {
  start: string;
  end: string;
  status: "up" | "down" | "degraded" | "indeterminate" | "unknown";
  uptimePct: number | null;
  checkCount: number;
  lastCheck: PublicCheckSnapshot | null;
  issues: PublicCheckSnapshot[];
}

export interface PublicComponentDayTimeline {
  componentIndex: number;
  componentName: string;
  day: string;
  windowKind: "rolling" | "calendar";
  slots: PublicHalfHourSlot[];
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
    .where(
      and(
        eq(statusPageMonitors.statusPageId, page.id),
        // A monitor in a migration bridge's shadow mode is invisible to
        // the public: its component chip, its uptime strip and its
        // incidents all stay off the page until cutover. Filtered at
        // read time as well as refused at write time, so that a write
        // path this module grows later cannot quietly publish a fleet
        // that was imported on the promise of having no public effects.
        isNull(monitors.shadowBridgeId),
      ),
    )
    .orderBy(asc(statusPageMonitors.sortOrder));

  const monitorIds = componentRows.map((row) => row.monitorId);
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 90 * 86_400_000);
  const [dailyByMonitor, totals, observations] = await Promise.all([
    dailyUptime(db, monitorIds, windowStart, windowEnd),
    uptimeByMonitor(db, monitorIds, windowStart, windowEnd),
    publicObservationDetails(db, monitorIds, windowStart),
  ]);

  const components: PublicComponent[] = componentRows.map((row) => ({
    name: row.displayName ?? row.internalName,
    status: row.paused ? "unknown" : row.status,
    paused: row.paused,
    // The 90-day number is one ratio over the whole window, not the mean
    // of ninety daily percentages. A mean of means weights a day holding
    // three samples exactly as heavily as a day holding seven hundred,
    // which is a second distortion stacked on the one duration weighting
    // removes. Summing the segments and dividing once is the same
    // methodology the strip uses, just at a different resolution — so
    // the headline and the bars can no longer disagree.
    uptime90dPct: totals.get(row.monitorId)?.uptimePct ?? null,
    dailyUptime: (dailyByMonitor.get(row.monitorId) ?? []).map((day) => ({
      ...day,
      issues:
        observations.issuesByMonitorDay.get(`${row.monitorId}:${day.day}`) ??
        [],
    })),
    lastCheck: observations.latestByMonitor.get(row.monitorId) ?? null,
    recentIssues: (observations.issuesByMonitor.get(row.monitorId) ?? []).slice(
      0,
      2,
    ),
  }));

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

/**
 * The 90-day strip: duration-weighted uptime per Bangkok calendar day.
 *
 * Each coverage segment is intersected with each day it touches, so an
 * outage that straddles midnight is charged to both days in the exact
 * proportion it occupied them. That is the part a `group by
 * date_trunc('day', checked_at)` cannot express: it charges a sample
 * wholly to the day it was *taken*, which puts a 23:59 sample's ten
 * minutes of evidence entirely on the wrong side of the boundary.
 */
async function dailyUptime(
  db: DbClient,
  monitorIds: string[],
  windowStart: Date,
  windowEnd: Date,
): Promise<Map<string, DailyUptime[]>> {
  if (monitorIds.length === 0) return new Map();

  const segments = uptimeSegments(monitorIds, windowStart, windowEnd);
  // Bucket by the status page's Bangkok calendar day. Both segment bounds
  // are converted to Bangkok wall time up front, so
  // every subsequent comparison, `generate_series` step and `+ interval
  // '1 day'` happens in plain `timestamp` space where a day is always
  // exactly 24 hours. Doing it on `timestamptz` would make day
  // arithmetic follow the session's TimeZone, and a server in a
  // DST-observing zone would produce 23- and 25-hour "days".
  const { rows } = await db.execute<{
    monitor_id: string;
    day: string;
    up_ms: string | null;
    covered_ms: string | null;
  }>(sql`
    with seg as (
      select
        raw.monitor_id,
        raw.ok,
        raw.seg_start at time zone 'Asia/Bangkok' as local_start,
        raw.seg_end at time zone 'Asia/Bangkok' as local_end
      from (${segments}) raw
    ),
    overlap as (
      select
        seg.monitor_id,
        seg.ok,
        d.day,
        extract(epoch from (
          least(seg.local_end, d.day + interval '1 day')
          - greatest(seg.local_start, d.day)
        )) * 1000 as ms
      from seg
      join lateral generate_series(
        date_trunc('day', seg.local_start),
        date_trunc('day', seg.local_end - interval '1 microsecond'),
        interval '1 day'
      ) as d(day) on true
    )
    select
      monitor_id,
      to_char(day, 'YYYY-MM-DD') as day,
      sum(ms) filter (where ok) as up_ms,
      sum(ms) as covered_ms
    from overlap
    group by monitor_id, day
    order by day
  `);

  const map = new Map<string, DailyUptime[]>();
  for (const row of rows) {
    const coveredMs = Number(row.covered_ms ?? 0);
    const list = map.get(row.monitor_id) ?? [];
    list.push({
      day: row.day,
      // Null, not 0, when the day was never covered: `Number(null)` is 0,
      // which is the red bar this whole rule exists to stop drawing.
      uptimePct:
        coveredMs === 0
          ? null
          : round2((Number(row.up_ms ?? 0) / coveredMs) * 100),
      issues: [],
    });
    map.set(row.monitor_id, list);
  }
  return map;
}

type ObservationRow = {
  checkedAt: Date;
  ok: boolean;
  verdict: string | null;
  statusCode: number | null;
  responseTimeMs: number | null;
  failureClass: string | null;
};

function publicVerdict(
  verdict: string | null,
  ok: boolean,
): PublicCheckSnapshot["verdict"] {
  if (
    verdict === "up" ||
    verdict === "down" ||
    verdict === "degraded" ||
    verdict === "indeterminate"
  ) {
    return verdict;
  }
  return ok ? "up" : "down";
}

/**
 * Public status pages never receive the stored error string. Probe errors can
 * contain a private hostname or path even after credentials are redacted, so
 * this summary exposes the useful category and measurements only.
 */
function publicObservation(row: ObservationRow): PublicCheckSnapshot {
  const verdict = publicVerdict(row.verdict, row.ok);
  let summary = "Check succeeded";
  if (verdict === "degraded") {
    summary =
      row.responseTimeMs === null
        ? "Performance degraded"
        : `Slow response (${row.responseTimeMs}ms)`;
  } else if (row.statusCode !== null && row.statusCode >= 400) {
    summary = `HTTP ${row.statusCode}`;
  } else if (row.failureClass === "transport") {
    summary = "Service could not be reached";
  } else if (row.failureClass === "assertion") {
    summary = "Response did not match the expected result";
  } else if (row.failureClass === "misconfigured") {
    summary = "The monitoring check could not run";
  } else if (verdict === "indeterminate") {
    summary = "The service could not be measured";
  } else if (verdict === "down") {
    summary = "The service did not respond as expected";
  }

  return {
    checkedAt: new Date(row.checkedAt).toISOString(),
    verdict,
    statusCode: row.statusCode,
    responseTimeMs: row.responseTimeMs,
    summary,
  };
}

/**
 * Loads one component's one-day drill-down on demand. The public page uses
 * its stable display order as the selector, so the monitor UUID never has to
 * appear in markup or URLs. Only the selected day's checks are read.
 */
export async function getPublicComponentDayTimeline(
  db: DbClient,
  slug: string,
  componentIndex: number,
  day: string,
): Promise<PublicComponentDayTimeline | null> {
  if (!Number.isInteger(componentIndex) || componentIndex < 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;

  const selectedDayStart = new Date(`${day}T00:00:00.000+07:00`);
  if (Number.isNaN(selectedDayStart.getTime())) return null;
  const bangkokToday = new Date(Date.now() + 7 * 60 * 60_000)
    .toISOString()
    .slice(0, 10);
  const today = new Date(`${bangkokToday}T00:00:00.000+07:00`);
  const oldest = new Date(today.getTime() - 90 * 86_400_000);
  if (selectedDayStart < oldest || selectedDayStart > today) return null;

  // Today's drill-down is a rolling 24-hour window. Rounding the end up to
  // the current half-hour keeps the newest observation in the rightmost slot
  // instead of leaving future hours as a long gray tail. Historical dates
  // remain true Bangkok calendar days (00:00–24:00).
  const windowKind = day === bangkokToday ? "rolling" : "calendar";
  const halfHourMs = 30 * 60_000;
  const end =
    windowKind === "rolling"
      ? new Date(Math.ceil(Date.now() / halfHourMs) * halfHourMs)
      : new Date(selectedDayStart.getTime() + 86_400_000);
  const start =
    windowKind === "rolling"
      ? new Date(end.getTime() - 86_400_000)
      : selectedDayStart;

  const [component] = await db
    .select({
      monitorId: monitors.id,
      internalName: monitors.name,
      displayName: statusPageMonitors.displayName,
    })
    .from(statusPageMonitors)
    .innerJoin(statusPages, eq(statusPages.id, statusPageMonitors.statusPageId))
    .innerJoin(monitors, eq(monitors.id, statusPageMonitors.monitorId))
    .where(
      and(
        eq(statusPages.slug, slug),
        eq(statusPages.published, true),
        isNull(monitors.shadowBridgeId),
      ),
    )
    .orderBy(asc(statusPageMonitors.sortOrder))
    .limit(1)
    .offset(componentIndex);
  if (!component) return null;

  const checks = await db
    .select({
      checkedAt: monitorChecks.checkedAt,
      ok: monitorChecks.ok,
      verdict: monitorChecks.verdict,
      statusCode: monitorChecks.statusCode,
      responseTimeMs: monitorChecks.responseTimeMs,
      failureClass: monitorChecks.failureClass,
    })
    .from(monitorChecks)
    .where(
      and(
        eq(monitorChecks.monitorId, component.monitorId),
        gte(monitorChecks.checkedAt, start),
        lt(monitorChecks.checkedAt, end),
      ),
    )
    .orderBy(asc(monitorChecks.checkedAt));

  const working = Array.from({ length: 48 }, (_, index) => ({
    start: new Date(start.getTime() + index * 30 * 60_000).toISOString(),
    end: new Date(start.getTime() + (index + 1) * 30 * 60_000).toISOString(),
    status: "unknown" as PublicHalfHourSlot["status"],
    upCount: 0,
    checkCount: 0,
    lastCheck: null as PublicCheckSnapshot | null,
    issues: [] as PublicCheckSnapshot[],
  }));

  const priority: Record<PublicHalfHourSlot["status"], number> = {
    unknown: 0,
    up: 1,
    degraded: 2,
    indeterminate: 3,
    down: 4,
  };

  for (const row of checks) {
    const checkedAt = new Date(row.checkedAt);
    const slotIndex = Math.floor(
      (checkedAt.getTime() - start.getTime()) / (30 * 60_000),
    );
    const slot = working[slotIndex];
    if (!slot) continue;
    const snapshot = publicObservation(row);
    slot.checkCount += 1;
    slot.lastCheck = snapshot;
    if (row.ok) slot.upCount += 1;
    if (priority[snapshot.verdict] > priority[slot.status]) {
      slot.status = snapshot.verdict;
    }
    if (snapshot.verdict !== "up") {
      slot.issues.unshift(snapshot);
      if (slot.issues.length > 2) slot.issues.pop();
    }
  }

  return {
    componentIndex,
    componentName: component.displayName ?? component.internalName,
    day,
    windowKind,
    slots: working.map(({ upCount, ...slot }) => ({
      ...slot,
      uptimePct:
        slot.checkCount === 0
          ? null
          : round2((upCount / slot.checkCount) * 100),
    })),
  };
}

async function publicObservationDetails(
  db: DbClient,
  monitorIds: string[],
  windowStart: Date,
): Promise<{
  latestByMonitor: Map<string, PublicCheckSnapshot>;
  issuesByMonitor: Map<string, PublicCheckSnapshot[]>;
  issuesByMonitorDay: Map<string, PublicCheckSnapshot[]>;
}> {
  const latestByMonitor = new Map<string, PublicCheckSnapshot>();
  const issuesByMonitor = new Map<string, PublicCheckSnapshot[]>();
  const issuesByMonitorDay = new Map<string, PublicCheckSnapshot[]>();
  if (monitorIds.length === 0) {
    return { latestByMonitor, issuesByMonitor, issuesByMonitorDay };
  }

  const latest = await db
    .selectDistinctOn([monitorChecks.monitorId], {
      monitorId: monitorChecks.monitorId,
      checkedAt: monitorChecks.checkedAt,
      ok: monitorChecks.ok,
      verdict: monitorChecks.verdict,
      statusCode: monitorChecks.statusCode,
      responseTimeMs: monitorChecks.responseTimeMs,
      failureClass: monitorChecks.failureClass,
    })
    .from(monitorChecks)
    .where(inArray(monitorChecks.monitorId, monitorIds))
    .orderBy(
      monitorChecks.monitorId,
      desc(monitorChecks.checkedAt),
      desc(monitorChecks.id),
    );
  for (const row of latest) {
    latestByMonitor.set(row.monitorId, publicObservation(row));
  }

  const idList = sql.join(
    monitorIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const { rows } = await db.execute<{
    monitor_id: string;
    checked_at: Date;
    ok: boolean;
    verdict: string | null;
    status_code: number | null;
    response_time_ms: number | null;
    failure_class: string | null;
    day: string;
  }>(sql`
    with ranked as (
      select
        monitor_id,
        checked_at,
        ok,
        verdict,
        status_code,
        response_time_ms,
        failure_class,
        to_char(checked_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') as day,
        row_number() over (
          partition by monitor_id, (checked_at at time zone 'Asia/Bangkok')::date
          order by checked_at desc, id desc
        ) as day_rank
      from monitor_checks
      where monitor_id in (${idList})
        and checked_at >= ${windowStart}
        and (
          ok = false
          or verdict in ('down', 'degraded', 'indeterminate')
        )
    )
    select
      monitor_id,
      checked_at,
      ok,
      verdict,
      status_code,
      response_time_ms,
      failure_class,
      day
    from ranked
    where day_rank <= 2
    order by monitor_id, checked_at desc
  `);

  for (const row of rows) {
    const issue = publicObservation({
      checkedAt: row.checked_at,
      ok: row.ok,
      verdict: row.verdict,
      statusCode: row.status_code,
      responseTimeMs: row.response_time_ms,
      failureClass: row.failure_class,
    });
    const monitorIssues = issuesByMonitor.get(row.monitor_id) ?? [];
    monitorIssues.push(issue);
    issuesByMonitor.set(row.monitor_id, monitorIssues);

    const dayKey = `${row.monitor_id}:${row.day}`;
    const dayIssues = issuesByMonitorDay.get(dayKey) ?? [];
    dayIssues.push(issue);
    issuesByMonitorDay.set(dayKey, dayIssues);
  }

  return { latestByMonitor, issuesByMonitor, issuesByMonitorDay };
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
      // A shadow incident was recorded for migration comparison and was
      // never announced to anyone; publishing it here would announce it.
      // The component query already excludes shadow monitors, so this
      // predicate is the belt for the one path that does not go through
      // it: a monitor whose shadow ended still has shadow incidents, and
      // those stay off the page even once the monitor itself is on it.
      eq(incidents.shadow, false),
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
    // By id, not `created_at`: that column defaults to `now()`, which
    // is the transaction START time, so two concurrent writers can land
    // on the public timeline in the reverse of the order they
    // committed. `uuidv7()` uses the wall clock at insert.
    orderBy: [desc(incidentEvents.id)],
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
