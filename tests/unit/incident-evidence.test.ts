import { describe, expect, it } from "vitest";

import {
  BURST_MAX_STEPS,
  burstsInFlight,
  classifyStage,
  failureSignature,
  fitSnapshot,
  hostOfTarget,
  MAX_CORRELATIONS,
  MAX_SNAPSHOT_BYTES,
  meaningfulChanges,
  rankCorrelations,
  runBurst,
  signalsBetween,
  type BurstRecord,
  type BurstTransport,
  type CorrelationCandidate,
  type CorrelationSubject,
  type IncidentEvidenceSnapshot,
} from "@/modules/incidents/evidence";
import { makeRedactor, sealEvidence } from "@/lib/redact";
import { secretValuesOf } from "@/modules/monitors/types/config";
import { findSpec } from "@/modules/monitors/types/specs";
import { registrableDomain } from "@/modules/monitors/types/targets";

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

function burst(steps: BurstRecord["steps"]): BurstRecord {
  return {
    ranAt: "2026-08-25T00:00:00.000Z",
    budgetMs: 5000,
    maxSteps: BURST_MAX_STEPS,
    spentMs: 12,
    steps,
  };
}

describe("classifying which layer failed", () => {
  it("names DNS when the resolver answered", () => {
    const verdict = classifyStage({
      error: "getaddrinfo ENOTFOUND api.example.com",
      failureClass: "transport",
      statusCode: null,
    });
    expect(verdict.stage).toBe("dns");
    expect(verdict.basis).toBe("reported");
  });

  it("names the connection when the kernel refused it", () => {
    const verdict = classifyStage({
      error: "connect ECONNREFUSED 10.0.0.4:443",
      failureClass: "transport",
      statusCode: null,
    });
    expect(verdict.stage).toBe("tcp");
    expect(verdict.basis).toBe("reported");
  });

  it("names TLS when the certificate did", () => {
    const verdict = classifyStage({
      error: "certificate has expired: CERT_HAS_EXPIRED",
      failureClass: "transport",
      statusCode: null,
    });
    expect(verdict.stage).toBe("tls");
    expect(verdict.basis).toBe("reported");
  });

  it("calls a status code an HTTP failure, and an assertion on one an application failure", () => {
    expect(
      classifyStage({
        error: "Unexpected status 503",
        failureClass: "transport",
        statusCode: 503,
      }).stage,
    ).toBe("http");

    const assertion = classifyStage({
      error: "Unexpected status 503",
      failureClass: "assertion",
      statusCode: 503,
    });
    expect(assertion.stage).toBe("application");
    // The observation proves the transport worked, so no burst is needed
    // to say so.
    expect(assertion.basis).toBe("assertion");
  });

  it("refuses to guess a layer from a timeout", () => {
    const verdict = classifyStage({
      error: "Timed out after 10000ms",
      failureClass: "transport",
      statusCode: null,
    });
    expect(verdict.stage).toBe("unknown");
    expect(verdict.basis).toBe("unknown");
    expect(verdict.reason).toContain("does not say which layer");
  });

  it("refuses to call a probe that could not run an outage of the target", () => {
    const verdict = classifyStage({
      error: "ICMP needs a raw socket",
      failureClass: "misconfigured",
      statusCode: null,
    });
    expect(verdict.stage).toBe("unknown");
    expect(verdict.basis).toBe("unknown");
  });

  it("returns unknown for an unrecognised failure rather than a plausible guess", () => {
    const verdict = classifyStage({
      error: "the widget frobnicator disengaged",
      failureClass: "transport",
      statusCode: null,
    });
    expect(verdict.stage).toBe("unknown");
    expect(verdict.basis).toBe("unknown");
  });

  it("upgrades a timeout to a measured layer when the burst reproduced it", () => {
    const verdict = classifyStage(
      {
        error: "Timed out after 10000ms",
        failureClass: "transport",
        statusCode: null,
      },
      burst([
        { kind: "dns", ok: true, durationMs: 4, detail: {}, error: null },
        {
          kind: "tcp",
          ok: false,
          durationMs: 9,
          detail: {},
          error: "connect ECONNREFUSED",
        },
      ]),
    );
    expect(verdict.stage).toBe("tcp");
    expect(verdict.basis).toBe("measured");
    expect(verdict.reason).toContain("resolved");
  });

  it("blames the outermost layer that failed, not the innermost step run", () => {
    const verdict = classifyStage(
      {
        error: "Timed out after 10000ms",
        failureClass: "transport",
        statusCode: null,
      },
      burst([
        {
          kind: "dns",
          ok: false,
          durationMs: 4,
          detail: {},
          error: "ENOTFOUND",
        },
        {
          kind: "tcp",
          ok: false,
          durationMs: 1,
          detail: {},
          error: "no address",
        },
      ]),
    );
    expect(verdict.stage).toBe("dns");
  });

  it("keeps unknown when every diagnostic step passed", () => {
    const verdict = classifyStage(
      {
        error: "Timed out after 10000ms",
        failureClass: "transport",
        statusCode: null,
      },
      burst([
        { kind: "dns", ok: true, durationMs: 4, detail: {}, error: null },
        { kind: "tcp", ok: true, durationMs: 9, detail: {}, error: null },
      ]),
    );
    // A burst that reproduced nothing is not evidence of recovery and
    // not evidence of a layer.
    expect(verdict.stage).toBe("unknown");
  });

  it("mentions what re-probing saw without calling it the failing layer", () => {
    // The burst succeeded end to end. Reporting that as a measured HTTP
    // failure - which an earlier version did - tells an operator the
    // application is broken on the strength of a request that worked.
    // The status is worth saying; it is not worth calling a diagnosis.
    const verdict = classifyStage(
      {
        error: "Timed out after 10000ms",
        failureClass: "transport",
        statusCode: null,
      },
      burst([
        { kind: "dns", ok: true, durationMs: 4, detail: {}, error: null },
        { kind: "tcp", ok: true, durationMs: 9, detail: {}, error: null },
        {
          kind: "http",
          ok: true,
          durationMs: 30,
          detail: { statusCode: 503 },
          error: null,
        },
      ]),
    );
    expect(verdict.stage).toBe("unknown");
    expect(verdict.basis).toBe("unknown");
    expect(verdict.reason).toContain("503");
  });

  it("names the browser only for a journey type", () => {
    expect(
      classifyStage({
        error: "the step failed",
        failureClass: "assertion",
        statusCode: null,
        browser: true,
      }).stage,
    ).toBe("browser");
  });

  it("does not blame the browser for a journey that never reached the page", () => {
    // `page.goto: getaddrinfo ENOTFOUND` is a resolver answer wearing a
    // browser's stack frame. Filing it as `browser` points an operator at
    // their own JavaScript while DNS is down.
    const verdict = classifyStage({
      error: "page.goto: getaddrinfo ENOTFOUND app.example.com",
      failureClass: "assertion",
      statusCode: null,
      browser: true,
    });
    expect(verdict.stage).toBe("dns");
    expect(verdict.basis).toBe("reported");
  });

  it("does not tell a monitor that dials nothing that its target was reachable", () => {
    // A heartbeat whose silence ran out, a group derived from its
    // members, an operator's own "this is down": all `assertion`
    // failures, none of which reached anything.
    const verdict = classifyStage({
      error: "No heartbeat for 15 minutes",
      failureClass: "assertion",
      statusCode: null,
      dials: false,
    });
    expect(verdict.stage).toBe("unknown");
    expect(verdict.basis).toBe("unknown");
    expect(verdict.reason).not.toContain("reachable");
  });

  it("does not read a bare mention of a certificate as a TLS failure", () => {
    // An application rejecting a client credential, not a TLS stack.
    const verdict = classifyStage({
      error: 'The API answered {"error":"invalid client certificate"}',
      failureClass: "assertion",
      statusCode: 403,
    });
    expect(verdict.stage).toBe("application");
  });

  it("does not read a step Vigil itself abandoned as a measured layer", () => {
    // The budget running out is a fact about Vigil. Reading it as a
    // measurement reports "the connection failed" when what happened is
    // that we stopped waiting.
    const verdict = classifyStage(
      {
        error: "Timed out after 10000ms",
        failureClass: "transport",
        statusCode: null,
      },
      burst([
        { kind: "dns", ok: true, durationMs: 4, detail: {}, error: null },
        {
          kind: "tcp",
          ok: false,
          durationMs: 2000,
          detail: {},
          error: "Gave up after 2000ms",
          selfInflicted: true,
        },
      ]),
    );
    expect(verdict.stage).toBe("unknown");
    expect(verdict.basis).toBe("unknown");
  });

  it("does not turn an all-passing burst into a measured HTTP failure", () => {
    // The burst reproduced nothing. That is evidence the failure was not
    // at a layer it can reach; it is NOT evidence the application broke.
    const verdict = classifyStage(
      {
        error: "Timed out after 10000ms",
        failureClass: "transport",
        statusCode: null,
      },
      burst([
        { kind: "dns", ok: true, durationMs: 4, detail: {}, error: null },
        { kind: "tcp", ok: true, durationMs: 9, detail: {}, error: null },
        {
          kind: "http",
          ok: true,
          durationMs: 30,
          detail: { statusCode: 200 },
          error: null,
        },
      ]),
    );
    expect(verdict.stage).toBe("unknown");
    expect(verdict.basis).toBe("unknown");
    // But it still says what re-probing saw, because that is useful.
    expect(verdict.reason).toContain("200");
  });
});

describe("failure signatures", () => {
  it("uses the code when there is one", () => {
    expect(
      failureSignature({ error: "getaddrinfo ENOTFOUND x", statusCode: null }),
    ).toBe("ENOTFOUND");
  });

  it("prefers the status code, which is the more specific answer", () => {
    expect(
      failureSignature({ error: "Unexpected status 503", statusCode: 503 }),
    ).toBe("HTTP_503");
  });

  it("normalises free text so two hosts fail the same way", () => {
    const a = failureSignature({
      error: "the pool refused 12 clients",
      statusCode: null,
    });
    const b = failureSignature({
      error: "the pool refused 4 clients",
      statusCode: null,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^text:/);
  });

  it("is null when nothing was reported", () => {
    expect(failureSignature({ error: null, statusCode: null })).toBeNull();
    expect(failureSignature({ error: "   ", statusCode: null })).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Before and after                                                    */
/* ------------------------------------------------------------------ */

const HTTP_FACTS = [
  { key: "statusCode", label: "Status code", kind: "number" as const },
  {
    key: "responseTimeMs",
    label: "Response time",
    kind: "number" as const,
    unit: "ms",
  },
  {
    key: "tlsDaysRemaining",
    label: "Certificate expires in",
    kind: "number" as const,
    unit: "days",
  },
];

describe("what changed since the last success", () => {
  it("reports a status change even though the relative move is small", () => {
    const changes = meaningfulChanges(
      { statusCode: 200 },
      { statusCode: 201 },
      HTTP_FACTS,
    );
    expect(changes).toEqual([
      {
        key: "statusCode",
        label: "Status code",
        before: 200,
        after: 201,
        note: "changed",
      },
    ]);
  });

  it("ignores response-time noise and reports a real slowdown", () => {
    expect(
      meaningfulChanges(
        { responseTimeMs: 130 },
        { responseTimeMs: 160 },
        HTTP_FACTS,
      ),
    ).toEqual([]);

    const slow = meaningfulChanges(
      { responseTimeMs: 130 },
      { responseTimeMs: 9800 },
      HTTP_FACTS,
    );
    expect(slow).toHaveLength(1);
    expect(slow[0]!.note).toBe("slower");
  });

  it("reports a fact that stopped being measured", () => {
    const changes = meaningfulChanges(
      { statusCode: 200, tlsDaysRemaining: 40 },
      { statusCode: 200 },
      HTTP_FACTS,
    );
    expect(changes).toEqual([
      {
        key: "tlsDaysRemaining",
        label: "Certificate expires in",
        unit: "days",
        before: 40,
        after: null,
        note: "disappeared",
      },
    ]);
  });

  it("reports a fact that appeared", () => {
    const changes = meaningfulChanges(
      { statusCode: 200 },
      { statusCode: 200, keywordPresent: false },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.note).toBe("appeared");
  });

  it("compares lists by value", () => {
    expect(
      meaningfulChanges({ records: ["a", "b"] }, { records: ["a", "b"] }),
    ).toEqual([]);
    expect(
      meaningfulChanges({ records: ["a", "b"] }, { records: ["a"] }),
    ).toHaveLength(1);
  });

  it("has nothing to say when there is no last success", () => {
    expect(meaningfulChanges(null, { statusCode: 503 }, HTTP_FACTS)).toEqual(
      [],
    );
  });

  it("orders by the type's own fact declaration, not by size of change", () => {
    const changes = meaningfulChanges(
      { tlsDaysRemaining: 40, statusCode: 200 },
      { tlsDaysRemaining: 1, statusCode: 500 },
      HTTP_FACTS,
    );
    expect(changes.map((change) => change.key)).toEqual([
      "statusCode",
      "tlsDaysRemaining",
    ]);
  });

  it("caps the list", () => {
    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    for (let i = 0; i < 40; i += 1) {
      before[`fact${i}`] = 1;
      after[`fact${i}`] = 2;
    }
    expect(meaningfulChanges(before, after).length).toBeLessThanOrEqual(12);
  });
});

/* ------------------------------------------------------------------ */
/* Correlation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Two failures with nothing whatever in common except the minute they
 * started. Every test below opts INTO one shared attribute, so what is
 * being asserted is always the attribute and never the fixture.
 */
function candidate(
  overrides: Partial<CorrelationCandidate> = {},
): CorrelationCandidate {
  return {
    monitorId: "00000000-0000-0000-0000-0000000000bb",
    monitorName: "Other",
    checkType: "tcp",
    host: "other.example.net",
    addresses: [],
    firstFailureAt: new Date("2026-08-25T10:00:00.000Z"),
    error: "connect ECONNREFUSED 10.0.0.9:80",
    statusCode: null,
    failureClass: "transport",
    incidentId: null,
    ...overrides,
  };
}

function subject(
  overrides: Partial<CorrelationSubject> = {},
): CorrelationSubject {
  return {
    ...candidate({
      monitorId: "00000000-0000-0000-0000-0000000000aa",
      monitorName: "Subject",
      checkType: "http",
      host: "api.example.com",
      error: "Timed out after 10000ms",
    }),
    stage: "unknown",
    ...overrides,
  };
}

describe("relating one failure to another", () => {
  it("relates nothing on time alone", () => {
    // Two monitors, failing at the same instant, with nothing in common.
    expect(signalsBetween(subject(), candidate())).toEqual([]);
  });

  it("relates two targets on the same host and says so", () => {
    const signals = signalsBetween(
      subject({ host: "api.example.com" }),
      candidate({ host: "api.example.com" }),
    );
    expect(signals[0]).toEqual({
      kind: "same-host",
      detail: "api.example.com",
    });
  });

  it("relates two hosts under one registrable domain", () => {
    const signals = signalsBetween(
      subject({ host: "api.example.com" }),
      candidate({ host: "cdn.example.com" }),
    );
    expect(signals.map((signal) => signal.kind)).toContain("same-domain");
    expect(
      signals.find((signal) => signal.kind === "same-domain")!.detail,
    ).toBe("example.com");
  });

  it("relates two targets a diagnostic resolved to one address", () => {
    const signals = signalsBetween(
      subject({ host: "a.example.com", addresses: ["93.184.216.34"] }),
      candidate({
        host: "b.example.org",
        addresses: ["93.184.216.34", "93.184.216.35"],
      }),
    );
    expect(signals[0]).toEqual({
      kind: "same-address",
      detail: "93.184.216.34",
    });
  });

  it("relates two identical failure signatures", () => {
    const signals = signalsBetween(
      subject({
        host: "a.example.com",
        error: "connect ECONNREFUSED 10.0.0.1:5432",
      }),
      candidate({
        host: "b.example.org",
        error: "connect ECONNREFUSED 10.0.0.2:5432",
      }),
    );
    expect(signals.map((signal) => signal.kind)).toEqual(["same-signature"]);
  });

  it("does not relate two failures that merely share a status code", () => {
    // One endpoint's opinion of one request. Every overloaded
    // application in the world returns 503, so counting it would relate
    // half the fleet to the other half.
    expect(
      signalsBetween(
        subject({
          host: "a.example.com",
          error: "Unexpected status 503",
          statusCode: 503,
        }),
        candidate({
          host: "b.example.org",
          error: "Unexpected status 503",
          statusCode: 503,
        }),
      ),
    ).toEqual([]);
  });

  it("still mentions a shared status once something specific relates the two", () => {
    const signals = signalsBetween(
      subject({
        host: "a.example.com",
        error: "Unexpected status 503",
        statusCode: 503,
      }),
      candidate({
        host: "a.example.com",
        error: "Unexpected status 503",
        statusCode: 503,
      }),
    );
    expect(signals[0]!.kind).toBe("same-host");
    expect(signals.map((signal) => signal.kind)).toContain("same-signature");
  });

  it("does not relate two failures that merely both timed out", () => {
    // The most common failure a monitor has, and it names no layer. If
    // a shared timeout were a strong signal, every slow endpoint in the
    // fleet would be related to every other one.
    expect(
      signalsBetween(
        subject({ host: "a.example.com", error: "Timed out after 10000ms" }),
        candidate({ host: "b.example.org", error: "Timed out after 30000ms" }),
      ),
    ).toEqual([]);
  });

  it("still mentions a shared timeout once something specific relates the two", () => {
    const signals = signalsBetween(
      subject({ host: "a.example.com", error: "Timed out after 10000ms" }),
      candidate({ host: "a.example.com", error: "Timed out after 30000ms" }),
    );
    expect(signals[0]!.kind).toBe("same-host");
    expect(signals.map((signal) => signal.kind)).toContain("same-signature");
  });

  it("never relates two failures that both said nothing", () => {
    expect(
      signalsBetween(
        subject({ host: "a.example.com", error: null, statusCode: null }),
        candidate({ host: "b.example.org", error: null, statusCode: null }),
      ),
    ).toEqual([]);
  });

  it("relates on a shared probe location", () => {
    const signals = signalsBetween(
      subject({ host: "a.example.com", probeLocations: ["eu-west"] }),
      candidate({
        host: "b.example.org",
        probeLocations: ["eu-west", "us-east"],
      }),
    );
    expect(signals[0]).toEqual({
      kind: "same-probe-location",
      detail: "eu-west",
    });
  });

  it("adds the weak signals only once a strong one has earned the row", () => {
    // Same check type and same stage, nothing else: not related.
    expect(
      signalsBetween(
        subject({ host: "a.example.com", checkType: "http", stage: "tcp" }),
        candidate({ host: "b.example.org", checkType: "http" }),
      ),
    ).toEqual([]);

    const related = signalsBetween(
      subject({ host: "a.example.com", checkType: "http", stage: "tcp" }),
      candidate({
        host: "a.example.com",
        checkType: "http",
        error: "connect ECONNREFUSED 10.0.0.2:443",
      }),
    );
    expect(related.map((signal) => signal.kind)).toContain("same-check-type");
    expect(related.map((signal) => signal.kind)).toContain("same-stage");
    // Strong first: the reason the row is here comes before the colour.
    expect(related[0]!.kind).toBe("same-host");
  });

  it("ranks strong signals first and is stable on ties", () => {
    const strong = candidate({
      monitorId: "00000000-0000-0000-0000-0000000000cc",
      monitorName: "Strong",
      host: "api.example.com",
      error: "connect ECONNREFUSED 10.0.0.2:443",
    });
    const weaker = candidate({
      monitorId: "00000000-0000-0000-0000-0000000000dd",
      monitorName: "Weaker",
      host: "cdn.example.com",
      error: "Timed out after 10000ms",
    });
    const me = subject({
      host: "api.example.com",
      error: "connect ECONNREFUSED 10.0.0.1:443",
    });

    const ordered = rankCorrelations(me, [weaker, strong]);
    expect(ordered.map((row) => row.monitorName)).toEqual(["Strong", "Weaker"]);
    // Deterministic: the same inputs in the other order give the same
    // answer.
    expect(rankCorrelations(me, [strong, weaker])).toEqual(ordered);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      candidate({
        monitorId: `00000000-0000-0000-0000-0000000${String(i).padStart(5, "0")}`,
        host: "api.example.com",
      }),
    );
    expect(
      rankCorrelations(subject({ host: "api.example.com" }), many),
    ).toHaveLength(MAX_CORRELATIONS);
  });
});

describe("hostnames and domains", () => {
  it("reads a host out of every target shape the product stores", () => {
    expect(hostOfTarget("https://api.example.com/health")).toBe(
      "api.example.com",
    );
    expect(hostOfTarget("postgres://app:secret@db.example.com:5432/main")).toBe(
      "db.example.com",
    );
    expect(hostOfTarget("db.example.com")).toBe("db.example.com");
    expect(hostOfTarget("db.example.com:5432")).toBe("db.example.com");
    expect(hostOfTarget("[2001:db8::1]:9000")).toBe("2001:db8::1");
  });

  it("gives no answer for a label, rather than a wrong one", () => {
    expect(hostOfTarget("Nightly backup")).toBeNull();
    expect(hostOfTarget("")).toBeNull();
  });

  it("finds the registrable domain, including two-level suffixes", () => {
    expect(registrableDomain("api.example.com")).toBe("example.com");
    expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("93.184.216.34")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The burst, and its bounds                                           */
/* ------------------------------------------------------------------ */

function transport(overrides: Partial<BurstTransport> = {}): BurstTransport {
  return {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    connect: async () => ({ error: null }),
    handshake: async () => ({ facts: { daysRemaining: 40 }, error: null }),
    request: async () => ({ facts: { statusCode: 200 }, error: null }),
    ...overrides,
  };
}

const TARGET = {
  host: "api.example.com",
  port: 443,
  url: "https://api.example.com/health",
  method: "GET",
  tls: true,
};

describe("the diagnostic burst", () => {
  it("runs at most four steps, in layer order", async () => {
    const record = await runBurst({ target: TARGET, transport: transport() });
    expect(record.steps.map((step) => step.kind)).toEqual([
      "dns",
      "tcp",
      "tls",
      "http",
    ]);
    expect(record.steps.length).toBeLessThanOrEqual(BURST_MAX_STEPS);
    expect(record.skipped).toBeUndefined();
  });

  it("stops at the first layer that failed", async () => {
    const record = await runBurst({
      target: TARGET,
      transport: transport({
        connect: async () => ({ error: "connect ECONNREFUSED" }),
      }),
    });
    expect(record.steps.map((step) => step.kind)).toEqual(["dns", "tcp"]);
    expect(record.steps[1]!.ok).toBe(false);
  });

  it("records the addresses it would have dialled", async () => {
    const record = await runBurst({
      target: TARGET,
      transport: transport({
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "93.184.216.35", family: 4 },
        ],
      }),
    });
    expect(record.steps[0]!.detail.addresses).toEqual([
      "93.184.216.34",
      "93.184.216.35",
    ]);
  });

  it("refuses a target that now resolves into private space", async () => {
    const record = await runBurst({
      target: TARGET,
      allowPrivateTargets: false,
      transport: transport({
        lookup: async () => [{ address: "10.0.0.1", family: 4 }],
      }),
    });
    expect(record.skipped).toBe("refused");
    // The resolve is still recorded: what it resolved TO is the finding.
    expect(record.steps.map((step) => step.kind)).toEqual(["dns"]);
  });

  it("reaches a private target when the installation permits one", async () => {
    // The same answer the monitor's own check gives. A diagnostic that
    // refused a LAN target an operator has deliberately allowed would
    // report "refused" about a target that is perfectly reachable.
    const record = await runBurst({
      target: TARGET,
      allowPrivateTargets: true,
      transport: transport({
        lookup: async () => [{ address: "10.0.0.1", family: 4 }],
      }),
    });
    expect(record.skipped).toBeUndefined();
    expect(record.steps.map((step) => step.kind)).toEqual([
      "dns",
      "tcp",
      "tls",
      "http",
    ]);
  });

  it("refuses cloud metadata however the installation is configured", async () => {
    const record = await runBurst({
      target: TARGET,
      allowPrivateTargets: true,
      transport: transport({
        lookup: async () => [{ address: "169.254.169.254", family: 4 }],
      }),
    });
    expect(record.skipped).toBe("refused");
    expect(record.steps.map((step) => step.kind)).toEqual(["dns"]);
  });

  it("truncates an error a target made arbitrarily long", async () => {
    const record = await runBurst({
      target: TARGET,
      transport: transport({
        connect: async () => ({ error: "x".repeat(50_000) }),
      }),
    });
    expect(record.steps[1]!.error!.length).toBeLessThan(600);
  });

  it("refuses a metadata endpoint by name", async () => {
    const record = await runBurst({
      target: { ...TARGET, host: "metadata.google.internal" },
      transport: transport(),
    });
    expect(record.skipped).toBe("refused");
    expect(record.steps).toEqual([]);
  });

  it("stops when the budget is spent rather than running every step", async () => {
    const record = await runBurst({
      target: TARGET,
      budgetMs: 40,
      transport: transport({
        lookup: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return [{ address: "93.184.216.34", family: 4 }];
        },
      }),
    });
    expect(record.steps.map((step) => step.kind)).toEqual(["dns"]);
    expect(record.budgetMs).toBe(40);
  });

  it("skips rather than joining a stampede, and lets go afterwards", async () => {
    const slow = transport({
      lookup: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return [{ address: "93.184.216.34", family: 4 }];
      },
    });
    const running = [
      runBurst({ target: TARGET, transport: slow }),
      runBurst({ target: TARGET, transport: slow }),
    ];
    // The third is over the limit while the first two are in flight.
    const third = await runBurst({ target: TARGET, transport: transport() });
    expect(third.skipped).toBe("concurrency");
    expect(third.steps).toEqual([]);

    await Promise.all(running);
    expect(burstsInFlight()).toBe(0);
    const after = await runBurst({ target: TARGET, transport: transport() });
    expect(after.skipped).toBeUndefined();
  });

  it("stops at the budget even when a step never settles", async () => {
    // The bound has to hold against a transport that ignores the timeout
    // it was handed, because two of the four steps genuinely do:
    // `dns.lookup` takes no timeout, and `egressFetch` resolves the host
    // inside `authorizeEgress` before any AbortSignal reaches a socket.
    // A burst that only passed a number down was bounded by the system
    // resolver's patience, not by this one.
    const never = new Promise<never>(() => {});
    const startedAt = Date.now();
    const record = await runBurst({
      target: TARGET,
      budgetMs: 300,
      transport: transport({ lookup: () => never }),
    });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2_000);
    expect(record.steps).toHaveLength(1);
    expect(record.steps[0]!.ok).toBe(false);
    expect(record.steps[0]!.error).toContain("Gave up after");
  });

  it("stops at the budget when a later step never settles", async () => {
    const never = new Promise<never>(() => {});
    const startedAt = Date.now();
    const record = await runBurst({
      target: TARGET,
      budgetMs: 300,
      transport: transport({ connect: () => never }),
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(record.steps.map((step) => step.kind)).toEqual(["dns", "tcp"]);
    expect(record.steps[1]!.ok).toBe(false);
  });

  it("records a rejecting step instead of losing the whole snapshot", async () => {
    // Only the resolve step used to be wrapped. A rejection from any
    // later step unwound runBurst -> buildSnapshot into
    // captureIncidentEvidence's catch, so one throwing socket cost the
    // entire row rather than one field.
    for (const failing of ["connect", "handshake", "request"] as const) {
      const record = await runBurst({
        target: TARGET,
        transport: transport({
          [failing]: () => Promise.reject(new Error(`${failing} exploded`)),
        }),
      });
      const step = record.steps.find((entry) => !entry.ok);
      expect(
        step,
        `${failing} should be recorded as a failed step`,
      ).toBeDefined();
      expect(step!.error).toContain("exploded");
    }
  });

  it("never throws when a step does", async () => {
    const record = await runBurst({
      target: TARGET,
      transport: transport({
        lookup: async () => {
          throw new Error("resolver exploded");
        },
      }),
    });
    expect(record.steps[0]!.ok).toBe(false);
    expect(record.steps[0]!.error).toContain("resolver exploded");
  });

  it("skips the handshake for a target that speaks no TLS", async () => {
    const record = await runBurst({
      target: { ...TARGET, tls: false, url: null },
      transport: transport(),
    });
    expect(record.steps.map((step) => step.kind)).toEqual(["dns", "tcp"]);
  });
});

/* ------------------------------------------------------------------ */
/* Bounds and redaction                                                */
/* ------------------------------------------------------------------ */

function snapshot(
  overrides: Partial<IncidentEvidenceSnapshot> = {},
): IncidentEvidenceSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: "2026-08-25T10:00:00.000Z",
    monitor: {
      id: "m",
      name: "API",
      checkType: "http",
      target: "https://api.example.com/health",
      host: "api.example.com",
      port: 443,
    },
    failure: {
      at: "2026-08-25T10:00:00.000Z",
      verdict: "down",
      failureClass: "transport",
      error: "Timed out after 10000ms",
      statusCode: null,
      responseTimeMs: 10000,
      failedAssertions: [],
      facts: { responseTimeMs: 10000 },
    },
    stage: { stage: "unknown", basis: "unknown", reason: "no layer named" },
    signature: "TIMED_OUT",
    firstFailureAt: "2026-08-25T09:58:00.000Z",
    lastSuccess: null,
    lastSuccessNote: "none-retained",
    changes: [],
    burst: null,
    correlations: [],
    ...overrides,
  };
}

describe("the storage bound", () => {
  it("leaves a normal snapshot alone", () => {
    const fitted = fitSnapshot(snapshot());
    expect(fitted.truncated).toBeUndefined();
  });

  it("measures the cap in bytes, not UTF-16 code units", () => {
    // A three-byte character counts as one `.length`. Measuring with
    // `.length` let a snapshot of a target that answers in Japanese sit
    // at three times the documented cap AND not set `truncated`, because
    // the size test never tripped.
    const wide = snapshot({
      failure: {
        at: "2026-08-25T10:00:00.000Z",
        verdict: "down",
        failureClass: "transport",
        error: "あ".repeat(20_000),
        statusCode: null,
        responseTimeMs: 10_000,
        failedAssertions: [],
        facts: {},
      },
    });
    expect(JSON.stringify(wide).length).toBeLessThan(MAX_SNAPSHOT_BYTES * 3);
    const fitted = fitSnapshot(wide);
    expect(fitted.truncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(fitted), "utf8"),
    ).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
  });

  it("trims the least useful evidence first and says it trimmed", () => {
    const huge = snapshot({
      correlations: Array.from({ length: 10 }, (_, i) => ({
        monitorId: `monitor-${i}`,
        monitorName: "x".repeat(4000),
        checkType: "http",
        incidentId: null,
        firstFailureAt: null,
        signals: [{ kind: "same-host" as const, detail: "api.example.com" }],
      })),
    });
    const fitted = fitSnapshot(huge);
    expect(fitted.truncated).toBe(true);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(
      MAX_SNAPSHOT_BYTES,
    );
    // The failure itself survives every level of trimming.
    expect(fitted.failure.error).toBe("Timed out after 10000ms");
    expect(fitted.stage).toEqual(huge.stage);
  });
});

describe("redaction of a monitor's own secrets", () => {
  it("collects the values a spec declares secret, including named maps", () => {
    const redis = findSpec("redis")!;
    expect(secretValuesOf(redis, { password: "hunter2" })).toEqual(["hunter2"]);

    const journey = findSpec("synthetic-api");
    if (journey) {
      expect(
        secretValuesOf(journey, { secrets: { token: "sk-live-1", blank: "" } }),
      ).toEqual(["sk-live-1"]);
    }
  });

  it("masks a credential wherever it ended up in an evidence bag", () => {
    const redact = makeRedactor(["hunter2"]);
    const sealed = sealEvidence(
      {
        error: "connection to db failed for user app with password hunter2",
        url: "postgres://app:hunter2@db.example.com:5432/main",
        encoded: "pass=hunter2&page=3",
      },
      redact,
    ) as Record<string, string>;
    expect(JSON.stringify(sealed)).not.toContain("hunter2");
    expect(sealed.error).toContain("[redacted]");
  });
});
