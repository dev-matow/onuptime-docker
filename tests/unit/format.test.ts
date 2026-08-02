import { describe, expect, it } from "vitest";

import { formatDuration, formatRelativeTime, formatUptime } from "@/lib/format";

describe("formatDuration", () => {
  it("renders sub-second durations in milliseconds", () => {
    expect(formatDuration(900)).toBe("900ms");
  });

  it("renders whole seconds under a minute", () => {
    expect(formatDuration(5000)).toBe("5s");
  });

  it("renders minutes with a seconds remainder", () => {
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("omits the remainder for exact hours", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
  });

  it("renders hours with a minutes remainder", () => {
    expect(formatDuration(5_700_000)).toBe("1h 35m");
  });
});

describe("formatUptime", () => {
  it("renders a dash for missing data", () => {
    expect(formatUptime(null)).toBe("-");
  });

  it("renders two decimal places", () => {
    expect(formatUptime(99.99)).toBe("99.99%");
    expect(formatUptime(100)).toBe("100.00%");
  });

  it("truncates instead of rounding — real downtime never shows as 100%", () => {
    expect(formatUptime(99.995)).toBe("99.99%");
    expect(formatUptime(99.999)).toBe("99.99%");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-07-01T12:00:00Z");

  it("renders a two-hour-old date as '2 hours ago'", () => {
    const date = new Date("2026-07-01T10:00:00Z");
    expect(formatRelativeTime(date, now)).toBe("2 hours ago");
  });

  it("renders anything under a minute as 'just now'", () => {
    const date = new Date("2026-07-01T11:59:30Z");
    expect(formatRelativeTime(date, now)).toBe("just now");
  });

  it("renders a date one day in the future as 'tomorrow'", () => {
    const date = new Date("2026-07-02T12:00:00Z");
    expect(formatRelativeTime(date, now)).toBe("tomorrow");
  });
});
