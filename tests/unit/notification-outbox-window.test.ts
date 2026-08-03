import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

import {
  backoffMs,
  backoffSchedule,
  retryPolicy,
} from "@/modules/notifications/outbox";

/**
 * The retry schedule, pinned to arithmetic rather than to a sentence.
 *
 * The version of this file that shipped with 1.17.0 asserted the window
 * was 31 to 62 seconds - which was true, and was the bug. It existed
 * because three published pages had claimed half an hour for two
 * releases while the code retried for a minute, and nothing anywhere
 * compared the two.
 *
 * 1.18.0 makes the schedule what those pages said it was. The test
 * stays, aimed at the new numbers, because the failure it guards
 * against is not a wrong constant - it is a number that lives only in
 * prose.
 */

/** The waits `recordOutcome` schedules, at both jitter bounds. */
function retryWindowMs(): { min: number; max: number } {
  const { maxAttempts } = retryPolicy();
  let min = 0;
  let max = 0;
  // `recordOutcome` schedules a wait after each attempt except the
  // last, which ends the chain instead.
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    min += backoffMs(attempt, () => 0);
    max += backoffMs(attempt, () => 1);
  }
  return { min, max };
}

describe("the retry schedule", () => {
  it("doubles to a half-hour ceiling", () => {
    // No jitter, so this is the published curve itself.
    expect(backoffSchedule(12).map((ms) => ms / 1_000)).toEqual([
      2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 1800, 1800,
    ]);
  });

  it("jitters by a quarter either way, never more", () => {
    for (let attempt = 1; attempt <= 14; attempt++) {
      const base = backoffSchedule(attempt)[attempt - 1]!;
      expect(backoffMs(attempt, () => 0)).toBe(Math.round(base * 0.75));
      expect(backoffMs(attempt, () => 1)).toBe(Math.round(base * 1.25));
    }
  });

  it("spans hours, not the minute it used to", () => {
    const { min, max } = retryWindowMs();
    // The regression this file was created for: 62 seconds.
    expect(min).toBeGreaterThan(3 * 60 * 60 * 1_000);
    expect(max).toBeLessThan(8 * 60 * 60 * 1_000);
  });

  it("reaches its ceiling inside the attempt budget", () => {
    // A ceiling the schedule never reaches is a constant pretending to
    // be a policy. At twenty attempts the curve sits on it for nine.
    const { maxAttempts } = retryPolicy();
    const waits = backoffSchedule(maxAttempts - 1);
    expect(waits.filter((ms) => ms === 1_800_000).length).toBeGreaterThan(5);
  });

  it("is published as a table matching the code", () => {
    // The failure this guards is not a wrong constant - it is a number
    // that lives only in prose. Every wait in the published table is
    // read back out of the page and compared to the function.
    const docs = readFileSync(join(ROOT, "docs/NOTIFICATIONS.md"), "utf8");
    // The table lists the wait BEFORE each attempt, so attempt N+1
    // carries schedule entry N. The first six are in seconds.
    backoffSchedule(6).forEach((ms, index) => {
      const seconds = ms / 1_000;
      const row = new RegExp(
        `\\|\\s*${index + 2}\\s*\\|\\s*${seconds} s\\s*\\|`,
      );
      expect(docs, `the schedule table's row for attempt ${index + 2}`).toMatch(
        row,
      );
    });
    // And the ceiling, which is where the curve spends most of its
    // attempts and the reason the horizon is reachable at all.
    expect(docs).toMatch(/\|\s*12-20\s*\|\s*30 min each\s*\|/);
    // And the limitation this release removes must be described as
    // past, not present.
    expect(docs).toContain("Until 1.18.0 this was six attempts");
  });

  it("fits inside the default horizon, so both bounds are reachable", () => {
    // Two controls that can never both bind are one control and a
    // decoration. The attempt budget must run out inside the horizon
    // for a fast-failing provider, and the horizon must be able to
    // arrive first for an unreachable one.
    const { min } = retryWindowMs();
    const { horizonHours } = retryPolicy();
    expect(min).toBeLessThan(horizonHours * 60 * 60 * 1_000);
  });
});
