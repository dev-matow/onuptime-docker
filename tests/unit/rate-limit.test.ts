import { afterEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/rate-limit";

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
