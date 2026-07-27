import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { monitors } from "@/db/schema";
import {
  createMonitorSchema,
  updateMonitorSchema,
} from "@/modules/monitors/schemas";
import { createMonitor, updateMonitor } from "@/modules/monitors/service";
import { MONITOR_FORM_DEFAULTS } from "@/app/(app)/monitors/monitor-form";

import { createTestOrg, db } from "../helpers";

/**
 * The action layer, exercised with the exact payloads the form sends.
 *
 * This suite exists because of a bug that shipped once already: the
 * create form sent `bodyKeyword: null`, the schema said `.optional()`,
 * and monitor creation failed silently — the dialog just never closed.
 * Integration tests that call `createMonitor` directly bypass zod
 * entirely, so they could not have caught it. Everything here goes
 * through the schema first, the way a real submission does.
 */
function submit(overrides: Record<string, unknown>) {
  return { ...MONITOR_FORM_DEFAULTS, name: "Test", ...overrides };
}

function parseCreate(overrides: Record<string, unknown>) {
  return createMonitorSchema.safeParse(submit(overrides));
}

describe("creating each check type through the action layer", () => {
  it("accepts an http monitor with the form's null-heavy payload", () => {
    const parsed = parseCreate({ url: "https://example.com/health" });
    expect(parsed.success).toBe(true);
  });

  it("accepts a tcp monitor with a hostname and a port", () => {
    expect(
      parseCreate({ checkType: "tcp", url: "db.example.com", port: 5432 })
        .success,
    ).toBe(true);
  });

  it("rejects a tcp monitor with no port", () => {
    const parsed = parseCreate({ checkType: "tcp", url: "db.example.com" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["port"]);
  });

  it("rejects a tcp monitor given a URL", () => {
    const parsed = parseCreate({
      checkType: "tcp",
      url: "https://db.example.com",
      port: 5432,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["url"]);
  });

  it("accepts a ping monitor", () => {
    expect(
      parseCreate({ checkType: "ping", url: "gateway.example.com" }).success,
    ).toBe(true);
  });

  it("accepts a dns monitor with a record type and no expected value", () => {
    const parsed = parseCreate({
      checkType: "dns",
      url: "example.com",
      config: { recordType: "MX", expectedValue: null },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a dns monitor asking for a record type that does not exist", () => {
    const parsed = parseCreate({
      checkType: "dns",
      url: "example.com",
      config: { recordType: "SRV" },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["config"]);
  });

  it("accepts a tls-expiry monitor and defaults its port", () => {
    expect(
      parseCreate({
        checkType: "tls-expiry",
        url: "example.com",
        config: { warnDays: 21 },
      }).success,
    ).toBe(true);
  });

  it("accepts a domain-expiry monitor", () => {
    expect(
      parseCreate({
        checkType: "domain-expiry",
        url: "example.com",
        config: { warnDays: 30 },
      }).success,
    ).toBe(true);
  });

  it("rejects a domain-expiry monitor given a subdomain", () => {
    const parsed = parseCreate({
      checkType: "domain-expiry",
      url: "status.example.com",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["url"]);
  });

  it("rejects a check type this build does not have", () => {
    const parsed = parseCreate({ checkType: "redis", url: "example.com" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("Unknown check type");
  });

  it("still refuses the metadata endpoint, whatever the type", () => {
    for (const [checkType, url] of [
      ["http", "https://169.254.169.254/"],
      ["tcp", "metadata.google.internal"],
      ["ping", "metadata.google.internal"],
    ] as const) {
      const parsed = parseCreate({ checkType, url, port: 80 });
      expect(parsed.success).toBe(false);
    }
  });
});

describe("persisting each check type", () => {
  it("stores the config blob for a type that has one", async () => {
    const actor = await createTestOrg();
    const parsed = createMonitorSchema.parse(
      submit({
        checkType: "dns",
        url: "example.com",
        config: { recordType: "MX", expectedValue: "aspmx" },
      }),
    );
    const monitor = await createMonitor(db, actor, parsed);

    expect(monitor.checkType).toBe("dns");
    expect(monitor.config).toEqual({
      recordType: "MX",
      expectedValue: "aspmx",
    });
    // A dns monitor has no port and no keyword; the writer normalises
    // from the same descriptor the form renders from.
    expect(monitor.port).toBeNull();
    expect(monitor.bodyKeyword).toBeNull();
    expect(monitor.tlsCheck).toBe(false);
  });

  it("leaves the blob null for the types that use flat columns", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      createMonitorSchema.parse(
        submit({ url: "https://example.com/health", bodyKeyword: "ok" }),
      ),
    );
    expect(monitor.config).toBeNull();
    expect(monitor.bodyKeyword).toBe("ok");
  });

  it("defaults the port for a type that declares one", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      createMonitorSchema.parse(
        submit({ checkType: "tls-expiry", url: "example.com" }),
      ),
    );
    expect(monitor.port).toBe(443);
  });

  it("is due immediately, so a wrong URL surfaces at once", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      createMonitorSchema.parse(submit({ url: "https://example.com/health" })),
    );
    expect(monitor.nextEvaluationAt).toBeInstanceOf(Date);
    expect(monitor.nextEvaluationAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("switching a monitor's type", () => {
  it("clears the previous type's settings instead of leaving them behind", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      createMonitorSchema.parse(
        submit({
          url: "https://example.com/health",
          bodyKeyword: "ok",
          expectedStatusCode: 204,
          tlsCheck: true,
        }),
      ),
    );
    expect(monitor.bodyKeyword).toBe("ok");

    const updated = await updateMonitor(
      db,
      actor,
      monitor.id,
      updateMonitorSchema.parse({
        checkType: "dns",
        url: "example.com",
        config: { recordType: "A", expectedValue: null },
      }),
    );

    // Otherwise a switch back to http would silently resurrect a
    // keyword assertion the operator thought they had removed.
    expect(updated.checkType).toBe("dns");
    expect(updated.bodyKeyword).toBeNull();
    expect(updated.expectedStatusCode).toBeNull();
    expect(updated.tlsCheck).toBe(false);
    expect(updated.config).toEqual({ recordType: "A", expectedValue: null });
  });

  it("bumps the spec version when the rule changes, not when the name does", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      createMonitorSchema.parse(submit({ url: "https://example.com/health" })),
    );
    expect(monitor.specVersion).toBe(1);

    const renamed = await updateMonitor(db, actor, monitor.id, { name: "New" });
    expect(renamed.specVersion).toBe(1);

    const retargeted = await updateMonitor(db, actor, monitor.id, {
      url: "https://example.com/status",
    });
    expect(retargeted.specVersion).toBe(2);

    const reconfigured = await updateMonitor(db, actor, monitor.id, {
      failureWindowSeconds: 300,
    });
    expect(reconfigured.specVersion).toBe(3);
  });

  it("makes a changed interval take effect now rather than after the old one", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      createMonitorSchema.parse(
        submit({ url: "https://example.com/health", intervalSeconds: 3600 }),
      ),
    );
    await db
      .update(monitors)
      .set({ nextEvaluationAt: new Date(Date.now() + 3_600_000) })
      .where(eq(monitors.id, monitor.id));

    const updated = await updateMonitor(db, actor, monitor.id, {
      intervalSeconds: 60,
    });
    expect(updated.nextEvaluationAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("the form's defaults", () => {
  it("parse cleanly, so an untouched dialog can be submitted", () => {
    // The defaults object is what the create dialog opens with. If it
    // does not satisfy the schema, the first thing a new user does
    // fails.
    const parsed = createMonitorSchema.safeParse({
      ...MONITOR_FORM_DEFAULTS,
      name: `Monitor ${randomUUID().slice(0, 8)}`,
      url: "https://example.com/health",
    });
    expect(parsed.success).toBe(true);
  });
});
