import { describe, expect, it } from "vitest";

import {
  CALM_MULTIPLIER,
  CALM_RUN_LENGTH,
  MAX_EVALUATION_MS,
  MIN_EVALUATION_MS,
  nextEvaluationAt,
  SUSPICION_DIVISOR,
  type RecentObservation,
} from "@/modules/monitors/scheduling";

const NOW = new Date("2026-07-26T12:00:00Z");

function clean(count: number): RecentObservation[] {
  return Array.from({ length: count }, () => ({
    ok: true,
    verdict: "up" as const,
  }));
}

function delaySeconds(
  intervalSeconds: number,
  recent: RecentObservation[],
  currentStatus?: "up" | "down" | "degraded" | "unknown",
): number {
  const next = nextEvaluationAt(
    { intervalSeconds, currentStatus },
    recent,
    NOW,
  );
  return (next.getTime() - NOW.getTime()) / 1000;
}

describe("nextEvaluationAt", () => {
  it("returns the baseline for an ordinary healthy monitor", () => {
    expect(delaySeconds(60, clean(3))).toBe(60);
  });

  it("returns the baseline for a monitor with no history at all", () => {
    expect(delaySeconds(60, [])).toBe(60);
  });

  it("tightens when anything recent failed", () => {
    const recent: RecentObservation[] = [
      { ok: true, verdict: "up" },
      { ok: false, verdict: "down" },
      ...clean(5),
    ];
    expect(delaySeconds(60, recent)).toBe(60 / SUSPICION_DIVISOR);
  });

  it("stops tightening once the monitor is already down", () => {
    // Caught by running the real worker: a permanently failing monitor
    // was being re-probed every 3.75s indefinitely. Tightening buys
    // faster detection, and once the verdict is in there is nothing
    // left to detect — the extra requests only land on something
    // already broken.
    const recent: RecentObservation[] = [
      { ok: false, verdict: "down" },
      { ok: false, verdict: "down" },
    ];
    expect(delaySeconds(60, recent)).toBe(60 / SUSPICION_DIVISOR);
    expect(delaySeconds(60, recent, "down")).toBe(60);
  });

  it("still tightens while failing but not yet declared down", () => {
    // This is the window the whole mechanism exists for.
    const recent: RecentObservation[] = [{ ok: false, verdict: "down" }];
    expect(delaySeconds(60, recent, "up")).toBe(60 / SUSPICION_DIVISOR);
  });

  it("relaxes after a long clean run", () => {
    expect(delaySeconds(60, clean(CALM_RUN_LENGTH))).toBe(60 * CALM_MULTIPLIER);
  });

  it("does not relax one observation short of the run", () => {
    expect(delaySeconds(60, clean(CALM_RUN_LENGTH - 1))).toBe(60);
  });

  it("a degraded observation breaks the calm run without tightening", () => {
    const recent: RecentObservation[] = [
      { ok: true, verdict: "degraded" },
      ...clean(CALM_RUN_LENGTH),
    ];
    expect(delaySeconds(60, recent)).toBe(60);
  });

  it("an indeterminate observation neither tightens nor counts as calm", () => {
    // Not knowing is not the same as being fine, and it is not the same
    // as being broken — a missing ICMP capability must not make Vigil
    // hammer a target it cannot probe at all.
    const recent: RecentObservation[] = [
      { ok: false, verdict: "indeterminate" },
      ...clean(CALM_RUN_LENGTH),
    ];
    expect(delaySeconds(60, recent)).toBe(60);
  });

  it("never goes below the floor, however hard it tightens", () => {
    // Below the schema's own minimum interval on purpose: this asserts
    // the clamp, which is what stops a future lower bound (or a harsher
    // divisor) producing a nonsense cadence.
    const recent: RecentObservation[] = [{ ok: false, verdict: "down" }];
    expect(delaySeconds(4, recent) * 1000).toBe(MIN_EVALUATION_MS);
  });

  it("tightens the shortest allowed baseline to 625ms", () => {
    // The tightest cadence actually reachable today, recorded so a
    // change to either bound is a deliberate one. The scheduler cannot
    // deliver it yet — pg-boss polls every couple of seconds — which is
    // why the policy targets the floor rather than the current limit.
    const recent: RecentObservation[] = [{ ok: false, verdict: "down" }];
    expect(delaySeconds(10, recent) * 1000).toBe(625);
  });

  it("never schedules beyond the ceiling, however calm", () => {
    expect(delaySeconds(86_400, clean(CALM_RUN_LENGTH)) * 1000).toBe(
      MAX_EVALUATION_MS,
    );
  });

  it("is pure — same inputs, same answer", () => {
    const recent = clean(4);
    expect(nextEvaluationAt({ intervalSeconds: 60 }, recent, NOW)).toEqual(
      nextEvaluationAt({ intervalSeconds: 60 }, recent, NOW),
    );
  });
});
