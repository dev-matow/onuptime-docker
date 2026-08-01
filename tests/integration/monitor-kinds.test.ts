// @covers-type: push, group, manual
import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { GET as pushEndpoint } from "@/app/api/push/[token]/route";
import {
  incidents,
  monitorChecks,
  monitorHeartbeats,
  monitors,
} from "@/db/schema";
import { evaluateMonitor } from "@/modules/monitors/evaluate";
import { recordHeartbeat } from "@/modules/monitors/heartbeat";
import { applyOutcome, refreshDeclaredState } from "@/modules/monitors/outcome";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import { createMonitorSchema } from "@/modules/monitors/schemas";
import {
  createMonitor,
  deleteMonitor,
  findDueMonitors,
  regeneratePushToken,
  updateMonitor,
  uptimeByMonitor,
  type Monitor,
} from "@/modules/monitors/service";
import { runMonitorCheck } from "@/worker/jobs/monitor-check";

import {
  createTestOrg,
  db,
  failResult,
  okResult,
  type TestActor,
} from "../helpers";

/**
 * The three kinds that are not probes, end to end.
 *
 * The unit suite proves each one judges its facts correctly. This one
 * proves the things only a database can: that the scheduler never picks
 * up a group, that a heartbeat arriving at an HTTP endpoint turns into
 * an observation on the same table as an HTTP probe's, that a member's
 * failure reaches its group without either of them being scheduled, and
 * that all three produce uptime an operator can read rather than a
 * permanent "no data".
 */

function input(overrides: Partial<CreateMonitorInput>): CreateMonitorInput {
  return {
    name: `kind-${randomUUID().slice(0, 8)}`,
    url: "https://kinds.example.com/health",
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 10_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    checkType: "http",
    tlsCheck: false,
    tlsWarnDays: 14,
    // One failed observation opens the incident — keeps these direct.
    failureWindowSeconds: 0,
    config: null,
    ...overrides,
  } as CreateMonitorInput;
}

function pushInput(overrides: Partial<CreateMonitorInput> = {}) {
  return input({
    checkType: "push",
    url: "nightly-backup",
    config: { graceSeconds: 0 },
    ...overrides,
  });
}

function groupInput(overrides: Partial<CreateMonitorInput> = {}) {
  return input({ checkType: "group", url: "EU region", ...overrides });
}

function manualInput(overrides: Partial<CreateMonitorInput> = {}) {
  return input({
    checkType: "manual",
    url: "Stripe payments",
    config: { status: "up", note: null },
    ...overrides,
  });
}

async function reload(monitorId: string): Promise<Monitor> {
  const row = await db.query.monitors.findFirst({
    where: eq(monitors.id, monitorId),
  });
  if (!row) throw new Error("monitor vanished");
  return row;
}

async function openIncidentFor(monitorId: string) {
  return db.query.incidents.findFirst({
    where: and(
      eq(incidents.monitorId, monitorId),
      eq(incidents.source, "monitor"),
    ),
  });
}

async function checksFor(monitorId: string) {
  return db.query.monitorChecks.findMany({
    where: eq(monitorChecks.monitorId, monitorId),
    orderBy: [desc(monitorChecks.checkedAt)],
  });
}

function tokenOf(monitor: Monitor): string {
  return (monitor.config as { token: string }).token;
}

describe("the scheduler and the kinds it does not own", () => {
  let actor: TestActor;

  it("never offers a group or a manual monitor to the scheduler", async () => {
    actor = await createTestOrg();
    const group = await createMonitor(db, actor, groupInput());
    const manual = await createMonitor(db, actor, manualInput());
    const push = await createMonitor(db, actor, pushInput());

    // Nothing to measure and nobody to ask: selecting either would spend
    // a queue slot and a worker to write an observation identical to the
    // last one, for ever.
    expect(group.nextEvaluationAt).toBeNull();
    expect(manual.nextEvaluationAt).toBeNull();
    expect(push.nextEvaluationAt).not.toBeNull();

    // A generous limit: the test database accumulates monitors from
    // every other suite, and the default batch would truncate before
    // reaching these three — which would pass the two negative
    // assertions for entirely the wrong reason.
    const due = await findDueMonitors(db, 100_000);
    const ids = due.map((monitor) => monitor.id);
    expect(ids).not.toContain(group.id);
    expect(ids).not.toContain(manual.id);
    expect(ids).toContain(push.id);
  });

  it("declines a check job that reaches a group anyway", async () => {
    // A job can outlive the type it was queued for — an edit, or a
    // deploy. Honouring it would write an observation on a cadence that
    // means nothing for this kind.
    actor = await createTestOrg();
    const group = await createMonitor(db, actor, groupInput());
    await runMonitorCheck(group.id, {});
    expect(await checksFor(group.id)).toHaveLength(0);
  });

  it("takes a monitor off the scheduler when its type is changed to a group", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, input({}));
    expect(monitor.nextEvaluationAt).not.toBeNull();

    const changed = await updateMonitor(db, actor, monitor.id, {
      checkType: "group",
      url: "EU region",
    });
    expect(changed.nextEvaluationAt).toBeNull();
    expect((await findDueMonitors(db, 100_000)).map((m) => m.id)).not.toContain(
      monitor.id,
    );
  });
});

describe("a push monitor", () => {
  let actor: TestActor;

  it("is created with a token nobody typed", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, pushInput());
    expect(tokenOf(monitor)).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
  });

  it("is pending, not up, until its first heartbeat", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, pushInput());
    const outcome = await evaluateMonitor(db, monitor);
    // Nothing has succeeded and nothing has failed. Reporting either
    // would be a claim Vigil cannot support.
    expect(outcome.verdict).toBe("indeterminate");
  });

  it("records an arriving heartbeat and nothing else", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, pushInput());

    const response = await pushEndpoint(
      new Request(`http://localhost/api/push/${tokenOf(monitor)}`),
      { params: Promise.resolve({ token: tokenOf(monitor) }) },
    );
    expect(response.status).toBe(200);

    // The endpoint is unauthenticated by construction, so it writes one
    // row of state and never an observation, an incident or an email.
    expect(await checksFor(monitor.id)).toHaveLength(0);

    const heartbeat = await db.query.monitorHeartbeats.findFirst({
      where: eq(monitorHeartbeats.monitorId, monitor.id),
    });
    expect(heartbeat?.reportedStatus).toBe("up");
  });

  it("reports up on the evaluation after a heartbeat lands", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, pushInput());
    await recordHeartbeat(db, monitor.id, {
      status: "up",
      message: null,
      responseTimeMs: 1_200,
    });

    await runMonitorCheck(monitor.id, {});
    const updated = await reload(monitor.id);
    expect(updated.currentStatus).toBe("up");
    expect((await checksFor(monitor.id))[0]?.responseTimeMs).toBe(1_200);
  });

  it("carries the reported status and message through to the check", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, pushInput());
    await pushEndpoint(
      new Request(
        `http://localhost/api/push/${tokenOf(monitor)}?status=down&msg=backup+failed&ping=900`,
      ),
      { params: Promise.resolve({ token: tokenOf(monitor) }) },
    );

    await runMonitorCheck(monitor.id, {});
    const [check] = await checksFor(monitor.id);
    expect(check?.ok).toBe(false);
    expect(check?.error).toContain("reported a failure");
    expect((check?.facts as Record<string, unknown>).reportedMessage).toBe(
      "backup failed",
    );
    expect(await openIncidentFor(monitor.id)).toBeDefined();
  });

  it("opens an incident when the heartbeat stops arriving", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, pushInput());
    await recordHeartbeat(
      db,
      monitor.id,
      { status: "up", message: null, responseTimeMs: null },
      new Date(Date.now() - 10 * 60_000),
    );

    await runMonitorCheck(monitor.id, {});
    const updated = await reload(monitor.id);
    expect(updated.currentStatus).toBe("down");
    const incident = await openIncidentFor(monitor.id);
    expect(incident?.status).not.toBe("resolved");
  });

  it("resolves the incident on the evaluation after the job checks back in", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, pushInput());
    await recordHeartbeat(
      db,
      monitor.id,
      { status: "up", message: null, responseTimeMs: null },
      new Date(Date.now() - 10 * 60_000),
    );
    await runMonitorCheck(monitor.id, {});
    expect((await reload(monitor.id)).currentStatus).toBe("down");

    await pushEndpoint(
      new Request(`http://localhost/api/push/${tokenOf(monitor)}`),
      { params: Promise.resolve({ token: tokenOf(monitor) }) },
    );
    await runMonitorCheck(monitor.id, {});

    expect((await reload(monitor.id)).currentStatus).toBe("up");
    expect((await openIncidentFor(monitor.id))?.status).toBe("resolved");
  });

  it("answers a token that does not exist exactly as it answers a paused one", async () => {
    // No oracle: an endpoint that only 404s for wrong tokens is a way to
    // find right ones.
    const response = await pushEndpoint(
      new Request("http://localhost/api/push/" + "x".repeat(32)),
      { params: Promise.resolve({ token: "x".repeat(32) }) },
    );
    expect(response.status).toBe(404);
  });

  it("accepts a heartbeat for a paused monitor without recording it", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, pushInput());
    await db
      .update(monitors)
      .set({ paused: true })
      .where(eq(monitors.id, monitor.id));

    const response = await pushEndpoint(
      new Request(`http://localhost/api/push/${tokenOf(monitor)}`),
      { params: Promise.resolve({ token: tokenOf(monitor) }) },
    );
    expect(response.status).toBe(200);
    // Pausing means "stop telling me about this". An arrival must not
    // leave a "last seen" that reads as live the moment it is resumed.
    const heartbeat = await db.query.monitorHeartbeats.findFirst({
      where: eq(monitorHeartbeats.monitorId, monitor.id),
    });
    expect(heartbeat).toBeUndefined();
  });

  it("stops honouring the old token once a new one is issued", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, pushInput());
    const old = tokenOf(monitor);

    await regeneratePushToken(db, actor, monitor.id);
    const response = await pushEndpoint(
      new Request(`http://localhost/api/push/${old}`),
      { params: Promise.resolve({ token: old }) },
    );
    expect(response.status).toBe(404);
    expect(tokenOf(await reload(monitor.id))).not.toBe(old);
  });

  it("keeps its token through an edit that never mentions it", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, pushInput());
    const original = tokenOf(monitor);

    // The form has never been given the real token, so it cannot echo
    // one. An edit that changes the name must not silently break the
    // cron that has been calling the endpoint for a year.
    await updateMonitor(db, actor, monitor.id, { name: "renamed" });
    expect(tokenOf(await reload(monitor.id))).toBe(original);
  });

  it("is accepted by the create schema with the payload the form sends", async () => {
    expect(
      createMonitorSchema.safeParse({
        ...pushInput(),
        escalationPolicyId: null,
      }).success,
    ).toBe(true);
  });

  it("refuses a job name with control characters in it", async () => {
    const parsed = createMonitorSchema.safeParse({
      ...pushInput({ url: "nightly backup" }),
      escalationPolicyId: null,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["url"]);
  });
});

describe("a group derives its state from its members", () => {
  let actor: TestActor;

  it("goes down when a member does, without either being scheduled", async () => {
    actor = await createTestOrg();
    const group = await createMonitor(db, actor, groupInput());
    const member = await createMonitor(
      db,
      actor,
      input({ parentId: group.id }),
    );

    await applyOutcome(member, failResult());

    const derived = await reload(group.id);
    expect(derived.currentStatus).toBe("down");
    const [check] = await checksFor(group.id);
    expect((check?.facts as Record<string, unknown>).downMembers).toBe(1);
    expect(await openIncidentFor(group.id)).toBeDefined();
  });

  it("recovers when its member does", async () => {
    actor = await createTestOrg();
    const group = await createMonitor(db, actor, groupInput());
    const member = await createMonitor(
      db,
      actor,
      input({ parentId: group.id }),
    );

    await applyOutcome(member, failResult());
    await applyOutcome(await reload(member.id), okResult());

    expect((await reload(group.id)).currentStatus).toBe("up");
    expect((await openIncidentFor(group.id))?.status).toBe("resolved");
  });

  it("reaches a group two levels up", async () => {
    actor = await createTestOrg();
    const region = await createMonitor(db, actor, groupInput());
    const service = await createMonitor(
      db,
      actor,
      groupInput({ url: "checkout", parentId: region.id }),
    );
    const member = await createMonitor(
      db,
      actor,
      input({ parentId: service.id }),
    );

    await applyOutcome(member, failResult());

    expect((await reload(service.id)).currentStatus).toBe("down");
    expect((await reload(region.id)).currentStatus).toBe("down");
  });

  it("takes its cadence from its slowest member", async () => {
    // A group can only learn something when a member reports, and
    // `uptime.ts` sizes an observation's coverage horizon from
    // `interval_seconds`. A group left on the 60s default while its
    // members report hourly would show coverage gaps that were never
    // gaps in evidence.
    actor = await createTestOrg();
    const group = await createMonitor(db, actor, groupInput());
    const fast = await createMonitor(
      db,
      actor,
      input({ parentId: group.id, intervalSeconds: 30 }),
    );
    await createMonitor(
      db,
      actor,
      input({ parentId: group.id, intervalSeconds: 3_600 }),
    );

    await applyOutcome(fast, okResult());
    expect((await reload(group.id)).intervalSeconds).toBe(3_600);
  });

  it("does not write an observation for every member check once it is steady", async () => {
    actor = await createTestOrg();
    const group = await createMonitor(db, actor, groupInput());
    const member = await createMonitor(
      db,
      actor,
      input({ parentId: group.id, intervalSeconds: 3_600 }),
    );

    await applyOutcome(member, okResult());
    await applyOutcome(await reload(member.id), okResult());
    await applyOutcome(await reload(member.id), okResult());

    // Three member observations, one group observation: the state never
    // changed and the throttle has not elapsed. Recording all three
    // would double the largest table in the product to say "still fine".
    expect(await checksFor(group.id)).toHaveLength(1);
  });

  it("records immediately when the derived state changes, throttle or not", async () => {
    actor = await createTestOrg();
    const group = await createMonitor(db, actor, groupInput());
    const member = await createMonitor(
      db,
      actor,
      input({ parentId: group.id, intervalSeconds: 3_600 }),
    );

    await applyOutcome(member, okResult());
    await applyOutcome(await reload(member.id), failResult());

    expect(await checksFor(group.id)).toHaveLength(2);
  });

  it("releases its members when it is deleted, rather than taking them with it", async () => {
    actor = await createTestOrg();
    const group = await createMonitor(db, actor, groupInput());
    const member = await createMonitor(
      db,
      actor,
      input({ parentId: group.id }),
    );

    await deleteMonitor(db, actor, group.id);

    const survivor = await reload(member.id);
    expect(survivor.parentId).toBeNull();
  });

  it("refuses to be a member of itself", async () => {
    actor = await createTestOrg();
    const group = await createMonitor(db, actor, groupInput());
    await expect(
      updateMonitor(db, actor, group.id, { parentId: group.id }),
    ).rejects.toThrow(/member of itself/);
  });

  it("refuses a cycle through a nested group", async () => {
    actor = await createTestOrg();
    const outer = await createMonitor(db, actor, groupInput());
    const inner = await createMonitor(
      db,
      actor,
      groupInput({ url: "inner", parentId: outer.id }),
    );
    await expect(
      updateMonitor(db, actor, outer.id, { parentId: inner.id }),
    ).rejects.toThrow(/inside one of its own members/);
  });

  it("refuses a group that belongs to another organization", async () => {
    // Membership crossing a tenant boundary would publish one
    // organization's status inside another's rollup.
    actor = await createTestOrg();
    const stranger = await createTestOrg();
    const theirGroup = await createMonitor(db, stranger, groupInput());
    await expect(
      createMonitor(db, actor, input({ parentId: theirGroup.id })),
    ).rejects.toThrow(/does not exist/);
  });

  it("refuses a parent that is not a group", async () => {
    actor = await createTestOrg();
    const http = await createMonitor(db, actor, input({}));
    await expect(
      createMonitor(db, actor, input({ parentId: http.id })),
    ).rejects.toThrow(/not a group/);
  });

  it("refuses to stop being a group while it still has members", async () => {
    actor = await createTestOrg();
    const group = await createMonitor(db, actor, groupInput());
    await createMonitor(db, actor, input({ parentId: group.id }));
    await expect(
      updateMonitor(db, actor, group.id, {
        checkType: "http",
        url: "https://kinds.example.com/health",
      }),
    ).rejects.toThrow(/still has 1 member/);
  });
});

describe("a manual monitor", () => {
  let actor: TestActor;

  it("records the operator's statement when it is created", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, manualInput());
    await refreshDeclaredState(monitor);

    const [check] = await checksFor(monitor.id);
    expect(check?.ok).toBe(true);
    expect((await reload(monitor.id)).currentStatus).toBe("up");
  });

  it("opens an incident when an operator marks it down", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, manualInput());
    await refreshDeclaredState(monitor);

    const edited = await updateMonitor(db, actor, monitor.id, {
      config: { status: "down", note: "vendor outage" },
    });
    await refreshDeclaredState(edited);

    expect((await reload(monitor.id)).currentStatus).toBe("down");
    const incident = await openIncidentFor(monitor.id);
    expect(incident?.status).not.toBe("resolved");
  });

  it("resolves it when the operator says the vendor is back", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      manualInput({ config: { status: "down", note: "vendor outage" } }),
    );
    await refreshDeclaredState(monitor);

    const edited = await updateMonitor(db, actor, monitor.id, {
      config: { status: "up", note: null },
    });
    await refreshDeclaredState(edited);

    expect((await reload(monitor.id)).currentStatus).toBe("up");
    expect((await openIncidentFor(monitor.id))?.status).toBe("resolved");
  });

  it("stays where the operator put it, with nothing scheduled to change it", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      manualInput({ config: { status: "degraded", note: "partial" } }),
    );
    await refreshDeclaredState(monitor);

    await runMonitorCheck(monitor.id, {});
    expect(await checksFor(monitor.id)).toHaveLength(1);
    expect((await reload(monitor.id)).currentStatus).toBe("degraded");
  });

  it("carries a member's manual state into its group", async () => {
    actor = await createTestOrg();
    const group = await createMonitor(db, actor, groupInput());
    const vendor = await createMonitor(
      db,
      actor,
      manualInput({
        parentId: group.id,
        config: { status: "down", note: "vendor outage" },
      }),
    );
    await refreshDeclaredState(vendor);

    expect((await reload(group.id)).currentStatus).toBe("down");
  });
});

describe("uptime for the kinds that are not probes", () => {
  let actor: TestActor;

  it("covers a manual monitor for as long as its statement stood", async () => {
    // The exception the horizon makes, and the whole point of it: an
    // operator's statement is not evidence that goes stale, it is
    // evidence that is replaced. Expiring it after three intervals would
    // report "no data" for a monitor doing exactly what it was asked.
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, manualInput());
    const twentyDaysAgo = new Date(Date.now() - 20 * 86_400_000);
    await applyOutcome(monitor, await evaluateMonitor(db, monitor), {
      now: twentyDaysAgo,
    });

    const now = new Date();
    const result = (
      await uptimeByMonitor(
        db,
        [monitor.id],
        new Date(now.getTime() - 30 * 86_400_000),
        now,
      )
    ).get(monitor.id);

    expect(result?.uptimePct).toBe(100);
    // Twenty days of coverage from one statement, not three minutes.
    expect(result?.coveredMs).toBeGreaterThan(19 * 86_400_000);
  });

  it("covers a push monitor from its evaluations, not from its heartbeats", async () => {
    actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, pushInput());
    await recordHeartbeat(db, monitor.id, {
      status: "up",
      message: null,
      responseTimeMs: null,
    });

    const start = new Date(Date.now() - 10 * 60_000);
    for (const minutesAgo of [8, 6, 4, 2]) {
      await applyOutcome(
        await reload(monitor.id),
        await evaluateMonitor(db, monitor),
        { now: new Date(Date.now() - minutesAgo * 60_000) },
      );
    }

    const result = (
      await uptimeByMonitor(db, [monitor.id], start, new Date())
    ).get(monitor.id);
    expect(result?.uptimePct).toBe(100);
    expect(result?.coveredMs).toBeGreaterThan(0);
  });

  it("gives a group real coverage rather than a permanent no-data", async () => {
    actor = await createTestOrg();
    const group = await createMonitor(db, actor, groupInput());
    const member = await createMonitor(
      db,
      actor,
      input({ parentId: group.id }),
    );

    const start = new Date(Date.now() - 10 * 60_000);
    for (const minutesAgo of [8, 5, 2]) {
      await applyOutcome(await reload(member.id), okResult(), {
        now: new Date(Date.now() - minutesAgo * 60_000),
      });
    }

    const result = (
      await uptimeByMonitor(db, [group.id], start, new Date())
    ).get(group.id);
    expect(result?.uptimePct).toBe(100);
    expect(result?.coveredMs).toBeGreaterThan(0);
  });

  it("leaves an empty group out of uptime rather than reporting it green", async () => {
    actor = await createTestOrg();
    const group = await createMonitor(db, actor, groupInput());
    await refreshDeclaredState(group);

    // The observation exists and is `indeterminate`, so it establishes
    // no state and contributes to neither numerator nor denominator.
    expect(await checksFor(group.id)).toHaveLength(1);
    const result = (
      await uptimeByMonitor(
        db,
        [group.id],
        new Date(Date.now() - 3_600_000),
        new Date(),
      )
    ).get(group.id);
    expect(result?.uptimePct ?? null).toBeNull();
  });
});
