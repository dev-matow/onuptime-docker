// @covers-type: websocket, grpc
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { monitors } from "@/db/schema";
import { exportMonitors, importMonitors } from "@/modules/monitors/portability";
import { createMonitorSchema } from "@/modules/monitors/schemas";
import {
  createMonitor,
  getMonitorDetail,
  updateMonitor,
} from "@/modules/monitors/service";
import { describeMonitorTarget } from "@/modules/monitors/spec";
import { redactConfig, SECRET_MASK } from "@/modules/monitors/types/config";
import type { AnyCheckTypeSpec } from "@/modules/monitors/types/contract";
import { CHECK_TYPE_SPECS, findSpec } from "@/modules/monitors/types/specs";
import { grpcSpec } from "@/modules/monitors/types/specs/grpc";
import { websocketSpec } from "@/modules/monitors/types/specs/websocket";

import { createTestOrg, db } from "../helpers";

/**
 * The `websocket` and `grpc` types against a real database: created,
 * edited, exported, imported, and never leaking the credential they
 * carry.
 *
 * The two types are covered together because their settings have the
 * same shape — one credential and one protocol option each — so the
 * cases worth asserting are identical and listing them twice would be
 * two copies to keep in step.
 */

/**
 * Registers both specs if the registry does not already carry them.
 *
 * `specs/index.ts` is written by whoever assembles the release, and
 * these two types were built alongside several others: until that file
 * names them, `findSpec` cannot, and every path below goes through it.
 * The specs registered here are the real, shipped objects — nothing is
 * stubbed — so this is the wiring and not a substitute for it. Once the
 * index names them the `??=` is inert, at which point this block can go.
 */
beforeAll(() => {
  const registry = CHECK_TYPE_SPECS as Record<string, AnyCheckTypeSpec>;
  registry.websocket ??= websocketSpec as unknown as AnyCheckTypeSpec;
  registry.grpc ??= grpcSpec as unknown as AnyCheckTypeSpec;
});

interface Case {
  checkType: string;
  target: string;
  port: number | null;
  config: Record<string, unknown>;
  /** The credential in `config`, and the field it lives in. */
  secretField: string;
  secret: string;
  /** A setting that is not a credential, to prove the rest survives too. */
  plainField: string;
  plainValue: unknown;
}

const CASES: Case[] = [
  {
    checkType: "websocket",
    target: "wss://socket.example.com/live?token=query-string-secret",
    port: null,
    config: { subprotocol: "graphql-ws", authorization: "Bearer ws-secret" },
    secretField: "authorization",
    secret: "Bearer ws-secret",
    plainField: "subprotocol",
    plainValue: "graphql-ws",
  },
  {
    checkType: "grpc",
    target: "api.example.com",
    port: 50_051,
    config: {
      service: "orders.v1.Orders",
      tls: true,
      authorization: "Bearer grpc-secret",
    },
    secretField: "authorization",
    secret: "Bearer grpc-secret",
    plainField: "service",
    plainValue: "orders.v1.Orders",
  },
];

function inputFor(testCase: Case, config?: Record<string, unknown> | null) {
  // Parsed with the schema the create action uses, not hand-built: a
  // monitor that only exists because a test skipped validation is a
  // monitor nobody can create.
  return createMonitorSchema.parse({
    name: `${testCase.checkType}-${randomUUID().slice(0, 8)}`,
    checkType: testCase.checkType,
    url: testCase.target,
    port: testCase.port,
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 10_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    tlsCheck: false,
    tlsWarnDays: 14,
    failureWindowSeconds: 120,
    config: config === undefined ? testCase.config : config,
  });
}

async function storedConfig(
  monitorId: string,
): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ config: monitors.config })
    .from(monitors)
    .where(eq(monitors.id, monitorId));
  return (row?.config ?? {}) as Record<string, unknown>;
}

describe.each(CASES)("a $checkType monitor", (testCase) => {
  it("is created with the settings the operator submitted", async () => {
    const actor = await createTestOrg();

    const monitor = await createMonitor(db, actor, inputFor(testCase));

    expect(monitor.checkType).toBe(testCase.checkType);
    expect(monitor.url).toBe(testCase.target);
    // A type that declares no port stores none; one that declares a
    // default gets it filled in.
    expect(monitor.port).toBe(testCase.port);
    expect(await storedConfig(monitor.id)).toMatchObject({
      [testCase.plainField]: testCase.plainValue,
      [testCase.secretField]: testCase.secret,
    });
  });

  it("keeps its settings through an edit that says nothing about them", async () => {
    // Exactly what the monitor form sends for a type whose fields it
    // does not render: `config: null`. This was the 1.13.0 data-loss
    // path, and a credential is what it lost.
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor(testCase));
    const before = await storedConfig(monitor.id);

    await updateMonitor(db, actor, monitor.id, {
      name: `renamed-${randomUUID().slice(0, 8)}`,
      config: null,
    });

    expect(await storedConfig(monitor.id)).toEqual(before);
  });

  it("keeps the credential when the client echoes the mask back", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor(testCase));

    await updateMonitor(db, actor, monitor.id, {
      config: { [testCase.secretField]: SECRET_MASK },
    });

    const stored = await storedConfig(monitor.id);
    expect(stored[testCase.secretField]).toBe(testCase.secret);
    expect(JSON.stringify(stored)).not.toContain(SECRET_MASK);
  });

  it("changes one setting without disturbing the credential", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor(testCase));

    await updateMonitor(db, actor, monitor.id, {
      config: {
        [testCase.plainField]:
          testCase.checkType === "grpc" ? "billing.v1.Billing" : "mqtt",
      },
    });

    const stored = await storedConfig(monitor.id);
    expect(stored[testCase.secretField]).toBe(testCase.secret);
  });

  it("clears the credential when the client sends null", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor(testCase));

    await updateMonitor(db, actor, monitor.id, {
      config: { [testCase.secretField]: null },
    });

    expect((await storedConfig(monitor.id))[testCase.secretField]).toBeNull();
  });

  it("masks the credential on the way to a browser", async () => {
    // The edit dialog is a client component: whatever reaches it is in
    // the page source, readable by anyone who can open it — including a
    // viewer who cannot edit the monitor at all.
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor(testCase));
    const detail = await getMonitorDetail(db, actor.organizationId, monitor.id);

    const spec = findSpec(testCase.checkType);
    const redacted = redactConfig(spec!, detail.monitor.config) as Record<
      string,
      unknown
    >;

    expect(redacted[testCase.secretField]).toBe(SECRET_MASK);
    expect(JSON.stringify(redacted)).not.toContain(testCase.secret);
    // The setting next to it is not a credential and must stay readable,
    // or the form would offer to overwrite a value it cannot show.
    expect(redacted[testCase.plainField]).toBe(testCase.plainValue);
  });

  it("survives an export and a re-import into another organization", async () => {
    const source = await createTestOrg();
    const original = await createMonitor(db, source, inputFor(testCase));

    const file = await exportMonitors(db, source.organizationId, [original.id]);
    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);

    expect({
      imported: report.imported,
      reason: report.outcomes[0]?.reason,
    }).toEqual({ imported: 1, reason: undefined });

    const [copy] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, report.outcomes[0]!.monitorId!));
    expect(copy?.url).toBe(original.url);
    expect(copy?.port).toBe(original.port);
    expect((copy?.config as Record<string, unknown>)[testCase.plainField]).toBe(
      testCase.plainValue,
    );
  });

  it("never writes the credential into the export file", async () => {
    // An export is a file an operator emails to themselves, commits, or
    // pastes into a ticket.
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor(testCase));

    const file = await exportMonitors(db, actor.organizationId, [monitor.id]);

    expect(JSON.stringify(file)).not.toContain(testCase.secret);
    const config = file.monitors[0]?.config as Record<string, unknown>;
    // Masked rather than omitted: the operator has to be able to see
    // that a credential exists and must be re-entered.
    expect(config[testCase.secretField]).toBe(SECRET_MASK);
  });

  it("imports the mask as absent and says which field to re-enter", async () => {
    const source = await createTestOrg();
    const monitor = await createMonitor(db, source, inputFor(testCase));
    const file = await exportMonitors(db, source.organizationId, [monitor.id]);

    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);

    const [copy] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, report.outcomes[0]!.monitorId!));
    const config = copy?.config as Record<string, unknown>;
    // A monitor that authenticated with the literal sentinel would fail
    // in a way that looks exactly like a wrong password.
    expect(JSON.stringify(config)).not.toContain(SECRET_MASK);
    expect(config[testCase.secretField]).toBeNull();
    expect(report.outcomes[0]?.secretsToReenter).toEqual([
      testCase.secretField,
    ]);
  });
});

describe("what the action layer tells the operator", () => {
  it("puts a bad websocket URL on the url field, in words that name the fix", () => {
    const parsed = createMonitorSchema.safeParse({
      ...inputFor(CASES[0]!, null),
      url: "https://socket.example.com/live",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["url"]);
    expect(parsed.error?.issues[0]?.message).toContain("ws://");
  });

  it("puts a bad grpc service name on the config field", () => {
    const parsed = createMonitorSchema.safeParse({
      ...inputFor(CASES[1]!, null),
      config: { service: "not a service name" },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["config"]);
    expect(parsed.error?.issues[0]?.message).toContain("grpc.health.v1.Health");
  });

  it("refuses a websocket target inside the metadata service", () => {
    const parsed = createMonitorSchema.safeParse({
      ...inputFor(CASES[0]!, null),
      url: "ws://metadata.google.internal/socket",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["url"]);
  });

  it("gives a grpc monitor the default port when the operator leaves it empty", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      createMonitorSchema.parse({ ...inputFor(CASES[1]!, null), port: null }),
    );
    expect(monitor.port).toBe(50_051);
  });

  it("drops a port typed into a websocket monitor, because the URL carries it", async () => {
    // Two answers to the same question is how a monitor ends up dialling
    // a port nobody can see in the field they typed.
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      createMonitorSchema.parse({ ...inputFor(CASES[0]!, null), port: 8443 }),
    );
    expect(monitor.port).toBeNull();
  });
});

describe("what an incident says about these monitors", () => {
  it("keeps a websocket query-string token out of the target line", async () => {
    // `monitor.url` is embedded in incident emails and webhook bodies.
    // A browser cannot set an Authorization header on a WebSocket, so a
    // token in the query string is the ordinary way these authenticate.
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor(CASES[0]!));

    const described = describeMonitorTarget(monitor);

    expect(described).toBe("wss://socket.example.com/live");
    expect(described).not.toContain("query-string-secret");
  });

  it("names the gRPC service alongside the host", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, inputFor(CASES[1]!));

    expect(describeMonitorTarget(monitor)).toBe(
      "api.example.com:50051 (orders.v1.Orders)",
    );
  });
});
