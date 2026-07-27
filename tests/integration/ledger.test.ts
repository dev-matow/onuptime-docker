import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { monitorChecks } from "@/db/schema";
import { verifyChain, type FactInput } from "@/modules/ledger/chain";
import { ensureActor } from "@/modules/ledger/service";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import {
  createMonitor,
  observationClaim,
  recordCheckOutcome,
} from "@/modules/monitors/service";

import { createTestOrg, db, failResult, okResult } from "../helpers";

function monitorInput(
  overrides: Partial<CreateMonitorInput> = {},
): CreateMonitorInput {
  return {
    name: `Monitor ${randomUUID().slice(0, 8)}`,
    url: "https://vigil-tests.example.com/health",
    checkType: "http",
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

/**
 * Rebuilds the fact inputs a verifier would reconstruct from stored
 * columns. This is the whole point of the exercise: the chain has to be
 * checkable from what is on disk, by something that did not write it.
 */
async function storedChain(
  actorId: string,
): Promise<(FactInput & { hash: string })[]> {
  const rows = await db
    .select()
    .from(monitorChecks)
    .where(eq(monitorChecks.actorId, actorId))
    .orderBy(asc(monitorChecks.seq));

  return rows.map((row) => ({
    actorId: row.actorId!,
    seq: row.seq!,
    hlc: row.hlc!,
    prevHash: row.prevHash,
    kind: "observation" as const,
    subject: row.monitorId,
    specVersion: row.specVersion,
    claim: observationClaim(
      {
        ok: row.ok,
        degraded: false,
        statusCode: row.statusCode,
        responseTimeMs: row.responseTimeMs,
        error: row.error,
        verdict: row.verdict as never,
        failureClass: row.failureClass as never,
        facts: row.facts as never,
        failedAssertions: [],
      },
      row.checkedAt,
    ),
    hash: row.hash!,
  }));
}

/** A fresh actor per test, so chains never interleave across suites. */
function actorName(): string {
  return `test-worker-${randomUUID().slice(0, 8)}`;
}

describe("the observation ledger", () => {
  it("stamps every observation with an identity, a clock and a chain link", async () => {
    const org = await createTestOrg();
    const actorId = await ensureActor(db, "worker", actorName());
    const monitor = await createMonitor(db, org, monitorInput());

    await recordCheckOutcome(db, monitor, okResult(), { actorId });

    const [row] = await db
      .select()
      .from(monitorChecks)
      .where(eq(monitorChecks.monitorId, monitor.id));

    expect(row?.actorId).toBe(actorId);
    expect(row?.seq).toBe(1n);
    expect(row?.hlc).toBeTypeOf("bigint");
    expect(row?.hash).toHaveLength(64);
    // The first fact in a chain has nothing before it.
    expect(row?.prevHash).toBeNull();
    // A collection from day one, not a column.
    expect(row?.signatures).toEqual([]);
    expect(row?.specVersion).toBe(monitor.specVersion);
    expect(row?.verdict).toBe("up");
    expect(row?.facts).toMatchObject({ statusCode: 200 });
  });

  it("produces a chain that verifies from the stored columns alone", async () => {
    const org = await createTestOrg();
    const actorId = await ensureActor(db, "worker", actorName());
    const monitor = await createMonitor(db, org, monitorInput());

    let current = monitor;
    for (const outcome of [okResult(), failResult(), okResult(90)]) {
      ({ monitor: current } = await recordCheckOutcome(db, current, outcome, {
        actorId,
      }));
    }

    expect(verifyChain(await storedChain(actorId))).toEqual({ valid: true });
  });

  it("keeps one chain per actor, across every monitor it observes", async () => {
    // Per-actor, not per-monitor and not global: a global chain would
    // need a global serialisation point, which is exactly what edge
    // autonomy forbids.
    const org = await createTestOrg();
    const actorId = await ensureActor(db, "worker", actorName());
    const first = await createMonitor(db, org, monitorInput({ name: "One" }));
    const second = await createMonitor(db, org, monitorInput({ name: "Two" }));

    await recordCheckOutcome(db, first, okResult(), { actorId });
    await recordCheckOutcome(db, second, okResult(), { actorId });
    await recordCheckOutcome(db, first, failResult(), { actorId });

    const chain = await storedChain(actorId);
    expect(chain.map((fact) => fact.seq)).toEqual([1n, 2n, 3n]);
    expect(new Set(chain.map((fact) => fact.subject)).size).toBe(2);
    expect(verifyChain(chain)).toEqual({ valid: true });
  });

  it("gives each actor its own independent sequence", async () => {
    const org = await createTestOrg();
    const alpha = await ensureActor(db, "worker", actorName());
    const beta = await ensureActor(db, "edge", actorName());
    const monitor = await createMonitor(db, org, monitorInput());

    await recordCheckOutcome(db, monitor, okResult(), { actorId: alpha });
    await recordCheckOutcome(db, monitor, okResult(), { actorId: beta });

    expect((await storedChain(alpha)).map((f) => f.seq)).toEqual([1n]);
    expect((await storedChain(beta)).map((f) => f.seq)).toEqual([1n]);
  });

  it("advances the clock monotonically even within a millisecond", async () => {
    const org = await createTestOrg();
    const actorId = await ensureActor(db, "worker", actorName());
    const monitor = await createMonitor(db, org, monitorInput());
    const sameInstant = new Date("2026-07-26T12:00:00.000Z");

    let current = monitor;
    for (let i = 0; i < 3; i++) {
      ({ monitor: current } = await recordCheckOutcome(
        db,
        current,
        okResult(),
        {
          actorId,
          now: sameInstant,
        },
      ));
    }

    const chain = await storedChain(actorId);
    expect(chain).toHaveLength(3);
    expect(chain[1]!.hlc > chain[0]!.hlc).toBe(true);
    expect(chain[2]!.hlc > chain[1]!.hlc).toBe(true);
    expect(verifyChain(chain)).toEqual({ valid: true });
  });

  it("detects an observation edited after the fact", async () => {
    const org = await createTestOrg();
    const actorId = await ensureActor(db, "worker", actorName());
    const monitor = await createMonitor(db, org, monitorInput());

    let current = monitor;
    for (let i = 0; i < 3; i++) {
      ({ monitor: current } = await recordCheckOutcome(
        db,
        current,
        failResult(),
        { actorId },
      ));
    }

    // Somebody quietly turns a failed check into a passing one — the
    // exact edit an evidence ledger exists to make visible.
    const [target] = await db
      .select({ id: monitorChecks.id })
      .from(monitorChecks)
      .where(eq(monitorChecks.actorId, actorId))
      .orderBy(asc(monitorChecks.seq))
      .limit(1);
    await db
      .update(monitorChecks)
      .set({ ok: true, verdict: "up", error: null })
      .where(eq(monitorChecks.id, target!.id));

    expect(verifyChain(await storedChain(actorId))).toMatchObject({
      valid: false,
      index: 0,
      reason: "content does not match its hash",
    });
  });

  // One edit per column, because a single UPDATE touching three fields
  // cannot tell you which of them the hash actually covers — and `ok`
  // and `checked_at` are precisely the two that generate every uptime
  // number, so "some other column caught it" is not good enough.
  it.each([
    ["ok", { ok: true }],
    ["verdict", { verdict: "up" }],
    ["failureClass", { failureClass: null }],
    ["error", { error: null }],
    ["statusCode", { statusCode: 200 }],
    ["responseTimeMs", { responseTimeMs: 1 }],
    ["checkedAt", { checkedAt: new Date("2020-01-01T00:00:00Z") }],
    ["facts", { facts: { statusCode: 200 } }],
  ])("detects an edit to %s on its own", async (_column, patch) => {
    const org = await createTestOrg();
    const actorId = await ensureActor(db, "worker", actorName());
    const monitor = await createMonitor(db, org, monitorInput());
    await recordCheckOutcome(db, monitor, failResult(), { actorId });

    await db
      .update(monitorChecks)
      .set(patch)
      .where(eq(monitorChecks.actorId, actorId));

    expect(verifyChain(await storedChain(actorId))).toMatchObject({
      valid: false,
      reason: "content does not match its hash",
    });
  });

  it("records nothing when no actor is supplied", async () => {
    // A script or a test may write without an identity. Inventing one
    // would be a lie about who observed it; the columns stay null.
    const org = await createTestOrg();
    const monitor = await createMonitor(db, org, monitorInput());
    await recordCheckOutcome(db, monitor, okResult());

    const [row] = await db
      .select()
      .from(monitorChecks)
      .where(eq(monitorChecks.monitorId, monitor.id));
    expect(row?.actorId).toBeNull();
    expect(row?.hash).toBeNull();
    expect(row?.seq).toBeNull();
  });
});

describe("ensureActor", () => {
  it("is idempotent for the same kind and name", async () => {
    const name = actorName();
    const first = await ensureActor(db, "worker", name);
    const second = await ensureActor(db, "worker", name);
    expect(second).toBe(first);
  });

  it("treats the same name under a different kind as a different actor", async () => {
    const name = actorName();
    expect(await ensureActor(db, "worker", name)).not.toBe(
      await ensureActor(db, "edge", name),
    );
  });
});
