import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { eq, like } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import {
  monitorHeartbeats,
  monitors,
  statusPageMonitors,
  statusPages,
} from "@/db/schema";
import { importKumaDatabase } from "@/modules/importers/kuma/import";
import {
  FIELD_MATRIX,
  TYPE_MATRIX,
  type TypeMapping,
} from "@/modules/importers/kuma/mapping";
import { KUMA_PIN } from "@/modules/importers/kuma/pinned";
import {
  readKumaDatabase,
  type KumaDatabase,
} from "@/modules/importers/kuma/read";
import type {
  ImportReport,
  ReportEntry,
} from "@/modules/importers/kuma/report";
import { SECRET_MASK } from "@/modules/monitors/types/config";
import type { Monitor } from "@/modules/monitors/service";

import { createTestOrg, db, type TestActor } from "../helpers";

/**
 * The Uptime Kuma importer, proved against the real thing.
 *
 * `kuma-2.4.0.db` is a database Uptime Kuma created, migrated and wrote
 * every row of — not a SQLite file shaped like one. The distinction is
 * the whole test: an importer checked against a hand-rolled schema
 * proves only that it can read the schema its author imagined, and the
 * failures that matter in a migration are the shapes nobody would have
 * guessed. `accepted_statuscodes_json` as a JSON array of range
 * strings, `conditions` as an expression tree, credentials inline in
 * `database_connection_string`, booleans stored as the string '0'.
 *
 * Three properties are worth more than the rest, and they are the ones
 * that fail loudly on a fixture refresh:
 *
 * 1. the pinned facts are the fixture's actual facts;
 * 2. the field matrix classifies *exactly* the columns present — a
 *    column Kuma adds fails this, and so does one the matrix forgets;
 * 3. nothing leaves Kuma without a report line saying what became of it.
 */

const FIXTURE = join(process.cwd(), "tests/fixtures/kuma/kuma-2.4.0.db");

/**
 * The Kuma monitors that actually become Vigil monitors.
 *
 * Every one of Kuma's 31 *types* now maps, and 27 of the fixture's 31
 * *monitors* import. The four that do not are the point of listing them
 * by hand rather than deriving the list: each is refused by a rule that
 * is meant to refuse it, and a derived list would go green the day one
 * of those rules quietly stopped applying.
 *
 * - 1 `seed-http` and 2 `seed-keyword` watch `http://127.0.0.1:…`.
 *   Vigil's URL schema demands a hostname; that is an SSRF boundary,
 *   not a formatting preference.
 * - 6 `seed-docker` reaches its daemon over a unix socket, so Kuma's
 *   host record has no hostname for Vigil's target to name.
 * - 15 `seed-kafka` authenticates with SCRAM-SHA-256 and Vigil's Kafka
 *   check speaks SASL/PLAIN, so an imported monitor could never
 *   authenticate and would report an outage that is not one.
 */
const REFUSED_IDS = [1, 2, 6, 15];
const MAPPABLE_IDS = [
  3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
  26, 27, 28, 29, 30, 31,
];

let source: KumaDatabase;
let actor: TestActor;
let report: ImportReport;
let created: Map<string, Monitor>;

function monitorEntry(sourceId: number): ReportEntry {
  const entry = report.entries.find(
    (candidate) =>
      candidate.kind === "monitor" && candidate.sourceId === String(sourceId),
  );
  if (!entry) throw new Error(`no report entry for Kuma monitor ${sourceId}`);
  return entry;
}

function imported(sourceId: number): Monitor {
  const entry = monitorEntry(sourceId);
  const id = entry.monitorId;
  if (id === null) {
    throw new Error(
      `Kuma monitor ${sourceId} was ${entry.outcome}: ${entry.detail}`,
    );
  }
  const monitor = created.get(id);
  if (!monitor) throw new Error(`monitor ${id} is not in the database`);
  return monitor;
}

function config(sourceId: number): Record<string, unknown> {
  const value = imported(sourceId).config;
  expect(value).toBeTypeOf("object");
  return (value ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  // A status page slug is globally unique because it is a public URL,
  // and this suite imports the same Kuma database several times per
  // run into throwaway organisations that are never deleted. Left
  // alone, `seed-status`, `seed-status-2`, … fill up the importer's
  // suffix range after a few runs and the page stops importing — a
  // failure about the test database, not about the code. Every other
  // row this suite writes is scoped to its own organisation; this one
  // is not, so this suite stands its own leftovers down.
  await db.delete(statusPages).where(like(statusPages.slug, "seed-status%"));

  source = readKumaDatabase(FIXTURE);
  actor = await createTestOrg();
  report = await importKumaDatabase(db, actor, source);
  const rows = await db
    .select()
    .from(monitors)
    .where(eq(monitors.organizationId, actor.organizationId));
  created = new Map(rows.map((row) => [row.id, row]));
});

describe("the pinned Uptime Kuma release", () => {
  it("names the schema version the fixture actually stamps", () => {
    expect(source.schema.databaseVersion).toBe(KUMA_PIN.databaseVersion);
  });

  it("names the number of columns the fixture's monitor table actually has", () => {
    expect(source.schema.monitorColumns).toHaveLength(
      KUMA_PIN.monitorColumnCount,
    );
  });

  it("names the number of selectable types the fixture actually contains", () => {
    expect(source.schema.monitorTypes).toHaveLength(KUMA_PIN.selectableTypes);
  });

  it("counts Group and Manual in the 31 and out of the 29", () => {
    expect(source.schema.monitorTypes).toContain("group");
    expect(source.schema.monitorTypes).toContain("manual");
    expect(KUMA_PIN.selectableTypes - KUMA_PIN.selectableProbeTypes).toBe(2);
  });

  it("finds no drift between the fixture and the pin", () => {
    expect(report.drift).toEqual([]);
    expect(report.status).toBe("completed");
  });
});

describe("the field matrix", () => {
  it("classifies exactly the columns the fixture's monitor table has", () => {
    const classified = FIELD_MATRIX.map((field) => field.column).sort();
    expect(classified).toEqual([...source.schema.monitorColumns].sort());
  });

  it("leaves no column without a reason for its classification", () => {
    for (const field of FIELD_MATRIX) {
      expect(field.note.trim().length, field.column).toBeGreaterThan(0);
    }
  });

  it("names a Vigil destination for every column it claims to carry", () => {
    for (const field of FIELD_MATRIX) {
      const carried =
        field.classification === "mapped" ||
        field.classification === "transformed";
      expect(field.target === null, field.column).toBe(!carried);
    }
  });
});

describe("the type matrix", () => {
  it("covers exactly the monitor types the fixture contains", () => {
    const classified = TYPE_MATRIX.map((entry) => entry.kumaType).sort();
    expect(classified).toEqual([...source.schema.monitorTypes].sort());
  });

  it("gives every unmapped type a reason and every mapped type a check Vigil has", () => {
    // Widened to the interface: the matrix is `as const`, so once every
    // entry maps the compiler narrows the unmapped branch to `never`
    // and the assertion stops compiling — which would delete the check
    // exactly when a future release needs it again.
    const matrix: readonly TypeMapping[] = TYPE_MATRIX;
    for (const entry of matrix) {
      if (entry.checkType === null) {
        expect(
          entry.reason?.trim().length ?? 0,
          entry.kumaType,
        ).toBeGreaterThan(0);
      } else {
        expect(entry.reason, entry.kumaType).toBeNull();
      }
    }
  });
});

describe("importing the pinned fixture", () => {
  it("creates a Vigil monitor for every row Vigil's own rules accept", () => {
    const importedIds = report.entries
      .filter((entry) => entry.kind === "monitor" && entry.monitorId !== null)
      .map((entry) => Number(entry.sourceId))
      .sort((a, b) => a - b);
    expect(importedIds).toEqual(MAPPABLE_IDS);
    expect(created.size).toBe(MAPPABLE_IDS.length);
    expect(report.totals.monitorsCreated).toBe(MAPPABLE_IDS.length);
  });

  it("refuses exactly the four rows that are meant to be refused", () => {
    const refusedIds = report.entries
      .filter((entry) => entry.kind === "monitor" && entry.monitorId === null)
      .map((entry) => Number(entry.sourceId))
      .sort((a, b) => a - b);
    expect(refusedIds).toEqual(REFUSED_IDS);
  });

  it("publishes the number of fixture monitors that actually import", () => {
    // The type count on the compatibility page is generated from the
    // matrix and asserted by the unit suite. This one cannot be — it is
    // the result of running the importer against a real database — so
    // it is asserted here, against the run that just happened. A doc
    // that says 27 while the importer manages 24 fails the build.
    const page = readFileSync(
      join(process.cwd(), "docs/KUMA-IMPORT.md"),
      "utf8",
    );
    expect(page).toContain(
      `${report.totals.monitorsCreated} of the fixture's ${source.monitors.length} monitors import`,
    );
  });

  it("reports the monitors in Kuma's own order, whatever order it created them in", () => {
    // Groups have to be created before their members; a person reading
    // the report is comparing it to a Kuma screen.
    const reported = report.entries
      .filter((entry) => entry.kind === "monitor")
      .map((entry) => Number(entry.sourceId));
    expect(reported).toEqual(source.monitors.map((row) => row.id));
  });

  it("leaves a report line for every record in the source database", () => {
    const sourceRecords =
      source.monitors.length +
      source.notifications.length +
      source.monitorNotifications.length +
      source.statusPages.length +
      source.statusPageGroups.length +
      source.statusPageGroupMonitors.length +
      source.tags.length +
      source.monitorTags.length +
      source.maintenances.length +
      source.monitorMaintenances.length +
      source.dockerHosts.length +
      source.proxies.length +
      source.heartbeats.length;
    expect(report.entries).toHaveLength(sourceRecords);
  });

  it("explains itself on every line, whatever the outcome", () => {
    for (const entry of report.entries) {
      expect(
        entry.detail.trim().length,
        `${entry.kind}:${entry.sourceId}`,
      ).toBeGreaterThan(0);
    }
  });

  it("never reports a monitor as imported without having created one", () => {
    for (const entry of report.entries) {
      if (entry.kind !== "monitor") continue;
      const wrote = entry.monitorId !== null;
      const claims =
        entry.outcome === "imported" || entry.outcome === "transformed";
      expect(wrote, `${entry.sourceId} ${entry.outcome}`).toBe(claims);
    }
  });

  it("accounts for all 31 source monitors and drops none of them", () => {
    expect(
      report.entries.filter((entry) => entry.kind === "monitor"),
    ).toHaveLength(source.monitors.length);
  });

  it("carries the paused state in both directions, not just the paused one", () => {
    // Kuma stored every monitor it was not actually running inactive.
    // The group (9) is the one active row that imports, and it has to
    // arrive running — an importer that paused everything would be
    // indistinguishable from one that carried the flag, on this fixture.
    for (const sourceId of MAPPABLE_IDS) {
      expect(imported(sourceId).paused, String(sourceId)).toBe(sourceId !== 9);
    }
  });

  it("turns Kuma's retry count and retry interval into one failure window", () => {
    // seed-port: maxretries 0, retry_interval 60 — down on the first
    // failed check, which is a window of zero.
    expect(imported(3).failureWindowSeconds).toBe(0);
  });

  it("carries the interval and the timeout Kuma stored", () => {
    expect(imported(3).intervalSeconds).toBe(60);
    // Kuma keeps the timeout in seconds as a double.
    expect(imported(3).timeoutMs).toBe(12_000);
  });

  it("falls back to Vigil's own timeout when Kuma never stored one", () => {
    expect(imported(16).timeoutMs).toBe(10_000);
  });
});

describe("round-tripping the distinctive values the fixture seeds", () => {
  it("carries a TCP port check's host and port", () => {
    const monitor = imported(3);
    expect(monitor.checkType).toBe("tcp");
    expect(monitor.url).toBe("port.seed.invalid");
    expect(monitor.port).toBe(6543);
  });

  it("carries a ping check's host and echo count", () => {
    const monitor = imported(4);
    expect(monitor.checkType).toBe("ping");
    expect(monitor.url).toBe("ping.seed.invalid");
    expect(config(4).packets).toBe(4);
  });

  it("carries a DNS check's record type, and its one expressible condition", () => {
    const monitor = imported(5);
    expect(monitor.checkType).toBe("dns");
    expect(monitor.url).toBe("dns.seed.invalid");
    expect(config(5).recordType).toBe("MX");
    // Kuma stored this as a `record contains "seed-mx"` expression tree.
    expect(config(5).expectedValue).toBe("seed-mx");
  });

  it("rewrites a JSON query's JSONPath as Vigil's dotted path", () => {
    const monitor = imported(14);
    expect(monitor.checkType).toBe("json-query");
    expect(monitor.url).toBe("https://jsonquery.seed.invalid/api");
    // Kuma stored `$.status.state`.
    expect(config(14).jsonPath).toBe("status.state");
    expect(config(14).expectedValue).toBe("seed-ok");
  });

  it("carries an MQTT broker's host, port and credentials", () => {
    const monitor = imported(16);
    expect(monitor.checkType).toBe("mqtt");
    expect(monitor.url).toBe("mqtt.seed.invalid");
    expect(monitor.port).toBe(1883);
    expect(config(16).username).toBe("seedmqtt");
    expect(config(16).password).toBe("seedmqttpass");
  });

  it("carries an SMTP check's host and port", () => {
    const monitor = imported(19);
    expect(monitor.checkType).toBe("smtp");
    expect(monitor.url).toBe("smtp.seed.invalid");
    expect(monitor.port).toBe(587);
  });

  it("splits a MongoDB connection string into the host and port Vigil targets", () => {
    const monitor = imported(24);
    expect(monitor.checkType).toBe("mongodb");
    expect(monitor.url).toBe("mongo.seed.invalid");
    expect(monitor.port).toBe(27_017);
  });

  it("splits a MySQL connection string into the host and port Vigil targets", () => {
    const monitor = imported(25);
    expect(monitor.checkType).toBe("mysql");
    expect(monitor.url).toBe("mysql.seed.invalid");
    expect(monitor.port).toBe(3306);
  });

  it("keeps a PostgreSQL connection string whole, because that is Vigil's target too", () => {
    const monitor = imported(27);
    expect(monitor.checkType).toBe("postgres");
    expect(monitor.url).toBe(
      "postgres://seed:seedpass@pg.seed.invalid:5432/seed",
    );
  });

  it("lifts the Redis password out of the connection string into the config", () => {
    const monitor = imported(29);
    expect(monitor.checkType).toBe("redis");
    expect(monitor.url).toBe("redis.seed.invalid");
    expect(monitor.port).toBe(6379);
    expect(config(29).password).toBe("seedpass");
  });

  /**
   * The eighteen types the importer could not express until the
   * registry had an equivalent. Written against the stored row rather
   * than the builder's output, because the thing worth proving is that
   * the value survived `createMonitorSchema`, `monitorColumnsFor` and
   * the config merge — not that a function returned it.
   */

  it("carries the SNMP OID, version and v3 user out of Kuma's reused columns", () => {
    const monitor = imported(20);
    expect(monitor.checkType).toBe("snmp");
    expect(monitor.url).toBe("snmp.seed.invalid");
    expect(monitor.port).toBe(161);
    expect(config(20)).toMatchObject({
      oid: "1.3.6.1.2.1.1.3.0",
      version: "3",
      v3Username: "seedsnmp",
      community: null,
    });
  });

  it("carries a RADIUS shared secret, test account and Access-Accept expectation", () => {
    const monitor = imported(28);
    expect(monitor.checkType).toBe("radius");
    expect(monitor.url).toBe("radius.seed.invalid");
    expect(monitor.port).toBe(1812);
    expect(config(28)).toMatchObject({
      secret: "seedradiussecret",
      username: "seedradius",
      password: "seedradiuspass",
      expectAccept: true,
    });
  });

  it("carries a gRPC endpoint as a host, a port and the service the health check asks about", () => {
    const monitor = imported(13);
    expect(monitor.checkType).toBe("grpc");
    expect(monitor.url).toBe("grpc.seed.invalid");
    expect(monitor.port).toBe(50_051);
    expect(config(13)).toMatchObject({ service: "SeedService", tls: true });
  });

  it("carries a RabbitMQ node and its management credentials", () => {
    const monitor = imported(17);
    expect(monitor.checkType).toBe("rabbitmq");
    expect(monitor.url).toBe("https://rabbit1.seed.invalid:15672");
    expect(config(17)).toMatchObject({
      username: "seedrabbit",
      password: "seedrabbitpass",
    });
  });

  it("rewrites a SQL Server ADO connection string into the URL Vigil stores", () => {
    const monitor = imported(23);
    expect(monitor.checkType).toBe("sqlserver");
    expect(monitor.url).toBe(
      "sqlserver://seed:seedpass@mssql.seed.invalid:1433/seed",
    );
  });

  it("rewrites an Oracle Easy Connect string and stores no credential", () => {
    const monitor = imported(26);
    expect(monitor.checkType).toBe("oracledb");
    expect(monitor.url).toBe("oracle://oracle.seed.invalid:1521/FREEPDB1");
    expect(monitor.url).not.toContain("seedoracle");
  });

  it("carries a game server's protocol family, host and query port", () => {
    const monitor = imported(30);
    expect(monitor.checkType).toBe("gamedig");
    expect(monitor.url).toBe("game.seed.invalid");
    expect(monitor.port).toBe(27_015);
    expect(config(30).protocol).toBe("source");
  });

  it("carries a WebSocket URL and subprotocol", () => {
    const monitor = imported(22);
    expect(monitor.checkType).toBe("websocket");
    expect(monitor.url).toBe("wss://ws.seed.invalid/socket");
    expect(config(22).subprotocol).toBe("seed-proto");
  });

  it("carries a systemd unit name as the target, because nothing is dialled", () => {
    const monitor = imported(7);
    expect(monitor.checkType).toBe("system-service");
    expect(monitor.url).toBe("seed-daemon.service");
    expect(monitor.port).toBeNull();
  });

  it("carries a Globalping location and the hostname out of Kuma's URL", () => {
    const monitor = imported(12);
    expect(monitor.checkType).toBe("globalping");
    expect(monitor.url).toBe("globalping.seed.invalid");
    expect(config(12).location).toBe("Europe");
  });

  it("carries a manual monitor's declared status", () => {
    const monitor = imported(11);
    expect(monitor.checkType).toBe("manual");
    expect(monitor.url).toBe("seed-manual");
    expect(config(11)).toMatchObject({ status: "up" });
  });

  it("carries a SIP host and port on Vigil's UDP default", () => {
    const monitor = imported(18);
    expect(monitor.checkType).toBe("sip");
    expect(monitor.url).toBe("sip.seed.invalid");
    expect(monitor.port).toBe(5060);
    expect(config(18).transport).toBe("udp");
  });

  it("carries a Tailscale peer and a Steam query port", () => {
    expect(imported(21).checkType).toBe("tailscale-ping");
    expect(imported(21).url).toBe("tailscale.seed.invalid");
    expect(imported(31).checkType).toBe("steam");
    expect(imported(31).port).toBe(27_016);
  });
});

describe("credentials", () => {
  it("masks a stored secret in the report the caller renders", () => {
    const preview = monitorEntry(16).configPreview as Record<string, unknown>;
    expect(preview.password).toBe(SECRET_MASK);
    expect(preview.username).toBe("seedmqtt");
  });

  it("never echoes a seeded credential anywhere in the report", () => {
    const serialised = JSON.stringify(report);
    for (const secret of [
      "seedmqttpass",
      "seedproxypass",
      "seedmailpass",
      "seed-telegram-token",
      "seedkafkapass",
      "seedrabbitpass",
      "seedradiussecret",
      "seedPushToken1234",
      "seed-gamedig-token",
    ]) {
      expect(serialised, secret).not.toContain(secret);
    }
  });
});

describe("the relationships between records, not just the records", () => {
  it("carries the group hierarchy onto the members, which is where Vigil stores it", () => {
    const group = imported(9);
    expect(group.checkType).toBe("group");
    // Every child Kuma attached to seed-group and that imported.
    const children = MAPPABLE_IDS.filter(
      (sourceId) =>
        source.monitors.find((row) => row.id === sourceId)?.parent === 9,
    );
    expect(children.length).toBeGreaterThan(15);
    for (const sourceId of children) {
      expect(imported(sourceId).parentId, String(sourceId)).toBe(group.id);
    }
  });

  it("names the group on the report line of a child that lost it", () => {
    // seed-kafka is refused, and its line still says which group it was
    // in — an operator recreating it by hand needs to know.
    expect(monitorEntry(15).detail).toContain("seed-group");
  });

  it("creates the status page and publishes the monitors that were on it", async () => {
    const entry = report.entries.find(
      (candidate) => candidate.kind === "status-page",
    );
    expect(entry?.outcome).toBe("transformed");
    expect(entry?.detail).toContain("published");

    const pages = await db
      .select()
      .from(statusPages)
      .where(eq(statusPages.organizationId, actor.organizationId));
    expect(pages).toHaveLength(1);
    const page = pages[0]!;
    expect(page.published).toBe(true);
    // Kuma's show_powered_by is off on the fixture's page.
    expect(page.showBranding).toBe(false);
    expect(page.slug.startsWith("seed-status")).toBe(true);

    const shown = await db
      .select()
      .from(statusPageMonitors)
      .where(eq(statusPageMonitors.statusPageId, page.id));
    // The Kuma page listed seed-http (refused), seed-postgres and
    // seed-push. Two of the three make it, and the third is reported.
    expect(shown).toHaveLength(2);
    const ids = new Set(shown.map((row) => row.monitorId));
    expect(ids.has(imported(27).id)).toBe(true);
    expect(ids.has(imported(10).id)).toBe(true);
  });

  it("reports the Kuma public group whose name Vigil's flat list cannot hold", () => {
    const entry = report.entries.find(
      (candidate) => candidate.kind === "status-page-group",
    );
    expect(entry?.outcome).toBe("unsupported");
    expect(entry?.label).toBe("Seeded services");
    expect(entry?.detail).toContain("one ordered list");
  });

  it("says of each monitor on the Kuma page whether it reached the Vigil one", () => {
    const members = report.entries.filter(
      (entry) => entry.kind === "status-page-monitor",
    );
    expect(members).toHaveLength(source.statusPageGroupMonitors.length);
    expect(
      members.filter((entry) => entry.outcome === "imported"),
    ).toHaveLength(2);
    expect(members.find((entry) => entry.sourceId === "1:1")?.detail).toContain(
      "did not import",
    );
  });

  it("carries a push token only when Vigil's own rule would accept it", async () => {
    // The fixture's token is 17 characters and Vigil's are 32–128, so a
    // fresh one is generated — and the report says so rather than
    // leaving an operator to discover the endpoint changed.
    const monitor = imported(10);
    expect(monitor.checkType).toBe("push");
    const token = (monitor.config as { token?: string }).token;
    expect(token).toBeTypeOf("string");
    expect(token).not.toBe("seedPushToken1234");
    expect(monitorEntry(10).detail).toContain("32–128 characters");
  });

  it("carries a push monitor's last heartbeat, so it is not born having never reported", async () => {
    // The fixture's push monitor never ran, which is exactly the case
    // the reporting has to be honest about: there is nothing to carry
    // and no line claiming there was.
    const beats = await db
      .select()
      .from(monitorHeartbeats)
      .where(eq(monitorHeartbeats.monitorId, imported(10).id));
    expect(beats).toHaveLength(0);

    const withBeat = await createTestOrg();
    const seeded: KumaDatabase = {
      ...source,
      heartbeats: [
        {
          monitorId: 10,
          beats: 4,
          lastAt: "2026-07-31 22:15:00.000",
          lastStatus: 1,
          lastMessage: "backup finished",
          lastPingMs: 4210,
        },
      ],
    };
    const second = await importKumaDatabase(db, withBeat, seeded);
    const pushEntry = second.entries.find(
      (entry) => entry.kind === "monitor" && entry.sourceId === "10",
    );
    expect(pushEntry?.monitorId).not.toBeNull();
    const carried = await db
      .select()
      .from(monitorHeartbeats)
      .where(eq(monitorHeartbeats.monitorId, pushEntry!.monitorId!));
    expect(carried).toHaveLength(1);
    expect(carried[0]?.reportedStatus).toBe("up");
    expect(carried[0]?.message).toBe("backup finished");
    expect(carried[0]?.responseTimeMs).toBe(4210);
    // Kuma stores UTC without saying so; a naive parse would read this
    // as the worker's local midnight-ish and change what "overdue"
    // means.
    expect(carried[0]?.receivedAt.toISOString()).toBe(
      "2026-07-31T22:15:00.000Z",
    );
    expect(
      second.entries.find((entry) => entry.kind === "heartbeat-history")
        ?.outcome,
    ).toBe("transformed");
  });
});

describe("a dry run", () => {
  it("reports exactly what a real run would, and writes none of it", async () => {
    const previewActor = await createTestOrg();
    const preview = await importKumaDatabase(db, previewActor, source, {
      dryRun: true,
    });

    expect(preview.status).toBe("preview");
    expect(preview.totals.monitorsCreated).toBe(MAPPABLE_IDS.length);
    // The summary an operator confirms against has to be the same
    // summary they get: same lines, same outcomes, same reasons.
    expect(
      preview.entries.map((entry) => [
        entry.kind,
        entry.sourceId,
        entry.outcome,
      ]),
    ).toEqual(
      report.entries.map((entry) => [
        entry.kind,
        entry.sourceId,
        entry.outcome,
      ]),
    );

    const rows = await db
      .select()
      .from(monitors)
      .where(eq(monitors.organizationId, previewActor.organizationId));
    expect(rows).toHaveLength(0);
    const pages = await db
      .select()
      .from(statusPages)
      .where(eq(statusPages.organizationId, previewActor.organizationId));
    expect(pages).toHaveLength(0);
  });
});

describe("records Vigil has no home for", () => {
  function outcomeOf(kind: ReportEntry["kind"], sourceId: string): ReportEntry {
    const entry = report.entries.find(
      (candidate) => candidate.kind === kind && candidate.sourceId === sourceId,
    );
    if (!entry) throw new Error(`no ${kind} entry for ${sourceId}`);
    return entry;
  }

  it("reports every notification provider and every monitor it was attached to", () => {
    expect(
      report.entries.filter((entry) => entry.kind === "notification"),
    ).toHaveLength(source.notifications.length);
    expect(
      report.entries.filter((entry) => entry.kind === "notification-link"),
    ).toHaveLength(source.monitorNotifications.length);
    expect(outcomeOf("notification", "1").outcome).toBe("unsupported");
  });

  it("reports the maintenance window and warns that imported monitors will alert through it", () => {
    const entry = outcomeOf("maintenance", "1");
    expect(entry.outcome).toBe("unsupported");
    expect(entry.detail).toContain("alert during it");
  });

  it("reports the tag and both monitors it was applied to", () => {
    expect(outcomeOf("tag", "1").outcome).toBe("unsupported");
    expect(
      report.entries.filter((entry) => entry.kind === "tag-application"),
    ).toHaveLength(source.monitorTags.length);
  });

  it("reports the Docker host, and says plainly that nothing ended up using it", () => {
    // The fixture's one Docker monitor is refused (its host is a local
    // socket with no hostname), so the host record is carried nowhere.
    // Saying "consumed" here would be the comfortable lie.
    const entry = outcomeOf("docker-host", "1");
    expect(entry.outcome).toBe("unsupported");
    expect(entry.detail).toContain("no imported monitor referenced this host");
  });

  it("reports the proxy without ever having read its credentials", () => {
    const entry = outcomeOf("proxy", "1");
    expect(entry.outcome).toBe("unsupported");
    expect(entry.detail).toContain("credentials were not read");
  });

  it("says how much history stays behind, per monitor that has any", () => {
    const histories = report.entries.filter(
      (entry) => entry.kind === "heartbeat-history",
    );
    expect(histories).toHaveLength(source.heartbeats.length);
    expect(histories[0]?.detail).toMatch(/\d+ heartbeat/);
  });
});

describe("a monitor whose type maps but whose row does not", () => {
  it("skips an HTTP monitor Vigil's own URL rules refuse, and says which rule", () => {
    // Kuma happily watches http://127.0.0.1:3001/. Vigil's target
    // schema demands a hostname, which is an SSRF boundary rather than
    // a formatting preference, so the monitor is refused rather than
    // written in a shape the edit form could never save again.
    const entry = monitorEntry(1);
    expect(entry.outcome).toBe("skipped");
    expect(entry.monitorId).toBeNull();
    expect(entry.detail).toContain("127.0.0.1");
  });

  it("names every reason a row was refused, not just the first", () => {
    // seed-http is both a POST and an IP-literal URL. An operator who
    // fixes the verb should not then discover the URL.
    const entry = monitorEntry(1);
    expect(entry.detail).toContain("POST");
    expect(entry.detail).toContain("rejects the target");
  });

  it("skips a Docker monitor whose Kuma host is a local socket with no hostname", () => {
    const entry = monitorEntry(6);
    expect(entry.outcome).toBe("skipped");
    expect(entry.detail).toContain("seed-docker-host");
  });
});

describe("a Kuma database from a schema this importer has never read", () => {
  let futureDir: string;
  let futurePath: string;
  let future: KumaDatabase;

  beforeAll(() => {
    futureDir = mkdtempSync(join(tmpdir(), "vigil-kuma-future-"));
    futurePath = join(futureDir, "kuma.db");
    // A copy of the real fixture, moved forward — not a second
    // hand-made database. Everything else about it stays true.
    copyFileSync(FIXTURE, futurePath);
    const ahead = new DatabaseSync(futurePath);
    try {
      ahead.exec("alter table monitor add column vigil_unknown_column TEXT");
      ahead.exec(
        "update setting set value = '11' where key = 'database_version'",
      );
    } finally {
      ahead.close();
    }
    future = readKumaDatabase(futurePath);
  });

  afterAll(() => {
    rmSync(futureDir, { recursive: true, force: true });
  });

  it("refuses it, naming the version and the column nobody has classified", async () => {
    const other = await createTestOrg();
    const refused = await importKumaDatabase(db, other, future);

    expect(refused.status).toBe("refused");
    expect(refused.totals.monitorsCreated).toBe(0);
    expect(refused.drift.map((entry) => entry.subject)).toContain(
      "database_version",
    );
    expect(refused.drift.map((entry) => entry.subject)).toContain(
      "monitor_columns",
    );
    expect(JSON.stringify(refused.drift)).toContain("vigil_unknown_column");

    const rows = await db
      .select()
      .from(monitors)
      .where(eq(monitors.organizationId, other.organizationId));
    expect(rows).toHaveLength(0);
  });

  it("still leaves a line per monitor, so a refusal is not silence either", async () => {
    const other = await createTestOrg();
    const refused = await importKumaDatabase(db, other, future);
    expect(
      refused.entries.filter((entry) => entry.kind === "monitor"),
    ).toHaveLength(future.monitors.length);
    for (const entry of refused.entries) {
      expect(entry.outcome).toBe("skipped");
    }
  });

  it("imports anyway when the caller accepts the drift, with the drift still on the report", async () => {
    const other = await createTestOrg();
    const forced = await importKumaDatabase(db, other, future, {
      allowSchemaDrift: true,
    });
    expect(forced.status).toBe("completed");
    expect(forced.drift.length).toBeGreaterThan(0);
    expect(forced.totals.monitorsCreated).toBe(MAPPABLE_IDS.length);
  });
});
