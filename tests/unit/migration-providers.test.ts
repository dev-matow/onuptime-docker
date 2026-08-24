import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SourceCheck, SourceSnapshot } from "@/modules/importers/model";
import {
  migrationCounts,
  renderLimitationList,
  renderRefusedTable,
  renderSourceTable,
  renderTypeTable,
} from "@/modules/importers/providers/compatibility";
import {
  PROVIDERS,
  UNSUPPORTED_SOURCES,
  findProvider,
  type ProviderAdapter,
} from "@/modules/importers/providers";
import { translateCheck } from "@/modules/importers/translate";

import {
  BETTERSTACK,
  CHECKLY,
  CRONITOR,
  DATADOG,
  FIXTURE_SECRET,
  GRAFANA,
  HEALTHCHECKS,
  HYPERPING,
  NEWRELIC,
  OHDEAR,
  PINGDOM,
  STATUSCAKE,
  UPDOWN,
  UPTIMECOM,
  UPTIMEROBOT,
} from "../fixtures/migrations/accounts";
import { fakeTransport, type Route } from "../fixtures/migrations/fetcher";

/**
 * Every adapter, read against an account shaped like the vendor's own.
 *
 * The properties asserted for all of them at once are the ones a
 * customer's trust actually rests on: no credential escapes, every
 * source type the adapter can meet has a published row, and a row that
 * claims a Vigil check type names one that exists.
 *
 * The per-provider blocks then pin the mappings that would be invisible
 * if they were wrong. A unit that is off by sixty, a keyword inversion
 * dropped, a status list read as an accept list when it is an alert
 * list: each of those produces a monitor that looks fine.
 */

/**
 * The page counts its sources in words, so the number and the sentence
 * cannot drift apart. Only the counts this registry can actually reach
 * are here: a source added without updating the prose fails on the
 * lookup rather than passing on a coincidence.
 */
const SOURCE_WORDS: Readonly<Record<number, string>> = {
  13: "thirteen",
  14: "fourteen",
  15: "fifteen",
  16: "sixteen",
  17: "seventeen",
  18: "eighteen",
};

const ACCOUNTS: Readonly<Record<string, Route[]>> = {
  betterstack: BETTERSTACK,
  checkly: CHECKLY,
  cronitor: CRONITOR,
  datadog: DATADOG,
  grafana: GRAFANA,
  healthchecks: HEALTHCHECKS,
  hyperping: HYPERPING,
  newrelic: NEWRELIC,
  ohdear: OHDEAR,
  pingdom: PINGDOM,
  statuscake: STATUSCAKE,
  updown: UPDOWN,
  uptimecom: UPTIMECOM,
  uptimerobot: UPTIMEROBOT,
};

/** Credentials that satisfy every adapter's required fields. */
function credentialsFor(provider: ProviderAdapter): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const field of provider.credentials) {
    if (field.choices !== undefined) {
      credentials[field.name] = field.choices[0]?.value ?? "";
      continue;
    }
    if (!field.required) continue;
    credentials[field.name] =
      field.name === "baseUrl"
        ? "https://synthetic-monitoring-api.grafana.net"
        : "fixture-token";
  }
  return credentials;
}

async function read(
  id: string,
): Promise<{ snapshot: SourceSnapshot; requests: number }> {
  const provider = findProvider(id);
  if (provider === undefined) throw new Error(`no adapter ${id}`);
  const routes = ACCOUNTS[id];
  if (routes === undefined) throw new Error(`no fixture account for ${id}`);
  const { api, options } = fakeTransport(routes);
  const snapshot = await provider.read({
    credentials: credentialsFor(provider),
    transport: options,
  });
  return { snapshot, requests: api.requests.length };
}

function byName(snapshot: SourceSnapshot, name: string): SourceCheck {
  const found = snapshot.checks.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(
      `no check named "${name}"; saw ${snapshot.checks.map((c) => c.name).join(", ")}`,
    );
  }
  return found;
}

/** Everything the check would say on a report, as one string. */
function reported(source: SourceCheck): string {
  const translated = translateCheck(source);
  return translated.outcome === "unsupported"
    ? translated.detail
    : [...translated.build.notes, ...translated.build.refusals].join(" ");
}

describe("the provider registry", () => {
  it("has an adapter for every account fixture and a fixture for every adapter", () => {
    expect(PROVIDERS.map((provider) => provider.id).sort()).toEqual(
      Object.keys(ACCOUNTS).sort(),
    );
  });

  it("gives every adapter an id, a vendor doc, and instructions for the token", () => {
    for (const provider of PROVIDERS) {
      expect(provider.docs, provider.id).toMatch(/^https:\/\//);
      expect(provider.access.length, provider.id).toBeGreaterThan(40);
      expect(provider.credentials.length, provider.id).toBeGreaterThan(0);
      expect(
        provider.credentials.some((field) => field.secret),
        `${provider.id} must take a secret`,
      ).toBe(true);
    }
  });

  it("explains every source type it can meet, and every one it refuses", () => {
    for (const provider of PROVIDERS) {
      expect(provider.capabilities.length, provider.id).toBeGreaterThan(0);
      for (const capability of provider.capabilities) {
        // A complete sentence, because "unsupported" on its own
        // satisfies the letter of the rule and none of its purpose.
        const note = capability.note.trim();
        const where = `${provider.id}:${capability.sourceType}`;
        expect(note.length, where).toBeGreaterThan(15);
        expect(note.endsWith("."), `${where} is not a sentence`).toBe(true);
      }
    }
  });

  it("only claims Vigil check types that exist", async () => {
    const { CHECK_TYPE_SPECS } = await import("@/modules/monitors/types/specs");
    for (const provider of PROVIDERS) {
      for (const capability of provider.capabilities) {
        if (capability.becomes === null) continue;
        expect(
          Object.hasOwn(CHECK_TYPE_SPECS, capability.becomes),
          `${provider.id} claims ${capability.becomes}`,
        ).toBe(true);
      }
    }
  });

  it("says why every unsupported source is unsupported, at length", () => {
    for (const source of UNSUPPORTED_SOURCES) {
      expect(source.docs).toMatch(/^https:\/\//);
      expect(source.reason.length, source.id).toBeGreaterThan(80);
    }
  });
});

describe("the published compatibility page", () => {
  const page = readFileSync(join(process.cwd(), "docs/MIGRATION.md"), "utf8");

  /**
   * Column padding is Prettier's business, not the matrix's. Comparing
   * the cells rather than the whitespace lets the page stay formatted
   * while still failing the moment a row's content drifts.
   *
   * The separator row is padding all the way down: Prettier widens its
   * dashes to the column, so a run of them is normalised too. Without
   * that, this test fails the moment anybody formats the repository,
   * which is how a guard gets switched off.
   */
  const cells = (markdown: string): string =>
    markdown
      .split("\n")
      .map((line) =>
        line.trim().startsWith("|")
          ? line
              .split("|")
              .map((part) => part.trim())
              .map((part) => (/^:?-{2,}:?$/.test(part) ? "---" : part))
              .join("|")
          : line.trim(),
      )
      .join("\n");

  it("lists exactly the sources that have an adapter", () => {
    expect(cells(page)).toContain(cells(renderSourceTable()));
  });

  it("publishes what every source type actually becomes", () => {
    expect(cells(page)).toContain(cells(renderTypeTable()));
  });

  it("publishes what each source cannot bring", () => {
    expect(cells(page)).toContain(cells(renderLimitationList()));
  });

  it("publishes the reason for every source it refuses", () => {
    expect(cells(page)).toContain(cells(renderRefusedTable()));
  });

  it("states the headline figure the registry supports, and no better one", () => {
    expect(page).toContain(
      `Vigil imports your monitors from ${SOURCE_WORDS[migrationCounts().sources] ?? migrationCounts().sources} other systems.`,
    );
  });
});

describe("reading every account", () => {
  it("never lets a credential out of the adapter", async () => {
    for (const id of Object.keys(ACCOUNTS)) {
      const { snapshot } = await read(id);
      const serialised = JSON.stringify(snapshot);
      expect(serialised, `${id} leaked a fixture secret`).not.toContain(
        FIXTURE_SECRET,
      );
      expect(serialised, `${id} leaked its own token`).not.toContain(
        "fixture-token",
      );
      // And the same again through the mapping layer, which is what the
      // report is actually built from.
      const rendered = snapshot.checks
        .map((check) => reported(check))
        .join(" ");
      expect(rendered, `${id} leaked through its report lines`).not.toContain(
        FIXTURE_SECRET,
      );
    }
  });

  it("gives every check an id, a name, the vendor's own type name and a target or a reason", async () => {
    for (const id of Object.keys(ACCOUNTS)) {
      const { snapshot } = await read(id);
      expect(snapshot.provider).toBe(id);
      expect(snapshot.facts.length, id).toBeGreaterThan(0);
      expect(snapshot.checks.length, id).toBeGreaterThan(0);
      for (const check of snapshot.checks) {
        expect(check.sourceId.length, `${id}:${check.name}`).toBeGreaterThan(0);
        expect(check.name.length, `${id}:${check.sourceId}`).toBeGreaterThan(0);
        expect(check.sourceType.length, `${id}:${check.name}`).toBeGreaterThan(
          0,
        );
        if (check.kind === "unsupported") {
          expect(
            (check.unsupportedReason ?? "").length,
            `${id}:${check.name} has no reason`,
          ).toBeGreaterThan(20);
        }
      }
    }
  });

  it("survives a row with fields missing rather than losing the account", async () => {
    const { snapshot } = await read("uptimerobot");
    const broken = byName(snapshot, "Half a monitor");
    expect(broken.kind).toBe("unsupported");
    expect(snapshot.checks.length).toBe(7);
  });
});

describe("UptimeRobot", () => {
  it("walks the cursor to the end of the list", async () => {
    const { snapshot } = await read("uptimerobot");
    expect(snapshot.checks.map((check) => check.sourceId)).toContain("7770005");
  });

  it("maps each type onto the check that means the same thing", async () => {
    const { snapshot } = await read("uptimerobot");
    expect(byName(snapshot, "Marketing site").kind).toBe("http");
    expect(byName(snapshot, "Gateway ping").kind).toBe("ping");
    expect(byName(snapshot, "Postgres port").kind).toBe("tcp");
    expect(byName(snapshot, "Postgres port").target.port).toBe(5432);
  });

  it("keeps the keyword inversion that lives in a separate field", async () => {
    const keyword = byName(
      snapshot0(await read("uptimerobot")),
      "Checkout keyword",
    );
    expect(keyword.http?.keyword).toBe("READY");
    expect(keyword.http?.keywordAbsent).toBe(true);
  });

  it("refuses a DNS monitor rather than resolving the resolver", async () => {
    const dns = byName(snapshot0(await read("uptimerobot")), "Zone A record");
    expect(dns.kind).toBe("unsupported");
    expect(dns.unsupportedReason).toContain("DNS server");
  });

  it("names the credential it did not read without reading it", async () => {
    const keyword = byName(
      snapshot0(await read("uptimerobot")),
      "Checkout keyword",
    );
    expect(keyword.withheld?.join(" ")).toContain("credential");
    expect(JSON.stringify(keyword)).not.toContain(FIXTURE_SECRET);
  });

  it("carries the group as a folder", async () => {
    const site = byName(snapshot0(await read("uptimerobot")), "Marketing site");
    expect(site.groupPath).toEqual(["Payments"]);
  });
});

describe("mappings that would produce a monitor that is down forever", () => {
  // Each of these was mapped before this audit, and each would have
  // produced a Vigil monitor that fails every interval for a reason the
  // operator could not see. A false red teaches people to ignore the
  // product; refusing is the honest outcome.

  it("refuses a UDP check, because Vigil's UDP probe needs a payload", async () => {
    const check = byName(
      snapshot0(await read("betterstack")),
      "Datagram probe",
    );
    expect(check.kind).toBe("unsupported");
    expect(reported(check)).toContain("empty datagram");
  });

  it("refuses SMTP on the port that speaks TLS before a byte of SMTP", async () => {
    const check = byName(
      snapshot0(await read("betterstack")),
      "Submission over TLS",
    );
    // The adapter maps it; the shared translator is what refuses it, so
    // this proves the rule holds for every provider rather than one.
    expect(check.kind).toBe("smtp");
    expect(check.target.port).toBe(465);
    expect(reported(check)).toContain("expects a TLS handshake");
  });

  it("refuses a gRPC check that calls a method rather than the health service", async () => {
    const checkly = byName(snapshot0(await read("checkly")), "Payments gRPC");
    expect(checkly.kind).toBe("unsupported");
    expect(checkly.unsupportedReason).toContain("BEHAVIOR mode");

    const datadog = byName(snapshot0(await read("datadog")), "Payments gRPC");
    expect(datadog.kind).toBe("unsupported");
    expect(datadog.unsupportedReason).toContain("unary");
  });
});

describe("Better Stack", () => {
  it("reads the timeout in the unit the type implies", async () => {
    const snapshot = snapshot0(await read("betterstack"));
    // Seconds on an HTTP monitor.
    expect(byName(snapshot, "Homepage keyword absence").timeoutMs).toBe(15_000);
    // Milliseconds on a TCP one, in the same field.
    expect(byName(snapshot, "Postgres port").timeoutMs).toBe(2_000);
  });

  it("keeps the inversion that Better Stack encodes as a separate type", async () => {
    const check = byName(
      snapshot0(await read("betterstack")),
      "Homepage keyword absence",
    );
    expect(check.http?.keyword).toBe("maintenance");
    expect(check.http?.keywordAbsent).toBe(true);
  });

  it("carries the confirmation period as a failure window, unchanged", async () => {
    const check = byName(
      snapshot0(await read("betterstack")),
      "Homepage keyword absence",
    );
    const translated = translateCheck(check);
    expect(translated.outcome).toBe("build");
    if (translated.outcome === "build") {
      expect(translated.build.input.failureWindowSeconds).toBe(120);
    }
  });

  it("refuses DNS, POP and Playwright monitors with the reason for each", async () => {
    const snapshot = snapshot0(await read("betterstack"));
    for (const name of ["Zone lookup", "POP mailbox", "Signup journey"]) {
      const check = byName(snapshot, name);
      expect(check.kind, name).toBe("unsupported");
      expect((check.unsupportedReason ?? "").length, name).toBeGreaterThan(40);
    }
  });

  it("says that Vigil also passes a 3xx, which Better Stack does not", async () => {
    // Better Stack: "We will check your website for a 2XX HTTP status
    // code." Vigil with no expected code also passes a 3XX, so a
    // monitor the source failed on a redirect would silently stop
    // alerting.
    const check = byName(
      snapshot0(await read("betterstack")),
      "Homepage keyword absence",
    );
    expect(check.http?.acceptedStatus).toEqual(["2xx"]);
    expect(reported(check)).toContain("any 2xx or 3xx");
  });

  it("reads a monitor as paused from the timestamp Better Stack stores", async () => {
    expect(
      byName(snapshot0(await read("betterstack")), "Postgres port").paused,
    ).toBe(true);
  });

  it("reads heartbeats as their own resource, with prefixed ids", async () => {
    const snapshot = snapshot0(await read("betterstack"));
    const backup = byName(snapshot, "Nightly backup");
    expect(backup.kind).toBe("heartbeat");
    expect(backup.sourceType).toBe("heartbeat");
    // The fixture's heartbeat deliberately shares the integer "2" with a
    // monitor, because the two id sequences are independent at the
    // source. An unprefixed id would make a re-import dedupe silently
    // match the wrong record.
    expect(backup.sourceId).toBe("heartbeat:2");
    expect(backup.heartbeat).toEqual({
      periodSeconds: 86_400,
      graceSeconds: 3_600,
    });
    expect(backup.groupPath).toEqual(["Cron jobs"]);
    expect(backup.paused).toBe(false);
  });

  it("reads a heartbeat as paused from its timestamp, outside any group", async () => {
    const check = byName(snapshot0(await read("betterstack")), "Hourly sync");
    expect(check.paused).toBe(true);
    expect(check.groupPath).toBeUndefined();
    expect(check.heartbeat).toEqual({
      periodSeconds: 3_600,
      graceSeconds: 300,
    });
  });

  it("names the ping token it did not read, and never the token itself", async () => {
    const snapshot = snapshot0(await read("betterstack"));
    const check = byName(snapshot, "Nightly backup");
    expect(check.withheld?.join(" ")).toContain("ping URL");
    expect(JSON.stringify(snapshot)).not.toContain(FIXTURE_SECRET);
  });
});

describe("Pingdom", () => {
  it("assembles a URL from the host, the path and the encryption flag", async () => {
    const check = byName(snapshot0(await read("pingdom")), "www prod");
    expect(check.target.url).toBe("https://www.example.com/health");
  });

  it("converts the interval out of minutes", async () => {
    expect(
      byName(snapshot0(await read("pingdom")), "www prod").intervalSeconds,
    ).toBe(300);
  });

  it("calls a check with post data a POST, so the mapping refuses it", async () => {
    const check = byName(snapshot0(await read("pingdom")), "checkout post");
    expect(check.http?.method).toBe("POST");
    expect(reported(check)).toContain("Vigil's HTTP check issues GET or HEAD");
  });

  it("keeps one bad check from costing the other four", async () => {
    const { snapshot } = await read("pingdom");
    expect(snapshot.checks).toHaveLength(5);
    const broken = byName(snapshot, "unreadable");
    expect(broken.kind).toBe("unsupported");
    expect(broken.unsupportedReason).toContain("would not return");
    expect(byName(snapshot, "smtp relay").kind).toBe("smtp");
  });

  it("names the header it dropped without quoting its value", async () => {
    const check = byName(snapshot0(await read("pingdom")), "www prod");
    expect(check.http?.headerNames).toEqual(["X-Env", "Authorization"]);
    expect(JSON.stringify(check)).not.toContain(FIXTURE_SECRET);
  });
});

describe("StatusCake", () => {
  it("never reads an alert-on status list as an accept list", async () => {
    const check = byName(
      snapshot0(await read("statuscake")),
      "example HTTP check",
    );
    expect(check.http?.acceptedStatus).toBeUndefined();
    expect(check.losses?.join(" ")).toContain(
      "opposite of an accepted-codes list",
    );
  });

  it("reads header names out of a JSON document stored as a string", async () => {
    const check = byName(
      snapshot0(await read("statuscake")),
      "example HTTP check",
    );
    expect(check.http?.headerNames).toEqual(["X-Env", "Authorization"]);
  });

  it("survives a header blob that is not JSON at all", async () => {
    const check = byName(snapshot0(await read("statuscake")), "head check");
    expect(check.http?.headerNames).toBeUndefined();
    expect(check.http?.method).toBe("HEAD");
  });

  it("walks every page of the list", async () => {
    const snapshot = snapshot0(await read("statuscake"));
    expect(snapshot.checks).toHaveLength(4);
    expect(byName(snapshot, "apex A record").kind).toBe("unsupported");
  });
});

describe("updown.io", () => {
  it("tells a status code from a keyword in the one column that holds both", async () => {
    const snapshot = snapshot0(await read("updown"));
    expect(byName(snapshot, "API status").http?.acceptedStatus).toEqual([
      "204",
    ]);
    expect(byName(snapshot, "Marketing site").http?.keyword).toBe(
      "All systems operational",
    );
  });

  it("reads a host and port out of the URL column for a TCP check", async () => {
    const check = byName(snapshot0(await read("updown")), "Primary DB port");
    expect(check.target).toEqual({ host: "db.example.com", port: 5432 });
    expect(check.paused).toBe(true);
  });

  it("says a pulse endpoint cannot be read back, on the check itself", async () => {
    const check = byName(snapshot0(await read("updown")), "Nightly backup");
    expect(check.kind).toBe("heartbeat");
    expect(check.losses?.join(" ")).toContain(
      "redacts a pulse check's ingest URL",
    );
  });
});

describe("Hyperping", () => {
  it("merges the detail response, which is where the keyword lives", async () => {
    const check = byName(snapshot0(await read("hyperping")), "API");
    expect(check.http?.keyword).toBe("healthy");
    expect(check.http?.acceptedStatus).toEqual(["200"]);
  });

  it("refuses to convert a delay whose unit is not published", async () => {
    const check = byName(snapshot0(await read("hyperping")), "API");
    expect(check.retries).toBeUndefined();
    expect(check.losses?.join(" ")).toContain("unit its API does not publish");
  });

  it("carries a DNS record type when the detail returns one", async () => {
    const check = byName(snapshot0(await read("hyperping")), "Apex DNS");
    expect(check.kind).toBe("dns");
    expect(check.dns?.recordType).toBe("A");
  });

  it("falls back to the summary when a detail read fails", async () => {
    const check = byName(snapshot0(await read("hyperping")), "Postgres");
    expect(check.kind).toBe("tcp");
    expect(check.target.port).toBe(5432);
  });
});

describe("Healthchecks.io", () => {
  it("turns every check into a heartbeat and splits the tag string", async () => {
    const snapshot = snapshot0(await read("healthchecks"));
    const backup = byName(snapshot, "Filesystem Backup");
    expect(backup.kind).toBe("heartbeat");
    expect(backup.heartbeat).toEqual({
      periodSeconds: 3600,
      graceSeconds: 600,
      cron: undefined,
    });
    expect(backup.tags).toEqual(["backup", "fs"]);
  });

  it("quotes a cron schedule it cannot honour, with its timezone", async () => {
    const check = byName(
      snapshot0(await read("healthchecks")),
      "Database Backup",
    );
    expect(check.heartbeat?.cron).toBe("15 5 * * * in UTC");
    expect(check.paused).toBe(true);
  });
});

describe("Cronitor", () => {
  it("reads the assertions it can express and reports the rest verbatim", async () => {
    const check = byName(snapshot0(await read("cronitor")), "Homepage");
    expect(check.http?.acceptedStatus).toEqual(["200"]);
    expect(check.http?.keyword).toBe("ok");
    expect(check.http?.certificateWarnDays).toBe(30);
    expect(check.losses?.join(" ")).toContain("response.time < 2s");
  });

  it("turns a job into a heartbeat and keeps its grace period", async () => {
    const check = byName(snapshot0(await read("cronitor")), "Nightly Backup");
    expect(check.kind).toBe("heartbeat");
    expect(check.heartbeat?.graceSeconds).toBe(300);
    expect(check.heartbeat?.cron).toBe("0 2 * * *");
  });

  it("refuses a TCP check whose host and port encoding is not published", async () => {
    const check = byName(snapshot0(await read("cronitor")), "SMTP port");
    expect(check.kind).toBe("unsupported");
    expect(check.unsupportedReason).toContain("no documented way");
  });
});

describe("Oh Dear", () => {
  it("names every other check running on the same site", async () => {
    const check = byName(snapshot0(await read("ohdear")), "example.com");
    const losses = check.losses?.join(" ") ?? "";
    expect(losses).toContain("certificate");
    expect(losses).toContain("broken links");
    // Disabled checks are not losses.
    expect(losses).not.toContain("Lighthouse");
  });

  it("reads a TCP port out of the URL, where Oh Dear keeps it", async () => {
    const check = byName(snapshot0(await read("ohdear")), "Outbound SMTP");
    expect(check.target).toEqual({ host: "smtp.example.com", port: 587 });
    expect(check.paused).toBe(true);
  });
});

describe("Uptime.com", () => {
  it("reads msp_threshold as a timeout or as expiry days, by type", async () => {
    const snapshot = snapshot0(await read("uptimecom"));
    expect(byName(snapshot, "Marketing site").timeoutMs).toBe(30_000);
    expect(byName(snapshot, "Wildcard cert expiry").warnDays).toBe(30);
    expect(byName(snapshot, "Wildcard cert expiry").timeoutMs).toBeUndefined();
  });

  it("reports an interval whose unit the vendor does not publish", async () => {
    const check = byName(snapshot0(await read("uptimecom")), "Marketing site");
    expect(check.intervalSeconds).toBeUndefined();
    expect(check.losses?.join(" ")).toContain("publishes no unit");
  });

  it("carries a plain-string match and refuses a regular expression", async () => {
    const snapshot = snapshot0(await read("uptimecom"));
    expect(byName(snapshot, "Marketing site").http?.keyword).toBe(
      "All systems operational",
    );
    expect(byName(snapshot, "Regex match").http?.keyword).toBeUndefined();
    expect(byName(snapshot, "Regex match").losses?.join(" ")).toContain(
      "regular expression",
    );
  });

  it("maps WHOIS onto domain expiry and reads the days off the same field", async () => {
    const check = byName(
      snapshot0(await read("uptimecom")),
      "Domain registration",
    );
    expect(check.kind).toBe("domain");
    expect(check.warnDays).toBe(45);
  });

  it("reports a scripted API check rather than importing its first step", async () => {
    const check = byName(
      snapshot0(await read("uptimecom")),
      "Checkout API script",
    );
    expect(check.kind).toBe("unsupported");
  });
});

describe("Checkly", () => {
  it("reads the two assertion shapes Vigil holds and reports the rest", async () => {
    const check = byName(snapshot0(await read("checkly")), "Checkout API");
    expect(check.http?.acceptedStatus).toEqual(["200"]);
    expect(check.http?.keyword).toBe("ok");
    expect(check.http?.otherAssertions?.join(" ")).toContain("JSON_BODY");
  });

  it("converts a frequency out of minutes and keeps the response-time limit", async () => {
    const check = byName(snapshot0(await read("checkly")), "Checkout API");
    expect(check.intervalSeconds).toBe(300);
    expect(check.timeoutMs).toBe(20_000);
  });

  it("converts a heartbeat's period and grace out of their own units", async () => {
    const check = byName(snapshot0(await read("checkly")), "Nightly ETL");
    expect(check.heartbeat).toEqual({
      periodSeconds: 86_400,
      graceSeconds: 1_800,
    });
  });

  it("reads an SSL check's host out of sslConfig, where Checkly keeps it", async () => {
    const check = byName(snapshot0(await read("checkly")), "Certificate");
    expect(check.kind).toBe("tls");
    expect(check.target).toEqual({ host: "www.example.com", port: 8443 });
    expect(check.warnDays).toBe(21);
  });

  it("reads a sub-minute frequency out of the offset, not as sixty seconds", async () => {
    const check = byName(snapshot0(await read("checkly")), "Sub-minute API");
    expect(check.intervalSeconds).toBe(20);
  });

  it("says a response-time limit is enforced as a timeout, not measured", async () => {
    const check = byName(snapshot0(await read("checkly")), "Sub-minute API");
    expect(check.timeoutMs).toBe(5000);
    const text = reported(check);
    expect(text).toContain("request timeout");
    expect(text).toContain("degraded above 2000ms");
  });

  it("refuses a browser check, which carries no request to map", async () => {
    const check = byName(snapshot0(await read("checkly")), "Login flow");
    expect(check.kind).toBe("unsupported");
    expect(check.unsupportedReason).toContain("no request object");
  });

  it("asks for group settings, so a check in a group has a real URL", async () => {
    const provider = findProvider("checkly");
    const { api, options } = fakeTransport(CHECKLY);
    await provider?.read({
      credentials: { token: "fixture-token" },
      transport: options,
    });
    expect(
      api.requests.some(
        (request) => request.query.applyGroupSettings === "true",
      ),
    ).toBe(true);
  });
});

describe("Datadog Synthetics", () => {
  it("reads the record type out of the assertion, where Datadog keeps it", async () => {
    const check = byName(snapshot0(await read("datadog")), "example.com DNS");
    expect(check.kind).toBe("dns");
    expect(check.dns?.recordType).toBe("A");
    expect(check.dns?.expectedValues).toEqual(["203.0.113.10"]);
  });

  it("converts a timeout out of seconds and keeps the interval in them", async () => {
    const check = byName(snapshot0(await read("datadog")), "Checkout API");
    expect(check.timeoutMs).toBe(30_000);
    expect(check.intervalSeconds).toBe(60);
  });

  it("reads the retry interval out of milliseconds, next to a field in seconds", async () => {
    const check = byName(snapshot0(await read("datadog")), "Checkout API");
    expect(check.retries?.count).toBe(2);
    expect(check.retries?.intervalSeconds).toBe(0.3);
  });

  it("re-reads a test the list returned without a request", async () => {
    const check = byName(snapshot0(await read("datadog")), "Login flow");
    expect(check.kind).toBe("unsupported");
    expect(check.unsupportedReason).toContain("free-form object");
  });

  it("reads a certificate expiry threshold from the operator Datadog documents", async () => {
    // `isInMoreThan`, not `moreThan`: reading the wrong one meant no SSL
    // test ever carried its threshold.
    const check = byName(snapshot0(await read("datadog")), "Edge certificate");
    expect(check.kind).toBe("tls");
    expect(check.warnDays).toBe(21);
    expect(check.target).toEqual({ host: "www.example.com", port: 443 });
  });

  it("reports the assertions it cannot hold, one line each", async () => {
    const check = byName(snapshot0(await read("datadog")), "Checkout API");
    expect(check.http?.acceptedStatus).toEqual(["200"]);
    expect(check.http?.keyword).toBe("ready");
    expect(check.losses?.join(" ")).toContain("responseTime");
  });
});

describe("Grafana Cloud Synthetic Monitoring", () => {
  it("reads an enum that arrives as an integer and one that arrives as a name", async () => {
    const snapshot = snapshot0(await read("grafana"));
    expect(byName(snapshot, "api-prod").http?.method).toBe("GET");
    expect(byName(snapshot, "dns-apex").dns?.recordType).toBe("A");
  });

  it("converts frequency and timeout out of milliseconds", async () => {
    const check = byName(snapshot0(await read("grafana")), "api-prod");
    expect(check.intervalSeconds).toBe(60);
    expect(check.timeoutMs).toBe(5_000);
  });

  it("reports every regular-expression assertion rather than approximating one", async () => {
    const check = byName(snapshot0(await read("grafana")), "api-prod");
    expect(check.losses?.join(" ")).toContain("not matching a pattern");
  });

  it("refuses a k6 script rather than downgrading it to a GET", async () => {
    const check = byName(snapshot0(await read("grafana")), "k6-journey");
    expect(check.kind).toBe("unsupported");
  });

  it("reads a host and port out of a target string", async () => {
    const check = byName(snapshot0(await read("grafana")), "smtp-edge");
    expect(check.target).toEqual({ host: "mail.example.com", port: 25 });
  });
});

describe("New Relic Synthetics", () => {
  it("reads configuration from the REST API, which is the only one that returns it", async () => {
    const check = byName(snapshot0(await read("newrelic")), "prod-api-health");
    expect(check.kind).toBe("http");
    expect(check.target.url).toBe("https://api.example.com/health");
    expect(check.intervalSeconds).toBe(300);
    expect(check.http?.keyword).toBe("ok");
  });

  it("names a monitor the entity search knows and the REST API did not return", async () => {
    const { snapshot } = await read("newrelic");
    const missing = snapshot.extras.find((extra) => extra.label === "cert-www");
    expect(missing).toBeDefined();
    expect(missing?.detail).toContain("did not return it");
  });

  it("refuses a scripted browser monitor", async () => {
    const check = byName(snapshot0(await read("newrelic")), "checkout-flow");
    expect(check.kind).toBe("unsupported");
    expect(check.paused).toBe(true);
  });
});

/** Sugar so a test reads `byName(snapshot0(await read(x)), name)`. */
function snapshot0(result: { snapshot: SourceSnapshot }): SourceSnapshot {
  return result.snapshot;
}
