import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { MONITOR_FORM_DEFAULTS } from "@/app/(app)/monitors/monitor-form";
import { performCheck } from "@/modules/monitors/check";
import { exportMonitors, importMonitors } from "@/modules/monitors/portability";
import {
  createMonitorSchema,
  type CreateMonitorInput,
} from "@/modules/monitors/schemas";
import {
  createMonitor,
  getMonitorDetail,
  updateMonitor,
} from "@/modules/monitors/service";
import { toCheckSpec } from "@/modules/monitors/spec";
import { redactConfig, SECRET_MASK } from "@/modules/monitors/types/config";
import type {
  AnyCheckTypeSpec,
  CheckTypeDefinition,
} from "@/modules/monitors/types/contract";
import { kafkaProducerProbe } from "@/modules/monitors/types/probes/kafka-producer";
import { rabbitmqProbe } from "@/modules/monitors/types/probes/rabbitmq";
import { CHECK_TYPES } from "@/modules/monitors/types/registry";
import { kafkaProducerSpec } from "@/modules/monitors/types/specs/kafka-producer";
import { rabbitmqSpec } from "@/modules/monitors/types/specs/rabbitmq";
import { CHECK_TYPE_SPECS } from "@/modules/monitors/types/specs";

import { createTestOrg, db } from "../helpers";

/**
 * The two broker check types, through the database they actually live in.
 *
 * What the unit suites cannot reach is here: a config blob that has been
 * written to Postgres, read back, and turned into the config a probe
 * receives. Every bug this file is aimed at survives a green unit suite —
 * a secret dropped by an edit, a topic that never leaves the row, a
 * credential serialised into a browser.
 */

/**
 * Registers these two types if the build has not already.
 *
 * `types/specs/index.ts` and `types/registry.ts` are wired by the release
 * that lands the types, and this suite must not depend on whether that
 * has happened yet: before it, the registry has no entry and every call
 * below would fail with "Unknown check type"; after it, these two lines
 * do nothing. `??=` is what makes both true, and the entry it writes is
 * exactly the one the index writes — the spec joined to its probe.
 */
const specs = CHECK_TYPE_SPECS as Record<string, AnyCheckTypeSpec>;
const definitions = CHECK_TYPES as Record<string, CheckTypeDefinition>;
specs.rabbitmq ??= rabbitmqSpec as unknown as AnyCheckTypeSpec;
specs["kafka-producer"] ??= kafkaProducerSpec as unknown as AnyCheckTypeSpec;
definitions.rabbitmq ??= {
  ...rabbitmqSpec,
  probe: rabbitmqProbe,
} as unknown as CheckTypeDefinition;
definitions["kafka-producer"] ??= {
  ...kafkaProducerSpec,
  probe: kafkaProducerProbe,
} as unknown as CheckTypeDefinition;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

interface ManagementApi {
  origin: string;
  authorizations: (string | null)[];
  close(): Promise<void>;
}

/** A management API that records what it was sent and answers healthy. */
async function startManagementApi(): Promise<ManagementApi> {
  const authorizations: (string | null)[] = [];
  const server = http.createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? null);
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    authorizations,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing is listening on, for the paths that must not connect. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const openApis: ManagementApi[] = [];
afterEach(async () => {
  await Promise.all(openApis.splice(0).map((api) => api.close()));
});

async function managementApi(): Promise<ManagementApi> {
  const api = await startManagementApi();
  openApis.push(api);
  return api;
}

/** What the create dialog sends, with this type's fields filled in. */
function submission(overrides: Record<string, unknown>) {
  return createMonitorSchema.parse({
    ...MONITOR_FORM_DEFAULTS,
    name: "broker monitor",
    ...overrides,
  });
}

/**
 * A monitor as the writer receives it, skipping the action layer.
 *
 * The tests that actually dial something have to point at loopback, and
 * both target schemas refuse an address literal deliberately — a target
 * is a name, and what it resolves to is decided at execution time.
 * `createMonitor` trusts its input, because validation lives at the
 * action layer and is exercised in its own block at the bottom of this
 * file.
 */
function stored(overrides: Record<string, unknown>): CreateMonitorInput {
  return {
    ...MONITOR_FORM_DEFAULTS,
    name: "broker monitor",
    ...overrides,
  } as CreateMonitorInput;
}

const RABBITMQ_URL = "https://rabbit.broker.example:15672";
const KAFKA_HOST = "kafka-1.broker.example";

/* ------------------------------------------------------------------ *
 * rabbitmq
 * ------------------------------------------------------------------ */

describe("a rabbitmq monitor through the database", () => {
  it("keeps its credentials when an edit says nothing about them", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      submission({
        checkType: "rabbitmq",
        url: RABBITMQ_URL,
        config: { username: "monitoring", password: "brokers-are-fun" },
      }),
    );

    // Exactly what the form sends for a type whose fields it does not
    // render: `config: null`. This was the 1.13.0 data-loss path.
    const renamed = await updateMonitor(db, actor, monitor.id, {
      name: "renamed",
      config: null,
    });

    expect(renamed.config).toEqual({
      username: "monitoring",
      password: "brokers-are-fun",
    });
  });

  it("keeps the password when the client echoes the mask back", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      submission({
        checkType: "rabbitmq",
        url: RABBITMQ_URL,
        config: { username: "monitoring", password: "brokers-are-fun" },
      }),
    );

    const updated = await updateMonitor(db, actor, monitor.id, {
      config: { username: "renamed", password: SECRET_MASK },
    });

    expect(updated.config).toEqual({
      username: "renamed",
      password: "brokers-are-fun",
    });
    expect(JSON.stringify(updated.config)).not.toContain(SECRET_MASK);
  });

  it("masks the password on the way to a browser", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      submission({
        checkType: "rabbitmq",
        url: RABBITMQ_URL,
        config: { username: "monitoring", password: "brokers-are-fun" },
      }),
    );

    const detail = await getMonitorDetail(db, actor.organizationId, monitor.id);
    const redacted = redactConfig(
      specs.rabbitmq!,
      detail.monitor.config,
    ) as Record<string, unknown>;

    expect(redacted.password).toBe(SECRET_MASK);
    expect(redacted.username).toBe("monitoring");
    expect(JSON.stringify(redacted)).not.toContain("brokers-are-fun");
  });

  it("exports without the password and imports asking for it back", async () => {
    const source = await createTestOrg();
    const monitor = await createMonitor(
      db,
      source,
      submission({
        checkType: "rabbitmq",
        url: RABBITMQ_URL,
        config: { username: "monitoring", password: "brokers-are-fun" },
      }),
    );

    const file = await exportMonitors(db, source.organizationId, [monitor.id]);
    expect(JSON.stringify(file)).not.toContain("brokers-are-fun");

    // Into a different organization: a template moved between tenants is
    // the real use, and importing into the same one would hide any
    // reliance on the source row.
    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);

    expect({
      imported: report.imported,
      reason: report.outcomes[0]?.reason,
    }).toEqual({ imported: 1, reason: undefined });
    expect(report.outcomes[0]?.secretsToReenter).toEqual(["password"]);

    const copy = await getMonitorDetail(
      db,
      target.organizationId,
      report.outcomes[0]!.monitorId!,
    );
    expect(copy.monitor.url).toBe(RABBITMQ_URL);
    // The user name is configuration and travels; the password does not,
    // and an imported monitor that authenticated with a placeholder
    // would be worse than one that says it needs a password.
    expect(copy.monitor.config).toEqual({
      username: "monitoring",
      password: null,
    });
  });

  it("sends the stored credential when the worker probes the stored row", async () => {
    const api = await managementApi();
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      stored({
        checkType: "rabbitmq",
        url: api.origin,
        config: { username: "monitoring", password: "brokers-are-fun" },
      }),
    );

    const detail = await getMonitorDetail(db, actor.organizationId, monitor.id);
    const outcome = await performCheck(toCheckSpec(detail.monitor), {
      allowPrivateTargets: true,
    });

    expect(outcome.verdict).toBe("up");
    // The whole path in one assertion: the blob went to Postgres, came
    // back through `fromRow`, and ended up in an Authorization header.
    const expected = Buffer.from("monitoring:brokers-are-fun", "utf8").toString(
      "base64",
    );
    expect(api.authorizations).toEqual([`Basic ${expected}`]);
  });
});

/* ------------------------------------------------------------------ *
 * kafka-producer
 * ------------------------------------------------------------------ */

describe("a kafka-producer monitor through the database", () => {
  const config = {
    topic: "orders.v2",
    message: "vigil says hello",
    username: "vigil",
    password: "s3cret",
    tls: true,
  };

  it("stores every setting it was created with", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      submission({
        checkType: "kafka-producer",
        url: KAFKA_HOST,
        port: 9092,
        config,
      }),
    );

    expect(monitor.config).toEqual(config);
    expect(monitor.port).toBe(9092);
  });

  it("keeps the topic and the password when only the message changes", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      submission({
        checkType: "kafka-producer",
        url: KAFKA_HOST,
        port: 9092,
        config,
      }),
    );

    const updated = await updateMonitor(db, actor, monitor.id, {
      config: { message: "still here" },
    });

    expect(updated.config).toEqual({ ...config, message: "still here" });
  });

  it("clears the password when the client sends null", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      submission({
        checkType: "kafka-producer",
        url: KAFKA_HOST,
        port: 9092,
        config,
      }),
    );

    // A password with no user name is refused, so both go together —
    // which is the pair an operator moving to an anonymous listener
    // actually wants to clear.
    const updated = await updateMonitor(db, actor, monitor.id, {
      config: { username: null, password: null },
    });

    expect(updated.config).toMatchObject({ username: null, password: null });
  });

  it("exports without the password and imports asking for it back", async () => {
    const source = await createTestOrg();
    const monitor = await createMonitor(
      db,
      source,
      submission({
        checkType: "kafka-producer",
        url: KAFKA_HOST,
        port: 9092,
        config,
      }),
    );

    const file = await exportMonitors(db, source.organizationId, [monitor.id]);
    expect(JSON.stringify(file)).not.toContain("s3cret");

    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);

    expect({
      imported: report.imported,
      reason: report.outcomes[0]?.reason,
    }).toEqual({ imported: 1, reason: undefined });
    expect(report.outcomes[0]?.secretsToReenter).toEqual(["password"]);

    const copy = await getMonitorDetail(
      db,
      target.organizationId,
      report.outcomes[0]!.monitorId!,
    );
    expect(copy.monitor.config).toEqual({
      ...config,
      password: null,
    });
    expect(copy.monitor.port).toBe(9092);
  });

  it("probes with the topic that came out of the row, not a default", async () => {
    // Nothing is listening on the port, so the check fails — but *how*
    // it fails is the assertion: a monitor whose topic never left the
    // database would report "no topic to produce to" instead of a
    // connection failure, and would do it silently.
    const port = await closedPort();
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      stored({
        checkType: "kafka-producer",
        url: "127.0.0.1",
        port,
        config: { ...config, tls: false },
      }),
    );

    const detail = await getMonitorDetail(db, actor.organizationId, monitor.id);
    const outcome = await performCheck(toCheckSpec(detail.monitor), {
      allowPrivateTargets: true,
    });

    expect(outcome.failureClass).toBe("transport");
    expect(outcome.error).toMatch(/ECONNREFUSED/);
  });

  it("says it has no topic when the row has none, rather than inventing one", async () => {
    const port = await closedPort();
    const actor = await createTestOrg();
    // What the create dialog sends today: the form renders no topic
    // field, so `config` is null and the stored blob is all defaults.
    const monitor = await createMonitor(
      db,
      actor,
      stored({
        checkType: "kafka-producer",
        url: "127.0.0.1",
        port,
        config: null,
      }),
    );

    const detail = await getMonitorDetail(db, actor.organizationId, monitor.id);
    const outcome = await performCheck(toCheckSpec(detail.monitor), {
      allowPrivateTargets: true,
    });

    expect(outcome.verdict).toBe("indeterminate");
    expect(outcome.failureClass).toBe("misconfigured");
    expect(outcome.error).toBe("This monitor has no topic to produce to.");
  });
});

/* ------------------------------------------------------------------ *
 * What the dialog refuses, and what it says
 * ------------------------------------------------------------------ */

describe("the action layer's answer to a form submission", () => {
  function parse(overrides: Record<string, unknown>) {
    return createMonitorSchema.safeParse({
      ...MONITOR_FORM_DEFAULTS,
      name: "broker monitor",
      ...overrides,
    });
  }

  it("accepts a rabbitmq monitor with the form's null-heavy payload", () => {
    expect(
      parse({ checkType: "rabbitmq", url: RABBITMQ_URL, config: null }).success,
    ).toBe(true);
  });

  it("tells the operator the rabbitmq target must be a URL", () => {
    const parsed = parse({ checkType: "rabbitmq", url: "rabbit.example.com" });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["url"]);
  });

  it("refuses a rabbitmq password with no user name, against the config field", () => {
    const parsed = parse({
      checkType: "rabbitmq",
      url: RABBITMQ_URL,
      config: { password: "orphaned" },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["config"]);
    expect(parsed.error?.issues[0]?.message).toBe(
      "A password needs a username.",
    );
  });

  it("refuses a rabbitmq monitor pointed at the metadata endpoint", () => {
    expect(
      parse({ checkType: "rabbitmq", url: "http://169.254.169.254/" }).success,
    ).toBe(false);
  });

  it("accepts a kafka-producer monitor with a host, a port and a topic", () => {
    expect(
      parse({
        checkType: "kafka-producer",
        url: KAFKA_HOST,
        port: 9092,
        config: { topic: "orders" },
      }).success,
    ).toBe(true);
  });

  it("tells the operator a kafka-producer target is a bare hostname", () => {
    const parsed = parse({
      checkType: "kafka-producer",
      url: "kafka://kafka-1.broker.example:9092",
      port: 9092,
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["url"]);
    expect(parsed.error?.issues[0]?.message).toContain("no scheme, no port");
  });

  it("names the topic rule when a topic name is one Kafka would refuse", () => {
    const parsed = parse({
      checkType: "kafka-producer",
      url: KAFKA_HOST,
      port: 9092,
      config: { topic: "orders and more" },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["config"]);
    expect(parsed.error?.issues[0]?.message).toContain(
      "letters, digits, dots, underscores and hyphens",
    );
  });

  it("defaults the kafka-producer port rather than demanding one", () => {
    // The descriptor declares a default, so the form's empty port field
    // is not an error — the writer fills it in.
    const parsed = parse({
      checkType: "kafka-producer",
      url: KAFKA_HOST,
      port: null,
      config: { topic: "orders" },
    });

    expect(parsed.success).toBe(true);
  });
});
