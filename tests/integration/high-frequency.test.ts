import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  monitorChecks,
  monitorHfLeases,
  monitorHfRollups,
  monitorHfSamples,
  monitors,
} from "@/db/schema";
import { HighFrequencyPlane } from "@/modules/monitors/highfreq/plane";
import {
  claimShards,
  liveShards,
  releaseShards,
} from "@/modules/monitors/highfreq/leases";
import { runHighFrequencyRollup } from "@/modules/monitors/highfreq/rollup";
import { shardOf } from "@/modules/monitors/highfreq/shards";
import { runMonitorTick } from "@/worker/jobs/monitor-tick";
import { QUEUES as TICK_QUEUES } from "@/worker/queues";
import { setHighFrequency } from "@/modules/monitors/highfreq/service";
import { achievedCadence } from "@/modules/monitors/highfreq/stats";
import { SampleWriter } from "@/modules/monitors/highfreq/writer";
import { HF_MAX_MONITORS_PER_ORG } from "@/modules/monitors/highfreq/limits";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import { createMonitor } from "@/modules/monitors/service";

/**
 * The plane loads every enrolled monitor in the database, by design —
 * it is one process serving every tenant. That makes this file the one
 * place where a stray high-frequency row left behind by anything else
 * changes the answer: a test asserting "one probe in flight" counts
 * probes to its own injected transport, and the plane uses that
 * transport for every monitor it picked up.
 *
 * So the file starts by standing down anything it did not enrol. It
 * cost an hour to work out the first time, from an assertion that said
 * only `expected 9 to be 1`.
 */
beforeAll(async () => {
  await db
    .update(monitors)
    .set({ highFrequency: false, highFrequencyIntervalMs: null })
    .where(eq(monitors.highFrequency, true));
});

import { createTestOrg, db, type TestActor } from "../helpers";
import { publicLookup } from "../probe-lookup";

const TARGET = "https://vigil-highfreq-tests.example.com/health";

function monitorInput(
  overrides: Partial<CreateMonitorInput> = {},
): CreateMonitorInput {
  return {
    name: `HF ${randomUUID().slice(0, 8)}`,
    url: TARGET,
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 5_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    checkType: "http" as const,
    tlsCheck: false,
    tlsWarnDays: 14,
    failureWindowSeconds: 0,
    ...overrides,
  };
}

/** Every plane a test starts, so a failed assertion cannot leave one probing. */
const running: HighFrequencyPlane[] = [];

/**
 * Monitors this file created, so the cleanup can be scoped to them.
 *
 * Scoped rather than `update monitors set high_frequency = false`: the
 * suites share one database and run in parallel, and an unqualified
 * UPDATE takes a row lock on every monitor row in it — which deadlocks
 * against whatever else is mid-transaction, in a different test each
 * run.
 */
const created: string[] = [];

async function makeMonitor(
  actor: TestActor,
  overrides: Partial<CreateMonitorInput> = {},
) {
  const monitor = await createMonitor(db, actor, monitorInput(overrides));
  created.push(monitor.id);
  return monitor;
}

async function startPlane(
  fetchImpl: typeof fetch,
  ownerId = `test-${randomUUID().slice(0, 8)}`,
): Promise<HighFrequencyPlane> {
  const plane = new HighFrequencyPlane({
    fetchImpl,
    lookup: publicLookup,
    allowPrivateTargets: true,
    ownerId,
  });
  running.push(plane);
  await plane.start();
  return plane;
}

afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
  // Leaves no monitor enabled for the next test's plane to pick up. The
  // plane loads every enabled monitor in the database, not only the ones
  // a test created, so an escaped one would probe through unrelated
  // tests and make their sample counts non-deterministic.
  if (created.length > 0) {
    await db
      .update(monitors)
      .set({ highFrequency: false })
      .where(inArray(monitors.id, created));
    created.length = 0;
  }
});

const ok = (async () =>
  new Response("ok", { status: 200 })) as unknown as typeof fetch;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function samplesFor(monitorId: string) {
  return db
    .select()
    .from(monitorHfSamples)
    .where(eq(monitorHfSamples.monitorId, monitorId))
    .orderBy(asc(monitorHfSamples.observedAt));
}

describe("the high-frequency plane", () => {
  it("probes an enabled monitor several times a second", async () => {
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor);
    await setHighFrequency(db, actor, monitor.id, {
      enabled: true,
      intervalMs: 500,
    });

    await startPlane(ok);
    await sleep(2_600);
    await running[0]!.stop();
    running.length = 0;

    const samples = await samplesFor(monitor.id);
    // Four in two and a half seconds is the honest floor of the
    // assertion: the plane spreads a monitor's first slot inside its
    // first interval, and a shared CI machine owes nobody a punctual
    // event loop. The point being proved is that it is several a
    // second, which the ordinary plane cannot do at all.
    expect(samples.length).toBeGreaterThanOrEqual(4);
    expect(samples.every((sample) => sample.ok)).toBe(true);
    expect(samples.every((sample) => sample.verdict === "up")).toBe(true);
  }, 20_000);

  it("keeps the observation of record at the monitor's own interval, not at the sample rate", async () => {
    const actor = await createTestOrg();
    // A minute: the point is that sixty seconds' worth of samples
    // produce one observation, not a hundred and twenty.
    const monitor = await makeMonitor(actor, { intervalSeconds: 60 });
    await setHighFrequency(db, actor, monitor.id, {
      enabled: true,
      intervalMs: 500,
    });

    await startPlane(ok);
    await sleep(2_600);
    await running[0]!.stop();
    running.length = 0;

    const samples = await samplesFor(monitor.id);
    const observations = await db
      .select()
      .from(monitorChecks)
      .where(eq(monitorChecks.monitorId, monitor.id));

    expect(samples.length).toBeGreaterThanOrEqual(4);
    // Exactly one: the first sample, which had no previous verdict to
    // agree with. Writing one per sample would multiply the largest
    // table in the product by a hundred and twenty.
    expect(observations).toHaveLength(1);
  }, 20_000);

  it("promotes a change of verdict without waiting for the interval", async () => {
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor, {
      intervalSeconds: 60,
      failureWindowSeconds: 0,
    });
    await setHighFrequency(db, actor, monitor.id, {
      enabled: true,
      intervalMs: 500,
    });

    let healthy = true;
    const flaky = (async () =>
      new Response("", {
        status: healthy ? 200 : 503,
      })) as unknown as typeof fetch;

    await startPlane(flaky);
    await sleep(1_200);
    healthy = false;
    await sleep(1_400);
    await running[0]!.stop();
    running.length = 0;

    const observations = await db
      .select()
      .from(monitorChecks)
      .where(eq(monitorChecks.monitorId, monitor.id))
      .orderBy(asc(monitorChecks.checkedAt));

    // Two: the first observation, and the edge into failure. Both
    // inside a monitor whose configured interval is a full minute — the
    // whole value of the plane is that the second one did not wait for
    // it.
    expect(observations.length).toBeGreaterThanOrEqual(2);
    expect(observations[0]!.verdict).toBe("up");
    expect(observations.at(-1)!.verdict).toBe("down");

    const [row] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, monitor.id));
    expect(row!.currentStatus).toBe("down");
  }, 20_000);

  it("never has two probes of one monitor in flight at once", async () => {
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor);
    await setHighFrequency(db, actor, monitor.id, {
      enabled: true,
      intervalMs: 500,
    });

    let inFlight = 0;
    let peak = 0;
    // Slower than the interval, on purpose: every slot after the first
    // arrives while the previous probe is still open. That is the
    // missed-slot case, and the plane must skip it rather than start a
    // second probe or queue one behind it.
    const slow = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(900);
      inFlight -= 1;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const plane = await startPlane(slow);
    await sleep(3_000);
    const stats = plane.stats();
    await plane.stop();
    running.length = 0;

    expect(peak).toBe(1);
    // The slots that did not happen are counted rather than made up.
    expect(stats.missedSlots).toBeGreaterThan(0);
  }, 20_000);

  it("skips missed slots instead of firing a burst to catch up", async () => {
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor);
    await setHighFrequency(db, actor, monitor.id, {
      enabled: true,
      intervalMs: 500,
    });

    const issuedAt: number[] = [];
    const slow = (async () => {
      issuedAt.push(Date.now());
      await sleep(1_400);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await startPlane(slow);
    await sleep(5_000);
    await running[0]!.stop();
    running.length = 0;

    // Coalescing would show up here as two or more probes issued within
    // a few milliseconds of each other, the moment a long one finished.
    // Skipping shows up as gaps that are multiples of the interval and
    // never shorter than it.
    for (let n = 1; n < issuedAt.length; n += 1) {
      expect(issuedAt[n]! - issuedAt[n - 1]!).toBeGreaterThanOrEqual(400);
    }
  }, 20_000);
});

describe("shard leases", () => {
  it("refuses a shard that another worker already holds", async () => {
    const first = await claimShards(db, "worker-a", [3]);
    expect(first.map((lease) => lease.shard)).toEqual([3]);

    const second = await claimShards(db, "worker-b", [3]);
    expect(second).toEqual([]);

    await releaseShards(db, "worker-a", [3]);
  });

  it("lets the holder renew its own lease as often as it likes", async () => {
    await claimShards(db, "worker-a", [4]);
    const renewed = await claimShards(db, "worker-a", [4]);
    expect(renewed.map((lease) => lease.shard)).toEqual([4]);
    await releaseShards(db, "worker-a", [4]);
  });

  it("hands a shard on once its lease has expired", async () => {
    await claimShards(db, "worker-a", [5]);
    // The replica that held it stopped without releasing — killed, or
    // partitioned. Postgres' clock decides, not either worker's.
    await db.execute(
      sql`update monitor_hf_leases set expires_at = now() - interval '1 second' where shard = 5`,
    );

    const taken = await claimShards(db, "worker-b", [5]);
    expect(taken.map((lease) => lease.shard)).toEqual([5]);
    await releaseShards(db, "worker-b", [5]);
  });

  it("does not let a departing worker release a shard someone else took over", async () => {
    await claimShards(db, "worker-a", [6]);
    await db.execute(
      sql`update monitor_hf_leases set expires_at = now() - interval '1 second' where shard = 6`,
    );
    await claimShards(db, "worker-b", [6]);

    await releaseShards(db, "worker-a", [6]);

    expect(await liveShards(db)).toContain(6);
    await releaseShards(db, "worker-b", [6]);
  });
});

describe("the sample writer", () => {
  it("writes many samples in one statement", async () => {
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor);
    const writer = new SampleWriter(db);

    const base = Date.now();
    for (let n = 0; n < 40; n += 1) {
      writer.add({
        monitorId: monitor.id,
        observedAt: new Date(base + n * 500),
        ok: true,
        verdict: "up",
        responseTimeMs: 12,
        error: null,
      });
    }
    await writer.stop();

    expect(writer.snapshot().written).toBe(40);
    // Forty rows, one statement. One statement per row is forty
    // transactions, forty WAL records and forty commits for six columns
    // of data each.
    expect(writer.snapshot().statements).toBe(1);
    expect(await samplesFor(monitor.id)).toHaveLength(40);
  });

  it("stamps each sample with when it was observed, not when it was flushed", async () => {
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor);
    const writer = new SampleWriter(db);

    const base = new Date("2026-08-01T09:00:00.000Z").getTime();
    for (let n = 0; n < 5; n += 1) {
      writer.add({
        monitorId: monitor.id,
        observedAt: new Date(base + n * 500),
        ok: true,
        verdict: "up",
        responseTimeMs: null,
        error: null,
      });
    }
    await writer.stop();

    const rows = await samplesFor(monitor.id);
    // Defaulting the column to now() would make a batch look like five
    // simultaneous samples, and the achieved cadence would then measure
    // the batch size rather than the cadence.
    const gaps = rows
      .slice(1)
      .map(
        (row, i) => row.observedAt.getTime() - rows[i]!.observedAt.getTime(),
      );
    expect(gaps).toEqual([500, 500, 500, 500]);
  });
});

describe("rollups", () => {
  it("aggregates raw samples into minute, hour and day buckets", async () => {
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor);

    const base = Date.now() - 90_000;
    const rows = Array.from({ length: 60 }, (_, n) => ({
      monitorId: monitor.id,
      observedAt: new Date(base + n * 500),
      ok: n !== 10,
      verdict: n === 10 ? "down" : "up",
      responseTimeMs: 10 + n,
      error: n === 10 ? "boom" : null,
    }));
    await db.insert(monitorHfSamples).values(rows);

    await runHighFrequencyRollup(db);

    const buckets = await db
      .select()
      .from(monitorHfRollups)
      .where(eq(monitorHfRollups.monitorId, monitor.id));

    const minutes = buckets.filter((b) => b.granularity === "minute");
    const hours = buckets.filter((b) => b.granularity === "hour");
    const days = buckets.filter((b) => b.granularity === "day");

    expect(minutes.length).toBeGreaterThan(0);
    expect(hours).toHaveLength(1);
    expect(days).toHaveLength(1);

    const total = minutes.reduce((sum, b) => sum + b.samples, 0);
    expect(total).toBe(60);
    expect(hours[0]!.samples).toBe(60);
    expect(hours[0]!.downSamples).toBe(1);
    expect(days[0]!.samples).toBe(60);
  });

  it("re-aggregates latency from sums so a coarse bucket is not a mean of means", async () => {
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor);

    // One minute with a single slow sample, one with many fast ones. A
    // mean of the two minute-means says ~505ms; the truth is ~14ms.
    const base = new Date(Date.now() - 150_000);
    base.setUTCSeconds(0, 0);
    // The two minutes have to land in the same hour, or the assertion
    // below reads whichever of the two hour buckets came back first and
    // counts half the samples. Truncated to the minute, `base` sits at
    // :59 for one minute in every sixty, which is how this test passed
    // locally and failed a CI run that happened to start at 00:02 UTC.
    if (base.getUTCMinutes() === 59) {
      base.setUTCMinutes(58);
    }
    await db.insert(monitorHfSamples).values([
      {
        monitorId: monitor.id,
        observedAt: base,
        ok: true,
        verdict: "up",
        responseTimeMs: 1_000,
        error: null,
      },
      ...Array.from({ length: 99 }, (_, n) => ({
        monitorId: monitor.id,
        observedAt: new Date(base.getTime() + 60_000 + n * 500),
        ok: true,
        verdict: "up",
        responseTimeMs: 4,
        error: null,
      })),
    ]);

    await runHighFrequencyRollup(db);

    const [hour] = await db
      .select()
      .from(monitorHfRollups)
      .where(
        and(
          eq(monitorHfRollups.monitorId, monitor.id),
          eq(monitorHfRollups.granularity, "hour"),
        ),
      );
    expect(hour!.responseSamples).toBe(100);
    expect(hour!.sumResponseMs).toBe(1_000 + 99 * 4);
    expect(hour!.sumResponseMs! / hour!.responseSamples).toBeLessThan(15);
  });

  it("reports a stall whose raw samples were pruned before either end could see it", async () => {
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor);

    // The sequence this reproduces: the plane stopped for eighteen
    // minutes. The minute bucket before the stall was written by a pass
    // that ran before it began, and the bucket after it is written by a
    // pass whose ten-minute raw window starts inside the stall — so
    // neither bucket has a previous sample to measure a gap against, and
    // both honestly report none. Only re-aggregating the buckets
    // themselves can see it.
    const now = Date.now();
    const before = new Date(now - 20 * 60_000);
    before.setUTCSeconds(0, 0);
    await db.insert(monitorHfRollups).values({
      monitorId: monitor.id,
      granularity: "minute",
      bucketStart: before,
      samples: 120,
      okSamples: 120,
      degradedSamples: 0,
      downSamples: 0,
      indeterminateSamples: 0,
      minResponseMs: 5,
      maxResponseMs: 9,
      sumResponseMs: 720,
      responseSamples: 120,
      firstObservedAt: before,
      lastObservedAt: new Date(before.getTime() + 59_500),
      maxGapMs: 500,
    });

    const after = new Date(now - 60_000);
    after.setUTCSeconds(0, 0);
    await db.insert(monitorHfSamples).values(
      Array.from({ length: 4 }, (_, n) => ({
        monitorId: monitor.id,
        observedAt: new Date(after.getTime() + n * 500),
        ok: true,
        verdict: "up",
        responseTimeMs: 5,
        error: null,
      })),
    );

    await runHighFrequencyRollup(db);

    const minutes = await db
      .select()
      .from(monitorHfRollups)
      .where(
        and(
          eq(monitorHfRollups.monitorId, monitor.id),
          eq(monitorHfRollups.granularity, "minute"),
          eq(monitorHfRollups.bucketStart, after),
        ),
      );
    // Its own 500ms spacing and nothing else: the stall happened before
    // this bucket's first sample, and there is no earlier raw row left
    // to measure it against.
    expect(minutes[0]!.maxGapMs).toBe(500);

    const hours = await db
      .select()
      .from(monitorHfRollups)
      .where(
        and(
          eq(monitorHfRollups.monitorId, monitor.id),
          eq(monitorHfRollups.granularity, "hour"),
        ),
      );
    // Asserted across every hour bucket rather than against one of them,
    // because which bucket carries the gap depends on where the hour
    // boundary happens to fall between the two minute buckets — and a
    // test whose meaning changes at :00 is a test that fails once an
    // hour for a reason unrelated to the rollup. The invariant is that
    // the stall is visible in the hour rollups at all: neither minute
    // bucket could measure it, so only re-aggregating them can.
    expect(Math.max(...hours.map((h) => h.maxGapMs ?? 0))).toBeGreaterThan(
      18 * 60_000,
    );
  });

  it("converges rather than double-counting when it runs twice", async () => {
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor);
    const base = Date.now() - 120_000;
    await db.insert(monitorHfSamples).values(
      Array.from({ length: 20 }, (_, n) => ({
        monitorId: monitor.id,
        observedAt: new Date(base + n * 500),
        ok: true,
        verdict: "up",
        responseTimeMs: 7,
        error: null,
      })),
    );

    await runHighFrequencyRollup(db);
    await runHighFrequencyRollup(db);

    const [hour] = await db
      .select()
      .from(monitorHfRollups)
      .where(
        and(
          eq(monitorHfRollups.monitorId, monitor.id),
          eq(monitorHfRollups.granularity, "hour"),
        ),
      );
    expect(hour!.samples).toBe(20);
  });
});

describe("achieved cadence", () => {
  it("reports the gap between samples, not the gap that was asked for", async () => {
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor);

    // Asked for 500ms; delivered 800ms, with one whole slot missed.
    const base = Date.now() - 60_000;
    const offsets = [0, 800, 1_600, 2_400, 4_000, 4_800];
    await db.insert(monitorHfSamples).values(
      offsets.map((offset) => ({
        monitorId: monitor.id,
        observedAt: new Date(base + offset),
        ok: true,
        verdict: "up",
        responseTimeMs: 9,
        error: null,
      })),
    );

    const cadence = await achievedCadence(db, monitor.id, 15, 500);
    expect(cadence.samples).toBe(5);
    expect(cadence.p50Ms).toBe(800);
    expect(cadence.maxMs).toBe(1_600);
    // A gap of at least twice the configured interval is a slot that did
    // not happen. Running consistently 300ms late is not that — it is
    // reported by the p50 being 800 rather than 500 — so exactly one of
    // these six samples follows a missed slot.
    expect(cadence.missedSlots).toBe(1);
  });

  it("counts no missed slots for a monitor that is not on the plane", async () => {
    const actor = await createTestOrg();
    const monitor = await makeMonitor(actor);
    const cadence = await achievedCadence(db, monitor.id, 15, null);
    expect(cadence.samples).toBe(0);
    expect(cadence.missedSlots).toBe(0);
    expect(cadence.p50Ms).toBeNull();
  });
});

describe("enabling high frequency", () => {
  let actor: TestActor;

  it("refuses a check type whose probe is too expensive, and says why", async () => {
    actor = await createTestOrg();
    const monitor = await makeMonitor(actor, {
      checkType: "ping",
      url: "example.com",
    });
    await expect(
      setHighFrequency(db, actor, monitor.id, {
        enabled: true,
        intervalMs: 500,
      }),
    ).rejects.toThrow(/spawns a process/);
  });

  it("refuses an interval below the floor the plane delivers", async () => {
    actor = await createTestOrg();
    const monitor = await makeMonitor(actor);
    await expect(
      setHighFrequency(db, actor, monitor.id, {
        enabled: true,
        intervalMs: 100,
      }),
    ).rejects.toThrow(/shortest interval this plane delivers is 500ms/);
  });

  it("refuses an interval the ordinary scheduler already delivers", async () => {
    actor = await createTestOrg();
    const monitor = await makeMonitor(actor);
    await expect(
      setHighFrequency(db, actor, monitor.id, {
        enabled: true,
        intervalMs: 5_000,
      }),
    ).rejects.toThrow(/handled by the ordinary scheduler/);
  });

  it("stops one organization taking the whole plane", async () => {
    actor = await createTestOrg();
    const ids: string[] = [];
    for (let n = 0; n < HF_MAX_MONITORS_PER_ORG; n += 1) {
      const monitor = await makeMonitor(actor);
      ids.push(monitor.id);
    }
    await db
      .update(monitors)
      .set({ highFrequency: true, highFrequencyIntervalMs: 500 })
      .where(eq(monitors.organizationId, actor.organizationId));

    const extra = await makeMonitor(actor);
    await expect(
      setHighFrequency(db, actor, extra.id, {
        enabled: true,
        intervalMs: 500,
      }),
    ).rejects.toThrow(new RegExp(`limit of ${HF_MAX_MONITORS_PER_ORG}`));

    // A monitor already on the plane is never refused by the quota it is
    // itself occupying.
    await expect(
      setHighFrequency(db, actor, ids[0]!, { enabled: true, intervalMs: 500 }),
    ).resolves.toBeTruthy();
  }, 30_000);

  it("hands a monitor straight back to the ordinary scheduler when it is turned off", async () => {
    actor = await createTestOrg();
    const monitor = await makeMonitor(actor);
    await setHighFrequency(db, actor, monitor.id, {
      enabled: true,
      intervalMs: 500,
    });
    const off = await setHighFrequency(db, actor, monitor.id, {
      enabled: false,
    });

    expect(off.highFrequency).toBe(false);
    expect(off.highFrequencyIntervalMs).toBeNull();
    // Due now, not whenever the last high-frequency promotion decided.
    expect(off.nextEvaluationAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

const TICK_QUEUE = TICK_QUEUES.monitorCheck;

/**
 * The ordinary scheduler's view of a monitor this plane owns.
 *
 * These live here rather than beside the tick's other tests because they
 * claim SHARD LEASES, and `monitor_hf_leases` is one global table keyed
 * by shard with no tenancy in it. Two test files claiming shards at once
 * fight over the same rows however carefully each scopes its monitors:
 * this file's plane could not claim a shard the other file held, and the
 * other file could not produce a shard with no holder. Same file, same
 * worker, one at a time.
 */
function tickBoss() {
  const ids: string[] = [];
  return {
    ids,
    insert: async (
      name: string,
      jobs: { data: object; singletonKey?: string }[],
    ) => {
      if (name === TICK_QUEUE) {
        for (const job of jobs) {
          ids.push((job.data as { monitorId: string }).monitorId);
        }
      }
      return jobs.map((_, index) => `job-${index}`);
    },
  };
}

/** A monitor this plane owns, overdue enough to head the fair ranking. */
async function makeTickMonitor(actor: TestActor): Promise<string> {
  const monitor = await makeMonitor(actor);
  await db
    .update(monitors)
    .set({
      highFrequency: true,
      highFrequencyIntervalMs: 500,
      nextEvaluationAt: new Date(Date.now() - 365 * 24 * 3_600_000),
    })
    .where(eq(monitors.id, monitor.id));
  await claimShards(db, `tick-${randomUUID()}`, [shardOf(monitor.id)]);
  // The plane caches live shards for a second, so a snapshot taken
  // before this lease existed would still be current.
  await sleep(1_100);
  return monitor.id;
}

describe("the ordinary tick, and monitors this plane owns", () => {
  it("defers a monitor a live shard lease covers, instead of reselecting it forever", async () => {
    // Nothing advances `next_evaluation_at` while that plane owns a
    // monitor, so without the deferral it is permanently the most
    // overdue row in its tenant and heads the ranking on every tick for
    // as long as the flag is on - spending a selection slot each time
    // that can never become work. With enough of them in one tenant that
    // is the fairness ordering starving the monitors it was written to
    // protect.
    const actor = await createTestOrg();
    const monitorId = await makeTickMonitor(actor);
    await claimShards(db, `test-${randomUUID()}`, [shardOf(monitorId)]);
    // The plane caches live shards for a second, so a snapshot taken
    // before this lease existed would still be current. Waiting past the
    // TTL is what makes the tick below read the lease rather than
    // whatever an earlier test left cached.
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const boss = tickBoss();
    await runMonitorTick(db, boss, actor.organizationId);

    expect(boss.ids.filter((id) => id === monitorId)).toEqual([]);
    const [row] = await db
      .select({ at: monitors.nextEvaluationAt })
      .from(monitors)
      .where(eq(monitors.id, monitorId));
    expect(row!.at!.getTime()).toBeGreaterThan(Date.now());
  });

  it("still schedules a high-frequency monitor whose plane has died", async () => {
    // The failover the deferral must not cost. The test is on the LEASE,
    // never on the flag: degrading from 500ms to the ordinary cadence is
    // a service level, degrading to silence is an outage nobody sees.
    const actor = await createTestOrg();
    const monitorId = await makeTickMonitor(actor);
    await claimShards(db, `test-${randomUUID()}`, [shardOf(monitorId)]);
    // The plane dies: its lease expires and is never renewed.
    await db
      .update(monitorHfLeases)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(monitorHfLeases.shard, shardOf(monitorId)));
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const boss = tickBoss();
    await runMonitorTick(db, boss, actor.organizationId);

    expect(boss.ids).toContain(monitorId);
  });
});
