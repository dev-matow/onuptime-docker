import { describe, expect, it } from "vitest";

import {
  createMonitorSchema,
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  monitorUrlSchema,
} from "@/modules/monitors/schemas";
import { monitorDomainSchema } from "@/modules/monitors/types/targets";

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
      failureWindowSeconds: 120,
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

  it("validates a tcp monitor: hostname + port required, no scheme", () => {
    const tcp = {
      name: "Postgres",
      checkType: "tcp" as const,
      url: "db.example.com",
      port: 5432,
      intervalSeconds: 60,
    };
    expect(createMonitorSchema.safeParse(tcp).success).toBe(true);
    // Missing port.
    expect(
      createMonitorSchema.safeParse({ ...tcp, port: undefined }).success,
    ).toBe(false);
    // A URL (scheme) is not a hostname.
    expect(
      createMonitorSchema.safeParse({ ...tcp, url: "https://db.example.com" })
        .success,
    ).toBe(false);
    // Metadata host is forbidden.
    expect(
      createMonitorSchema.safeParse({ ...tcp, url: "metadata.google.internal" })
        .success,
    ).toBe(false);
  });

  it("still requires a valid URL for http monitors", () => {
    const base = {
      name: "API",
      checkType: "http" as const,
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

  it("accepts any interval inside the bounds, not just a fixed ladder", () => {
    // The six-value ladder is gone: the interval is a baseline the
    // scheduler adapts around, so an operator must be able to say 45.
    for (const intervalSeconds of [
      MIN_INTERVAL_SECONDS,
      45,
      61,
      900,
      MAX_INTERVAL_SECONDS,
    ]) {
      const result = createMonitorSchema.safeParse({
        ...validInput,
        intervalSeconds,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an interval outside the bounds", () => {
    expect(
      createMonitorSchema.safeParse({
        ...validInput,
        intervalSeconds: MIN_INTERVAL_SECONDS - 1,
      }).success,
    ).toBe(false);
    expect(
      createMonitorSchema.safeParse({
        ...validInput,
        intervalSeconds: MAX_INTERVAL_SECONDS + 1,
      }).success,
    ).toBe(false);
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

  it("accepts failureWindowSeconds at its bounds, including zero", () => {
    expect(
      createMonitorSchema.safeParse({ ...validInput, failureWindowSeconds: 0 })
        .success,
    ).toBe(true);
    expect(
      createMonitorSchema.safeParse({
        ...validInput,
        failureWindowSeconds: 86_400,
      }).success,
    ).toBe(true);
  });

  it("rejects a failureWindowSeconds outside its bounds", () => {
    expect(
      createMonitorSchema.safeParse({ ...validInput, failureWindowSeconds: -1 })
        .success,
    ).toBe(false);
    expect(
      createMonitorSchema.safeParse({
        ...validInput,
        failureWindowSeconds: 86_401,
      }).success,
    ).toBe(false);
  });
});

describe("monitorDomainSchema", () => {
  const ok = (value: string) => monitorDomainSchema.safeParse(value).success;

  it("accepts a registrable domain under a single-label suffix", () => {
    expect(ok("example.com")).toBe(true);
    expect(ok("denic.de")).toBe(true);
    expect(ok("vigil-uptime.com")).toBe(true);
  });

  it("accepts a registrable domain under a two-level public suffix", () => {
    // Rejected outright before 1.10.1, while every other check type
    // accepted the same hosts and RDAP resolves them fine.
    expect(ok("bbc.co.uk")).toBe(true);
    expect(ok("company.com.au")).toBe(true);
    expect(ok("example.co.jp")).toBe(true);
    expect(ok("kernel.org.nz")).toBe(true);
  });

  it("rejects a subdomain, whichever suffix it sits under", () => {
    // The reason this is a table and not a relaxed label count: a
    // three-label rule would pass this, 404 at the registry, and page.
    expect(ok("status.example.com")).toBe(false);
    expect(ok("www.bbc.co.uk")).toBe(false);
    expect(ok("a.b.company.com.au")).toBe(false);
  });

  it("rejects a bare public suffix, which nobody can register", () => {
    expect(ok("gov.uk")).toBe(false);
    expect(ok("co.uk")).toBe(false);
    expect(ok("com")).toBe(false);
  });

  it("still refuses the metadata endpoints and malformed input", () => {
    expect(ok("metadata.google.internal")).toBe(false);
    expect(ok("169.254.169.254")).toBe(false);
    expect(ok("https://example.com")).toBe(false);
    expect(ok("example.com:443")).toBe(false);
    expect(ok("-bad.com")).toBe(false);
  });
});
