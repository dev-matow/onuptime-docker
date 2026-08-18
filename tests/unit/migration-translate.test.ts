import { describe, expect, it } from "vitest";

import type { SourceCheck } from "@/modules/importers/model";
import { translateCheck, type Build } from "@/modules/importers/translate";

/**
 * Capability mapping, exercised without a database.
 *
 * The rows worth testing are the ones that never reach Postgres: a POST
 * that has to be refused rather than issued as a GET, a keyword too long
 * to store, a JSONPath with a wildcard in it. Those are exactly the
 * cases an integration test cannot reach, because the monitor they would
 * have produced is never created.
 */

function check(overrides: Partial<SourceCheck> = {}): SourceCheck {
  return {
    sourceId: "1",
    name: "Example",
    sourceType: "http",
    kind: "http",
    paused: false,
    target: { url: "https://www.example.com/health" },
    ...overrides,
  };
}

function build(source: SourceCheck): Build {
  const translated = translateCheck(source);
  if (translated.outcome !== "build") {
    throw new Error(`expected a build, got: ${translated.detail}`);
  }
  return translated.build;
}

function notes(source: SourceCheck): string {
  return build(source).notes.join(" ");
}

describe("what a check becomes", () => {
  it("maps each kind onto the Vigil check type that means the same thing", () => {
    const cases: [SourceCheck["kind"], string][] = [
      ["http", "http"],
      ["json", "json-query"],
      ["ping", "ping"],
      ["tcp", "tcp"],
      ["dns", "dns"],
      ["tls", "tls-expiry"],
      ["domain", "domain-expiry"],
      ["smtp", "smtp"],
      ["imap", "imap"],
      ["ftp", "ftp"],
      ["ssh", "ssh"],
      ["ntp", "ntp"],
      ["websocket", "websocket"],
      ["grpc", "grpc"],
      ["heartbeat", "push"],
      ["group", "group"],
    ];
    for (const [kind, checkType] of cases) {
      const result = translateCheck(
        check({
          kind,
          target: {
            url: "https://www.example.com/",
            host: "www.example.com",
            domain: "example.com",
            port: 443,
            label: "A job",
          },
        }),
      );
      expect(result.outcome, `${kind} should build`).toBe("build");
      if (result.outcome === "build") {
        expect(result.build.input.checkType, kind).toBe(checkType);
      }
    }
  });

  it("refuses UDP outright, because Vigil's UDP check needs a payload", () => {
    // Vigil's own descriptor: "UDP answers nothing it was not asked, so
    // the check needs a payload the service will reply to." This
    // importer carries no request payloads, so an imported UDP monitor
    // would send an empty datagram and be down forever.
    const result = translateCheck(
      check({
        kind: "udp",
        sourceType: "udp",
        target: { host: "dns.example.com", port: 53 },
      }),
    );
    expect(result.outcome).toBe("unsupported");
    if (result.outcome === "unsupported") {
      expect(result.detail).toContain("payload the service replies to");
      expect(result.detail).toContain("permanent outage");
    }
  });

  it("refuses an unsupported kind with the adapter's own reason", () => {
    const result = translateCheck(
      check({
        kind: "unsupported",
        unsupportedReason: "It is a browser script.",
      }),
    );
    expect(result.outcome).toBe("unsupported");
    if (result.outcome === "unsupported") {
      expect(result.detail).toBe("It is a browser script.");
    }
  });

  it("says so loudly when an adapter marks a check unsupported and gives no reason", () => {
    const result = translateCheck(check({ kind: "unsupported" }));
    expect(result.outcome).toBe("unsupported");
    if (result.outcome === "unsupported") {
      expect(result.detail).toContain("which is itself the defect");
    }
  });
});

describe("the values every check carries", () => {
  it("cuts a name to the length Vigil's column holds and says it did", () => {
    const long = "a".repeat(140);
    const result = build(check({ name: long }));
    expect(String(result.input.name)).toHaveLength(100);
    expect(result.notes.join(" ")).toContain("cut to");
  });

  it("never turns a non-positive interval into a two-second poll", () => {
    // StatusCake publishes `check_rate: 0` as a value a check can hold.
    // Clamping it up to Vigil's floor would point a five-minute check at
    // the customer's production endpoint thirty times a second.
    for (const stored of [0, -1]) {
      const result = build(check({ intervalSeconds: stored }));
      expect(result.input.intervalSeconds, `interval ${stored}`).toBe(60);
      expect(result.notes.join(" ")).toContain("not a schedule");
    }
  });

  it("clamps an interval to Vigil's bounds and says so", () => {
    expect(build(check({ intervalSeconds: 300 })).input.intervalSeconds).toBe(
      300,
    );
    const clamped = build(check({ intervalSeconds: 1 }));
    expect(clamped.input.intervalSeconds).toBe(2);
    expect(clamped.notes.join(" ")).toContain("clamped");
  });

  it("clamps a timeout, and falls back silently when the source stored none", () => {
    expect(build(check({ timeoutMs: 45_000 })).input.timeoutMs).toBe(30_000);
    const absent = build(check({}));
    expect(absent.input.timeoutMs).toBe(10_000);
    expect(absent.notes.join(" ")).not.toContain("clamped");
  });

  it("turns a retry count and its spacing into one failure window", () => {
    const result = build(check({ intervalSeconds: 60, retries: { count: 3 } }));
    expect(result.input.failureWindowSeconds).toBe(180);
  });

  it("prefers a tolerance the source already stored as a duration", () => {
    const result = build(
      check({ intervalSeconds: 60, retries: { count: 3, windowSeconds: 120 } }),
    );
    expect(result.input.failureWindowSeconds).toBe(120);
  });

  it("carries a note the adapter wrote about the retry policy", () => {
    expect(
      notes(check({ retries: { count: 1, note: "Quorum was not carried." } })),
    ).toContain("Quorum was not carried.");
  });

  it("turns every withheld secret into a line that names it", () => {
    expect(notes(check({ withheld: ["the bearer token it sends"] }))).toContain(
      "does not copy credentials",
    );
  });

  it("reports the regions a source ran the check from", () => {
    expect(notes(check({ regions: ["us-east", "eu-west"] }))).toContain(
      "us-east, eu-west",
    );
  });
});

describe("an HTTP check", () => {
  it("carries GET and HEAD and refuses everything else", () => {
    expect(build(check({ http: { method: "HEAD" } })).input.method).toBe(
      "HEAD",
    );
    const post = build(check({ http: { method: "POST" } }));
    expect(post.refusals.join(" ")).toContain("POST");
    expect(post.refusals.join(" ")).toContain("GET or HEAD");
  });

  it("carries one explicit status code and reports a list it cannot express", () => {
    expect(
      build(check({ http: { acceptedStatus: ["204"] } })).input
        .expectedStatusCode,
    ).toBe(204);
    const many = build(check({ http: { acceptedStatus: ["200", "201"] } }));
    expect(many.input.expectedStatusCode).toBeUndefined();
    expect(many.notes.join(" ")).toContain("200, 201");
  });

  it("says nothing at all when the source did not narrow the status", () => {
    expect(build(check({ http: {} })).notes).toHaveLength(0);
  });

  it("carries a body assertion and its inversion", () => {
    const result = build(
      check({ http: { keyword: "ok", keywordAbsent: true } }),
    );
    expect(result.input.bodyKeyword).toBe("ok");
    expect(result.input.keywordAbsent).toBe(true);
  });

  it("drops a body assertion too long to store rather than truncating it", () => {
    const result = build(check({ http: { keyword: "x".repeat(240) } }));
    expect(result.input.bodyKeyword).toBeUndefined();
    expect(result.notes.join(" ")).toContain("Truncating it would assert");
  });

  it("drops a body assertion on a HEAD request, which has no body", () => {
    const result = build(check({ http: { method: "HEAD", keyword: "ok" } }));
    expect(result.input.bodyKeyword).toBeUndefined();
    expect(result.notes.join(" ")).toContain("returns no body");
  });

  it("removes credentials from a URL without ever repeating them", () => {
    const result = build(
      check({ target: { url: "https://ops:hunter2@www.example.com/health" } }),
    );
    expect(String(result.input.url)).toBe("https://www.example.com/health");
    expect(result.notes.join(" ")).toContain("were removed");
    expect(result.notes.join(" ")).not.toContain("hunter2");
  });

  it("names the headers it could not carry without quoting their values", () => {
    const result = build(
      check({ http: { headerNames: ["Authorization", "X-Env"] } }),
    );
    expect(result.notes.join(" ")).toContain("Authorization, X-Env");
  });

  it("reports a request body, basic auth and a redirect policy it cannot keep", () => {
    const text = notes(
      check({
        http: {
          hasRequestBody: true,
          hasBasicAuth: true,
          followRedirects: false,
        },
      }),
    );
    expect(text).toContain("request body was not carried");
    expect(text).toContain("HTTP authentication was not carried");
    expect(text).toContain("did not follow redirects");
  });

  it("turns a certificate warning into Vigil's TLS check and clamps the threshold", () => {
    const result = build(
      check({
        http: { checkCertificateExpiry: true, certificateWarnDays: 800 },
      }),
    );
    expect(result.input.tlsCheck).toBe(true);
    expect(result.input.tlsWarnDays).toBe(365);
    expect(result.notes.join(" ")).toContain("clamped");
  });

  it("refuses a check with no URL rather than building one", () => {
    expect(build(check({ target: {} })).refusals.join(" ")).toContain(
      "carries no URL",
    );
  });
});

describe("a JSON check", () => {
  it("rewrites a JSONPath into Vigil's dotted form", () => {
    const result = build(
      check({
        kind: "json",
        http: { jsonPath: "$.status.state", jsonExpectedValue: "ok" },
      }),
    );
    expect(result.input.config).toEqual({
      jsonPath: "status.state",
      expectedValue: "ok",
    });
  });

  it("refuses an expression with no single location to read", () => {
    const result = build(
      check({ kind: "json", http: { jsonPath: "$.items[*].name" } }),
    );
    expect(result.refusals.join(" ")).toContain("wildcard");
  });

  it("refuses a comparison that is not equality", () => {
    const result = build(
      check({ kind: "json", http: { jsonPath: "ok", jsonOperator: ">" } }),
    );
    expect(result.refusals.join(" ")).toContain(
      'compares the JSON value with ">"',
    );
  });
});

describe("a DNS check", () => {
  it("carries a record type Vigil resolves and one expected value", () => {
    const result = build(
      check({
        kind: "dns",
        target: { host: "www.example.com" },
        dns: { recordType: "cname", expectedValues: ["edge.example.net"] },
      }),
    );
    expect(result.input.config).toEqual({
      recordType: "CNAME",
      expectedValue: "edge.example.net",
    });
  });

  it("refuses a record type Vigil does not resolve rather than asking for another", () => {
    const result = build(
      check({
        kind: "dns",
        target: { host: "www.example.com" },
        dns: { recordType: "SRV" },
      }),
    );
    expect(result.refusals.join(" ")).toContain("SRV");
  });

  it("carries none of several expected values rather than asserting less", () => {
    const result = build(
      check({
        kind: "dns",
        target: { host: "www.example.com" },
        dns: { expectedValues: ["203.0.113.10", "203.0.113.11"] },
      }),
    );
    expect(result.input.config).toEqual({
      recordType: "A",
      expectedValue: null,
    });
    expect(result.notes.join(" ")).toContain("expected 2 values");
  });

  it("reports a per-check resolver it cannot use", () => {
    expect(
      notes(
        check({
          kind: "dns",
          target: { host: "www.example.com" },
          dns: { resolver: "8.8.8.8" },
        }),
      ),
    ).toContain("8.8.8.8");
  });
});

describe("a heartbeat", () => {
  it("carries the period and the grace, and always mints a new token", () => {
    const result = build(
      check({
        kind: "heartbeat",
        target: { label: "Nightly backup" },
        heartbeat: { periodSeconds: 3600, graceSeconds: 600 },
      }),
    );
    expect(result.input.intervalSeconds).toBe(3600);
    expect(result.input.config).toEqual({ graceSeconds: 600 });
    expect(result.notes.join(" ")).toContain("new push token was generated");
  });

  it("quotes a cron expression it cannot honour", () => {
    expect(
      notes(
        check({
          kind: "heartbeat",
          target: { label: "Backup" },
          heartbeat: { cron: "15 5 * * *" },
        }),
      ),
    ).toContain("15 5 * * *");
  });
});

describe("ports and hosts", () => {
  it("refuses a TCP check with no port rather than choosing one", () => {
    const result = build(
      check({ kind: "tcp", target: { host: "db.example.com" } }),
    );
    expect(result.refusals.join(" ")).toContain("needs a port");
  });

  it("refuses a host-shaped check with no host", () => {
    const result = build(check({ kind: "ping", target: {} }));
    expect(result.refusals.join(" ")).toContain("carries no hostname");
  });

  it("carries a TLS check's port and clamps its warning threshold", () => {
    const result = build(
      check({
        kind: "tls",
        target: { host: "www.example.com", port: 8443 },
        warnDays: 0,
      }),
    );
    expect(result.input.port).toBe(8443);
    expect(result.input.config).toEqual({ warnDays: 1 });
  });
});
