import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compatibilityCounts,
  renderCountsTable,
  renderFieldTable,
  renderTypeTable,
} from "@/modules/importers/kuma/compatibility";
import {
  buildMonitorInput,
  vigilJsonPath,
  vigilStatusPageSlug,
} from "@/modules/importers/kuma/import";
import {
  FIELD_MATRIX,
  TYPE_MATRIX,
  mappedTypes,
  unsupportedTypes,
  type KumaMonitorRow,
} from "@/modules/importers/kuma/mapping";
import { KUMA_PIN } from "@/modules/importers/kuma/pinned";
import { readKumaDatabase } from "@/modules/importers/kuma/read";
import { CHECK_TYPE_SPECS } from "@/modules/monitors/types/specs";

/**
 * The mapping matrices, judged on their own terms.
 *
 * Everything here is a property of the tables rather than of a
 * migration, so none of it needs a database. The integration suite
 * proves the tables describe the fixture; this one proves they are
 * internally coherent — that a `mapped` column names where it lands,
 * that an `unsupported` type says why, that no entry is a shrug.
 *
 * The transform functions are exercised against rows read out of the
 * real fixture, including the rows that never become monitors. Vigil's
 * URL schema refuses the IP literal both of Kuma's HTTP monitors watch,
 * so the keyword and status-code rules — the most used part of the most
 * used type — would otherwise never run in a test at all.
 */

const FIXTURE = join(process.cwd(), "tests/fixtures/kuma/kuma-2.4.0.db");

function fixtureRow(kumaType: string): KumaMonitorRow {
  const row = readKumaDatabase(FIXTURE).monitors.find(
    (candidate) => candidate.type === kumaType,
  );
  if (!row) throw new Error(`the fixture has no ${kumaType} monitor`);
  return row;
}

/** No host registries — the types exercised below reference neither. */
const NO_REGISTRIES = {
  dockerHostsById: new Map(),
  remoteBrowsersById: new Map(),
};

describe("the field matrix", () => {
  it("classifies each column exactly once", () => {
    const columns = FIELD_MATRIX.map((field) => field.column);
    expect(new Set(columns).size).toBe(columns.length);
  });

  it("holds as many columns as the pinned release has", () => {
    expect(FIELD_MATRIX).toHaveLength(KUMA_PIN.monitorColumnCount);
  });

  it("says where a carried column lands, and stays silent about destinations it has none for", () => {
    for (const field of FIELD_MATRIX) {
      const carried =
        field.classification === "mapped" ||
        field.classification === "transformed";
      if (carried) {
        expect(field.target, field.column).not.toBeNull();
      } else {
        expect(field.target, field.column).toBeNull();
      }
    }
  });

  it("names the Vigil limitation behind every column it cannot carry", () => {
    // A shrug — "not supported", "see basic_auth_user" — passes any
    // non-empty check and tells an operator nothing. Naming Vigil
    // forces the note to be about what this product cannot do, which
    // is the only thing the reader can act on.
    for (const field of FIELD_MATRIX) {
      if (field.classification !== "unsupported") continue;
      expect(field.note, field.column).toContain("Vigil");
      expect(field.note.trim(), field.column).toMatch(/\.$/);
    }
  });

  it("says something of its own about every column, never only a cross-reference", () => {
    for (const field of FIELD_MATRIX) {
      expect(field.note.trim(), field.column).not.toMatch(/^See [\w_]+\.$/);
    }
  });
});

describe("the type matrix", () => {
  it("names each Kuma type exactly once", () => {
    const types = TYPE_MATRIX.map((entry) => entry.kumaType);
    expect(new Set(types).size).toBe(types.length);
  });

  it("holds as many types as the pinned release's selector offers", () => {
    expect(TYPE_MATRIX).toHaveLength(KUMA_PIN.selectableTypes);
  });

  it("now names a Vigil check type for every one of Kuma's thirty-one", () => {
    expect(mappedTypes()).toHaveLength(KUMA_PIN.selectableTypes);
    expect(unsupportedTypes()).toHaveLength(0);
    expect(mappedTypes().length + unsupportedTypes().length).toBe(
      KUMA_PIN.selectableTypes,
    );
  });

  it("says what changes for every type whose Vigil check is not the same check", () => {
    // A mapped type with no `transform` is a claim that the monitor
    // means exactly what it meant in Kuma. Eighteen of these were
    // written the week Vigil grew an equivalent, and the temptation
    // there is to map the type and say nothing — which is how an
    // operator ends up with a gRPC monitor calling a method their
    // server does not implement.
    const identical = mappedTypes().filter((entry) => entry.transform === null);
    expect(identical.map((entry) => entry.kumaType)).toEqual(["http", "ping"]);
  });

  it("only ever maps to a check type this build actually registers", () => {
    for (const entry of mappedTypes()) {
      expect(Object.keys(CHECK_TYPE_SPECS), entry.kumaType).toContain(
        entry.checkType,
      );
    }
  });

  it("says why for every type it does not map, and nothing for the ones it does", () => {
    for (const entry of unsupportedTypes()) {
      expect(entry.reason?.length ?? 0, entry.kumaType).toBeGreaterThan(20);
    }
    for (const entry of mappedTypes()) {
      expect(entry.reason, entry.kumaType).toBeNull();
    }
  });
});

describe("the compatibility page", () => {
  const page = readFileSync(join(process.cwd(), "docs/KUMA-IMPORT.md"), "utf8");

  /**
   * Column padding is Prettier's business, not the matrix's. Comparing
   * the cells rather than the whitespace lets the page stay formatted
   * while still failing the moment a row's content drifts.
   */
  function cells(markdown: string): string {
    return markdown
      .split("\n")
      .map((line) =>
        line
          .trim()
          .replace(/\s*\|\s*/g, "|")
          .replace(/-{2,}/g, "-"),
      )
      .join("\n");
  }

  it("publishes the type table the matrix actually holds", () => {
    expect(cells(page)).toContain(cells(renderTypeTable()));
  });

  it("publishes the classification counts the matrix actually holds", () => {
    expect(cells(page)).toContain(cells(renderCountsTable()));
  });

  it("publishes a row for every column the matrix classifies", () => {
    expect(cells(page)).toContain(cells(renderFieldTable()));
  });

  it("states the headline figure the type matrix supports, and no better one", () => {
    const counts = compatibilityCounts();
    expect(page).toContain(
      `${counts.types.mapped} of Uptime Kuma's ${counts.types.total} monitor types import today`,
    );
    // The claim the release reference calls out by name, and it stays
    // forbidden now that every type maps — because it is still not the
    // claim the evidence supports. A type having an equivalent is not
    // every monitor of that type importing, and the fixture proves the
    // difference: see the count the integration suite asserts against
    // this same page.
    expect(page).not.toContain("all 31 monitor types");
  });

  it("keeps the two counts apart, so a mapped type is never read as an imported monitor", () => {
    expect(page).toContain("A type having an equivalent is not a promise");
  });
});

describe("rewriting Kuma's JSONPath as Vigil's dotted path", () => {
  it("strips the JSONPath root from a plain location", () => {
    expect(vigilJsonPath("$.status.state")).toBe("status.state");
    expect(vigilJsonPath("$.ok")).toBe("ok");
  });

  it("leaves a path that was already dotted alone", () => {
    expect(vigilJsonPath("db.connected")).toBe("db.connected");
    expect(vigilJsonPath("checks[0].name")).toBe("checks[0].name");
  });

  it("refuses an expression that does not name one fixed location", () => {
    // Narrowing any of these means choosing a meaning the operator
    // never wrote, so the monitor is refused instead.
    expect(vigilJsonPath("$")).toBeNull();
    expect(vigilJsonPath("$.items[*].name")).toBeNull();
    expect(vigilJsonPath("$..name")).toBeNull();
    expect(vigilJsonPath("$.items[?(@.ok)]")).toBeNull();
  });
});

describe("building a Vigil monitor from a Kuma keyword monitor", () => {
  it("moves the keyword and its inversion onto the HTTP check's own settings", () => {
    // Vigil has no keyword type: the body assertion is a setting on the
    // HTTP check. The fixture's keyword monitor is seeded inverted.
    const built = buildMonitorInput(
      fixtureRow("keyword"),
      "http",
      NO_REGISTRIES,
    );
    expect(built.input.checkType).toBe("http");
    expect(built.input.bodyKeyword).toBe("seed-keyword-value");
    expect(built.input.keywordAbsent).toBe(true);
  });

  it("leaves the status expectation unset, because Kuma's default is a range Vigil already accepts", () => {
    const built = buildMonitorInput(
      fixtureRow("keyword"),
      "http",
      NO_REGISTRIES,
    );
    expect(built.input.expectedStatusCode).toBeUndefined();
    expect(built.notes.join(" ")).not.toContain("accepted status codes");
  });

  it("still refuses the row, because Vigil's URL rules reject an IP literal", () => {
    const built = buildMonitorInput(
      fixtureRow("keyword"),
      "http",
      NO_REGISTRIES,
    );
    expect(built.refusals.join(" ")).toContain("127.0.0.1");
  });
});

describe("building a Vigil monitor from a Kuma HTTP monitor", () => {
  it("refuses a list of accepted status codes it cannot express, and says what it dropped", () => {
    // The fixture seeds ["200-299","301","418"]; Vigil holds one exact
    // code or none.
    const built = buildMonitorInput(fixtureRow("http"), "http", NO_REGISTRIES);
    expect(built.input.expectedStatusCode).toBeUndefined();
    expect(built.notes.join(" ")).toContain("418");
    expect(built.notes.join(" ")).toContain("any 2xx or 3xx");
  });

  it("refuses a verb Vigil does not send rather than quietly turning it into a GET", () => {
    const built = buildMonitorInput(fixtureRow("http"), "http", NO_REGISTRIES);
    expect(built.refusals.join(" ")).toContain("POST");
  });

  it("names the request body, headers and basic auth it would have dropped", () => {
    const built = buildMonitorInput(fixtureRow("http"), "http", NO_REGISTRIES);
    const notes = built.notes.join(" ");
    for (const column of ["body", "headers", "basic_auth_user", "proxy_id"]) {
      expect(notes, column).toContain(column);
    }
  });

  it("carries the certificate-expiry warning, which is Vigil's tlsCheck", () => {
    const built = buildMonitorInput(fixtureRow("http"), "http", NO_REGISTRIES);
    expect(built.input.tlsCheck).toBe(true);
  });
});

/**
 * The eighteen types that only became importable once the registry had
 * an equivalent for them.
 *
 * Exercised against the fixture's own rows rather than hand-made ones,
 * for the reason the fixture exists: `kafkaProducerSaslOptions` is a
 * JSON blob, a SQL Server connection string is ADO's key-value form and
 * not a URL, an Oracle one is Easy Connect, and the SNMP community
 * string lives in a column named after RADIUS. None of those shapes is
 * one anybody would invent.
 */
describe("the types that were unsupported until Vigil had an equivalent", () => {
  it("turns a Kuma group into a Vigil group whose target names what it covers", () => {
    const built = buildMonitorInput(
      fixtureRow("group"),
      "group",
      NO_REGISTRIES,
    );
    expect(built.refusals).toEqual([]);
    expect(built.input.url).toBe("seed-group");
  });

  it("reads Kuma's numeric manual status as the status an operator declared", () => {
    const built = buildMonitorInput(
      fixtureRow("manual"),
      "manual",
      NO_REGISTRIES,
    );
    expect(built.refusals).toEqual([]);
    expect(built.input.config).toMatchObject({ status: "up" });
  });

  it("refuses to carry a push token Vigil's own rule would not accept", () => {
    // The fixture's token is 17 characters; Vigil's are 32–128, because
    // the token is the only thing authenticating /api/push/<token>.
    const built = buildMonitorInput(fixtureRow("push"), "push", NO_REGISTRIES);
    expect(built.input.config).toEqual({});
    expect(built.notes.join(" ")).toContain("32–128 characters");
  });

  it("splits Kuma's gRPC host:port and says the health service is not the method Kuma called", () => {
    const built = buildMonitorInput(
      fixtureRow("grpc-keyword"),
      "grpc",
      NO_REGISTRIES,
    );
    expect(built.input.url).toBe("grpc.seed.invalid");
    expect(built.input.port).toBe(50_051);
    expect(built.input.config).toMatchObject({
      service: "SeedService",
      tls: true,
    });
    const notes = built.notes.join(" ");
    expect(notes).toContain("grpc.health.v1.Health");
    // The metadata line Vigil cannot send is named, not counted.
    expect(notes).toContain("seed-key");
    expect(notes).toContain("grpc_protobuf");
  });

  it("refuses a Kafka monitor whose broker speaks a SASL mechanism Vigil does not", () => {
    // Carrying SCRAM credentials as PLAIN would create a monitor that
    // can never authenticate — an outage that is not one.
    const built = buildMonitorInput(
      fixtureRow("kafka-producer"),
      "kafka-producer",
      NO_REGISTRIES,
    );
    expect(built.refusals.join(" ")).toContain("SCRAM-SHA-256");
    expect(built.input.url).toBe("kafka1.seed.invalid");
    expect(built.notes.join(" ")).toContain("kafka2.seed.invalid");
  });

  it("takes the first RabbitMQ node and names the ones it left", () => {
    const built = buildMonitorInput(
      fixtureRow("rabbitmq"),
      "rabbitmq",
      NO_REGISTRIES,
    );
    expect(built.refusals).toEqual([]);
    expect(built.input.url).toBe("https://rabbit1.seed.invalid:15672");
    expect(built.input.config).toMatchObject({
      username: "seedrabbit",
      password: "seedrabbitpass",
    });
  });

  it("reads the SNMP community out of the column Kuma named after RADIUS", () => {
    // Kuma reuses `radius_password` three ways. On a v3 monitor it is a
    // pass phrase with no protocol column beside it, so it is refused a
    // home rather than written into `community`, where nothing reads it.
    const built = buildMonitorInput(fixtureRow("snmp"), "snmp", NO_REGISTRIES);
    expect(built.refusals).toEqual([]);
    expect(built.input.config).toMatchObject({
      oid: "1.3.6.1.2.1.1.3.0",
      version: "3",
      v3Username: "seedsnmp",
      community: null,
    });
    const notes = built.notes.join(" ");
    expect(notes).toContain("pass phrase");
    // `oid > 100` is not `oid == x`, which is the one shape that maps.
    expect(notes).toContain("condition(s) dropped");
  });

  it("rewrites a SQL Server ADO connection string as the URL Vigil targets", () => {
    const built = buildMonitorInput(
      fixtureRow("sqlserver"),
      "sqlserver",
      NO_REGISTRIES,
    );
    expect(built.refusals).toEqual([]);
    expect(built.input.url).toBe(
      "sqlserver://seed:seedpass@mssql.seed.invalid:1433/seed",
    );
  });

  it("rewrites an Oracle Easy Connect string and drops the login nothing sends", () => {
    const built = buildMonitorInput(
      fixtureRow("oracledb"),
      "oracledb",
      NO_REGISTRIES,
    );
    expect(built.refusals).toEqual([]);
    expect(built.input.url).toBe("oracle://oracle.seed.invalid:1521/FREEPDB1");
    expect(built.notes.join(" ")).toContain("never signs in");
  });

  it("carries a RADIUS secret and asserts the Access-Accept Kuma asserted", () => {
    const built = buildMonitorInput(
      fixtureRow("radius"),
      "radius",
      NO_REGISTRIES,
    );
    expect(built.refusals).toEqual([]);
    expect(built.input.config).toMatchObject({
      secret: "seedradiussecret",
      username: "seedradius",
      expectAccept: true,
    });
    expect(built.notes.join(" ")).toContain("radius_called_station_id");
  });

  it("resolves a GameDig game id to one of the three protocols Vigil speaks", () => {
    const built = buildMonitorInput(
      fixtureRow("gamedig"),
      "gamedig",
      NO_REGISTRIES,
    );
    expect(built.refusals).toEqual([]);
    expect(built.input.config).toEqual({ protocol: "source" });
  });

  it("refuses a game it cannot place rather than querying with the wrong protocol", () => {
    const row = { ...fixtureRow("gamedig"), game: "some-game-nobody-mapped" };
    const built = buildMonitorInput(row, "gamedig", NO_REGISTRIES);
    expect(built.refusals.join(" ")).toContain("some-game-nobody-mapped");
  });

  it("makes a system-service monitor say which machine it now speaks for", () => {
    const built = buildMonitorInput(
      fixtureRow("system-service"),
      "system-service",
      NO_REGISTRIES,
    );
    expect(built.refusals).toEqual([]);
    expect(built.input.url).toBe("seed-daemon.service");
    expect(built.notes.join(" ")).toContain("Vigil's worker");
  });

  it("carries a WebSocket subprotocol and refuses to ignore the accept header", () => {
    const built = buildMonitorInput(
      fixtureRow("websocket-upgrade"),
      "websocket",
      NO_REGISTRIES,
    );
    expect(built.refusals).toEqual([]);
    expect(built.input.url).toBe("wss://ws.seed.invalid/socket");
    expect(built.input.config).toMatchObject({ subprotocol: "seed-proto" });
    expect(built.notes.join(" ")).toContain(
      "ws_ignore_sec_websocket_accept_header",
    );
  });

  it("lifts a Globalping hostname out of the URL and says the measurement changed", () => {
    const built = buildMonitorInput(
      fixtureRow("globalping"),
      "globalping",
      NO_REGISTRIES,
    );
    expect(built.refusals).toEqual([]);
    expect(built.input.url).toBe("globalping.seed.invalid");
    expect(built.input.config).toEqual({ location: "Europe" });
    const notes = built.notes.join(" ");
    expect(notes).toContain('"http" measurement');
    expect(notes).toContain("seed-globalping-keyword");
  });

  it("falls back to the install's renderer when a remote browser is not in the database", () => {
    const built = buildMonitorInput(
      fixtureRow("real-browser"),
      "real-browser",
      NO_REGISTRIES,
    );
    expect(built.refusals).toEqual([]);
    expect(built.input.config).toMatchObject({ serviceUrl: null });
    expect(built.notes.join(" ")).toContain("screenshot_delay");
  });

  it("copies a named Kuma remote browser onto the monitor that named it", () => {
    const row = { ...fixtureRow("real-browser"), remote_browser: 7 };
    const built = buildMonitorInput(row, "real-browser", {
      dockerHostsById: new Map(),
      remoteBrowsersById: new Map([
        [7, { id: 7, name: "shared pool", url: "http://browserless:3000" }],
      ]),
    });
    expect(built.input.config).toMatchObject({
      serviceUrl: "http://browserless:3000",
    });
  });

  it("keeps a SIP monitor on Vigil's UDP default, because Kuma stores no transport", () => {
    const built = buildMonitorInput(
      fixtureRow("sip-options"),
      "sip",
      NO_REGISTRIES,
    );
    expect(built.refusals).toEqual([]);
    expect(built.input.url).toBe("sip.seed.invalid");
    expect(built.input.port).toBe(5060);
    expect(built.input.config).toEqual({
      transport: "udp",
      requestUser: null,
    });
  });

  it("targets a Tailscale peer by the name tailscaled resolves, not by DNS", () => {
    const built = buildMonitorInput(
      fixtureRow("tailscale-ping"),
      "tailscale-ping",
      NO_REGISTRIES,
    );
    expect(built.refusals).toEqual([]);
    expect(built.input.url).toBe("tailscale.seed.invalid");
  });

  it("carries a Steam server's host and query port", () => {
    const built = buildMonitorInput(
      fixtureRow("steam"),
      "steam",
      NO_REGISTRIES,
    );
    expect(built.refusals).toEqual([]);
    expect(built.input.url).toBe("steam.seed.invalid");
    expect(built.input.port).toBe(27_016);
  });
});

describe("rewriting a Kuma status page slug", () => {
  it("keeps a slug Vigil's rules already accept", () => {
    expect(vigilStatusPageSlug("seed-status")).toBe("seed-status");
  });

  it("rewrites one they do not, because a slug is a public URL", () => {
    expect(vigilStatusPageSlug("Seed Status!")).toBe("seed-status");
    expect(vigilStatusPageSlug("--main--")).toBe("main");
  });

  it("refuses one there is nothing left of", () => {
    expect(vigilStatusPageSlug("!!")).toBeNull();
    expect(vigilStatusPageSlug("ab")).toBeNull();
  });
});
