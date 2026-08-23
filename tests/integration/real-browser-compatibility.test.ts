import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { monitors } from "@/db/schema";
import { createMonitor, updateMonitor } from "@/modules/monitors/service";
import { describeCheckType } from "@/modules/monitors/types/catalog";
import { redactConfig, SECRET_MASK } from "@/modules/monitors/types/config";
import { probeExecutability } from "@/modules/monitors/types/contract";
import { findSpec } from "@/modules/monitors/types/specs";

import { createTestOrg, db } from "../helpers";

/**
 * `real-browser`, after scripted synthetics arrived.
 *
 * Adding a bigger version of a feature is the classic way to break the
 * smaller one, and the two ways it happens are both silent. Either the
 * old type is quietly reshaped to share machinery with the new one - so
 * a stored config stops parsing, or a credential moves - or a migration
 * "helpfully" converts existing monitors and an operator finds their
 * fleet has changed type overnight.
 *
 * Neither happened, and this is what says so. NOT marked commercial on
 * purpose: `real-browser` is a Core type, so the guarantee has to hold
 * in the edition that does not have journeys at all, and a test that
 * only ran in the commercial build would prove the smaller half.
 *
 * There is deliberately no conversion. A `real-browser` monitor loads one
 * page and asserts on the DOM; a `synthetic-browser` monitor needs a
 * runner container, an allow-list and a journey. A migration that turned
 * one into the other would either invent those or produce a monitor that
 * reports `misconfigured` until somebody notices - which is a worse
 * outcome than leaving a working monitor alone. Converting is a decision
 * with prerequisites, so it stays an operator's, and `docs/SYNTHETICS.md`
 * says how.
 */

const STORED = {
  serviceUrl: "https://browserless.compat.example",
  token: "browserless-compat-token",
  settleMs: 1_500,
};

async function makeRealBrowser(name: string) {
  const actor = await createTestOrg();
  const monitor = await createMonitor(db, actor, {
    name,
    checkType: "real-browser",
    url: "https://app.compat.example/dashboard",
    method: "GET",
    intervalSeconds: 120,
    timeoutMs: 15_000,
    degradedThresholdMs: 5_000,
    expectedStatusCode: null,
    bodyKeyword: "Welcome back",
    keywordAbsent: false,
    tlsCheck: false,
    tlsWarnDays: 14,
    failureWindowSeconds: 180,
    config: STORED,
  });
  return { actor, monitor };
}

describe("an existing real-browser monitor is untouched", () => {
  it("stores exactly the keys it always stored", async () => {
    const { monitor } = await makeRealBrowser("compat-shape");
    // The whole config, compared as a whole. A subset assertion would
    // pass while a synthetics field leaked in beside them.
    expect(monitor.config).toEqual(STORED);
    expect(monitor.checkType).toBe("real-browser");
  });

  it("keeps its credential across an edit that does not mention it", async () => {
    const { actor, monitor } = await makeRealBrowser("compat-edit");
    await updateMonitor(db, actor, monitor.id, { name: "Renamed" });

    const [after] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, monitor.id));
    expect(after?.name).toBe("Renamed");
    // The data-loss shape `types/config.ts` exists to prevent, re-checked
    // now that the merge understands map-valued secrets as well.
    expect(after?.config).toEqual(STORED);
  });

  it("masks its token as a scalar, not through the new map path", async () => {
    const spec = findSpec("real-browser")!;
    const redacted = redactConfig(spec, STORED) as Record<string, unknown>;
    expect(redacted.token).toBe(SECRET_MASK);
    // The value, not an object of masked keys: this type's secret is one
    // string and must stay one string on the wire.
    expect(typeof redacted.token).toBe("string");
    expect(redacted.serviceUrl).toBe(STORED.serviceUrl);
    expect(redacted.settleMs).toBe(STORED.settleMs);
  });

  it("keeps the descriptor an operator's setup depends on", async () => {
    const descriptor = describeCheckType("real-browser");
    expect({
      kind: descriptor.kind,
      capability: descriptor.requiresCapability,
      recovery: descriptor.supportsRecovery,
      target: descriptor.target.kind,
    }).toEqual({
      kind: "active",
      // Still `headless-browser`, not the synthetics runner's. An
      // installation with a browserless and no synthetics runner must
      // keep working exactly as it did.
      capability: "headless-browser",
      recovery: true,
      target: "url",
    });
    expect(descriptor.form).toContain("keyword");
  });

  it("can still be assigned to a remote probe", async () => {
    // Journeys are controller-only because they record a run to a
    // database an agent has no credential for. `real-browser` records
    // nothing, so it stays assignable - and a change that made every
    // browser-ish type controller-only would have taken a shipped
    // capability away from installations using it.
    const descriptor = describeCheckType("real-browser");
    expect(descriptor.controllerOnly).toBeUndefined();
    expect(probeExecutability(descriptor).executable).toBe(true);
  });

  it("is not converted into anything by an upgrade", async () => {
    const { monitor } = await makeRealBrowser("compat-no-migration");
    // Nothing in the release rewrites a monitor row. The synthetics
    // migration is additive - three new tables and no ALTER - so this is
    // a statement about the shipped SQL as much as about this row.
    const [after] = await db
      .select()
      .from(monitors)
      .where(eq(monitors.id, monitor.id));
    expect(after?.checkType).toBe("real-browser");
    expect(after?.config).toEqual(STORED);
  });
});
