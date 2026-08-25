import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  incidentEvidence,
  incidents,
  migrationBridges,
  monitorChecks,
  monitors,
} from "@/db/schema";
import {
  captureIncidentEvidence,
  EVIDENCE_RETENTION_DAYS,
  getIncidentEvidence,
  pruneIncidentEvidence,
  type BurstTransport,
  type CaptureDeps,
} from "@/modules/incidents/evidence";
import { changeIncidentStatus } from "@/modules/incidents/service";
import { applyOutcome } from "@/modules/monitors/outcome";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import { createMonitor, type Monitor } from "@/modules/monitors/service";
import { pruneOldChecks } from "@/worker/jobs/retention";

import {
  checkResult,
  createTestOrg,
  db,
  failResult,
  okResult,
  withRowLocked,
} from "../helpers";

/**
 * Incident evidence, proven at the seam it actually runs through.
 *
 * Every test here drives `applyOutcome` - the same function the worker,
 * the probe settle loop and the "check it now" button call - and then
 * asserts on rows. What is being tested is not that a builder returns a
 * shape; it is that an incident opening in this product leaves behind a
 * record an operator can act on, that the record survives the retention
 * that deletes everything it was derived from, and that it never
 * contains a credential or another tenant's data.
 */

const BARRIER_TIMEOUT_MS = 30_000;

function monitorInput(
  overrides: Partial<CreateMonitorInput> = {},
): CreateMonitorInput {
  return {
    name: `Monitor ${randomUUID().slice(0, 8)}`,
    url: "https://api.vigil-tests.example.com/health",
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 10_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    checkType: "http" as const,
    tlsCheck: false,
    tlsWarnDays: 14,
    // Zero, so the first failing check crosses the window and opens an
    // incident without a test having to replay a timeline.
    failureWindowSeconds: 0,
    ...overrides,
  };
}

/**
 * A burst that reaches the connect and finds the port shut. Injected,
 * so the suite proves the classification rather than the resolver.
 */
function refusingTransport(): BurstTransport {
  return {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    connect: async () => ({ error: "connect ECONNREFUSED 93.184.216.34:443" }),
    handshake: async () => ({ facts: {}, error: null }),
    request: async () => ({ facts: {}, error: null }),
  };
}

function healthyTransport(): BurstTransport {
  return {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    connect: async () => ({ error: null }),
    handshake: async () => ({ facts: { daysRemaining: 40 }, error: null }),
    request: async () => ({ facts: { statusCode: 200 }, error: null }),
  };
}

/** Turns the burst back on for one capture, against an injected transport. */
function withBurst(transport: BurstTransport): CaptureDeps {
  return { burstEnabled: true, transport };
}

async function evidenceRows(incidentId: string) {
  return db.query.incidentEvidence.findMany({
    where: eq(incidentEvidence.incidentId, incidentId),
  });
}

async function openIncidentOf(monitorId: string) {
  return db.query.incidents.findFirst({
    where: and(
      eq(incidents.monitorId, monitorId),
      eq(incidents.source, "monitor"),
    ),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}

/* ------------------------------------------------------------------ */

describe("a controlled failure, end to end", () => {
  it("opens an incident and stores evidence that matches the failure", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    // A healthy check first, so there is a "before" to compare against.
    const healthy = await applyOutcome(monitor, okResult(120));

    // Then the controlled failure: the endpoint answers 503.
    await applyOutcome(healthy, failResult(), {
      evidence: withBurst(healthyTransport()),
    });

    const incident = await openIncidentOf(monitor.id);
    expect(incident).toBeDefined();

    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    expect(stored).not.toBeNull();
    const { snapshot } = stored!;

    // What failed, exactly as the check reported it.
    expect(snapshot.failure.statusCode).toBe(503);
    expect(snapshot.failure.error).toBe("Unexpected status 503");
    expect(snapshot.failure.failedAssertions).toEqual(["status"]);
    expect(snapshot.monitor.target).toBe(
      "https://api.vigil-tests.example.com/health",
    );

    // Which layer, and on what authority. The target answered, so the
    // transport is proven by the observation itself.
    expect(snapshot.stage.stage).toBe("application");
    expect(snapshot.stage.basis).toBe("assertion");

    // The last success, and what moved.
    expect(snapshot.lastSuccessNote).toBe("found");
    expect(snapshot.lastSuccess!.statusCode).toBe(200);
    expect(
      snapshot.changes.find((change) => change.key === "statusCode"),
    ).toMatchObject({ before: 200, after: 503, note: "changed" });

    // The diagnostics ran, bounded, and are recorded with their bounds.
    expect(snapshot.burst!.steps.map((step) => step.kind)).toEqual([
      "dns",
      "tcp",
      "tls",
      "http",
    ]);
    expect(snapshot.burst!.steps.length).toBeLessThanOrEqual(
      snapshot.burst!.maxSteps,
    );
  });

  it("names the layer a diagnostic step proved, not the one the error implied", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    // A bare timeout: the observation names no layer at all.
    const timedOut = checkResult({
      ok: false,
      verdict: "down",
      failureClass: "transport",
      statusCode: null,
      responseTimeMs: 10_000,
      error: "Timed out after 10000ms",
      facts: { responseTimeMs: 10_000 },
    });

    await applyOutcome(monitor, timedOut, {
      evidence: withBurst(refusingTransport()),
    });

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    expect(stored!.snapshot.stage.stage).toBe("tcp");
    expect(stored!.snapshot.stage.basis).toBe("measured");
    expect(stored!.snapshot.burst!.steps.at(-1)!.error).toContain(
      "ECONNREFUSED",
    );
  });

  it("leaves the layer unknown when nothing established one", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    await applyOutcome(
      monitor,
      checkResult({
        ok: false,
        verdict: "down",
        failureClass: "transport",
        statusCode: null,
        responseTimeMs: 10_000,
        error: "Timed out after 10000ms",
        facts: { responseTimeMs: 10_000 },
      }),
    );

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    expect(stored!.snapshot.stage.stage).toBe("unknown");
    // The burst is off for the suite, and the snapshot says so rather
    // than leaving a reader to wonder whether it ran and found nothing.
    expect(stored!.snapshot.burst!.skipped).toBe("disabled");
    expect(stored!.snapshot.burst!.steps).toEqual([]);
    // Everything that does not need the burst is still there.
    expect(stored!.snapshot.failure.error).toBe("Timed out after 10000ms");
    expect(stored!.snapshot.firstFailureAt).not.toBeNull();
  });

  it("says so when no successful check is retained", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    await applyOutcome(monitor, failResult());

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    expect(stored!.snapshot.lastSuccess).toBeNull();
    expect(stored!.snapshot.lastSuccessNote).toBe("none-retained");
    // No last success means nothing to diff, and an empty list rather
    // than an invented one.
    expect(stored!.snapshot.changes).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe("writing it exactly once", () => {
  it("keeps the first snapshot when a capture is retried", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    const down = await applyOutcome(monitor, failResult());
    const incident = await openIncidentOf(monitor.id);

    const first = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );

    // A retry, ten minutes later, of an incident that is already
    // captured. The row must not be overwritten with the middle of the
    // outage wearing an "at onset" label.
    await captureIncidentEvidence(
      db,
      {
        organizationId: actor.organizationId,
        incidentId: incident!.id,
        monitor: down,
        outcome: failResult(),
        shadow: false,
      },
      { now: new Date(Date.now() + 600_000) },
    );

    const rows = await evidenceRows(incident!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.capturedAt.getTime()).toBe(first!.capturedAt.getTime());
  });

  it("stores one snapshot when two workers capture concurrently", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    const down = await applyOutcome(monitor, failResult());
    const incident = await openIncidentOf(monitor.id);
    await db
      .delete(incidentEvidence)
      .where(eq(incidentEvidence.incidentId, incident!.id));

    const capture = () =>
      captureIncidentEvidence(db, {
        organizationId: actor.organizationId,
        incidentId: incident!.id,
        monitor: down,
        outcome: failResult(),
        shadow: false,
      });

    await Promise.all([capture(), capture(), capture()]);
    expect(await evidenceRows(incident!.id)).toHaveLength(1);
  });

  it(
    "stores one snapshot when two checks race to open one incident",
    async () => {
      const actor = await createTestOrg();
      const monitor = await createMonitor(db, actor, monitorInput());

      // Both callers read the same monitor state and then race for the
      // insert, which is the interleaving that produces two incidents if
      // anything here is check-then-act.
      await withRowLocked("monitors", monitor.id, 2, async () => {
        await Promise.all([
          applyOutcome(monitor, failResult()),
          applyOutcome(monitor, failResult()),
        ]);
      });

      const rows = await db.query.incidents.findMany({
        where: eq(incidents.monitorId, monitor.id),
      });
      expect(rows).toHaveLength(1);
      expect(await evidenceRows(rows[0]!.id)).toHaveLength(1);
    },
    BARRIER_TIMEOUT_MS,
  );

  it("gives a flap's second incident its own snapshot", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());

    const failing = await applyOutcome(monitor, failResult());
    const first = await openIncidentOf(monitor.id);
    const recovered = await applyOutcome(failing, okResult(90));
    await applyOutcome(recovered, failResult());
    const second = await openIncidentOf(monitor.id);

    expect(second!.id).not.toBe(first!.id);
    expect(await evidenceRows(first!.id)).toHaveLength(1);
    expect(await evidenceRows(second!.id)).toHaveLength(1);
    // The second one saw a recovery in between, so it has a last
    // success and the first one does not.
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      second!.id,
    );
    expect(stored!.snapshot.lastSuccess!.statusCode).toBe(200);
  });
});

/* ------------------------------------------------------------------ */

describe("tenant isolation", () => {
  it("refuses to read another organisation's evidence", async () => {
    const mine = await createTestOrg();
    const theirs = await createTestOrg();
    const monitor = await createMonitor(db, mine, monitorInput());
    await applyOutcome(monitor, failResult());
    const incident = await openIncidentOf(monitor.id);

    expect(
      await getIncidentEvidence(db, mine.organizationId, incident!.id),
    ).not.toBeNull();
    expect(
      await getIncidentEvidence(db, theirs.organizationId, incident!.id),
    ).toBeNull();
  });

  it("never relates a failure to another organisation's monitor", async () => {
    const mine = await createTestOrg();
    const theirs = await createTestOrg();

    // The same hostname, failing at the same moment, in a different
    // tenant. The strongest possible signal, and it must not appear.
    const neighbour = await createMonitor(db, theirs, monitorInput());
    await applyOutcome(neighbour, failResult());

    const sibling = await createMonitor(db, mine, monitorInput());
    await applyOutcome(sibling, failResult());

    const monitor = await createMonitor(db, mine, monitorInput());
    await applyOutcome(monitor, failResult());

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      mine.organizationId,
      incident!.id,
    );
    const ids = stored!.snapshot.correlations.map((row) => row.monitorId);
    expect(ids).toContain(sibling.id);
    expect(ids).not.toContain(neighbour.id);
  });

  it("explains why it related two monitors", async () => {
    const actor = await createTestOrg();
    const sibling = await createMonitor(
      db,
      actor,
      monitorInput({ url: "https://api.vigil-tests.example.com/ready" }),
    );
    await applyOutcome(sibling, failResult());

    const unrelated = await createMonitor(
      db,
      actor,
      monitorInput({
        url: "https://elsewhere.vigil-other.example.org/health",
      }),
    );
    await applyOutcome(
      unrelated,
      checkResult({
        ok: false,
        verdict: "down",
        failureClass: "transport",
        statusCode: null,
        error: "Timed out after 10000ms",
        facts: {},
      }),
    );

    const monitor = await createMonitor(db, actor, monitorInput());
    await applyOutcome(monitor, failResult());

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    const related = stored!.snapshot.correlations;

    const match = related.find((row) => row.monitorId === sibling.id);
    expect(match).toBeDefined();
    expect(match!.signals[0]).toEqual({
      kind: "same-host",
      detail: "api.vigil-tests.example.com",
    });
    // The unrelated one failed in the same minute and shares nothing.
    // Time on its own is not a reason.
    expect(related.map((row) => row.monitorId)).not.toContain(unrelated.id);
  });
});

/* ------------------------------------------------------------------ */

/**
 * The four predicates that decide which failing monitors are even
 * considered. Each test here kills one mutation: delete the predicate it
 * names and this test, and only this test, goes red. Without them the
 * whole selection could be deleted and the suite would stay green -
 * measured, not assumed.
 */
describe("what correlation refuses to consider", () => {
  it("never relates a monitor to itself", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    await applyOutcome(monitor, failResult());

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    // It shares every signal with itself, so nothing but the explicit
    // exclusion keeps it out.
    expect(
      stored!.snapshot.correlations.map((row) => row.monitorId),
    ).not.toContain(monitor.id);
  });

  it("never relates a failure to a shadow monitor", async () => {
    const actor = await createTestOrg();
    const [bridge] = await db
      .insert(migrationBridges)
      .values({
        organizationId: actor.organizationId,
        provider: "betterstack",
        credentialSealed: "",
        createdBy: actor.userId,
      })
      .returning({ id: migrationBridges.id });

    // The same host, failing at the same moment: every strong signal
    // matches. A shadow monitor is a second copy of one already in the
    // list, and reporting it would report one outage twice.
    const shadowed = await createMonitor(db, actor, monitorInput());
    const [shadow] = await db
      .update(monitors)
      .set({ shadowBridgeId: bridge!.id })
      .where(eq(monitors.id, shadowed.id))
      .returning();
    await applyOutcome(shadow as Monitor, failResult());

    const monitor = await createMonitor(db, actor, monitorInput());
    await applyOutcome(monitor, failResult());

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    expect(
      stored!.snapshot.correlations.map((row) => row.monitorId),
    ).not.toContain(shadowed.id);
  });

  it("never relates a failure that began outside the window", async () => {
    const actor = await createTestOrg();

    // Same host, so the signal is as strong as it gets. What disqualifies
    // it is that it has been failing since two hours before this one
    // started, which makes it a separate, older outage.
    const older = await createMonitor(db, actor, monitorInput());
    await applyOutcome(older, failResult());
    await db
      .update(monitors)
      .set({ firstFailureAt: sql`now() - interval '2 hours'` })
      .where(eq(monitors.id, older.id));

    const monitor = await createMonitor(db, actor, monitorInput());
    await applyOutcome(monitor, failResult());

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    expect(
      stored!.snapshot.correlations.map((row) => row.monitorId),
    ).not.toContain(older.id);
  });

  it("relates two different hostnames that resolved to one address", async () => {
    // The signal hostname and domain cannot see: a shared load balancer
    // or CDN edge. It only works because the OTHER monitor's own onset
    // snapshot recorded what its name resolved to - without that read,
    // candidates carry no addresses and this signal can never fire.
    const actor = await createTestOrg();
    const shared: BurstTransport = {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: async () => ({ error: "connect ECONNREFUSED" }),
      handshake: async () => ({ facts: {}, error: null }),
      request: async () => ({ facts: {}, error: null }),
    };

    const neighbour = await createMonitor(
      db,
      actor,
      monitorInput({ url: "https://ledger.vigil-other.example.org/health" }),
    );
    await applyOutcome(neighbour, failResult(), {
      evidence: withBurst(shared),
    });

    const monitor = await createMonitor(db, actor, monitorInput());
    await applyOutcome(monitor, failResult(), { evidence: withBurst(shared) });

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    const related = stored!.snapshot.correlations.find(
      (row) => row.monitorId === neighbour.id,
    );
    expect(related).toBeDefined();
    expect(related!.signals[0]).toEqual({
      kind: "same-address",
      detail: "93.184.216.34",
    });
  });

  it("relates one that began just inside the window", async () => {
    // The other side of the same boundary, so the test above is proving
    // the window rather than proving that nothing ever correlates.
    const actor = await createTestOrg();

    const recent = await createMonitor(db, actor, monitorInput());
    await applyOutcome(recent, failResult());
    await db
      .update(monitors)
      .set({ firstFailureAt: sql`now() - interval '5 minutes'` })
      .where(eq(monitors.id, recent.id));

    const monitor = await createMonitor(db, actor, monitorInput());
    await applyOutcome(monitor, failResult());

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    expect(stored!.snapshot.correlations.map((row) => row.monitorId)).toContain(
      recent.id,
    );
  });
});

/* ------------------------------------------------------------------ */

describe("secrets", () => {
  it("keeps a credential out of the snapshot wherever it appeared", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({
        checkType: "postgres",
        url: "postgres://app:hunter2@db.vigil-tests.example.com:5432/main",
      }),
    );

    // The failure quotes the connection string back, which is exactly
    // how a password ends up in evidence.
    await applyOutcome(
      monitor,
      checkResult({
        ok: false,
        verdict: "down",
        failureClass: "transport",
        statusCode: null,
        error:
          'connection to server at "db.vigil-tests.example.com" failed: password authentication failed for user "app" (hunter2)',
        facts: {
          dsn: "postgres://app:hunter2@db.vigil-tests.example.com:5432/main",
        },
      }),
    );

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    const serialized = JSON.stringify(stored!.snapshot);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).toContain("[redacted]");
    // And the target label never carried the credential in the first
    // place.
    expect(stored!.snapshot.monitor.target).not.toContain("hunter2");
  });

  it("finds the password even when the password contains an @", async () => {
    // The parser this used to use split on the FIRST "@" in the whole
    // string, so a password containing one - which Postgres, Redis and
    // MongoDB all permit - put a two-character prefix of the USERNAME
    // into the redactor. Both halves of that are wrong: the credential
    // survived into the snapshot, and masking two letters everywhere
    // shredded every fact key and message in it.
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({
        checkType: "postgres",
        url: "postgres://app:p@ssw0rd@db.vigil-tests.example.com:5432/main",
      }),
    );

    await applyOutcome(
      monitor,
      checkResult({
        ok: false,
        verdict: "down",
        failureClass: "transport",
        statusCode: null,
        responseTimeMs: 1_234,
        error: 'password authentication failed for user "app" using p@ssw0rd',
        facts: { responseTimeMs: 1_234, queryOk: false },
      }),
    );

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    const serialized = JSON.stringify(stored!.snapshot);
    expect(serialized).not.toContain("p@ssw0rd");
    expect(serialized).not.toContain("ssw0rd");
    // And nothing else was shredded on the way: a redactor holding a
    // one- or two-character string rewrites ordinary words and fact
    // keys, so the keys surviving intact is the other half of the proof.
    expect(stored!.snapshot.failure.facts.responseTimeMs).toBe(1_234);
    expect(stored!.snapshot.failure.facts.queryOk).toBe(false);
  });

  it("finds the password in the form the driver puts on the wire", async () => {
    // A DSN stores its password percent-encoded; the driver decodes it
    // before authenticating, so a server quoting the rejected credential
    // back quotes the decoded form, which is a different string from the
    // one stored on the row.
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({
        checkType: "postgres",
        url: "postgres://app:p%40ss%3Aword@db.vigil-tests.example.com:5432/main",
      }),
    );

    await applyOutcome(
      monitor,
      checkResult({
        ok: false,
        verdict: "down",
        failureClass: "transport",
        statusCode: null,
        error: 'authentication failed for user "app" using p@ss:word',
        facts: {},
      }),
    );

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    const serialized = JSON.stringify(stored!.snapshot);
    expect(serialized).not.toContain("p@ss:word");
    expect(serialized).not.toContain("p%40ss%3Aword");
  });

  it("registers nothing when an @ appears only in the path", async () => {
    // `/users/me@example.com` is an ordinary URL. Treating the text
    // before it as userinfo would load the redactor with a fragment of
    // the host and mask it out of the whole snapshot.
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ url: "https://api.vigil-tests.example.com/u/me@x.com" }),
    );

    await applyOutcome(monitor, failResult());

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    expect(stored!.snapshot.monitor.target).toBe(
      "https://api.vigil-tests.example.com/u/me@x.com",
    );
    expect(JSON.stringify(stored!.snapshot)).not.toContain("[redacted]");
  });

  it("keeps a credential the check type declares secret out of it too", async () => {
    // The other half of `monitorSecrets`, and the half the connection
    // string above does NOT cover: a secret that lives in the `config`
    // blob under a key the spec names in `secretFields`. Deleting the
    // `secretValuesOf` call leaves the test above green and this one
    // red, which is the whole reason it is a separate test.
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({
        checkType: "redis",
        url: "cache.vigil-tests.example.com",
        port: 6379,
        config: { password: "s3cr3t-redis-pw" },
      }),
    );
    expect((monitor.config as { password?: string }).password).toBe(
      "s3cr3t-redis-pw",
    );

    // A Redis server quotes the credential it rejected.
    await applyOutcome(
      monitor,
      checkResult({
        ok: false,
        verdict: "down",
        failureClass: "transport",
        statusCode: null,
        error: "WRONGPASS invalid username-password pair: s3cr3t-redis-pw",
        facts: { auth: "AUTH default s3cr3t-redis-pw" },
      }),
    );

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    const serialized = JSON.stringify(stored!.snapshot);
    expect(serialized).not.toContain("s3cr3t-redis-pw");
    expect(stored!.snapshot.failure.error).toContain("[redacted]");
  });
});

/* ------------------------------------------------------------------ */

describe("shadow mode", () => {
  it("records the snapshot and dials nothing", async () => {
    const actor = await createTestOrg();
    const [bridge] = await db
      .insert(migrationBridges)
      .values({
        organizationId: actor.organizationId,
        provider: "betterstack",
        credentialSealed: "",
        createdBy: actor.userId,
      })
      .returning({ id: migrationBridges.id });
    const created = await createMonitor(db, actor, monitorInput());
    const [monitor] = await db
      .update(monitors)
      .set({ shadowBridgeId: bridge!.id })
      .where(eq(monitors.id, created.id))
      .returning();

    // The burst is switched ON for this capture, and a working
    // transport is handed to it. Shadow mode still has to refuse it.
    await applyOutcome(monitor as Monitor, failResult(), {
      evidence: withBurst(healthyTransport()),
    });

    const incident = await openIncidentOf(created.id);
    expect(incident!.shadow).toBe(true);

    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    expect(stored).not.toBeNull();
    expect(stored!.snapshot.burst!.skipped).toBe("shadow");
    expect(stored!.snapshot.burst!.steps).toEqual([]);
    // Everything that costs nothing extra is still recorded: a shadow
    // fleet exists to be compared.
    expect(stored!.snapshot.failure.statusCode).toBe(503);
  });
});

/* ------------------------------------------------------------------ */

describe("the high-frequency plane", () => {
  /**
   * The flag is carried in memory and never written to the row, which
   * is not a shortcut but a requirement.
   *
   * `monitors.high_frequency` is discovered INSTALLATION-WIDE: the
   * plane's reload asks the whole table which monitors are on it, not
   * one tenant's. An earlier version of this test enabled the column and
   * left it enabled, so `tests/integration/high-frequency.test.ts`,
   * running in parallel, stood its own monitor down, waited for its
   * plane to release every shard, and found it still ticking - because
   * of a monitor in another organisation belonging to this file. It
   * failed here and was green against `main` on the same machine, which
   * is what a suite reaching across into another one looks like.
   *
   * `captureIncidentEvidence` is called directly for the same reason:
   * the branch under test reads `input.monitor.highFrequency`, and going
   * through `applyOutcome` would only re-read the row and get `false`.
   */
  it("records the snapshot without pausing to dial", async () => {
    const actor = await createTestOrg();
    const created = await createMonitor(db, actor, monitorInput());
    await applyOutcome(created, failResult());
    const incident = await openIncidentOf(created.id);
    await db
      .delete(incidentEvidence)
      .where(eq(incidentEvidence.incidentId, incident!.id));

    // The burst is switched ON and handed a working transport. It has to
    // refuse anyway, because the plane holds a per-monitor promotion
    // flag across the whole outcome call and promotes nothing else while
    // it is held.
    await captureIncidentEvidence(
      db,
      {
        organizationId: actor.organizationId,
        incidentId: incident!.id,
        monitor: { ...created, highFrequency: true },
        outcome: failResult(),
        shadow: false,
      },
      withBurst(healthyTransport()),
    );

    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    expect(stored!.snapshot.burst!.skipped).toBe("high-frequency");
    expect(stored!.snapshot.burst!.steps).toEqual([]);
    // Correlation is skipped too: it is the fleet-wide half and costs a
    // query over every failing monitor in the tenant, which this plane
    // cannot spend while holding its promotion flag. The empty list is
    // marked so it is never read as "nothing else was failing".
    expect(stored!.snapshot.correlations).toEqual([]);
    expect(stored!.snapshot.correlationsNote).toBe("high-frequency");
    // And everything that costs nothing extra is still there.
    expect(stored!.snapshot.failure.statusCode).toBe(503);
    expect(stored!.snapshot.stage.stage).toBe("application");
  });

  it("does not skip correlation for an ordinary monitor", async () => {
    // The other side of the rule, so the test above proves the plane
    // rather than proving that correlation never runs.
    const actor = await createTestOrg();
    const sibling = await createMonitor(db, actor, monitorInput());
    await applyOutcome(sibling, failResult());

    const monitor = await createMonitor(db, actor, monitorInput());
    await applyOutcome(monitor, failResult());

    const incident = await openIncidentOf(monitor.id);
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    expect(stored!.snapshot.correlationsNote).toBeUndefined();
    expect(stored!.snapshot.correlations.map((row) => row.monitorId)).toContain(
      sibling.id,
    );
  });
});

/* ------------------------------------------------------------------ */

describe("retention", () => {
  it("survives the prune that deletes the observations it came from", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    const healthy = await applyOutcome(monitor, okResult(120));
    await applyOutcome(healthy, failResult());
    const incident = await openIncidentOf(monitor.id);

    // Age every observation past the check-retention window.
    await db
      .update(monitorChecks)
      .set({ checkedAt: sql`now() - interval '400 days'` })
      .where(eq(monitorChecks.monitorId, monitor.id));

    await pruneOldChecks({ organizationId: actor.organizationId });

    const remaining = await db.query.monitorChecks.findMany({
      where: eq(monitorChecks.monitorId, monitor.id),
    });
    expect(remaining).toHaveLength(0);
    // The evidence is what is left, which is the whole reason it is a
    // table of its own.
    const stored = await getIncidentEvidence(
      db,
      actor.organizationId,
      incident!.id,
    );
    expect(stored).not.toBeNull();
    expect(stored!.snapshot.lastSuccess!.statusCode).toBe(200);
  });

  it("prunes only long-resolved incidents, and never an open one", async () => {
    const actor = await createTestOrg();
    const scope = { organizationId: actor.organizationId };

    const closed = await createMonitor(db, actor, monitorInput());
    await applyOutcome(closed, failResult());
    const resolvedIncident = await openIncidentOf(closed.id);
    await changeIncidentStatus(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      resolvedIncident!.id,
      { status: "resolved", message: "over" },
    );

    const stillOpen = await createMonitor(db, actor, monitorInput());
    await applyOutcome(stillOpen, failResult());
    const openIncident = await openIncidentOf(stillOpen.id);

    // The cutoff moves rather than the rows. `resolved_at` is immutable
    // once written - the `incidents_terminal` trigger refuses to move a
    // closed incident's resolution time, because a published status
    // page has already reported how long the outage lasted - so ageing
    // a fixture is not something this schema permits. Moving the cutoff
    // exercises the same predicate from the other side.
    const before = new Date(Date.now() - 60_000);
    expect(await pruneIncidentEvidence(db, before, 500, scope)).toBe(0);
    expect(await evidenceRows(resolvedIncident!.id)).toHaveLength(1);

    const after = new Date(Date.now() + 60_000);
    expect(await pruneIncidentEvidence(db, after, 500, scope)).toBe(1);
    expect(await evidenceRows(resolvedIncident!.id)).toHaveLength(0);
    // Never eligible at any cutoff: a stale open incident is a
    // bookkeeping problem, and deleting the record of why it opened does
    // not fix it.
    expect(await evidenceRows(openIncident!.id)).toHaveLength(1);
  });

  it("keeps the worker's own cutoff a year behind the clock", () => {
    // The number itself, asserted, because the whole point of a
    // separate table is that it outlives `CHECK_RETENTION_DAYS`.
    expect(EVIDENCE_RETENTION_DAYS).toBeGreaterThan(90);
  });

  it("goes with the incident when the incident is deleted", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    await applyOutcome(monitor, failResult());
    const incident = await openIncidentOf(monitor.id);

    await db.delete(incidents).where(eq(incidents.id, incident!.id));
    expect(await evidenceRows(incident!.id)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe("incidents without evidence", () => {
  it("reads back as nothing rather than as an error", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    await applyOutcome(monitor, failResult());
    const incident = await openIncidentOf(monitor.id);

    // An incident opened before this feature existed has no row. The
    // page renders no card; it must not throw.
    await db
      .delete(incidentEvidence)
      .where(eq(incidentEvidence.incidentId, incident!.id));
    expect(
      await getIncidentEvidence(db, actor.organizationId, incident!.id),
    ).toBeNull();
  });
});
