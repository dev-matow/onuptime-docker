// @covers-type: dns
import { describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import {
  describeDnsError,
  dnsProbe,
  type DnsResolver,
} from "@/modules/monitors/types/probes/dns";
import { dnsSpec, type DnsConfig } from "@/modules/monitors/types/specs/dns";

import { publicLookup } from "../probe-lookup";

function context(config: Partial<DnsConfig> = {}): ProbeContext<DnsConfig> {
  return {
    target: "example.com",
    port: null,
    config: {
      recordType: "A",
      expectedValue: null,
      degradedThresholdMs: 3_000,
      ...config,
    },
    timeoutMs: 5_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
    lookup: publicLookup,
  };
}

function resolver(overrides: Partial<DnsResolver> = {}): () => DnsResolver {
  const reject = () => Promise.reject(new Error("not stubbed"));
  return () => ({
    resolve4: reject,
    resolve6: reject,
    resolveCname: reject,
    resolveNs: reject,
    resolveMx: reject,
    resolveTxt: reject,
    ...overrides,
  });
}

function failWith(code: string): () => DnsResolver {
  const error = Object.assign(new Error(code), { code });
  return resolver({ resolve4: () => Promise.reject(error) });
}

describe("dnsProbe", () => {
  it("emits the records it resolved", async () => {
    const result = await dnsProbe(
      context(),
      resolver({ resolve4: async () => ["93.184.216.34"] }),
    );
    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      records: ["93.184.216.34"],
      recordCount: 1,
    });
    expect(judge(dnsSpec.assertions, context().config, result).verdict).toBe(
      "up",
    );
  });

  it("sorts MX records by priority and renders them readably", async () => {
    const result = await dnsProbe(
      context({ recordType: "MX" }),
      resolver({
        resolveMx: async () => [
          { priority: 20, exchange: "backup.example.com" },
          { priority: 10, exchange: "primary.example.com" },
        ],
      }),
    );
    expect(result.facts.records).toEqual([
      "10 primary.example.com",
      "20 backup.example.com",
    ]);
  });

  it("rejoins the chunks of a long TXT record", async () => {
    // SPF and DKIM values are split at 255 bytes on the wire; comparing
    // against a chunk instead of the whole value is how an "expected
    // value" assertion silently stops matching.
    const result = await dnsProbe(
      context({ recordType: "TXT" }),
      resolver({
        resolveTxt: async () => [["v=spf1 ", "include:_spf.example.com ~all"]],
      }),
    );
    expect(result.facts.records).toEqual([
      "v=spf1 include:_spf.example.com ~all",
    ]);
  });

  it("treats NODATA and NXDOMAIN as an answer of zero records", async () => {
    // The nameserver replied and said "nothing here". That is a
    // measurement the `resolves` assertion judges, not a failure to
    // measure — so the operator gets "No A records", not a raw errno.
    for (const code of ["ENODATA", "ENOTFOUND"]) {
      const result = await dnsProbe(context(), failWith(code));
      expect(result.error).toBeNull();
      expect(result.facts.recordCount).toBe(0);

      const verdict = judge(dnsSpec.assertions, context().config, result);
      expect(verdict.verdict).toBe("down");
      expect(verdict.failureClass).toBe("assertion");
      expect(verdict.error).toBe("No A records");
    }
  });

  it("treats a nameserver failure as a transport error", async () => {
    const result = await dnsProbe(context(), failWith("ESERVFAIL"));
    expect(result.error).toBe("The nameserver returned SERVFAIL");
    expect(
      judge(dnsSpec.assertions, context().config, result).failureClass,
    ).toBe("transport");
  });

  it("passes when a record contains the expected value", async () => {
    const config = context({ expectedValue: "93.184" }).config;
    const result = await dnsProbe(
      context({ expectedValue: "93.184" }),
      resolver({ resolve4: async () => ["93.184.216.34"] }),
    );
    expect(judge(dnsSpec.assertions, config, result).verdict).toBe("up");
  });

  it("fails when no record contains the expected value", async () => {
    const config = context({ expectedValue: "10.0.0" }).config;
    const result = await dnsProbe(
      context({ expectedValue: "10.0.0" }),
      resolver({ resolve4: async () => ["93.184.216.34"] }),
    );
    const verdict = judge(dnsSpec.assertions, config, result);
    expect(verdict.verdict).toBe("down");
    expect(verdict.error).toBe('No A record contains "10.0.0"');
  });

  it("skips the value assertion when no value was configured", async () => {
    const result = await dnsProbe(
      context(),
      resolver({ resolve4: async () => ["anything"] }),
    );
    expect(
      judge(dnsSpec.assertions, context().config, result).failedAssertions,
    ).toEqual([]);
  });
});

describe("describeDnsError", () => {
  it("translates the errnos an operator will actually see", () => {
    expect(describeDnsError("ETIMEOUT", new Error("x"))).toMatch(/in time/);
    expect(describeDnsError("ECONNREFUSED", new Error("x"))).toMatch(/refused/);
  });

  it("falls back to the underlying message", () => {
    expect(describeDnsError(undefined, new Error("something odd"))).toBe(
      "something odd",
    );
  });
});

describe("dns spec", () => {
  it("describes its target with the record type, so alerts are unambiguous", () => {
    const config = dnsSpec.fromRow({
      checkType: "dns",
      url: "example.com",
      port: null,
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 10_000,
      degradedThresholdMs: 3_000,
      expectedStatusCode: null,
      bodyKeyword: null,
      keywordAbsent: false,
      tlsCheck: false,
      tlsWarnDays: 14,
      config: { recordType: "MX", expectedValue: null },
    });
    expect(dnsSpec.describeTarget("example.com", null, config)).toBe(
      "MX example.com",
    );
  });
});
