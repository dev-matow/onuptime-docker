import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { notificationOutbox } from "@/db/schema";
import { openMonitorIncident } from "@/modules/incidents/service";
import { createMonitor } from "@/modules/monitors/service";
import {
  sendEmail,
  setEmailTransport,
  type EmailMessage,
  type EmailTransport,
} from "@/modules/notifications";
import { notifyIncidentOpened } from "@/modules/notifications/incident-emails";
import {
  backoffMs,
  claimDue,
  enqueue,
  retryPolicy,
  recordOutcome,
  type DeliveryOutcome,
} from "@/modules/notifications/outbox";
import { runNotificationDelivery } from "@/worker/jobs/notification-delivery";

import { createTestOrg, db, type TestActor } from "../helpers";

/**
 * The delivery guarantee, case by case.
 *
 * Every scenario the release reference names as required evidence has a
 * test here: a crash after commit but before sending, a crash after the
 * provider accepted, a 429, a 500, a timeout, redelivery, and a job
 * retried twice producing one user-visible notification.
 *
 * They are written against the real table because the interesting
 * behaviour is the table's — the lease, the unique index, the backoff.
 */

/**
 * A transport whose outcome each test dictates, recording what it saw.
 *
 * Handed to the tick rather than installed globally. `setEmailTransport`
 * mutates a module singleton, and a singleton shared by concurrently
 * running suites is a test that fails for reasons unrelated to what it
 * is checking.
 */
function scriptedTransport(script: () => DeliveryOutcome): {
  send: EmailTransport["send"];
  seen: EmailMessage[];
} {
  const seen: EmailMessage[] = [];
  return {
    seen,
    async send(message) {
      seen.push(message);
      return script();
    },
  };
}

async function monitorFor(actor: TestActor) {
  return createMonitor(db, actor, {
    name: `outbox-${randomUUID().slice(0, 8)}`,
    url: "https://outbox.example.com/health",
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 10_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    checkType: "http",
    tlsCheck: false,
    tlsWarnDays: 14,
    failureWindowSeconds: 120,
    config: null,
  });
}

async function rowsFor(organizationId: string) {
  return db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.organizationId, organizationId));
}

function message(organizationId: string, key: string) {
  return {
    organizationId,
    idempotencyKey: key,
    channel: "email" as const,
    destination: "ada@example.com",
    payload: { subject: "Checkout is down", text: "It is down." },
  };
}

describe("enqueueing is idempotent", () => {
  it("a job delivered twice produces one notification", async () => {
    const actor = await createTestOrg();
    const key = `incident:${randomUUID()}:opened:ada@example.com`;

    const first = await enqueue(db, message(actor.organizationId, key));
    const second = await enqueue(db, message(actor.organizationId, key));

    expect(first).not.toBeNull();
    // Null is the success signal: the guarantee held.
    expect(second).toBeNull();
    expect(await rowsFor(actor.organizationId)).toHaveLength(1);
  });

  it("two workers racing the same incident enqueue once", async () => {
    const actor = await createTestOrg();
    const key = `incident:${randomUUID()}:opened:ada@example.com`;

    const results = await Promise.all([
      enqueue(db, message(actor.organizationId, key)),
      enqueue(db, message(actor.organizationId, key)),
      enqueue(db, message(actor.organizationId, key)),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await rowsFor(actor.organizationId)).toHaveLength(1);
  });

  it("notifying an incident twice does not page anyone twice", async () => {
    const actor = await createTestOrg();
    const monitor = await monitorFor(actor);
    const incident = await openMonitorIncident(
      db,
      monitor,
      "connection refused",
    );
    if (!incident) throw new Error("incident was not opened");

    await notifyIncidentOpened(db, incident, monitor);
    await notifyIncidentOpened(db, incident, monitor);

    const rows = await rowsFor(actor.organizationId);
    // One member in a fresh test org, so one message — not two.
    expect(rows).toHaveLength(1);
  });
});

describe("a crash after commit loses nothing", () => {
  it("leaves the message queued when the worker dies before sending", async () => {
    // The enqueue committed; no delivery ran. This is the state a worker
    // that was SIGKILLed between the two leaves behind.
    const actor = await createTestOrg();
    await enqueue(db, message(actor.organizationId, `k-${randomUUID()}`));

    const [row] = await rowsFor(actor.organizationId);
    expect(row?.state).toBe("queued");
    expect(row?.attempts).toBe(0);

    // A later tick still finds and delivers it.
    const { send } = scriptedTransport(() => ({
      status: "delivered",
      providerMessageId: "resend-1",
    }));
    const result = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      send,
    });
    expect(result.delivered).toBeGreaterThanOrEqual(1);

    const [after] = await rowsFor(actor.organizationId);
    expect(after?.state).toBe("delivered");
    expect(after?.providerMessageId).toBe("resend-1");
  });

  it("re-claims a message whose worker died holding the lease", async () => {
    // `sending` with an expired lease is the crash-after-claim state.
    // Without the lease expiry the row would sit in `sending` forever and
    // the notification would be lost silently — the exact failure mode a
    // boolean "in flight" flag produces.
    const actor = await createTestOrg();
    const row = await enqueue(
      db,
      message(actor.organizationId, `k-${randomUUID()}`),
    );
    if (!row) throw new Error("enqueue returned null");

    await db
      .update(notificationOutbox)
      .set({
        state: "sending",
        leasedUntil: new Date(Date.now() - 60_000),
      })
      .where(eq(notificationOutbox.id, row.id));

    const claimed = await claimDue(db, 10, actor.organizationId);
    expect(claimed.map((c) => c.row.id)).toContain(row.id);
  });

  it("does not re-claim a message another worker currently holds", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(
      db,
      message(actor.organizationId, `k-${randomUUID()}`),
    );
    if (!row) throw new Error("enqueue returned null");

    const first = await claimDue(db, 10, actor.organizationId);
    expect(first.map((c) => c.row.id)).toContain(row.id);

    const second = await claimDue(db, 10, actor.organizationId);
    expect(second.map((c) => c.row.id)).not.toContain(row.id);
  });
});

describe("the transport's actual outcome is recorded", () => {
  it.each([
    ["429", { status: "retryable", error: "resend 429: rate limited" }],
    ["500", { status: "retryable", error: "resend 500: upstream" }],
    ["timeout", { status: "retryable", error: "The operation was aborted" }],
  ] as const)("retries after a %s", async (_label, outcome) => {
    const actor = await createTestOrg();
    await enqueue(db, message(actor.organizationId, `k-${randomUUID()}`));

    const { send, seen } = scriptedTransport(() => outcome);
    const result = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      send,
    });

    expect({ seen: seen.length, ...result }).toEqual({
      seen: 1,
      claimed: 1,
      delivered: 0,
      retrying: 1,
      failed: 0,
      expired: 0,
      superseded: 0,
      deferred: 0,
    });
    expect(result.retrying).toBe(1);
    expect(result.delivered).toBe(0);

    const [row] = await rowsFor(actor.organizationId);
    expect(row?.state).toBe("queued");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain(outcome.error.slice(0, 10));
    // Backed off, not immediately due again.
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("gives up permanently on a rejection that will never succeed", async () => {
    // Retrying a 400 forever hides a configuration error behind a queue
    // that never drains.
    const actor = await createTestOrg();
    await enqueue(db, message(actor.organizationId, `k-${randomUUID()}`));

    const { send } = scriptedTransport(() => ({
      status: "permanent",
      error: "resend 422: invalid recipient",
    }));
    const result = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      send,
    });

    expect(result.failed).toBe(1);
    const [row] = await rowsFor(actor.organizationId);
    expect(row?.state).toBe("failed");
    expect(row?.attempts).toBe(1);
  });

  it("stops retrying after the attempt budget and says so", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(
      db,
      message(actor.organizationId, `k-${randomUUID()}`),
    );
    if (!row) throw new Error("enqueue returned null");

    const { maxAttempts } = retryPolicy();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Claim it properly so each attempt carries its own fence and
      // writes its own evidence row, which is what the worker does.
      const [claim] = await claimDue(db, 1, actor.organizationId);
      if (!claim) throw new Error("nothing to claim");
      await recordOutcome(db, claim, {
        status: "retryable",
        error: "still failing",
      });
      // Make it due again so the next attempt is not gated on backoff.
      await db
        .update(notificationOutbox)
        .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(eq(notificationOutbox.id, row.id));
    }

    const [final] = await rowsFor(actor.organizationId);
    // Out of TRIES, not out of time - which is a different terminal
    // state from a provider that rejected the message outright.
    expect(final?.state).toBe("dead_letter");
    expect(final?.attempts).toBe(maxAttempts);
    expect(final?.lastError).toContain("still failing");
  });

  it("does not let one transport throw take down the batch", async () => {
    const actor = await createTestOrg();
    await enqueue(db, message(actor.organizationId, `k-${randomUUID()}`));

    const result = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      async send() {
        throw new Error("transport exploded");
      },
    });

    expect(result.retrying).toBe(1);
    const [row] = await rowsFor(actor.organizationId);
    expect(row?.state).toBe("queued");
    expect(row?.lastError).toContain("transport exploded");
  });

  it("redelivers after a retryable failure and then succeeds", async () => {
    const actor = await createTestOrg();
    await enqueue(db, message(actor.organizationId, `k-${randomUUID()}`));

    let attempt = 0;
    const send: EmailTransport["send"] = async () => {
      attempt++;
      return attempt === 1
        ? { status: "retryable", error: "resend 503" }
        : { status: "delivered", providerMessageId: "resend-2" };
    };

    await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      send,
    });
    const [afterFirst] = await rowsFor(actor.organizationId);
    expect(afterFirst?.state).toBe("queued");

    // Skip the backoff the way the passage of time would.
    await db
      .update(notificationOutbox)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(notificationOutbox.organizationId, actor.organizationId));

    await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      send,
    });
    const [afterSecond] = await rowsFor(actor.organizationId);
    expect(afterSecond?.state).toBe("delivered");
    expect(afterSecond?.attempts).toBe(2);
    expect(afterSecond?.providerMessageId).toBe("resend-2");
  });
});

describe("the provider is given a key to dedupe on", () => {
  it("sends the row's identity as an idempotency key", async () => {
    // This is what makes at-least-once delivery produce at most one
    // message in the case that actually happens: a crash after the
    // provider accepted but before the row recorded it.
    const actor = await createTestOrg();
    const row = await enqueue(
      db,
      message(actor.organizationId, `k-${randomUUID()}`),
    );
    if (!row) throw new Error("enqueue returned null");

    const { send, seen } = scriptedTransport(() => ({
      status: "delivered",
      providerMessageId: "resend-3",
    }));
    await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      send,
    });

    expect(seen[0]?.idempotencyKey).toBe(row.id);
  });

  it("a message the provider already accepted is re-sent with the same key", async () => {
    // The worker crashed after Resend accepted. The retry carries the
    // identical key, so Resend collapses it rather than sending twice.
    const actor = await createTestOrg();
    const row = await enqueue(
      db,
      message(actor.organizationId, `k-${randomUUID()}`),
    );
    if (!row) throw new Error("enqueue returned null");

    await db
      .update(notificationOutbox)
      .set({ state: "sending", leasedUntil: new Date(Date.now() - 60_000) })
      .where(eq(notificationOutbox.id, row.id));

    const { send, seen } = scriptedTransport(() => ({
      status: "delivered",
      providerMessageId: "resend-4",
    }));
    await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      send,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.idempotencyKey).toBe(row.id);
  });
});

describe("backoff", () => {
  it("grows with each attempt and stays jittered", () => {
    // Without jitter, a provider outage that queues a thousand messages
    // returns all thousand at the same instant and the recovery is the
    // next outage.
    const lowest = backoffMs(3, () => 0);
    const highest = backoffMs(3, () => 0.999);
    expect(lowest).toBeLessThan(highest);
    expect(backoffMs(1, () => 0.5)).toBeLessThan(backoffMs(5, () => 0.5));
  });

  it("is capped, so no single wait swallows the horizon", () => {
    // The ceiling moved from five minutes to thirty in 1.18.0, because
    // a five-minute ceiling cannot reach a six-hour horizon in twenty
    // attempts. It is still a ceiling: the cap plus the jitter bound
    // is the longest any one message ever waits between tries.
    expect(backoffMs(30, () => 1)).toBeLessThanOrEqual(1_800_000 * 1.25);
    expect(backoffMs(30, () => 1)).toBe(backoffMs(40, () => 1));
  });
});

describe("the transport contract", () => {
  it("reports an outcome rather than resolving silently", async () => {
    // The old signature was `Promise<void>`, which is why a 500 and a
    // delivery were the same thing to every caller.
    setEmailTransport({
      async send() {
        return { status: "permanent", error: "nope" };
      },
    });
    const outcome = await sendEmail({
      to: "a@example.com",
      subject: "s",
      text: "t",
    });
    expect(outcome.status).toBe("permanent");

    // Restored, because this is the one test that touches the singleton
    // and leaving it swapped would make whatever runs next depend on the
    // order it ran in.
    setEmailTransport({
      async send() {
        return { status: "delivered", providerMessageId: null };
      },
    });
  });
});

describe("scoping", () => {
  it("keeps one organization's outbox out of another's", async () => {
    const a = await createTestOrg();
    const b = await createTestOrg();
    await enqueue(db, message(a.organizationId, `k-${randomUUID()}`));

    const theirs = await db
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.organizationId, b.organizationId),
          eq(notificationOutbox.state, "queued"),
        ),
      );
    expect(theirs).toHaveLength(0);
  });
});
