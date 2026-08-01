// @covers-type: tls-expiry, domain-expiry
import { describe, expect, it, vi } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import { domainExpiryProbe } from "@/modules/monitors/types/probes/domain-expiry";
import { certificateResult } from "@/modules/monitors/types/probes/tls-expiry";
import {
  domainExpirySpec,
  type DomainExpiryConfig,
} from "@/modules/monitors/types/specs/domain-expiry";
import { tlsExpirySpec } from "@/modules/monitors/types/specs/tls-expiry";

import { publicLookup } from "../probe-lookup";

const NOW = Date.parse("2026-07-26T00:00:00Z");
const config = { warnDays: 14, degradedThresholdMs: 3_000 };

function daysFromNow(days: number): string {
  return new Date(NOW + days * 86_400_000).toUTCString();
}

describe("certificateResult", () => {
  it("emits days remaining, issuer and expiry", () => {
    const result = certificateResult(
      { valid_to: daysFromNow(90), issuer: { O: "Let's Encrypt" } },
      12,
      NOW,
    );
    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      daysRemaining: 90,
      issuer: "Let's Encrypt",
    });
  });

  it("takes the first component of a repeated DN attribute", () => {
    const result = certificateResult(
      { valid_to: daysFromNow(1), issuer: { O: ["First CA", "Second"] } },
      1,
      NOW,
    );
    expect(result.facts.issuer).toBe("First CA");
  });

  it("falls back to the common name when there is no organisation", () => {
    const result = certificateResult(
      { valid_to: daysFromNow(1), issuer: { CN: "Internal CA" } },
      1,
      NOW,
    );
    expect(result.facts.issuer).toBe("Internal CA");
  });

  it("reports a missing certificate as a transport failure", () => {
    // Here the certificate IS the observation, so being unable to read
    // one is a failure to measure — unlike the best-effort reading
    // folded into an http check, which stays silent.
    expect(certificateResult(null, 5, NOW).error).toMatch(/no certificate/);
    expect(certificateResult({}, 5, NOW).error).toMatch(/no certificate/);
  });

  it("reports an unparseable expiry rather than guessing", () => {
    expect(certificateResult({ valid_to: "not a date" }, 5, NOW).error).toMatch(
      /Unreadable certificate expiry/,
    );
  });
});

describe("tls-expiry assertions", () => {
  const judgeDays = (daysRemaining: number, warnDays = 14) =>
    judge(
      tlsExpirySpec.assertions,
      { warnDays, degradedThresholdMs: 3_000 },
      {
        facts: { daysRemaining, responseTimeMs: 10 },
        responseTimeMs: 10,
        error: null,
      },
    );

  it("passes comfortably ahead of expiry", () => {
    expect(judgeDays(90).verdict).toBe("up");
  });

  it("warns as degraded inside the warning window", () => {
    const verdict = judgeDays(3);
    expect(verdict.verdict).toBe("degraded");
    expect(verdict.error).toBe("The certificate expires in 3 days");
  });

  it("uses a singular day", () => {
    expect(judgeDays(1).error).toBe("The certificate expires in 1 day");
  });

  it("treats expiry day itself as an outage, not a warning", () => {
    const verdict = judgeDays(0);
    expect(verdict.verdict).toBe("down");
    expect(verdict.error).toBe("The certificate expires today");
  });

  it("reports an already-expired certificate as down", () => {
    const verdict = judgeDays(-5);
    expect(verdict.verdict).toBe("down");
    expect(verdict.error).toBe("The certificate expired 5 days ago");
  });
});

const RDAP_BODY = {
  events: [
    { eventAction: "registration", eventDate: "2010-01-01T00:00:00Z" },
    { eventAction: "expiration", eventDate: "2026-09-01T00:00:00Z" },
  ],
  entities: [
    {
      roles: ["registrar"],
      vcardArray: ["vcard", [["fn", {}, "text", "Example Registrar, Inc."]]],
    },
  ],
};

function context(fetchImpl: typeof fetch): ProbeContext<DomainExpiryConfig> {
  return {
    target: "example.com",
    port: null,
    config: { warnDays: 30, degradedThresholdMs: 3_000 },
    timeoutMs: 5_000,
    allowPrivateTargets: false,
    fetchImpl,
    lookup: publicLookup,
  };
}

const BOOTSTRAP = "https://rdap.org";
const REGISTRY = "https://rdap.verisign.com";

/**
 * `finalUrl` is what makes this helper able to reproduce the bug. A bare
 * `new Response(...)` has `url === ""`, so the probe falls back to the
 * request URL and every answer looks like it came from the bootstrap —
 * which is exactly the state the old test was in, and why it locked the
 * defect in rather than catching it.
 */
function rdap(body: unknown, status = 200, finalUrl?: string): typeof fetch {
  return vi.fn(async () => {
    const response = new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/rdap+json" },
    });
    if (finalUrl) {
      Object.defineProperty(response, "url", { value: finalUrl });
    }
    return response;
  }) as unknown as typeof fetch;
}

describe("domainExpiryProbe", () => {
  it("extracts the expiration event and the registrar", async () => {
    const result = await domainExpiryProbe(context(rdap(RDAP_BODY)));
    expect(result.error).toBeNull();
    expect(result.facts.expiresAt).toBe("2026-09-01T00:00:00.000Z");
    expect(result.facts.registrar).toBe("Example Registrar, Inc.");
    expect(typeof result.facts.daysRemaining).toBe("number");
  });

  it("asks for RDAP JSON and follows the bootstrap redirect one hop at a time", async () => {
    // The bootstrap redirect still gets followed — this check cannot
    // work otherwise — but by the egress loop, which classifies each
    // hop before issuing it. `redirect: "follow"` handed the whole
    // chain to the transport, and the chain is chosen by a third party.
    const fetchImpl = rdap(RDAP_BODY);
    await domainExpiryProbe(context(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/domain/example.com"),
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("reports an unknown domain as a failure to observe, not as expired", async () => {
    // A lapsed registration does look like this, but 404 is not an
    // expiry date — turning it into one would invent a number. Note the
    // final URL: this 404 came from a registry the bootstrap routed to.
    const result = await domainExpiryProbe(
      context(rdap({}, 404, `${REGISTRY}/com/v1/domain/example.com`)),
    );
    expect(result.error).toBe("The registry has no record of this domain");
    expect(result.unavailable).toBeUndefined();
    expect(result.facts.daysRemaining).toBeUndefined();
    expect(judge(domainExpirySpec.assertions, config, result).verdict).toBe(
      "down",
    );
  });

  it("does not call a TLD with no RDAP service a dead domain", async () => {
    // rdap.org answers 404 *itself* for .de, .io, .ch, .at, .jp, .nz and
    // .ru — it has no bootstrap entry to redirect to. Keying on the
    // status code alone made every domain under those TLDs a permanent
    // false outage that could never resolve, because closing an incident
    // needs a positive observation and this branch cannot produce one.
    const result = await domainExpiryProbe(
      context(rdap({}, 404, `${BOOTSTRAP}/domain/denic.de`)),
    );
    expect(result.error).toBeNull();
    expect(result.unavailable).toBe(
      "No RDAP service is published for this domain's TLD",
    );
    expect(judge(domainExpirySpec.assertions, config, result).verdict).toBe(
      "indeterminate",
    );
  });

  it("treats an unattributable 404 as unknown rather than as down", async () => {
    // No final URL at all — a polyfill, a proxy, anything that does not
    // set it. Conservative by construction: an unattributable 404 must
    // not page anybody.
    const result = await domainExpiryProbe(context(rdap({}, 404)));
    expect(result.error).toBeNull();
    expect(result.unavailable).toBeTruthy();
  });

  it("says so when a registry publishes no expiry date, without going down", async () => {
    // Judged `down`, this branch pins the monitor red forever: only a
    // positive observation resolves an incident, and it can never
    // produce one.
    const result = await domainExpiryProbe(
      context(rdap({ events: [{ eventAction: "registration" }] })),
    );
    expect(result.error).toBeNull();
    expect(result.unavailable).toMatch(/does not publish an expiry date/);
    expect(judge(domainExpirySpec.assertions, config, result).verdict).toBe(
      "indeterminate",
    );
  });

  it("reports malformed JSON rather than throwing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<html>nope</html>", { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await domainExpiryProbe(context(fetchImpl));
    expect(result.unavailable).toBe("RDAP returned malformed JSON");
    expect(result.error).toBeNull();
  });

  it.each([
    ["a null body", null],
    ["a JSON array", []],
    ["a bare number", 7],
    ["events as an object", { events: { eventAction: "expiration" } }],
    ["entities as a string", { events: [], entities: "nope" }],
    ["a null event in the list", { events: [null] }],
    [
      "a non-string eventDate",
      { events: [{ eventAction: "expiration", eventDate: 12345 }] },
    ],
  ])(
    "survives %s instead of throwing out of the probe",
    async (_label, body) => {
      // Optional chaining guards absence, not a wrong type. A throw here
      // escapes performCheck and runMonitorCheck, so no row is written,
      // nextEvaluationAt never advances, and the monitor is re-enqueued
      // every tick forever with nothing to show for it.
      const result = await domainExpiryProbe(context(rdap(body)));
      expect(result.unavailable).toBeTruthy();
      expect(judge(domainExpirySpec.assertions, config, result).verdict).toBe(
        "indeterminate",
      );
    },
  );

  it("keeps a rate-limited registry out of the uptime numbers", async () => {
    // An rdap.org 429 must not page on-call or redden a status page for
    // a domain that is perfectly fine.
    const result = await domainExpiryProbe(context(rdap({}, 429)));
    expect(result.error).toBeNull();
    expect(result.unavailable).toBe("RDAP lookup returned 429");
    expect(judge(domainExpirySpec.assertions, config, result).verdict).toBe(
      "indeterminate",
    );
  });

  it("still calls a registry-confirmed unregistered domain down", async () => {
    // The one answer this check exists to catch, and the only 404 that
    // is allowed to page anyone.
    const result = await domainExpiryProbe(
      context(rdap({}, 404, `${REGISTRY}/com/v1/domain/example.com`)),
    );
    expect(result.error).toBe("The registry has no record of this domain");
    expect(result.unavailable).toBeUndefined();
    expect(judge(domainExpirySpec.assertions, config, result).verdict).toBe(
      "down",
    );
  });

  it("survives a body that stops arriving mid-read", async () => {
    // `readCapped` uses try/finally and sits outside the probe's try
    // block, so a rejection here escaped `performCheck` and
    // `runMonitorCheck` entirely: no observation row, `nextEvaluationAt`
    // never advanced, and the monitor was re-enqueued every tick
    // forever. An ordinary slow ccTLD registry does this — the timeout
    // fires during the body read, past the branch that handles timeouts.
    const fetchImpl = vi.fn(async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"events":'));
          controller.error(new Error("terminated"));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await domainExpiryProbe(context(fetchImpl));
    expect(result.unavailable).toBe("RDAP response could not be read in full");
    // Says what actually happened: the body was never finished
    // arriving, not malformed.
    expect(result.unavailable).not.toMatch(/malformed/i);
    expect(result.error).toBeNull();
  });

  it("maps a timeout to a readable transport failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    const result = await domainExpiryProbe(context(fetchImpl));
    // A slow registry is "could not find out", not "the domain lapsed".
    expect(result.unavailable).toBe("RDAP lookup timed out after 5000ms");
    expect(result.error).toBeNull();
  });

  it("has no latency assertion — RDAP speed says nothing about the domain", () => {
    expect(domainExpirySpec.assertions.map((a) => a.id)).toEqual([
      "not-expired",
      "expiring-soon",
    ]);
  });

  it("judges a soon-to-lapse registration as degraded", () => {
    const verdict = judge(domainExpirySpec.assertions, config, {
      facts: { daysRemaining: 7 },
      responseTimeMs: 100,
      error: null,
    });
    expect(verdict.verdict).toBe("degraded");
    expect(verdict.error).toBe("The domain registration expires in 7 days");
  });
});
