import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { monitors } from "@/db/schema";
import {
  claimMonitorsForDispatch,
  reserveMonitorForFollowUp,
} from "@/modules/monitors/service";
import {
  runMonitorCheck,
  scheduleFastFollowUp,
} from "@/worker/jobs/monitor-check";
import { QUEUES } from "@/worker/queues";

import { createTestOrg, db, type TestActor } from "../helpers";
import { publicLookup } from "../probe-lookup";

/**
 * The sub-minute follow-up, and the boundary it gets wrong.
 *
 * `scheduleFastFollowUp` exists because the cron cannot fire faster than
 * once a minute: a monitor due sooner than the next tick enqueues its own
 * next check. It is the one path that enqueues WITHOUT going through the
 * scheduler's claim, so its boundary decides whether the claim covers
 * every enqueue or merely most of them.
 */
async function makeMonitor(
  actor: TestActor,
  intervalSeconds: number,
): Promise<string> {
  const [row] = await db
    .insert(monitors)
    .values({
      organizationId: actor.organizationId,
      name: `fu-${randomUUID().slice(0, 8)}`,
      url: "https://vigil-tests.example.com/health",
      checkType: "http",
      intervalSeconds,
      timeoutMs: 1_000,
      nextEvaluationAt: new Date(Date.now() - 1_000),
    })
    .returning();
  return row!.id;
}

function recordingBoss() {
  const sent: string[] = [];
  return {
    sent,
    send: async (name: string) => {
      sent.push(name);
      return null;
    },
  };
}

function deps(boss: ReturnType<typeof recordingBoss>) {
  return {
    boss,
    fetchImpl: (async () =>
      new Response("ok", { status: 200 })) as typeof fetch,
    lookup: publicLookup,
    allowPrivateTargets: true,
  };
}

describe("scheduleFastFollowUp", () => {
  it("fires for a monitor whose interval equals the tick period", async () => {
    // THE BOUNDARY, and it is inclusive because it was measured.
    //
    // A monitor with a 60-second interval on a 60-second tick has no
    // slack. The tick probes it at the first tick at or after
    // `next_evaluation_at - TICK_GRACE_SECONDS`, so as soon as queue
    // delay exceeds the grace that instant lands past a tick boundary
    // and the monitor waits a whole further cycle: 120 seconds for a
    // 60-second monitor. Leaving these to the tick cost a thousand-
    // monitor fleet at two workers 16.57 checks per second down to
    // 11.58, and the loss shrank as workers were added because a faster
    // drain keeps more monitors inside the grace.
    //
    // 60 seconds is the default interval, so this is most monitors in
    // most installations.
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor, 60);
    const boss = recordingBoss();

    await runMonitorCheck(monitor, deps(boss));

    expect(boss.sent).toContain(QUEUES.monitorCheck);
  });

  it("does not fire for a monitor with slack to spare", async () => {
    // The other side. A 10-minute monitor is due long after the next
    // tick, so the tick will catch it comfortably and a follow-up would
    // be a job sitting in the queue for ten minutes holding a claim.
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor, 600);
    const boss = recordingBoss();

    await runMonitorCheck(monitor, deps(boss));

    expect(boss.sent.filter((name) => name === QUEUES.monitorCheck)).toEqual(
      [],
    );
  });

  it("does not fire one second past the boundary", async () => {
    // Pins the comparison itself. An interval of 61 seconds is outside
    // the path; if this passes while the test above also passes, the
    // guard is at exactly the tick period and not somewhere near it.
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor, 61);
    const boss = recordingBoss();

    await runMonitorCheck(monitor, deps(boss));

    expect(boss.sent.filter((name) => name === QUEUES.monitorCheck)).toEqual(
      [],
    );
  });

  it("reserves the monitor, so the tick cannot enqueue it a second time", async () => {
    // The exclusion the reservation buys. `stately` drops a duplicate
    // only while the first job is still `created`; once pg-boss moves it
    // to `active` the singleton key permits another, and the tick firing
    // in that window would enqueue a monitor already being probed. The
    // reservation is what makes the two paths compete for one lease.
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor, 10);
    const boss = recordingBoss();

    await runMonitorCheck(monitor, deps(boss));

    expect(boss.sent).toContain(QUEUES.monitorCheck);
    expect(await claimMonitorsForDispatch(db, [monitor], 90)).toEqual([]);
  });

  it("still fires for a monitor that really is due before the next tick", async () => {
    // The case the path exists for. Without it a 10-second monitor waits
    // for the minute tick and runs at 60 seconds.
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor, 10);
    const boss = recordingBoss();

    await runMonitorCheck(monitor, deps(boss));

    expect(boss.sent).toContain(QUEUES.monitorCheck);
    const [row] = await db
      .select({ at: monitors.nextEvaluationAt })
      .from(monitors)
      .where(eq(monitors.id, monitor));
    expect(row!.at!.getTime() - Date.now()).toBeLessThan(60_000);
  });
});

describe("reserveMonitorForFollowUp", () => {
  it("refuses a monitor another dispatcher already holds", async () => {
    // The losing side of the reservation. A tick that claimed this
    // monitor owns its next dispatch, and the follow-up must stand down
    // rather than enqueue alongside it.
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor, 10);
    expect(await claimMonitorsForDispatch(db, [monitor], 120)).toEqual([
      monitor,
    ]);

    expect(await reserveMonitorForFollowUp(db, monitor, 60)).toBe(false);
  });

  it("lets exactly one of two concurrent reservations win", async () => {
    // Two workers finishing a check on the same monitor at the same
    // instant. Both reach the reservation; the second serialises on the
    // row lock, re-reads the winner's row and matches nothing. If both
    // could win, both would enqueue, which is the duplicate this exists
    // to prevent.
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor, 10);

    const outcomes = await Promise.all([
      reserveMonitorForFollowUp(db, monitor, 60),
      reserveMonitorForFollowUp(db, monitor, 60),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it("refuses a paused monitor", async () => {
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor, 10);
    await db
      .update(monitors)
      .set({ paused: true })
      .where(eq(monitors.id, monitor));

    expect(await reserveMonitorForFollowUp(db, monitor, 60)).toBe(false);
  });

  it("takes a monitor whose previous lease has expired", async () => {
    // Lease expiry IS the takeover path: a worker that died holding a
    // reservation must not hold it forever.
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor, 10);
    await db
      .update(monitors)
      .set({ dispatchClaimedUntil: new Date(Date.now() - 1_000) })
      .where(eq(monitors.id, monitor));

    expect(await reserveMonitorForFollowUp(db, monitor, 60)).toBe(true);
  });
});

describe("scheduleFastFollowUp, when it loses the reservation", () => {
  it("enqueues nothing", async () => {
    // The race, staged directly: another dispatcher claimed this monitor
    // in the window between the outcome clearing the claim and the
    // follow-up taking it. Enqueueing anyway puts the monitor in the
    // queue twice, which is precisely what the reservation is for.
    const actor = await createTestOrg();
    const monitorId = await makeMonitor(actor, 10);
    expect(await claimMonitorsForDispatch(db, [monitorId], 120)).toEqual([
      monitorId,
    ]);
    const monitor = await db.query.monitors.findFirst({
      where: eq(monitors.id, monitorId),
    });
    const boss = recordingBoss();

    await scheduleFastFollowUp(
      {
        ...monitor!,
        lastCheckedAt: new Date(),
        nextEvaluationAt: new Date(Date.now() + 10_000),
      },
      boss,
    );

    expect(boss.sent).toEqual([]);
  });
});
