import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { incidents, monitorChecks } from "@/db/schema";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import { createMonitor, setMonitorPaused } from "@/modules/monitors/service";
import {
  runMonitorCheck,
  type MonitorCheckDeps,
} from "@/worker/jobs/monitor-check";

import { createTestOrg, db } from "../helpers";

const MONITOR_URL = "https://vigil-tests.example.com/health";

function monitorInput(
  overrides: Partial<CreateMonitorInput> = {},
): CreateMonitorInput {
  return {
    name: `Monitor ${randomUUID().slice(0, 8)}`,
    url: MONITOR_URL,
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 10_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    // One failed check opens the incident — keeps these tests direct.
    failureThreshold: 1,
    ...overrides,
  };
}

/** Deps that answer every probe with a fixed status and body. */
function deps(status: number, body = ""): MonitorCheckDeps {
  return {
    fetchImpl: (async () => new Response(body, { status })) as typeof fetch,
    allowPrivateTargets: true,
  };
}

async function incidentFor(monitorId: string) {
  return db.query.incidents.findFirst({
    where: and(
      eq(incidents.monitorId, monitorId),
      eq(incidents.source, "monitor"),
    ),
  });
}

describe("runMonitorCheck", () => {
  it("records a check and leaves a healthy monitor alone", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    await runMonitorCheck(monitor.id, deps(200));

    const checks = await db.query.monitorChecks.findMany({
      where: eq(monitorChecks.monitorId, monitor.id),
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.ok).toBe(true);
    expect(await incidentFor(monitor.id)).toBeUndefined();
  });

  it("opens an incident once the failure threshold is reached", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    await runMonitorCheck(monitor.id, deps(503));

    const incident = await incidentFor(monitor.id);
    expect(incident).toBeDefined();
    expect(incident?.status).toBe("investigating");
    expect(incident?.source).toBe("monitor");
  });

  it("does not open an incident before the threshold is reached", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ failureThreshold: 3 }),
    );

    await runMonitorCheck(monitor.id, deps(503));
    await runMonitorCheck(monitor.id, deps(503));
    expect(await incidentFor(monitor.id)).toBeUndefined();

    await runMonitorCheck(monitor.id, deps(503));
    expect(await incidentFor(monitor.id)).toBeDefined();
  });

  it("auto-resolves the incident when the target recovers", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    await runMonitorCheck(monitor.id, deps(503));
    const opened = await incidentFor(monitor.id);
    expect(opened?.resolvedAt).toBeNull();

    await runMonitorCheck(monitor.id, deps(200));
    const resolved = await incidentFor(monitor.id);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedAt).toBeInstanceOf(Date);
  });

  it("treats a failed keyword assertion as a hard down", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ bodyKeyword: "healthy" }),
    );

    // HTTP 200, but the body doesn't carry the keyword.
    await runMonitorCheck(monitor.id, deps(200, "database unavailable"));

    const incident = await incidentFor(monitor.id);
    expect(incident).toBeDefined();

    const checks = await db.query.monitorChecks.findMany({
      where: eq(monitorChecks.monitorId, monitor.id),
    });
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.statusCode).toBe(200);
    expect(checks[0]?.error).toMatch(/healthy/);
  });

  it("skips paused monitors entirely", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    await setMonitorPaused(db, actor, monitor.id, true);

    await runMonitorCheck(monitor.id, deps(503));

    const checks = await db.query.monitorChecks.findMany({
      where: eq(monitorChecks.monitorId, monitor.id),
    });
    expect(checks).toHaveLength(0);
    expect(await incidentFor(monitor.id)).toBeUndefined();
  });
});
