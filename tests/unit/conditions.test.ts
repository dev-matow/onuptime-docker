import { describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { Assertion, ProbeResult } from "@/modules/monitors/types/contract";

interface Config {
  limit: number;
  enabled: boolean;
}

const down: Assertion<Config> = {
  id: "over-limit",
  fact: "value",
  severity: "down",
  evaluate: (value, config) =>
    typeof value === "number" && value > config.limit
      ? `value ${value} exceeds ${config.limit}`
      : null,
};

const degraded: Assertion<Config> = {
  id: "slow",
  fact: "latency",
  severity: "degraded",
  evaluate: (value) =>
    typeof value === "number" && value > 100 ? `slow: ${value}ms` : null,
};

const gated: Assertion<Config> = {
  id: "gated",
  fact: "value",
  severity: "down",
  applies: (config) => config.enabled,
  evaluate: () => "always fails when it applies",
};

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    facts: { value: 1, latency: 10 },
    responseTimeMs: 10,
    error: null,
    ...overrides,
  };
}

const config: Config = { limit: 5, enabled: false };

describe("judge", () => {
  it("passes when every assertion holds", () => {
    const verdict = judge([down, degraded], config, probe());
    expect(verdict).toMatchObject({
      verdict: "up",
      ok: true,
      degraded: false,
      failureClass: null,
      error: null,
      failedAssertions: [],
    });
  });

  it("reports degraded as passing, but keeps the reason", () => {
    const verdict = judge(
      [down, degraded],
      config,
      probe({ facts: { value: 1, latency: 500 } }),
    );
    expect(verdict.verdict).toBe("degraded");
    expect(verdict.ok).toBe(true);
    expect(verdict.degraded).toBe(true);
    // Passing, so no failure class — but "why is this amber" must stay
    // answerable.
    expect(verdict.failureClass).toBeNull();
    expect(verdict.error).toBe("slow: 500ms");
    expect(verdict.failedAssertions).toEqual(["slow"]);
  });

  it("a down assertion outranks a degraded one", () => {
    const verdict = judge(
      [down, degraded],
      config,
      probe({ facts: { value: 99, latency: 500 } }),
    );
    expect(verdict.verdict).toBe("down");
    expect(verdict.degraded).toBe(false);
    expect(verdict.error).toBe("value 99 exceeds 5");
    expect(verdict.failureClass).toBe("assertion");
    // Both are recorded; only the more serious one is the headline.
    expect(verdict.failedAssertions).toEqual(["over-limit", "slow"]);
  });

  it("reports the first failure in declaration order", () => {
    const other: Assertion<Config> = { ...down, id: "second" };
    const verdict = judge(
      [down, other],
      config,
      probe({ facts: { value: 99 } }),
    );
    expect(verdict.failedAssertions).toEqual(["over-limit", "second"]);
  });

  it("skips an assertion the operator has not enabled", () => {
    expect(judge([gated], config, probe()).verdict).toBe("up");
    expect(judge([gated], { ...config, enabled: true }, probe()).verdict).toBe(
      "down",
    );
  });

  it("a transport error short-circuits every assertion", () => {
    const verdict = judge(
      [down],
      config,
      probe({ error: "connection refused", facts: { value: 99 } }),
    );
    expect(verdict.verdict).toBe("down");
    expect(verdict.failureClass).toBe("transport");
    expect(verdict.error).toBe("connection refused");
    expect(verdict.failedAssertions).toEqual([]);
  });

  it("an unavailable probe is indeterminate, never down", () => {
    // The rule that matters most: an operator error must not be
    // indistinguishable from an outage.
    const verdict = judge(
      [down],
      config,
      probe({ unavailable: "ICMP is not permitted", facts: { value: 99 } }),
    );
    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.ok).toBe(false);
    expect(verdict.failureClass).toBe("misconfigured");
    expect(verdict.error).toBe("ICMP is not permitted");
  });

  it("unavailable outranks a transport error", () => {
    const verdict = judge(
      [down],
      config,
      probe({ unavailable: "no ping binary", error: "host unreachable" }),
    );
    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.error).toBe("no ping binary");
  });

  it("is a pure function of assertions, config and facts", () => {
    // Re-judging a stored observation must be possible without
    // re-probing — that is what forensic replay is built on.
    const result = probe({ facts: { value: 7, latency: 10 } });
    expect(judge([down], { limit: 5, enabled: false }, result).verdict).toBe(
      "down",
    );
    expect(judge([down], { limit: 10, enabled: false }, result).verdict).toBe(
      "up",
    );
  });
});
