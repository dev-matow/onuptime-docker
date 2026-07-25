import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditLogs, monitorChecks, monitors } from "@/db/schema";
import { NotFoundError } from "@/lib/errors";
import type { CheckOutcome } from "@/modules/monitors/check";
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

import { createTestOrg, db } from "../helpers";

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
    failureThreshold: 3,
    ...overrides,
  };
}

function okOutcome(responseTimeMs = 100): CheckOutcome {
  return {
    ok: true,
    degraded: false,
    statusCode: 200,
    responseTimeMs,
    error: null,
  };
}

function failOutcome(): CheckOutcome {
  return {
    ok: false,
    degraded: false,
    statusCode: 503,
    responseTimeMs: 250,
    error: "Unexpected status 503",
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
      failureThreshold: 5,
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
      failureThreshold: 5,
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
  it("keeps the previous status until failureThreshold consecutive failures", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ failureThreshold: 2 }),
    );

    const first = await recordCheckOutcome(db, monitor, failOutcome());
    expect(first.monitor.consecutiveFailures).toBe(1);
    expect(first.monitor.currentStatus).toBe("unknown");
    expect(first.becameDown).toBe(false);
    expect(first.becameUp).toBe(false);

    const second = await recordCheckOutcome(db, first.monitor, failOutcome());
    expect(second.monitor.consecutiveFailures).toBe(2);
    expect(second.monitor.currentStatus).toBe("down");
    expect(second.becameDown).toBe(true);

    const third = await recordCheckOutcome(db, second.monitor, failOutcome());
    expect(third.monitor.consecutiveFailures).toBe(3);
    expect(third.monitor.currentStatus).toBe("down");
    expect(third.becameDown).toBe(false);
  });

  it("marks recovery: success after down resets failures and flags becameUp", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ failureThreshold: 1 }),
    );

    const down = await recordCheckOutcome(db, monitor, failOutcome());
    expect(down.monitor.currentStatus).toBe("down");

    const recovered = await recordCheckOutcome(db, down.monitor, okOutcome());
    expect(recovered.becameUp).toBe(true);
    expect(recovered.becameDown).toBe(false);
    expect(recovered.monitor.consecutiveFailures).toBe(0);
    expect(recovered.monitor.currentStatus).toBe("up");
  });

  it("stores a degraded status for slow-but-ok outcomes", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    const result = await recordCheckOutcome(db, monitor, {
      ok: true,
      degraded: true,
      statusCode: 200,
      responseTimeMs: 4_500,
      error: null,
    });
    expect(result.monitor.currentStatus).toBe("degraded");
    expect(result.monitor.consecutiveFailures).toBe(0);
  });

  it("inserts a check row for every recorded outcome", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    const first = await recordCheckOutcome(db, monitor, okOutcome(120));
    await recordCheckOutcome(db, first.monitor, failOutcome());

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
      okOutcome(),
    );
    expect(checked.lastCheckedAt).toBeInstanceOf(Date);
  });
});

describe("findDueMonitors", () => {
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
    await recordCheckOutcome(db, monitor, okOutcome());

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
  it("pause then unpause resets consecutiveFailures and currentStatus", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ failureThreshold: 2 }),
    );
    const first = await recordCheckOutcome(db, monitor, failOutcome());
    const second = await recordCheckOutcome(db, first.monitor, failOutcome());
    expect(second.monitor.currentStatus).toBe("down");
    expect(second.monitor.consecutiveFailures).toBe(2);

    const paused = await setMonitorPaused(db, actor, monitor.id, true);
    expect(paused.paused).toBe(true);

    const resumed = await setMonitorPaused(db, actor, monitor.id, false);
    expect(resumed.paused).toBe(false);
    expect(resumed.consecutiveFailures).toBe(0);
    expect(resumed.currentStatus).toBe("unknown");
  });
});

describe("deleteMonitor", () => {
  it("removes the monitor, cascades its checks, and writes an audit row", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    const first = await recordCheckOutcome(db, monitor, okOutcome());
    await recordCheckOutcome(db, first.monitor, failOutcome());

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

describe("listMonitors", () => {
  it("computes uptime24hPct and avgResponseMs from recent checks", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    let current = monitor;
    for (let i = 0; i < 3; i++) {
      ({ monitor: current } = await recordCheckOutcome(
        db,
        current,
        okOutcome(100),
      ));
    }
    await recordCheckOutcome(db, current, failOutcome());

    const list = await listMonitors(db, actor.organizationId);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(monitor.id);
    expect(list[0]?.uptime24hPct).toBe(75);
    expect(list[0]?.avgResponseMs).toBe(100);
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
