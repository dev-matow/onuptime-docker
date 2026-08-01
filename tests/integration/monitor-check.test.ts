import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { incidents } from "@/db/schema";
import { claimIncidentNotification } from "@/modules/incidents/service";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import { createMonitor } from "@/modules/monitors/service";
import { runMonitorCheck } from "@/worker/jobs/monitor-check";

import { createTestOrg, db, type TestActor } from "../helpers";

import { publicLookup } from "../probe-lookup";

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
    checkType: "http" as const,
    tlsCheck: false,
    tlsWarnDays: 14,
    // One failed check opens the incident — keeps these tests direct.
    failureWindowSeconds: 0,
    ...overrides,
  };
}

async function openIncidentFor(monitorId: string) {
  return db.query.incidents.findFirst({
    where: and(
      eq(incidents.monitorId, monitorId),
      eq(incidents.source, "monitor"),
    ),
  });
}

describe("claimIncidentNotification", () => {
  let actor: TestActor;

  it("awards the claim exactly once", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    await runMonitorCheck(monitor.id, {
      fetchImpl: (async () =>
        new Response("", { status: 503 })) as typeof fetch,
      lookup: publicLookup,
      allowPrivateTargets: true,
    });
    const incident = await openIncidentFor(monitor.id);

    // The open path already claimed (no holding action configured).
    expect(await claimIncidentNotification(db, incident!.id)).toBeNull();

    const [first, second] = await Promise.all([
      claimIncidentNotification(db, incident!.id),
      claimIncidentNotification(db, incident!.id),
    ]);
    expect(first).toBeNull();
    expect(second).toBeNull();
  });

  it("is won by exactly one concurrent claimer on a fresh incident", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    const [row] = await db
      .insert(incidents)
      .values({
        organizationId: actor.organizationId,
        title: "held",
        source: "monitor",
        monitorId: monitor.id,
      })
      .returning();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimIncidentNotification(db, row!.id)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
