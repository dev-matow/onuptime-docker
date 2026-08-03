import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { backoffMs, MAX_ATTEMPTS } from "@/modules/notifications/outbox";

/**
 * The retry window, pinned to arithmetic rather than to a sentence.
 *
 * The code comment said "a little under half an hour" and the docs said
 * "a five-minute cap" and "retrying a rejected address for half an
 * hour". The real window is 31 to 62 seconds, so three published
 * statements were wrong by a factor of thirty, and nothing anywhere
 * would have noticed - the number lived only in prose.
 *
 * It lives here now. If someone widens the window on purpose, these
 * fail and the docs have to move with them, which is the point.
 */

const ROOT = process.cwd();

/** The waits `recordOutcome` actually schedules, at both jitter bounds. */
function retryWindowMs(): { min: number; max: number } {
  let min = 0;
  let max = 0;
  // `recordOutcome` computes backoffMs(row.attempts + 1) and gives up
  // once attempts reach MAX_ATTEMPTS, so the waits are for 1..MAX-1.
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    min += backoffMs(attempt, () => 0);
    max += backoffMs(attempt, () => 1);
  }
  return { min, max };
}

describe("the retry window", () => {
  it("is 31 to 62 seconds, not the half hour the comments used to claim", () => {
    const { min, max } = retryWindowMs();
    expect(min).toBe(31_000);
    expect(max).toBe(62_000);
  });

  it("never reaches the five-minute cap at this attempt count", () => {
    // The cap is real code and it is unreachable, which is worth
    // knowing: raising MAX_ATTEMPTS is what would make it bind.
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      expect(backoffMs(attempt, () => 1)).toBeLessThan(300_000);
    }
    expect(backoffMs(9, () => 1)).toBe(300_000);
  });

  it("is stated in seconds on the page that publishes it", () => {
    const docs = readFileSync(join(ROOT, "docs/NOTIFICATIONS.md"), "utf8");
    const { min, max } = retryWindowMs();
    expect(docs).toContain(
      `total retry window of ${min / 1_000} to ${max / 1_000}\nseconds`,
    );
    // And the claim it replaced must not come back.
    expect(docs).not.toContain("half an hour");
    expect(docs).not.toContain("five-minute cap");
  });
});
