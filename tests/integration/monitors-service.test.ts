import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditLogs, monitorChecks, monitors } from "@/db/schema";
import { NotFoundError } from "@/lib/errors";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import {
  createMonitor,
  deleteMonitor,
  findDueMonitors,
  getMonitorDetail,
  listMonitors,
  recordCheckOutcome,
  setMonitorPaused,
  updateMonitor,
} from "@/modules/monitors/service";

import {
  checkResult,
  createTestOrg,
  db,
  failResult,
  indeterminateResult,
  okResult,
} from "../helpers";

function monitorInput(
  overrides: Partial<CreateMonitorInput> = {},
): CreateMonitorInput {
  return {
    name: `Monitor ${randomUUID().slice(0, 8)}`,
    url: "https://vigil-tests.example.com/health",
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 10_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    checkType: "http" as const,
    tlsCheck: false,
    tlsWarnDays: 14,
    failureWindowSeconds: 120,
    config: null,
    ...overrides,
  };
}

describe("createMonitor", () => {
  it("persists the provided fields", async () => {
    const actor = await createTestOrg();
    const input = monitorInput({
      name: "Checkout API",
      url: "https://shop.example.com/health",
      method: "HEAD",
      intervalSeconds: 300,
      timeoutMs: 5_000,
      degradedThresholdMs: 1_500,
      expectedStatusCode: 204,
      failureWindowSeconds: 300,
    });

    const monitor = await createMonitor(db, actor, input);

    expect(monitor).toMatchObject({
      organizationId: actor.organizationId,
      createdBy: actor.userId,
      name: "Checkout API",
      url: "https://shop.example.com/health",
      method: "HEAD",
      intervalSeconds: 300,
      timeoutMs: 5_000,
      degradedThresholdMs: 1_500,
      expectedStatusCode: 204,
      failureWindowSeconds: 300,
      paused: false,
      currentStatus: "unknown",
      consecutiveFailures: 0,
      lastCheckedAt: null,
    });

    const persisted = await db.query.monitors.findFirst({
      where: eq(monitors.id, monitor.id),
    });
    expect(persisted?.name).toBe("Checkout API");
  });

  it("writes a monitor.created audit row scoped to the organization", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    const rows = await db.query.auditLogs.findMany({
      where: and(
        eq(auditLogs.organizationId, actor.organizationId),
        eq(auditLogs.action, "monitor.created"),
      ),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: actor.userId,
      targetType: "monitor",
      targetId: monitor.id,
      metadata: { name: monitor.name, url: monitor.url },
    });
  });
});

describe("org isolation", () => {
  it("getMonitorDetail rejects a monitor id belonging to another org", async () => {
    const owner = await createTestOrg();
    const intruder = await createTestOrg();
    const monitor = await createMonitor(db, owner, monitorInput());

    await expect(
      getMonitorDetail(db, intruder.organizationId, monitor.id),
    ).rejects.toThrow(NotFoundError);
  });

  it("updateMonitor rejects cross-org updates without touching the row", async () => {
    const owner = await createTestOrg();
    const intruder = await createTestOrg();
    const monitor = await createMonitor(
      db,
      owner,
      monitorInput({ name: "Original" }),
    );

    await expect(
      updateMonitor(db, intruder, monitor.id, { name: "Hijacked" }),
    ).rejects.toThrow(NotFoundError);

    const persisted = await db.query.monitors.findFirst({
      where: eq(monitors.id, monitor.id),
    });
    expect(persisted?.name).toBe("Original");
  });
});

describe("recordCheckOutcome", () => {
  it("stays up until the monitor has been failing for the whole window", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ failureWindowSeconds: 60 }),
    );
    const t0 = new Date("2026-07-26T12:00:00Z");
    const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

    const first = await recordCheckOutcome(db, monitor, failResult(), {
      now: t0,
    });
    expect(first.monitor.firstFailureAt?.toISOString()).toBe(t0.toISOString());
    // Never succeeded, so there is nothing to hold: it stays unknown
    // rather than being published as green while it is failing.
    expect(first.monitor.currentStatus).toBe("unknown");
    expect(first.reconciliation.openIncident).toBe(false);
    expect(first.reconciliation.resolveIncidents).toBe(false);

    const midway = await recordCheckOutcome(db, first.monitor, failResult(), {
      now: at(30),
    });
    expect(midway.monitor.currentStatus).toBe("unknown");
    expect(midway.reconciliation.openIncident).toBe(false);
    // The run keeps its original start — that is the whole point of
    // storing a fact instead of counting events.
    expect(midway.monitor.firstFailureAt?.toISOString()).toBe(t0.toISOString());

    const elapsed = await recordCheckOutcome(db, midway.monitor, failResult(), {
      now: at(60),
    });
    expect(elapsed.monitor.currentStatus).toBe("down");
    expect(elapsed.reconciliation.openIncident).toBe(true);
  });

  it("opens on the first failure when the window is zero", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ failureWindowSeconds: 0 }),
    );

    const down = await recordCheckOutcome(db, monitor, failResult());
    expect(down.monitor.currentStatus).toBe("down");
    expect(down.reconciliation.openIncident).toBe(true);
  });

  it("derives down from elapsed time, not from the number of checks", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ failureWindowSeconds: 90 }),
    );
    const t0 = new Date("2026-07-26T12:00:00Z");

    // One failure, then a long gap — a missed tick, a restarted worker,
    // a backfilled observation. An edge-triggered controller counting
    // failures would still be waiting; this one is already down.
    const first = await recordCheckOutcome(db, monitor, failResult(), {
      now: t0,
    });
    expect(first.monitor.currentStatus).not.toBe("down");
    expect(first.reconciliation.openIncident).toBe(false);

    const later = await recordCheckOutcome(db, first.monitor, failResult(), {
      now: new Date(t0.getTime() + 600_000),
    });
    expect(later.monitor.currentStatus).toBe("down");
    expect(later.reconciliation.openIncident).toBe(true);
  });

  it("recovers: a passing check clears the run and asks to resolve", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ failureWindowSeconds: 0 }),
    );

    const down = await recordCheckOutcome(db, monitor, failResult());
    expect(down.monitor.currentStatus).toBe("down");

    const recovered = await recordCheckOutcome(db, down.monitor, okResult());
    expect(recovered.reconciliation.resolveIncidents).toBe(true);
    expect(recovered.reconciliation.openIncident).toBe(false);
    expect(recovered.monitor.firstFailureAt).toBeNull();
    expect(recovered.monitor.consecutiveFailures).toBe(0);
    expect(recovered.monitor.currentStatus).toBe("up");
  });

  it("an indeterminate check neither opens nor resolves, and holds the run", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ failureWindowSeconds: 0 }),
    );

    const down = await recordCheckOutcome(db, monitor, failResult());
    expect(down.monitor.currentStatus).toBe("down");

    const unknown = await recordCheckOutcome(
      db,
      down.monitor,
      indeterminateResult("ICMP is not permitted for this process."),
    );
    expect(unknown.monitor.currentStatus).toBe("unknown");
    expect(unknown.reconciliation.openIncident).toBe(false);
    // Never resolve on "I could not tell" — that would report a
    // recovery nobody observed.
    expect(unknown.reconciliation.resolveIncidents).toBe(false);
    expect(unknown.monitor.firstFailureAt).not.toBeNull();
  });

  it("stores a degraded status for slow-but-ok outcomes", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    const result = await recordCheckOutcome(
      db,
      monitor,
      checkResult({
        degraded: true,
        verdict: "degraded",
        responseTimeMs: 4_500,
        error: "Responded in 4500ms, over the 3000ms threshold",
        facts: { statusCode: 200, responseTimeMs: 4_500 },
        failedAssertions: ["latency"],
      }),
    );
    expect(result.monitor.currentStatus).toBe("degraded");
    expect(result.monitor.consecutiveFailures).toBe(0);
  });

  it("inserts a check row for every recorded outcome", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    const first = await recordCheckOutcome(db, monitor, okResult(120));
    await recordCheckOutcome(db, first.monitor, failResult());

    const checks = await db.query.monitorChecks.findMany({
      where: eq(monitorChecks.monitorId, monitor.id),
    });
    expect(checks).toHaveLength(2);
    expect(checks.map((c) => c.ok).sort()).toEqual([false, true]);
    expect(checks.find((c) => c.ok)).toMatchObject({
      statusCode: 200,
      responseTimeMs: 120,
      error: null,
    });
    expect(checks.find((c) => !c.ok)).toMatchObject({
      statusCode: 503,
      responseTimeMs: 250,
      error: "Unexpected status 503",
    });
  });

  it("updates lastCheckedAt on the monitor", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    expect(monitor.lastCheckedAt).toBeNull();

    const { monitor: checked } = await recordCheckOutcome(
      db,
      monitor,
      okResult(),
    );
    expect(checked.lastCheckedAt).toBeInstanceOf(Date);
  });
});

describe("findDueMonitors", () => {
  it("picks up a monitor due within the tick's grace window", async () => {
    // `next_evaluation_at` is stamped when a probe *completes*, a few
    // seconds past the minute boundary, so a strict `<= now()` misses
    // it on the tick it was aimed at and waits a whole extra minute —
    // every cycle. A 120s cadence settles at 180s.
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    await db
      .update(monitors)
      .set({ nextEvaluationAt: new Date(Date.now() + 20_000) })
      .where(eq(monitors.id, monitor.id));

    const due = await findDueMonitors(db, 100_000);
    expect(due.some((m) => m.id === monitor.id)).toBe(true);
  });

  it("does not pick up a monitor well outside the grace window", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    await db
      .update(monitors)
      .set({ nextEvaluationAt: new Date(Date.now() + 120_000) })
      .where(eq(monitors.id, monitor.id));

    const due = await findDueMonitors(db, 100_000);
    expect(due.some((m) => m.id === monitor.id)).toBe(false);
  });

  // The query is deliberately not org-scoped (the worker sweeps every
  // tenant), so assertions check membership of our own monitors only.
  const BIG_LIMIT = 100_000;

  it("includes a fresh monitor that has never been checked", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    const due = await findDueMonitors(db, BIG_LIMIT);
    expect(due.some((m) => m.id === monitor.id)).toBe(true);
  });

  it("excludes a monitor checked within its interval", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ intervalSeconds: 300 }),
    );
    await recordCheckOutcome(db, monitor, okResult());

    const due = await findDueMonitors(db, BIG_LIMIT);
    expect(due.some((m) => m.id === monitor.id)).toBe(false);
  });

  it("never returns paused monitors, even unchecked ones", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    await setMonitorPaused(db, actor, monitor.id, true);

    const due = await findDueMonitors(db, BIG_LIMIT);
    expect(due.some((m) => m.id === monitor.id)).toBe(false);
  });
});

describe("setMonitorPaused", () => {
  it("resume clears the failure run, not just the dead counters", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ failureWindowSeconds: 0 }),
    );
    const first = await recordCheckOutcome(db, monitor, failResult());
    const second = await recordCheckOutcome(db, first.monitor, failResult());
    expect(second.monitor.currentStatus).toBe("down");
    expect(second.monitor.firstFailureAt).not.toBeNull();

    const paused = await setMonitorPaused(db, actor, monitor.id, true);
    expect(paused.paused).toBe(true);

    const resumed = await setMonitorPaused(db, actor, monitor.id, false);
    expect(resumed.paused).toBe(false);
    expect(resumed.currentStatus).toBe("unknown");
    expect(resumed.consecutiveFailures).toBe(0);
    // The one that matters. `firstFailureAt` is what the status
    // controller derives from; leaving it set meant the first failing
    // check after a week-long pause computed "failing for a week" and
    // paged instantly, skipping the window entirely. The original test
    // asserted only the two columns nothing reads any more, which is
    // exactly why this shipped.
    expect(resumed.firstFailureAt).toBeNull();
    // And it is due now, not on a schedule computed before the pause.
    expect(resumed.nextEvaluationAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("a resumed monitor gets its full window back before it pages", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ failureWindowSeconds: 300 }),
    );
    const longAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

    const failing = await recordCheckOutcome(db, monitor, failResult(), {
      now: longAgo,
    });
    expect(failing.monitor.firstFailureAt).not.toBeNull();

    await setMonitorPaused(db, actor, monitor.id, true);
    const resumed = await setMonitorPaused(db, actor, monitor.id, false);

    const afterResume = await recordCheckOutcome(db, resumed, failResult());
    expect(afterResume.monitor.currentStatus).not.toBe("down");
    expect(afterResume.reconciliation.openIncident).toBe(false);
  });
});

describe("a pause that lands mid-probe wins", () => {
  /**
   * `runMonitorCheck` reads `paused` once, before the probe. An
   * operator who pauses a monitor a second before its failure window
   * elapses — precisely to stop the page — used to get paged anyway,
   * and the incident was then unresolvable: every later check returns
   * early while paused, so nothing was left to close it.
   */
  it("keeps the observation but derives nothing from it", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ failureWindowSeconds: 0 }),
    );

    // The pause lands while the probe is in flight.
    await setMonitorPaused(db, actor, monitor.id, true);

    const result = await recordCheckOutcome(db, monitor, failResult());

    // Nothing is derived: no incident, no status change, no schedule.
    expect(result.reconciliation.openIncident).toBe(false);
    expect(result.reconciliation.resolveIncidents).toBe(false);
    expect(result.monitor.paused).toBe(true);
    expect(result.monitor.currentStatus).not.toBe("down");
    expect(result.monitor.firstFailureAt).toBeNull();

    // The observation itself survives — it was genuinely made, and a
    // ledger does not un-write facts.
    const checks = await db.query.monitorChecks.findMany({
      where: eq(monitorChecks.monitorId, monitor.id),
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.ok).toBe(false);
  });

  it("does not quietly succeed when the monitor really is gone", async () => {
    // The other way to match no row, and it must not be mistaken for a
    // pause. In practice the observation insert hits the foreign key
    // first and the whole transaction rolls back, so the caller sees a
    // throw either way — `runMonitorCheck` swallows it and the next
    // tick simply finds no monitor. The `NotFoundError` branch behind
    // it stays as a guard for the day that insert stops cascading.
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    await db.delete(monitors).where(eq(monitors.id, monitor.id));

    await expect(
      recordCheckOutcome(db, monitor, failResult()),
    ).rejects.toThrow();

    const orphans = await db.query.monitorChecks.findMany({
      where: eq(monitorChecks.monitorId, monitor.id),
    });
    expect(orphans).toEqual([]);
  });

  it("resumes normally afterwards", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ failureWindowSeconds: 0 }),
    );
    await setMonitorPaused(db, actor, monitor.id, true);
    await recordCheckOutcome(db, monitor, failResult());

    const resumed = await setMonitorPaused(db, actor, monitor.id, false);
    const after = await recordCheckOutcome(db, resumed, failResult());
    expect(after.monitor.currentStatus).toBe("down");
    expect(after.reconciliation.openIncident).toBe(true);
  });

  it("a pause and a resume inside one flight still cannot page", async () => {
    // The `paused` predicate alone was not enough: both land inside a
    // 30s probe flight, the row reads `paused = false` again by the
    // time the write arrives, and it restored the `first_failure_at`
    // the resume had just cleared. The monitor then computed "failing
    // since a week ago" from its first check back and paged at once.
    const actor = await createTestOrg();
    const created = await createMonitor(
      db,
      actor,
      monitorInput({ failureWindowSeconds: 3600 }),
    );
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    await db
      .update(monitors)
      .set({ firstFailureAt: weekAgo, currentStatus: "up" })
      .where(eq(monitors.id, created.id));

    // What the worker holds: the row as it was when the probe started.
    const inFlight = (await db.query.monitors.findFirst({
      where: eq(monitors.id, created.id),
    }))!;

    await setMonitorPaused(db, actor, created.id, true);
    const resumed = await setMonitorPaused(db, actor, created.id, false);
    expect(resumed.firstFailureAt).toBeNull();

    const result = await recordCheckOutcome(db, inFlight, failResult());

    expect(result.reconciliation.openIncident).toBe(false);
    expect(result.monitor.currentStatus).not.toBe("down");

    // The resume's clean slate survives the late write.
    const row = await db.query.monitors.findFirst({
      where: eq(monitors.id, created.id),
    });
    expect(row?.firstFailureAt).toBeNull();

    // And the observation is still recorded.
    const checks = await db.query.monitorChecks.findMany({
      where: eq(monitorChecks.monitorId, created.id),
    });
    expect(checks).toHaveLength(1);
  });
});

describe("deleteMonitor", () => {
  it("removes the monitor, cascades its checks, and writes an audit row", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    const first = await recordCheckOutcome(db, monitor, okResult());
    await recordCheckOutcome(db, first.monitor, failResult());

    await deleteMonitor(db, actor, monitor.id);

    const gone = await db.query.monitors.findFirst({
      where: eq(monitors.id, monitor.id),
    });
    expect(gone).toBeUndefined();

    const orphanChecks = await db.query.monitorChecks.findMany({
      where: eq(monitorChecks.monitorId, monitor.id),
    });
    expect(orphanChecks).toEqual([]);

    const audit = await db.query.auditLogs.findMany({
      where: and(
        eq(auditLogs.organizationId, actor.organizationId),
        eq(auditLogs.action, "monitor.deleted"),
      ),
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: actor.userId,
      targetId: monitor.id,
      metadata: { name: monitor.name, url: monitor.url },
    });
  });
});

describe("uptime excludes observations that measured nothing", () => {
  /**
   * An `indeterminate` check is stored `ok = false` because there is no
   * third boolean. Counting it as downtime publishes a red strip for a
   * ping monitor on a worker without CAP_NET_RAW — an operator
   * configuration problem rendered as an outage, which is exactly what
   * docs/UPGRADE.md promises never happens.
   */
  it("keeps them out of both halves of the ratio", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    let current = monitor;
    ({ monitor: current } = await recordCheckOutcome(db, current, okResult()));
    ({ monitor: current } = await recordCheckOutcome(db, current, okResult()));
    await recordCheckOutcome(
      db,
      current,
      indeterminateResult("ICMP is not permitted for this process."),
    );

    // Two measured checks, both fine. The third measured nothing.
    const list = await listMonitors(db, actor.organizationId);
    expect(list[0]?.uptime24hPct).toBe(100);

    const detail = await getMonitorDetail(db, actor.organizationId, monitor.id);
    expect(detail.windows[0]?.uptimePct).toBe(100);
  });

  it("reports no uptime at all when nothing was ever measured", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    await recordCheckOutcome(
      db,
      monitor,
      indeterminateResult("The `ping` command is not available."),
    );

    // Not 0% — that is the false-red. There is simply no measurement.
    const list = await listMonitors(db, actor.organizationId);
    expect(list[0]?.uptime24hPct).toBeNull();

    const detail = await getMonitorDetail(db, actor.organizationId, monitor.id);
    expect(detail.windows[0]?.uptimePct).toBeNull();
  });

  it("still counts pre-1.10 rows, which have no verdict at all", async () => {
    // Migration 0010 leaves `verdict` NULL on every existing row. A
    // `<> 'indeterminate'` predicate is NULL for those and would drop
    // the entire pre-upgrade history out of the denominator.
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    // Placed on an explicit timeline: uptime is duration-weighted, so
    // two rows written microseconds apart say nothing about a ratio.
    // Twenty minutes up, then twenty minutes down, inside the horizon
    // of a 60s monitor's cadence is not possible — so the samples are
    // spaced at the monitor's interval and the split is 50/50 by count
    // *and* by duration.
    await seedTimeline(monitor.id, [
      { minutesAgo: 4, ok: true },
      { minutesAgo: 3, ok: true },
      { minutesAgo: 2, ok: false },
      { minutesAgo: 1, ok: false },
    ]);
    await db
      .update(monitorChecks)
      .set({ verdict: null })
      .where(eq(monitorChecks.monitorId, monitor.id));

    const list = await listMonitors(db, actor.organizationId);
    // Same open final segment, same tolerance, same reasoning.
    expect(list[0]?.uptime24hPct).toBeCloseTo(50, 1);
  });
});

/**
 * Writes checks at controlled timestamps.
 *
 * Uptime is duration-weighted, so a test that calls `recordCheckOutcome`
 * four times in a row is asserting against whatever sub-millisecond gaps
 * the event loop happened to produce. Placing the samples on a stated
 * timeline is what makes the expected ratio a fact rather than a
 * coincidence.
 */
async function seedTimeline(
  monitorId: string,
  points: { minutesAgo: number; ok: boolean }[],
  responseTimeMs = 100,
): Promise<void> {
  const now = Date.now();
  await db.insert(monitorChecks).values(
    points.map((p) => ({
      monitorId,
      checkedAt: new Date(now - p.minutesAgo * 60_000),
      ok: p.ok,
      responseTimeMs: p.ok ? responseTimeMs : null,
      verdict: p.ok ? "up" : "down",
    })),
  );
}

describe("listMonitors", () => {
  it("computes uptime24hPct by duration and avgResponseMs from recent checks", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    // Three minutes up, one minute down: 75% — the same number the old
    // count-based version produced here, but for the right reason. The
    // difference only shows when the spacing is uneven, which is what
    // the next case covers.
    await seedTimeline(monitor.id, [
      { minutesAgo: 4, ok: true },
      { minutesAgo: 3, ok: true },
      { minutesAgo: 2, ok: true },
      { minutesAgo: 1, ok: false },
    ]);

    const list = await listMonitors(db, actor.organizationId);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(monitor.id);
    // Close-to, not exactly, and the reason is the methodology rather
    // than sloppiness: the last sample's segment is open and runs to
    // `now()`, so every millisecond between seeding these rows and
    // running the query lengthens the DOWN segment. On a quiet machine
    // that rounds to 75.00 and on a loaded CI runner it reported 74.99,
    // which is the test measuring the runner instead of the property.
    // A count-based regression would read 75 vs 50 vs 100, nowhere near
    // this tolerance, so the pin still catches what it exists to catch.
    expect(list[0]?.uptime24hPct).toBeCloseTo(75, 1);
    expect(list[0]?.avgResponseMs).toBe(100);
  });

  it("does not let a burst of samples outweigh the time it covers", async () => {
    // The defect this replaced: the scheduler probes a suspicious
    // monitor up to 16x as often, so a short blip produced a pile of
    // rows and a count-based ratio read it as a long outage.
    //
    // Ten minutes of history. One minute of it is down, sampled every
    // five seconds; the other nine are up, sampled every minute. By row
    // count that is 12/21 = 57% up. By duration it is 90%.
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    const points: { minutesAgo: number; ok: boolean }[] = [];
    for (let m = 10; m > 1; m--) points.push({ minutesAgo: m, ok: true });
    for (let s = 0; s < 12; s++) {
      points.push({ minutesAgo: 1 - s / 12, ok: false });
    }
    await seedTimeline(monitor.id, points);

    const list = await listMonitors(db, actor.organizationId);
    expect(list[0]?.uptime24hPct).toBeGreaterThan(88);
    expect(list[0]?.uptime24hPct).toBeLessThan(92);
  });

  it("returns null stats for a monitor with no checks", async () => {
    const actor = await createTestOrg();
    await createMonitor(db, actor, monitorInput());

    const list = await listMonitors(db, actor.organizationId);
    expect(list).toHaveLength(1);
    expect(list[0]?.uptime24hPct).toBeNull();
    expect(list[0]?.avgResponseMs).toBeNull();
  });
});
