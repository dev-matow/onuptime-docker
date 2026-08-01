import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { monitorChecks, monitors } from "@/db/schema";
import { uptimeByMonitor } from "@/modules/monitors/service";
import {
  coverageHorizonMs,
  uptimeFromSamples,
  type UptimeSample,
} from "@/modules/monitors/uptime";

import { createTestOrg, db } from "../helpers";

/**
 * The SQL and the TypeScript must agree.
 *
 * `uptimeFromSamples` is the readable definition of duration-weighted
 * uptime; `uptimeSegments` is the same rule in SQL so a 90-day status
 * page does not stream a million rows into Node. Two implementations of
 * one rule is exactly the arrangement that drifts, and the drift would
 * be invisible — both sides return a plausible percentage.
 *
 * So they are checked against each other on randomised, deliberately
 * ugly histories: irregular gaps, clustered bursts, samples straddling
 * both window edges, indeterminate rows mixed in, monitors whose
 * intervals give very different coverage horizons.
 */

const DAY_MS = 86_400_000;

interface Planned {
  offsetMs: number;
  ok: boolean;
  indeterminate: boolean;
}

/** Deterministic PRNG — a failing seed has to be reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * A history with the shapes that break naive implementations: a long
 * quiet stretch, a burst of rapid samples, a blackout, and samples
 * outside both window edges.
 */
function planHistory(seed: number, windowMs: number): Planned[] {
  const next = rng(seed);
  const planned: Planned[] = [];
  // Start before the window so the carry-in path is exercised.
  let cursor = -Math.floor(next() * windowMs * 0.3);
  const end = windowMs + Math.floor(next() * windowMs * 0.2);
  while (cursor < end) {
    const roll = next();
    planned.push({
      offsetMs: cursor,
      ok: roll > 0.25,
      // Roughly one in twelve rows measured nothing.
      indeterminate: roll < 0.08,
    });
    const shape = next();
    const stepMs =
      shape < 0.15
        ? // blackout: longer than any horizon
          windowMs * (0.05 + next() * 0.15)
        : shape < 0.5
          ? // burst
            500 + next() * 4_000
          : // ordinary cadence, jittered
            20_000 + next() * 120_000;
    cursor += Math.max(1, Math.floor(stepMs));
  }
  return planned;
}

describe("duration-weighted uptime: SQL and TypeScript agree", () => {
  it.each([60, 300, 900])(
    "matches on randomised histories for a %ss monitor",
    async (intervalSeconds) => {
      const actor = await createTestOrg();
      const windowMs = 3 * DAY_MS;
      const windowEnd = new Date("2026-04-10T00:00:00.000Z");
      const windowStart = new Date(windowEnd.getTime() - windowMs);
      const horizonMs = coverageHorizonMs(intervalSeconds);

      for (let seed = 1; seed <= 12; seed++) {
        const [monitor] = await db
          .insert(monitors)
          .values({
            organizationId: actor.organizationId,
            name: `parity-${intervalSeconds}-${seed}-${randomUUID().slice(0, 6)}`,
            url: "https://parity.example.com/health",
            checkType: "http",
            intervalSeconds,
          })
          .returning();
        if (!monitor) throw new Error("monitor insert returned no row");

        const planned = planHistory(seed * 7919 + intervalSeconds, windowMs);
        await db.insert(monitorChecks).values(
          planned.map((p) => ({
            monitorId: monitor.id,
            checkedAt: new Date(windowStart.getTime() + p.offsetMs),
            ok: p.indeterminate ? false : p.ok,
            verdict: p.indeterminate
              ? "indeterminate"
              : p.ok
                ? "up"
                : ("down" as string),
          })),
        );

        // The TypeScript definition sees exactly the rows the SQL is
        // allowed to see: measured ones.
        const samples: UptimeSample[] = planned
          .filter((p) => !p.indeterminate)
          .map((p) => ({
            at: new Date(windowStart.getTime() + p.offsetMs),
            ok: p.ok,
          }));
        const expected = uptimeFromSamples(
          samples,
          { start: windowStart, end: windowEnd },
          horizonMs,
        );

        const actual = (
          await uptimeByMonitor(db, [monitor.id], windowStart, windowEnd)
        ).get(monitor.id) ?? {
          coveredMs: 0,
          upMs: 0,
          uncoveredMs: windowMs,
          uptimePct: null,
        };

        const context = `interval=${intervalSeconds} seed=${seed} samples=${samples.length}`;
        // Sub-millisecond tolerance: Postgres does the arithmetic in
        // microsecond-resolution intervals, JavaScript in integer
        // milliseconds, so the two can differ in the last place.
        expect(actual.coveredMs, `coveredMs ${context}`).toBeCloseTo(
          expected.coveredMs,
          0,
        );
        expect(actual.upMs, `upMs ${context}`).toBeCloseTo(expected.upMs, 0);
        if (expected.uptimePct === null) {
          expect(actual.uptimePct, `uptimePct ${context}`).toBeNull();
        } else {
          expect(actual.uptimePct, `uptimePct ${context}`).toBeCloseTo(
            expected.uptimePct,
            2,
          );
        }
      }
    },
    120_000,
  );

  it("reports the same number for the same outage sampled two ways", async () => {
    // The end-to-end version of the unit test: the adaptive scheduler's
    // 16x burst around a failure must not change the reported uptime.
    const actor = await createTestOrg();
    const windowEnd = new Date("2026-04-10T00:00:00.000Z");
    const windowStart = new Date(windowEnd.getTime() - 2 * 3_600_000);
    const downFrom = windowStart.getTime() + 3_600_000;
    const downTo = downFrom + 600_000;
    const isUp = (t: number) => t < downFrom || t >= downTo;

    async function seedMonitor(
      name: string,
      stamps: number[],
    ): Promise<string> {
      const [monitor] = await db
        .insert(monitors)
        .values({
          organizationId: actor.organizationId,
          name: `${name}-${randomUUID().slice(0, 6)}`,
          url: "https://parity.example.com/health",
          checkType: "http",
          intervalSeconds: 120,
        })
        .returning();
      if (!monitor) throw new Error("monitor insert returned no row");
      await db.insert(monitorChecks).values(
        stamps.map((t) => ({
          monitorId: monitor.id,
          checkedAt: new Date(t),
          ok: isUp(t),
          verdict: isUp(t) ? "up" : "down",
        })),
      );
      return monitor.id;
    }

    const uniform: number[] = [];
    for (let t = windowStart.getTime(); t < windowEnd.getTime(); t += 60_000) {
      uniform.push(t);
    }
    const adaptive: number[] = [];
    for (let t = windowStart.getTime(); t < windowEnd.getTime();) {
      adaptive.push(t);
      // Baseline while calm; the scheduler's SUSPICION_DIVISOR cadence
      // through the failure and for one interval after it.
      t += isUp(t) && isUp(t + 120_000) ? 120_000 : 120_000 / 16;
    }

    const uniformId = await seedMonitor("uniform", uniform);
    const adaptiveId = await seedMonitor("adaptive", adaptive);

    const results = await uptimeByMonitor(
      db,
      [uniformId, adaptiveId],
      windowStart,
      windowEnd,
    );
    const a = results.get(uniformId)?.uptimePct;
    const b = results.get(adaptiveId)?.uptimePct;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Ten minutes down in two hours: 91.67%. Both, within rounding.
    expect(a!).toBeCloseTo(91.67, 1);
    expect(b!).toBeCloseTo(91.67, 1);
    expect(Math.abs(a! - b!)).toBeLessThan(0.5);
  });

  it("never claims coverage past a sample's horizon", async () => {
    const actor = await createTestOrg();
    const [monitor] = await db
      .insert(monitors)
      .values({
        organizationId: actor.organizationId,
        name: `horizon-${randomUUID().slice(0, 6)}`,
        url: "https://parity.example.com/health",
        checkType: "http",
        intervalSeconds: 60,
      })
      .returning();
    if (!monitor) throw new Error("monitor insert returned no row");

    const windowEnd = new Date("2026-04-10T00:00:00.000Z");
    const windowStart = new Date(windowEnd.getTime() - DAY_MS);
    await db.insert(monitorChecks).values({
      monitorId: monitor.id,
      checkedAt: windowStart,
      ok: true,
      verdict: "up",
    });

    const result = (
      await uptimeByMonitor(db, [monitor.id], windowStart, windowEnd)
    ).get(monitor.id);
    // One sample, then a day of silence: three minutes of green, and
    // twenty-three-and-a-bit hours nobody vouched for.
    expect(result?.coveredMs).toBeCloseTo(coverageHorizonMs(60), 0);
    expect(result?.uptimePct).toBe(100);
    expect(result?.uncoveredMs).toBeGreaterThan(DAY_MS * 0.99 - 180_000);
  });

  it("excludes indeterminate observations from the timeline entirely", async () => {
    const actor = await createTestOrg();
    const [monitor] = await db
      .insert(monitors)
      .values({
        organizationId: actor.organizationId,
        name: `indet-${randomUUID().slice(0, 6)}`,
        url: "https://parity.example.com/health",
        checkType: "ping",
        intervalSeconds: 60,
      })
      .returning();
    if (!monitor) throw new Error("monitor insert returned no row");

    const windowEnd = new Date("2026-04-10T00:00:00.000Z");
    const windowStart = new Date(windowEnd.getTime() - 3_600_000);
    // A worker without CAP_NET_RAW: every row is stored ok=false, but
    // none of them measured anything. This must not read as an outage.
    const rows = [];
    for (let t = windowStart.getTime(); t < windowEnd.getTime(); t += 60_000) {
      rows.push({
        monitorId: monitor.id,
        checkedAt: new Date(t),
        ok: false,
        verdict: "indeterminate",
      });
    }
    await db.insert(monitorChecks).values(rows);

    const result = (
      await uptimeByMonitor(db, [monitor.id], windowStart, windowEnd)
    ).get(monitor.id);
    expect(result).toBeUndefined();
  });

  it("keeps pre-1.10 rows with a NULL verdict in the timeline", async () => {
    // `<>` would be NULL for these and silently drop every row written
    // before 1.10.0 — the whole reason the predicate is `is distinct from`.
    const actor = await createTestOrg();
    const [monitor] = await db
      .insert(monitors)
      .values({
        organizationId: actor.organizationId,
        name: `legacy-${randomUUID().slice(0, 6)}`,
        url: "https://parity.example.com/health",
        checkType: "http",
        intervalSeconds: 60,
      })
      .returning();
    if (!monitor) throw new Error("monitor insert returned no row");

    const windowEnd = new Date("2026-04-10T00:00:00.000Z");
    const windowStart = new Date(windowEnd.getTime() - 600_000);
    await db.execute(sql`
      insert into ${monitorChecks} (monitor_id, checked_at, ok, verdict)
      values
        (${monitor.id}, ${windowStart}, true, null),
        (${monitor.id}, ${new Date(windowStart.getTime() + 300_000)}, false, null)
    `);

    const result = (
      await uptimeByMonitor(db, [monitor.id], windowStart, windowEnd)
    ).get(monitor.id);
    expect(result?.uptimePct).toBe(50);
  });
});
