import { describe, expect, it } from "vitest";

import {
  coverageHorizonMs,
  uptimeFromSamples,
  type UptimeSample,
} from "@/modules/monitors/uptime";

/**
 * The semantics of duration-weighted uptime, pinned.
 *
 * The headline case is the first one: the same real outage, sampled at
 * two very different densities, has to produce the same number. That is
 * the property the count-based version could not hold, and it is the
 * whole reason this module exists.
 */

const T0 = new Date("2026-03-01T00:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const window = (fromMin: number, toMin: number) => ({
  start: at(fromMin),
  end: at(toMin),
});

/** Evenly spaced samples, `ok` decided per-minute by the predicate. */
function evenly(
  fromMin: number,
  toMin: number,
  stepMin: number,
  ok: (minute: number) => boolean,
): UptimeSample[] {
  const samples: UptimeSample[] = [];
  for (let m = fromMin; m < toMin; m += stepMin) {
    samples.push({ at: at(m), ok: ok(m) });
  }
  return samples;
}

describe("uptimeFromSamples", () => {
  const HOUR = 60;

  it("reports the same uptime for the same outage at different sample rates", () => {
    // Ten minutes down inside a two-hour window: 10/120 = 8.33% down.
    const isUp = (minute: number) => minute < 60 || minute >= 70;

    // What the scheduler actually does: baseline while calm, sixteen
    // times as often once something looks wrong. The count-weighted
    // ratio saw 16x as many rows from the bad ten minutes and reported
    // the outage as far larger than it was.
    const adaptive: UptimeSample[] = [
      ...evenly(0, 60, 2, isUp),
      ...evenly(60, 70, 0.125, isUp),
      ...evenly(70, 120, 2, isUp),
    ];
    const uniform = evenly(0, 120, 1, isUp);

    const horizon = coverageHorizonMs(120);
    const a = uptimeFromSamples(adaptive, window(0, 120), horizon);
    const u = uptimeFromSamples(uniform, window(0, 120), horizon);

    expect(a.uptimePct).toBeCloseTo(91.67, 1);
    expect(u.uptimePct).toBeCloseTo(91.67, 1);
    expect(a.uptimePct).toBeCloseTo(u.uptimePct!, 5);
  });

  it("weights by duration, not by how many rows agree", () => {
    // One down sample standing for 30 minutes, three up samples standing
    // for 10 minutes each. By row count that is 75% up; by duration it
    // is 50%.
    const samples: UptimeSample[] = [
      { at: at(0), ok: false },
      { at: at(30), ok: true },
      { at: at(40), ok: true },
      { at: at(50), ok: true },
    ];
    const result = uptimeFromSamples(samples, window(0, 60), 60 * 60_000);
    expect(result.uptimePct).toBe(50);
    expect(result.upMs).toBe(30 * 60_000);
    expect(result.coveredMs).toBe(60 * 60_000);
  });

  it("clips the leading segment to the window start", () => {
    // A sample from before the window still establishes the state at the
    // window's opening instant — but only the part inside counts.
    const samples: UptimeSample[] = [
      { at: at(-20), ok: false },
      { at: at(10), ok: true },
    ];
    const result = uptimeFromSamples(samples, window(0, 20), 60 * 60_000);
    expect(result.coveredMs).toBe(20 * 60_000);
    expect(result.upMs).toBe(10 * 60_000);
    expect(result.uptimePct).toBe(50);
  });

  it("clips the trailing segment to the window end", () => {
    const samples: UptimeSample[] = [{ at: at(0), ok: true }];
    const result = uptimeFromSamples(samples, window(0, 20), 60 * 60_000);
    expect(result.coveredMs).toBe(20 * 60_000);
    expect(result.uncoveredMs).toBe(0);
  });

  it("stops trusting a sample after its coverage horizon", () => {
    // One sample, then nothing for a day. It vouches for its horizon and
    // not one millisecond more — the rest is uncovered, not green.
    const horizon = coverageHorizonMs(60); // 180s
    const samples: UptimeSample[] = [{ at: at(0), ok: true }];
    const result = uptimeFromSamples(samples, window(0, 24 * HOUR), horizon);
    expect(result.coveredMs).toBe(horizon);
    expect(result.upMs).toBe(horizon);
    expect(result.uptimePct).toBe(100);
    expect(result.uncoveredMs).toBe(24 * HOUR * 60_000 - horizon);
  });

  it("treats a long gap as uncovered on both sides", () => {
    const horizon = coverageHorizonMs(60); // 180s = 3 min
    const samples: UptimeSample[] = [
      { at: at(0), ok: true },
      { at: at(60), ok: true },
    ];
    const result = uptimeFromSamples(samples, window(0, 63), horizon);
    // 3 minutes from each sample, 57 minutes of gap nobody vouched for.
    expect(result.coveredMs).toBe(6 * 60_000);
    expect(result.uncoveredMs).toBe(57 * 60_000);
    expect(result.uptimePct).toBe(100);
  });

  it("returns null rather than 0% when nothing is covered", () => {
    const result = uptimeFromSamples([], window(0, 60), coverageHorizonMs(60));
    expect(result.uptimePct).toBeNull();
    expect(result.coveredMs).toBe(0);
    expect(result.uncoveredMs).toBe(60 * 60_000);
  });

  it("reports a paused stretch as uncovered, not as up and not as down", () => {
    // Pausing writes no checks, so a pause is exactly an absence of
    // evidence. It needs no pause-history table to be honest about.
    const horizon = coverageHorizonMs(60);
    const samples: UptimeSample[] = [
      ...evenly(0, 30, 1, () => true),
      // …paused for half an hour…
      ...evenly(60, 90, 1, () => true),
    ];
    const result = uptimeFromSamples(samples, window(0, 90), horizon);
    expect(result.uptimePct).toBe(100);
    expect(result.uncoveredMs).toBeGreaterThan(25 * 60_000);
  });

  it("counts a first sample from its own timestamp, not from the window", () => {
    // A monitor created mid-window has no evidence about the time before
    // it existed, and must not be charged for it.
    const samples: UptimeSample[] = [{ at: at(45), ok: false }];
    const result = uptimeFromSamples(samples, window(0, 60), 60 * 60_000);
    expect(result.coveredMs).toBe(15 * 60_000);
    expect(result.upMs).toBe(0);
    expect(result.uptimePct).toBe(0);
    expect(result.uncoveredMs).toBe(45 * 60_000);
  });

  it("ignores samples whose horizon expires before the window opens", () => {
    const horizon = coverageHorizonMs(60); // 3 min
    const samples: UptimeSample[] = [{ at: at(-30), ok: false }];
    const result = uptimeFromSamples(samples, window(0, 60), horizon);
    expect(result.coveredMs).toBe(0);
    expect(result.uptimePct).toBeNull();
  });

  it("is order-independent", () => {
    const shuffled: UptimeSample[] = [
      { at: at(40), ok: true },
      { at: at(0), ok: false },
      { at: at(20), ok: true },
    ];
    const sorted = [...shuffled].sort(
      (a, b) => a.at.getTime() - b.at.getTime(),
    );
    const horizon = 60 * 60_000;
    expect(uptimeFromSamples(shuffled, window(0, 60), horizon)).toEqual(
      uptimeFromSamples(sorted, window(0, 60), horizon),
    );
  });

  it("returns nothing for an empty window", () => {
    const result = uptimeFromSamples(
      [{ at: at(0), ok: true }],
      window(10, 10),
      60_000,
    );
    expect(result.uptimePct).toBeNull();
    expect(result.coveredMs).toBe(0);
  });

  it("never reports covered time it did not observe", () => {
    // Property: coveredMs + uncoveredMs is exactly the window, and
    // upMs never exceeds coveredMs — for any sampling pattern.
    for (let seed = 0; seed < 200; seed++) {
      const samples: UptimeSample[] = [];
      let cursor = -40 + (seed % 37);
      let step = seed;
      while (cursor < 130) {
        samples.push({ at: at(cursor), ok: (seed + step) % 3 !== 0 });
        // Deliberately jittered spacing, and deliberately always
        // forward: `%` in JS keeps the sign of its left operand, so a
        // step derived from a negative cursor can be negative.
        step = (step * 31 + 17) % 1013;
        cursor += 1 + (step % 23);
      }
      const horizon = coverageHorizonMs(30 + (seed % 90));
      const result = uptimeFromSamples(samples, window(0, 120), horizon);
      expect(result.coveredMs + result.uncoveredMs).toBe(120 * 60_000);
      expect(result.upMs).toBeLessThanOrEqual(result.coveredMs);
      expect(result.coveredMs).toBeGreaterThanOrEqual(0);
      expect(result.uncoveredMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("coverageHorizonMs", () => {
  it("is three intervals", () => {
    expect(coverageHorizonMs(60)).toBe(180_000);
    expect(coverageHorizonMs(300)).toBe(900_000);
  });

  it("never drops below a minute", () => {
    // Otherwise an ordinary worker redeploy would punch an outage-shaped
    // hole in a fast monitor's coverage.
    expect(coverageHorizonMs(2)).toBe(60_000);
    expect(coverageHorizonMs(1)).toBe(60_000);
  });
});
