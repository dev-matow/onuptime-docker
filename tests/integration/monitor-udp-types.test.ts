import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { monitors } from "@/db/schema";
import { exportMonitors, importMonitors } from "@/modules/monitors/portability";
import { createMonitorSchema } from "@/modules/monitors/schemas";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import { createMonitor, updateMonitor } from "@/modules/monitors/service";
import { SECRET_MASK, redactConfig } from "@/modules/monitors/types/config";

import { createTestOrg, db } from "../helpers";

/**
 * The three datagram types, against a real database.
 *
 * The unit suites prove the protocols; this proves the half that has
 * nothing to do with protocols and is where check types actually break:
 * a config blob that survives an edit, a secret that never leaves in an
 * export, and a submission the action layer refuses with a message an
 * operator can act on.
 *
 * The registry is patched here for one reason. `specs/index.ts` is
 * assembled centrally — a type's spec file and its entry in that index
 * are written by different hands — and this suite has to be able to
 * prove the database half before that entry lands. Once it has, this
 * mock returns the same three objects the index already holds and the
 * suite is unchanged by it.
 */
vi.mock("@/modules/monitors/types/specs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/modules/monitors/types/specs")>();
  const { udpSpec } = await import("@/modules/monitors/types/specs/udp");
  const { ntpSpec } = await import("@/modules/monitors/types/specs/ntp");
  const { radiusSpec } = await import("@/modules/monitors/types/specs/radius");

  const specs = {
    ...actual.CHECK_TYPE_SPECS,
    udp: udpSpec,
    ntp: ntpSpec,
    radius: radiusSpec,
  } as typeof actual.CHECK_TYPE_SPECS;

  return {
    ...actual,
    CHECK_TYPE_SPECS: specs,
    findSpec: (id: string) =>
      Object.hasOwn(specs, id) ? specs[id] : undefined,
    requireSpec: (id: string) => {
      const spec = Object.hasOwn(specs, id) ? specs[id] : undefined;
      if (!spec) throw new Error(`Unknown check type: ${id}`);
      return spec;
    },
  };
});

const RADIUS_CONFIG = {
  secret: "shared-secret-from-the-appliance",
  username: "vigil-probe@example.com",
  password: "account-password-that-works",
  nasIdentifier: "vigil-eu",
  expectAccept: true,
};

function submission(overrides: Record<string, unknown>): unknown {
  return {
    name: `udp-types-${randomUUID().slice(0, 8)}`,
    url: "collector.example.com",
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
    config: null,
    ...overrides,
  };
}

/** Everything a real submission goes through before it reaches the service. */
function accepted(overrides: Record<string, unknown>): CreateMonitorInput {
  const parsed = createMonitorSchema.safeParse(submission(overrides));
  if (!parsed.success) {
    throw new Error(
      `submission rejected: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

async function storedConfig(monitorId: string): Promise<unknown> {
  const [row] = await db
    .select({ config: monitors.config })
    .from(monitors)
    .where(eq(monitors.id, monitorId));
  return row?.config ?? null;
}

describe("creating a datagram monitor", () => {
  it("stores a udp monitor's payload and its port", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      accepted({
        checkType: "udp",
        port: 5514,
        config: {
          payload: "STATUS\n",
          payloadEncoding: "text",
          expectedResponse: "READY",
        },
      }),
    );

    expect(monitor.port).toBe(5514);
    expect(await storedConfig(monitor.id)).toEqual({
      payload: "STATUS\n",
      payloadEncoding: "text",
      expectedResponse: "READY",
    });
  });

  it("writes down 123 for an ntp monitor whose operator typed no port", async () => {
    // The well-known port is the answer often enough that demanding it
    // would be a field that exists to be agreed with — but it is stored
    // rather than left null, so the row says which port was watched
    // instead of leaving that to whatever the probe defaults to today.
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      accepted({ checkType: "ntp", url: "time.example.com" }),
    );

    expect(monitor.port).toBe(123);
    expect(await storedConfig(monitor.id)).toEqual({ maxOffsetMs: 1_000 });
  });

  it("schedules a datagram monitor for its first check immediately", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      accepted({ checkType: "ntp", url: "time.example.com" }),
    );

    expect(monitor.nextEvaluationAt).not.toBeNull();
  });

  it("stores a radius monitor's credentials", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      accepted({
        checkType: "radius",
        url: "radius.example.com",
        config: RADIUS_CONFIG,
      }),
    );

    expect(await storedConfig(monitor.id)).toEqual(RADIUS_CONFIG);
  });
});

describe("editing a datagram monitor", () => {
  it("keeps a radius monitor's secrets through a rename", async () => {
    // The 1.13.0 data-loss shape: the form renders no fields for this
    // type, so an edit sends `config: null` and means "I said nothing".
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      accepted({
        checkType: "radius",
        url: "radius.example.com",
        config: RADIUS_CONFIG,
      }),
    );

    await updateMonitor(db, actor, monitor.id, {
      name: `renamed-${randomUUID().slice(0, 8)}`,
      config: null,
    });

    expect(await storedConfig(monitor.id)).toEqual(RADIUS_CONFIG);
  });

  it("keeps a udp monitor's payload when only the interval changes", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      accepted({
        checkType: "udp",
        port: 5514,
        config: { payload: "00ff2a", payloadEncoding: "hex" },
      }),
    );

    await updateMonitor(db, actor, monitor.id, { intervalSeconds: 300 });

    expect(await storedConfig(monitor.id)).toMatchObject({
      payload: "00ff2a",
      payloadEncoding: "hex",
    });
  });

  it("keeps the stored radius credentials when the client echoes the mask", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      accepted({
        checkType: "radius",
        url: "radius.example.com",
        config: RADIUS_CONFIG,
      }),
    );

    await updateMonitor(db, actor, monitor.id, {
      config: {
        ...RADIUS_CONFIG,
        secret: SECRET_MASK,
        password: SECRET_MASK,
        nasIdentifier: "vigil-us",
      },
    });

    const stored = (await storedConfig(monitor.id)) as Record<string, unknown>;
    expect(stored.secret).toBe(RADIUS_CONFIG.secret);
    expect(stored.password).toBe(RADIUS_CONFIG.password);
    expect(stored.nasIdentifier).toBe("vigil-us");
    expect(JSON.stringify(stored)).not.toContain(SECRET_MASK);
  });

  it("clears a radius secret when the client sends null", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      accepted({
        checkType: "radius",
        url: "radius.example.com",
        config: RADIUS_CONFIG,
      }),
    );

    await updateMonitor(db, actor, monitor.id, { config: { secret: null } });

    expect(
      (await storedConfig(monitor.id)) as Record<string, unknown>,
    ).toMatchObject({ secret: null, username: RADIUS_CONFIG.username });
  });
});

describe("exporting and re-importing a datagram monitor", () => {
  it("carries a udp monitor's payload and port into another organization", async () => {
    const source = await createTestOrg();
    const original = await createMonitor(
      db,
      source,
      accepted({
        checkType: "udp",
        port: 5514,
        config: {
          payload: "00ff2a",
          payloadEncoding: "hex",
          expectedResponse: "deadbeef",
        },
      }),
    );

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
      .where(eq(monitors.id, report.outcomes[0]?.monitorId ?? ""));
    expect(copy?.port).toBe(5514);
    expect(copy?.config).toEqual({
      payload: "00ff2a",
      payloadEncoding: "hex",
      expectedResponse: "deadbeef",
    });
  });

  it("never writes a radius credential into the export file", async () => {
    // An export is a file an operator emails to themselves, commits, or
    // pastes into a ticket.
    const source = await createTestOrg();
    const monitor = await createMonitor(
      db,
      source,
      accepted({
        checkType: "radius",
        url: "radius.example.com",
        config: RADIUS_CONFIG,
      }),
    );

    const file = await exportMonitors(db, source.organizationId, [monitor.id]);
    const serialised = JSON.stringify(file);

    expect(serialised).not.toContain(RADIUS_CONFIG.secret);
    expect(serialised).not.toContain(RADIUS_CONFIG.password);
    // Masked rather than omitted: the operator has to see that a
    // credential exists and has to be re-entered.
    expect(file.monitors[0]?.config).toMatchObject({
      secret: SECRET_MASK,
      password: SECRET_MASK,
      username: RADIUS_CONFIG.username,
    });
  });

  it("imports a radius monitor with its secrets unset rather than as the mask", async () => {
    const source = await createTestOrg();
    const monitor = await createMonitor(
      db,
      source,
      accepted({
        checkType: "radius",
        url: "radius.example.com",
        config: RADIUS_CONFIG,
      }),
    );
    const file = await exportMonitors(db, source.organizationId, [monitor.id]);

    const target = await createTestOrg();
    const report = await importMonitors(db, target, file);

    const [copy] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, report.outcomes[0]?.monitorId ?? ""));
    const config = copy?.config as Record<string, unknown>;

    expect(JSON.stringify(config)).not.toContain(SECRET_MASK);
    expect(config.secret).toBeNull();
    expect(config.password).toBe("");
    // The settings around the credentials still arrive, which is what
    // makes an exported monitor worth importing at all.
    expect(config.username).toBe(RADIUS_CONFIG.username);
    expect(config.nasIdentifier).toBe(RADIUS_CONFIG.nasIdentifier);
    expect(config.expectAccept).toBe(true);
  });

  it("masks both radius credentials on the way to a browser", async () => {
    const { requireSpec } = await import("@/modules/monitors/types/specs");
    const redacted = redactConfig(
      requireSpec("radius"),
      RADIUS_CONFIG,
    ) as Record<string, unknown>;

    expect(redacted.secret).toBe(SECRET_MASK);
    expect(redacted.password).toBe(SECRET_MASK);
    expect(JSON.stringify(redacted)).not.toContain(RADIUS_CONFIG.secret);
    expect(JSON.stringify(redacted)).not.toContain(RADIUS_CONFIG.password);
  });
});

describe("what the action layer refuses", () => {
  function issue(overrides: Record<string, unknown>) {
    const parsed = createMonitorSchema.safeParse(submission(overrides));
    return parsed.success ? null : parsed.error.issues[0];
  }

  it("asks for a port on a udp monitor, which has no default", () => {
    expect(issue({ checkType: "udp" })).toMatchObject({
      path: ["port"],
      message: "A UDP port check needs a port.",
    });
  });

  it("refuses a URL where a udp monitor wants a hostname", () => {
    expect(
      issue({
        checkType: "udp",
        port: 5514,
        url: "udp://collector.example.com",
      }),
    ).toMatchObject({ path: ["url"] });
  });

  it("explains a hex payload that is not whole bytes", () => {
    expect(
      issue({
        checkType: "udp",
        port: 5514,
        config: { payload: "0f0f0", payloadEncoding: "hex" },
      }),
    ).toMatchObject({
      path: ["config"],
      message: "Enter the payload as pairs of hex digits, like 00ff2a.",
    });
  });

  it("refuses a payload too large for one datagram", () => {
    expect(
      issue({
        checkType: "udp",
        port: 5514,
        config: { payload: "x".repeat(1_100) },
      }),
    ).toMatchObject({
      path: ["config"],
      message: "The payload cannot exceed 1024 bytes.",
    });
  });

  it("refuses an ntp tolerance of nothing", () => {
    expect(
      issue({
        checkType: "ntp",
        url: "time.example.com",
        config: { maxOffsetMs: 0 },
      }),
    ).toMatchObject({ path: ["config"] });
  });

  it("refuses a radius user name too long for the attribute that carries it", () => {
    expect(
      issue({
        checkType: "radius",
        url: "radius.example.com",
        config: { ...RADIUS_CONFIG, username: "u".repeat(300) },
      }),
    ).toMatchObject({ path: ["config"] });
  });

  it("accepts a radius monitor with no credentials at all", () => {
    // It reports `misconfigured` until one is supplied, which is the
    // honest answer — and refusing to create it would leave an operator
    // unable to write down the thing they intend to watch.
    expect(
      issue({ checkType: "radius", url: "radius.example.com" }),
    ).toBeNull();
  });
});
