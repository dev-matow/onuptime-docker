import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkRateLimit,
  rateLimitKeyCount,
  resetRateLimits,
} from "@/lib/rate-limit";

// The limiter keeps per-key state in module scope; each test uses its
// own key so tests in this file cannot interfere with one another.

describe("checkRateLimit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to the limit within the window", () => {
    const options = { limit: 3, windowMs: 60_000 };
    expect(checkRateLimit("unit:up-to-limit", options)).toBe(true);
    expect(checkRateLimit("unit:up-to-limit", options)).toBe(true);
    expect(checkRateLimit("unit:up-to-limit", options)).toBe(true);
  });

  it("blocks the request that exceeds the limit", () => {
    const options = { limit: 2, windowMs: 60_000 };
    expect(checkRateLimit("unit:over-limit", options)).toBe(true);
    expect(checkRateLimit("unit:over-limit", options)).toBe(true);
    expect(checkRateLimit("unit:over-limit", options)).toBe(false);
    expect(checkRateLimit("unit:over-limit", options)).toBe(false);
  });

  it("tracks separate keys independently", () => {
    const options = { limit: 1, windowMs: 60_000 };
    expect(checkRateLimit("unit:key-a", options)).toBe(true);
    expect(checkRateLimit("unit:key-a", options)).toBe(false);
    expect(checkRateLimit("unit:key-b", options)).toBe(true);
  });

  it("allows requests again once the window has elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    const options = { limit: 2, windowMs: 60_000 };

    expect(checkRateLimit("unit:expiry", options)).toBe(true);
    expect(checkRateLimit("unit:expiry", options)).toBe(true);
    expect(checkRateLimit("unit:expiry", options)).toBe(false);

    // Just before expiry the hits are still inside the window.
    vi.setSystemTime(new Date("2026-07-01T00:00:59.999Z"));
    expect(checkRateLimit("unit:expiry", options)).toBe(false);

    // Past the window both original hits fall out.
    vi.setSystemTime(new Date("2026-07-01T00:01:00.001Z"));
    expect(checkRateLimit("unit:expiry", options)).toBe(true);
    expect(checkRateLimit("unit:expiry", options)).toBe(true);
    expect(checkRateLimit("unit:expiry", options)).toBe(false);
  });

  it("does not retain a key for every value an attacker tries", () => {
    // The keys here are chosen by the caller: `push:<token>` from an
    // unauthenticated route, `sp-subscribe:<email>`, a status-page slug.
    // Nothing evicted them, so guessing tokens grew the map forever —
    // half a million keys measured at 132 MB, and every behavioural test
    // above still passed, because the limiting itself was never wrong.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    resetRateLimits();

    const options = { limit: 1, windowMs: 60_000 };
    for (let i = 0; i < 40_000; i += 1) {
      checkRateLimit(`unit:flood-${i}`, options);
    }
    const atPeak = rateLimitKeyCount();
    expect(atPeak).toBeLessThanOrEqual(20_000);

    // And an expired backlog is released rather than merely capped: once
    // the windows lapse, ordinary traffic sweeps them out, so a quiet
    // process does not sit on twenty thousand dead keys forever.
    vi.setSystemTime(new Date("2026-07-01T00:02:00Z"));
    for (let i = 0; i < 1_000; i += 1) {
      checkRateLimit(`unit:after-${i}`, options);
    }
    expect(rateLimitKeyCount()).toBeLessThan(2_000);

    resetRateLimits();
  });

  it("does not count blocked attempts against the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    const options = { limit: 1, windowMs: 60_000 };

    expect(checkRateLimit("unit:no-penalty", options)).toBe(true);
    // Repeated blocked attempts must not extend the window.
    expect(checkRateLimit("unit:no-penalty", options)).toBe(false);
    vi.setSystemTime(new Date("2026-07-01T00:00:30Z"));
    expect(checkRateLimit("unit:no-penalty", options)).toBe(false);

    vi.setSystemTime(new Date("2026-07-01T00:01:00.001Z"));
    expect(checkRateLimit("unit:no-penalty", options)).toBe(true);
  });
});
