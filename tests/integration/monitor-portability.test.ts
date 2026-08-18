import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { monitors } from "@/db/schema";
import {
  exportMonitors,
  importMonitors,
  monitorExportSchema,
} from "@/modules/monitors/portability";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import { createMonitor, setMonitorPaused } from "@/modules/monitors/service";
import { maskTargetSecret, restoreTargetSecret } from "@/modules/monitors/spec";
import { SECRET_MASK } from "@/modules/monitors/types/config";
import { CHECK_TYPE_SPECS } from "@/modules/monitors/types/specs";

import { createTestOrg, db } from "../helpers";

/**
 * Export and import, for every registered type.
 *
 * The round trip is the easy half. The two things this suite really
 * guards are what must NOT round trip: a credential must never be in the
 * file, and a record that cannot be imported must be reported rather
 * than dropped.
 */

const CONFIGS: Record<string, Record<string, unknown> | null> = {
  http: null,
  tcp: null,
  ping: { packets: 3 },
  dns: { recordType: "AAAA", expectedValue: "2001:db8::1" },
  "tls-expiry": { warnDays: 21 },
  "domain-expiry": { warnDays: 45 },
  postgres: null,
  mysql: null,
  mongodb: null,
  redis: { password: "export-secret-redis" },
  docker: { containerName: "exported", socketPath: "/var/run/docker.sock" },
  mqtt: { username: "export-user", password: "export-secret-mqtt" },
  rabbitmq: { username: "export-user", password: "export-secret-rabbit" },
  "kafka-producer": {
    topic: "export.orders",
    message: "vigil export check",
    username: "export-user",
    password: "export-secret-kafka",
    tls: true,
  },
  smtp: null,
  // Both database types keep their credential in the connection string,
  // exactly as postgres does, so there is no config blob to export.
  sqlserver: null,
  oracledb: null,
  ldap: {
    bindDn: "cn=vigil,ou=service,dc=export,dc=example",
    bindPassword: "export-secret-ldap",
  },
  ssh: { expectedBanner: "OpenSSH_9" },
  imap: { requiredCapability: "IDLE" },
  ftp: { username: "export-user", password: "export-secret-ftp" },
  "json-query": { jsonPath: "$.ok", expectedValue: "true" },
  globalping: {
    location: "Germany",
    probeLimit: 3,
    packets: 4,
    maxPacketLossPct: 20,
    apiToken: "globalping-export-token",
  },
  "real-browser": {
    serviceUrl: "https://browserless.export.example",
    token: "browserless-export-token",
    settleMs: 1_500,
  },
  sip: { transport: "tcp", requestUser: "vigil-probe" },
  snmp: {
    oid: "1.3.6.1.2.1.1.3.0",
    version: "2c",
    community: "export-community",
  },
  "system-service": null,
  "tailscale-ping": { packets: 4, requireDirect: true },
  // The token is a secret, so it is masked on the way out and generated
  // fresh on the way in — a copied push monitor gets its own endpoint,
  // which is the only safe answer when a template moves between tenants.
  push: { graceSeconds: 45 },
  group: null,
  manual: { status: "degraded", note: "vendor is investigating" },
  memcached: { username: "export-user", password: "export-secret-memcached" },
  // The API key is the other credential this type can hold, so the
  // export path has to mask a field that is not called "password".
  elasticsearch: { apiKey: "export-secret-elastic-key" },
  // No blob: A2S has no settings and no credential.
  steam: null,
  gamedig: { protocol: "quake3" },
  udp: {
    payload: "00ff2a",
    payloadEncoding: "hex",
    expectedResponse: "deadbeef",
  },
  ntp: { maxOffsetMs: 750 },
  // Both credentials are masked on the way out, so what this proves is
  // the other half: the settings around them — the account name, the NAS
  // identifier, the accept requirement — still arrive.
  radius: {
    secret: "export-secret-radius",
    username: "export-user",
    password: "export-secret-account",
    nasIdentifier: "exported",
    expectAccept: true,
  },
  // The Authorization header is masked on the way out, so what survives
  // the round trip is the subprotocol next to it — the setting that
  // decides whether the check is watching the right endpoint at all.
  websocket: {
    subprotocol: "graphql-ws",
    authorization: "export-secret-websocket",
  },
  grpc: {
    service: "orders.v1.Orders",
    tls: true,
    authorization: "export-secret-grpc",
  },
};

const TARGETS: Record<string, string> = {
  http: "https://export.example.com/health",
  "json-query": "https://export.example.com/api",
  tcp: "db.export.example",
  ping: "host.export.example",
  dns: "export.example",
  "tls-expiry": "export.example",
  "domain-expiry": "export.example",
  postgres: "postgres://u:p@db.export.example:5432/app",
  mysql: "db.export.example",
  mongodb: "db.export.example",
  redis: "cache.export.example",
  docker: "docker.export.example",
  mqtt: "broker.export.example",
  rabbitmq: "https://rabbit.export.example:15672",
  "kafka-producer": "kafka.export.example",
  smtp: "mail.export.example",
  grpc: "api.export.example",
  websocket: "wss://ws.export.example/socket",
  globalping: "globalping.export.example",
  "real-browser": "https://browser.export.example/app",
  sip: "sip.export.example",
  snmp: "switch.export.example",
  "system-service": "nginx.service",
  "tailscale-ping": "db-1",
  // The password travels in the target rather than in a config blob, so
  // what this proves is the other half of the export contract: a
  // credential that is part of the address survives the round trip, and
  // `describeTarget` is the thing that keeps it out of an email.
  sqlserver: "sqlserver://u:p@db.export.example:1433/app",
  oracledb: "oracle://db.export.example:1521/ORCLPDB1",
  ldap: "ldap.export.example",
  ssh: "bastion.export.example",
  imap: "imap.export.example",
  ftp: "files.export.example",
  push: "nightly-backup",
  group: "EU region",
  manual: "Stripe payments",
  memcached: "cache.export.example",
  elasticsearch: "https://search.export.example:9200",
  steam: "cs.export.example",
  gamedig: "q3.export.example",
  udp: "collector.export.example",
  ntp: "time.export.example",
  radius: "radius.export.example",
};

/**
 * Ports for the types whose schema requires one. Absent elsewhere,
 * because `createMonitorSchema` refuses a port on a type that takes
 * none — and the importer validates with that same schema, which is the
 * point of this suite.
 */
const PORTS: Record<string, number | null> = {
  tcp: 5432,
  mysql: 3306,
  mongodb: 27017,
  redis: 6379,
  postgres: 5432,
  smtp: 587,
  mqtt: 1883,
  "kafka-producer": 9092,
  "tls-expiry": 443,
  sip: 5060,
  snmp: 161,
  grpc: 50051,
  ldap: 389,
  ssh: 22,
  imap: 143,
  ftp: 21,
  steam: 27015,
  // Required with no default on this type: the right port is a
  // property of the protocol, so the importer has to carry one.
  gamedig: 27960,
  // Also required with no default: there is no such thing as "the" UDP
  // port, so an export that lost it would import a monitor that cannot
  // run.
  udp: 5514,
  ntp: 123,
  radius: 1812,
  memcached: 11_211,
};

const TYPE_IDS = Object.keys(CHECK_TYPE_SPECS);

function inputFor(checkType: string, name?: string): CreateMonitorInput {
  const target = TARGETS[checkType];
  if (!target) throw new Error(`No test target for ${checkType}`);
  return {
    name: name ?? `export-${checkType}-${randomUUID().slice(0, 8)}`,
    url: target,
    method: "GET",
    intervalSeconds: 120,
    timeoutMs: 8_000,
    degradedThresholdMs: 2_500,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    checkType,
    port: PORTS[checkType] ?? null,
    tlsCheck: false,
    tlsWarnDays: 14,
    failureWindowSeconds: 180,
    config: CONFIGS[checkType] ?? null,
  } as CreateMonitorInput;
}

describe("every registered type survives an export and re-import", () => {
  it("has an entry here for every type in the registry", () => {
    expect(Object.keys(CONFIGS).sort()).toEqual([...TYPE_IDS].sort());
  });

  it.each(TYPE_IDS)("%s round-trips its configuration", async (checkType) => {
    const source = await createTestOrg();
    const original = await createMonitor(db, source, inputFor(checkType));

    const file = await exportMonitors(db, source.organizationId, [original.id]);
    expect(file.monitors).toHaveLength(1);

    // Imported into a DIFFERENT organization, which is the real use: a
    // template moved between tenants. Importing into the same one would
    // hide any accidental reliance on the source row.
    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);
    // The reason is folded into the assertion so a rejection explains
    // itself instead of showing only a count.
    expect({
      imported: report.imported,
      reason: report.outcomes[0]?.reason,
    }).toEqual({ imported: 1, reason: undefined });
    expect(report.skipped).toBe(0);

    const [copy] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, report.outcomes[0]!.monitorId!));

    expect(copy?.checkType).toBe(original.checkType);
    // The target round-trips except for the password inside it. A
    // `postgres` or `sqlserver` target is a connection string, so it
    // carries a credential exactly like `config` does, and it follows
    // the same rule the config blob has always followed here: the user
    // name is configuration and travels, the password does not. Targets
    // with no userinfo — every other type — are unchanged by this.
    expect(copy?.url).toBe(
      restoreTargetSecret(maskTargetSecret(original.url), null),
    );
    expect(copy?.port).toBe(original.port);
    expect(copy?.intervalSeconds).toBe(original.intervalSeconds);
    expect(copy?.timeoutMs).toBe(original.timeoutMs);
    expect(copy?.degradedThresholdMs).toBe(original.degradedThresholdMs);
    expect(copy?.failureWindowSeconds).toBe(original.failureWindowSeconds);
    expect(copy?.tlsWarnDays).toBe(original.tlsWarnDays);

    // Non-secret config must arrive intact.
    const expected = CONFIGS[checkType];
    if (expected) {
      const spec = CHECK_TYPE_SPECS[checkType]!;
      const secrets = new Set(spec.secretFields ?? []);
      const stored = copy?.config as Record<string, unknown> | null;
      for (const [key, value] of Object.entries(expected)) {
        if (secrets.has(key)) continue;
        expect({ [key]: stored?.[key] }).toEqual({ [key]: value });
      }
    }
  });
});

describe("secrets never travel in an export", () => {
  it("masks a credential carried inside the target itself", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor("postgres"));

    const file = await exportMonitors(db, actor.organizationId, [monitor.id]);
    const serialised = JSON.stringify(file);

    // The password in `postgres://u:p@host/db` is a credential wherever
    // it happens to sit. An export that masked `config.password` and
    // wrote this one out in full was masking one copy and publishing
    // the other.
    expect(serialised).not.toContain("//u:p@");
    expect(file.monitors[0]?.url).toBe(
      `postgres://u:${SECRET_MASK}@db.export.example:5432/app`,
    );
  });

  it("imports a masked target without the sentinel reaching the row", async () => {
    const source = await createTestOrg();
    const monitor = await createMonitor(db, source, inputFor("postgres"));
    const file = await exportMonitors(db, source.organizationId, [monitor.id]);

    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);

    const [copy] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, report.outcomes[0]!.monitorId!));

    // The user name survives so the imported monitor addresses the right
    // server as the right user and fails authentication with a message
    // that says so. Dialling out with the sentinel as a password is the
    // one thing it must never do.
    expect(copy?.url).toBe("postgres://u@db.export.example:5432/app");
    expect(copy?.url).not.toContain(SECRET_MASK);
    expect(report.outcomes[0]?.secretsToReenter).toContain("url");
  });

  it("masks a stored credential rather than writing it to the file", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor("redis"));

    const file = await exportMonitors(db, actor.organizationId, [monitor.id]);
    const serialised = JSON.stringify(file);

    expect(serialised).not.toContain("export-secret-redis");
    const config = file.monitors[0]?.config as Record<string, unknown>;
    // Masked, not omitted: an operator reading the file has to be able
    // to see that a credential exists and must be re-entered.
    expect(config.password).toBe(SECRET_MASK);
  });

  it("imports the mask as absent, never as a literal password", async () => {
    const source = await createTestOrg();
    const monitor = await createMonitor(db, source, inputFor("mqtt"));
    const file = await exportMonitors(db, source.organizationId, [monitor.id]);

    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);

    const [copy] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, report.outcomes[0]!.monitorId!));
    const config = copy?.config as Record<string, unknown>;

    expect(JSON.stringify(config)).not.toContain(SECRET_MASK);
    expect(config.password).toBeNull();
    // The non-secret half of the same blob still arrives.
    expect(config.username).toBe("export-user");
  });

  it("tells the operator which secrets they have to re-enter", async () => {
    const source = await createTestOrg();
    const monitor = await createMonitor(db, source, inputFor("redis"));
    const file = await exportMonitors(db, source.organizationId, [monitor.id]);

    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);
    expect(report.outcomes[0]?.secretsToReenter).toEqual(["password"]);
  });
});

describe("nothing is dropped without a report line", () => {
  it("reports a check type this build does not have", async () => {
    const target = await createTestOrg();
    const report = await importMonitors(db, target, {
      format: "vigil.monitors",
      version: 1,
      exportedAt: new Date().toISOString(),
      monitors: [
        {
          ...inputFor("http"),
          checkType: "quantum-entanglement",
          port: null,
          config: null,
          paused: false,
        },
      ],
    });

    expect(report.imported).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.outcomes[0]?.reason).toContain("quantum-entanglement");
  });

  it("keeps importing the rest of the file when one record is bad", async () => {
    // One bad monitor in a file of fifty must not cost the other
    // forty-nine.
    const source = await createTestOrg();
    const good = await createMonitor(db, source, inputFor("http"));
    const file = await exportMonitors(db, source.organizationId, [good.id]);
    file.monitors.push({
      ...file.monitors[0]!,
      name: "broken",
      url: "not a url at all",
    });

    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);

    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.outcomes).toHaveLength(2);
    expect(
      report.outcomes.every((o) => o.status === "imported" || o.reason),
    ).toBe(true);
  });

  it("produces exactly one outcome per input record", async () => {
    const source = await createTestOrg();
    for (const type of ["http", "redis", "dns"]) {
      await createMonitor(db, source, inputFor(type));
    }
    const file = await exportMonitors(db, source.organizationId);
    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);

    expect(report.outcomes).toHaveLength(file.monitors.length);
    expect(report.imported + report.skipped).toBe(file.monitors.length);
  });

  it("refuses a file from a newer Vigil rather than guessing", async () => {
    const target = await createTestOrg();
    await expect(
      importMonitors(db, target, {
        format: "vigil.monitors",
        version: 99,
        exportedAt: new Date().toISOString(),
        monitors: [],
      }),
    ).rejects.toThrow(/newer Vigil/);
  });
});

describe("export scoping", () => {
  it("never exports another organization's monitor, even by id", async () => {
    const mine = await createTestOrg();
    const theirs = await createTestOrg();
    const theirMonitor = await createMonitor(db, theirs, inputFor("http"));

    const file = await exportMonitors(db, mine.organizationId, [
      theirMonitor.id,
    ]);
    expect(file.monitors).toHaveLength(0);
  });

  it("carries paused state across", async () => {
    // Paused is an operator decision, not an observed state, so it is
    // one of the few life-cycle fields worth moving.
    const source = await createTestOrg();
    const monitor = await createMonitor(db, source, inputFor("http"));
    await setMonitorPaused(db, source, monitor.id, true);

    const file = await exportMonitors(db, source.organizationId, [monitor.id]);
    expect(file.monitors[0]?.paused).toBe(true);

    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);
    const [copy] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, report.outcomes[0]!.monitorId!));
    expect(copy?.paused).toBe(true);
  });

  it("does not carry identity or observed state across", async () => {
    const source = await createTestOrg();
    const monitor = await createMonitor(db, source, inputFor("http"));
    const file = await exportMonitors(db, source.organizationId, [monitor.id]);

    const record = file.monitors[0] as Record<string, unknown>;
    for (const forbidden of [
      "id",
      "organizationId",
      "currentStatus",
      "consecutiveFailures",
      "lastCheckedAt",
      "createdAt",
      "createdBy",
    ]) {
      expect({ [forbidden]: record[forbidden] }).toEqual({
        [forbidden]: undefined,
      });
    }
  });

  it("is a valid document by its own schema", async () => {
    const source = await createTestOrg();
    await createMonitor(db, source, inputFor("http"));
    const file = await exportMonitors(db, source.organizationId);
    expect(() => monitorExportSchema.parse(file)).not.toThrow();
  });
});
