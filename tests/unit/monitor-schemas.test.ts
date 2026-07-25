import { describe, expect, it } from "vitest";

import {
  createMonitorSchema,
  MONITOR_INTERVALS_SECONDS,
  monitorUrlSchema,
} from "@/modules/monitors/schemas";

const validInput = { name: "API health", url: "https://example.com/health" };

describe("monitorUrlSchema", () => {
  it("rejects localhost URLs", () => {
    expect(monitorUrlSchema.safeParse("http://localhost:3000").success).toBe(
      false,
    );
  });

  it("rejects bare IPv4 URLs", () => {
    expect(monitorUrlSchema.safeParse("https://1.2.3.4/").success).toBe(false);
  });

  it("rejects non-http(s) protocols", () => {
    expect(monitorUrlSchema.safeParse("ftp://example.com").success).toBe(false);
  });

  it("rejects the cloud metadata hostname", () => {
    expect(
      monitorUrlSchema.safeParse("https://metadata.google.internal/").success,
    ).toBe(false);
  });

  it("rejects the cloud metadata IP", () => {
    expect(monitorUrlSchema.safeParse("https://169.254.169.254/").success).toBe(
      false,
    );
  });

  it("accepts a plain https URL with a path", () => {
    expect(
      monitorUrlSchema.safeParse("https://example.com/health").success,
    ).toBe(true);
  });

  it("accepts an http URL with subdomain, port, and path", () => {
    expect(
      monitorUrlSchema.safeParse("http://sub.domain.io:8443/path").success,
    ).toBe(true);
  });
});

describe("createMonitorSchema", () => {
  it("applies defaults for method, interval, timeouts, and thresholds", () => {
    const parsed = createMonitorSchema.parse(validInput);
    expect(parsed).toMatchObject({
      name: "API health",
      url: "https://example.com/health",
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 10_000,
      degradedThresholdMs: 3_000,
      failureThreshold: 3,
    });
  });

  it("normalizes bodyKeyword — null, undefined and empty all become null", () => {
    // The create form sends `null` when no keyword is set; the schema
    // must accept it (a regression that once broke monitor creation).
    for (const value of [null, undefined, "", "   "]) {
      const parsed = createMonitorSchema.parse({
        ...validInput,
        bodyKeyword: value,
      });
      expect(parsed.bodyKeyword).toBeNull();
    }
    const withKeyword = createMonitorSchema.parse({
      ...validInput,
      bodyKeyword: "  healthy  ",
      keywordAbsent: true,
    });
    expect(withKeyword.bodyKeyword).toBe("healthy");
    expect(withKeyword.keywordAbsent).toBe(true);
    // Absent by default.
    expect(createMonitorSchema.parse(validInput).keywordAbsent).toBe(false);
  });

  it("requires a valid URL", () => {
    const base = {
      name: "API",
      intervalSeconds: 60,
    };
    expect(
      createMonitorSchema.safeParse({ ...base, url: "https://ok.example.com" })
        .success,
    ).toBe(true);
    expect(
      createMonitorSchema.safeParse({ ...base, url: "not-a-url" }).success,
    ).toBe(false);
    expect(
      createMonitorSchema.safeParse({ ...base, url: "http://localhost" })
        .success,
    ).toBe(false);
  });

  it("accepts every supported check interval", () => {
    expect(MONITOR_INTERVALS_SECONDS).toEqual([60, 120, 300, 600, 1800, 3600]);
    for (const intervalSeconds of MONITOR_INTERVALS_SECONDS) {
      const result = createMonitorSchema.safeParse({
        ...validInput,
        intervalSeconds,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an interval outside the supported set", () => {
    const result = createMonitorSchema.safeParse({
      ...validInput,
      intervalSeconds: 61,
    });
    expect(result.success).toBe(false);
  });

  it("requires a non-empty name", () => {
    expect(createMonitorSchema.safeParse({ url: validInput.url }).success).toBe(
      false,
    );
    expect(
      createMonitorSchema.safeParse({ ...validInput, name: "" }).success,
    ).toBe(false);
    expect(
      createMonitorSchema.safeParse({ ...validInput, name: "   " }).success,
    ).toBe(false);
  });

  it("trims surrounding whitespace from the name", () => {
    const parsed = createMonitorSchema.parse({
      ...validInput,
      name: "  My Monitor  ",
    });
    expect(parsed.name).toBe("My Monitor");
  });

  it("accepts failureThreshold at the 1..10 bounds", () => {
    expect(
      createMonitorSchema.safeParse({ ...validInput, failureThreshold: 1 })
        .success,
    ).toBe(true);
    expect(
      createMonitorSchema.safeParse({ ...validInput, failureThreshold: 10 })
        .success,
    ).toBe(true);
  });

  it("rejects failureThreshold outside 1..10", () => {
    expect(
      createMonitorSchema.safeParse({ ...validInput, failureThreshold: 0 })
        .success,
    ).toBe(false);
    expect(
      createMonitorSchema.safeParse({ ...validInput, failureThreshold: 11 })
        .success,
    ).toBe(false);
  });
});
