import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { notificationAttempts, notificationOutbox } from "@/db/schema";
import type { EgressLookup } from "@/modules/monitors/egress";
import {
  createChannel,
  deliveryHistory,
  dispatchToChannels,
  replayDeliveries,
} from "@/modules/notifications/channel-service";
import {
  backoffMs,
  claimDue,
  dueRankingSql,
  enqueue,
  expireOverdue,
  pruneNotificationHistory,
  queueHealth,
  recordOutcome,
  retryPolicy,
  sweepStaleAttempts,
  type OutboxMessage,
} from "@/modules/notifications/outbox";
import { runNotificationDelivery } from "@/worker/jobs/notification-delivery";

import { createTestOrg, db, type TestActor } from "../helpers";

/**
 * Durable delivery: the properties 1.18.0 added, each one written as
 * the failure it prevents rather than as the mechanism it uses.
 *
 * These run against the real table because every interesting behaviour
 * here IS the table's - the fence, the partial index, the cascade, the
 * ranking. A mock of Postgres would be a mock of the thing under test.
 */

const publicLookup: EgressLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

function message(organizationId: string, key = randomUUID()): OutboxMessage {
  return {
    organizationId,
    idempotencyKey: key,
    channel: "email",
    destination: "ops@example.com",
    event: "monitor.down",
    payload: { subject: "Monitor down", text: "Checkout API is down." },
  };
}

/** Makes a queued row due now, so a test does not wait out a backoff. */
async function makeDue(id: string) {
  await db
    .update(notificationOutbox)
    .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
    .where(eq(notificationOutbox.id, id));
}

async function rowFor(id: string) {
  const [row] = await db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.id, id));
  return row;
}

async function attemptsOf(outboxId: string) {
  return db
    .select()
    .from(notificationAttempts)
    .where(eq(notificationAttempts.outboxId, outboxId))
    .orderBy(notificationAttempts.attempt);
}

/* ------------------------------------------------------------------ */
/* The retry schedule survives a provider being down for hours          */
/* ------------------------------------------------------------------ */

describe("a provider that is down for hours", () => {
  it("keeps the message queued long past the minute 1.17.0 gave up at", async () => {
    // The regression this release exists for. Under 1.17.0 six attempts
    // spanned 31 to 62 seconds, so a provider out for two minutes ended
    // with every queued alert marked failed. Here the same six attempts
    // leave the message queued with hours of budget left.
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");

    for (let i = 0; i < 6; i++) {
      await makeDue(row.id);
      const [claim] = await claimDue(db, 1, actor.organizationId);
      if (!claim) throw new Error("nothing claimed");
      const recorded = await recordOutcome(db, claim, {
        status: "retryable",
        error: "503: provider is down",
      });
      expect(recorded.committed).toBe(true);
      expect(recorded.state).toBe("queued");
    }

    const after = await rowFor(row.id);
    expect(after?.state).toBe("queued");
    expect(after?.attempts).toBe(6);
    // Still hours from its deadline rather than a minute past it.
    const remainingMs = after!.expiresAt!.getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(4 * 60 * 60 * 1_000);
  });

  it("dead-letters when it runs out of tries, and says which bound it hit", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    const { maxAttempts } = retryPolicy();

    for (let i = 0; i < maxAttempts; i++) {
      await makeDue(row.id);
      const [claim] = await claimDue(db, 1, actor.organizationId);
      if (!claim) throw new Error("nothing claimed");
      await recordOutcome(db, claim, {
        status: "retryable",
        error: "503: still down",
      });
    }

    const after = await rowFor(row.id);
    // Out of TRIES. A provider answering fast and badly.
    expect(after?.state).toBe("dead_letter");
    expect(after?.attempts).toBe(maxAttempts);
  });

  it("expires when it runs out of time, which is a different fact", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");

    // Bring the deadline inside the next backoff rather than waiting
    // six hours: the decision under test is "would the next attempt
    // land past the horizon", and that is what this arranges.
    await db
      .update(notificationOutbox)
      .set({ expiresAt: new Date(Date.now() + 500) })
      .where(eq(notificationOutbox.id, row.id));

    const [claim] = await claimDue(db, 1, actor.organizationId);
    if (!claim) throw new Error("nothing claimed");
    const recorded = await recordOutcome(db, claim, {
      status: "retryable",
      error: "503: unreachable",
    });

    // Out of TIME, on attempt one. A provider that is simply gone.
    expect(recorded.state).toBe("expired");
    expect((await rowFor(row.id))?.state).toBe("expired");
  });

  it("retires a row whose deadline passes while it waits out a backoff", async () => {
    // `recordOutcome` only sees a message when its next attempt comes
    // due. A row parked behind a thirty-minute wait when the deadline
    // arrives would otherwise sit until the wait elapsed and only then
    // be told it was too late.
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    await db
      .update(notificationOutbox)
      .set({
        expiresAt: new Date(Date.now() - 1_000),
        nextAttemptAt: new Date(Date.now() + 60 * 60 * 1_000),
      })
      .where(eq(notificationOutbox.id, row.id));

    expect(await expireOverdue(db, actor.organizationId)).toBe(1);
    expect((await rowFor(row.id))?.state).toBe("expired");
  });

  it("never expires a row a worker is holding", async () => {
    // Expiring a row out from under its worker is the same class of
    // violation the fence exists to remove.
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    const [claim] = await claimDue(db, 1, actor.organizationId);
    expect(claim).toBeTruthy();
    await db
      .update(notificationOutbox)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(notificationOutbox.id, row.id));

    expect(await expireOverdue(db, actor.organizationId)).toBe(0);
    expect((await rowFor(row.id))?.state).toBe("sending");
  });

  it("honours Retry-After, bounded", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    const [claim] = await claimDue(db, 1, actor.organizationId);
    if (!claim) throw new Error("nothing claimed");

    const before = Date.now();
    await recordOutcome(db, claim, {
      status: "retryable",
      error: "429: slow down",
      // Far beyond the cap: a broken proxy could send this, and honoured
      // literally it would park the message past its own horizon.
      retryAfterMs: 48 * 60 * 60 * 1_000,
    });

    const after = await rowFor(row.id);
    const waited = after!.nextAttemptAt.getTime() - before;
    expect(waited).toBeLessThanOrEqual(60 * 60 * 1_000 + 5_000);
    // And it did respect it as far as the cap allows, rather than
    // ignoring the provider entirely.
    expect(waited).toBeGreaterThan(50 * 60 * 1_000);
    const [attempt] = await attemptsOf(row.id);
    expect(attempt?.retryAfterMs).toBe(48 * 60 * 60 * 1_000);
  });

  it("does not retry a rejected credential even once", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    const [claim] = await claimDue(db, 1, actor.organizationId);
    if (!claim) throw new Error("nothing claimed");

    const recorded = await recordOutcome(db, claim, {
      status: "permanent",
      error: "401: invalid api key",
      httpStatus: 401,
    });
    expect(recorded.state).toBe("failed");
    expect((await rowFor(row.id))?.attempts).toBe(1);
    const [attempt] = await attemptsOf(row.id);
    expect(attempt?.outcome).toBe("permanent");
    expect(attempt?.httpStatus).toBe(401);
  });

  it("keeps the schedule across a restart, because it is in the row", async () => {
    // Nothing about the retry lives in worker memory: the whole
    // schedule is `next_attempt_at` and `expires_at` on the row, so a
    // redeploy mid-outage changes nothing about when a message is next
    // tried. Simulated by reading the row back through a fresh query
    // after the outcome, which is all a restarted worker does.
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    const [claim] = await claimDue(db, 1, actor.organizationId);
    if (!claim) throw new Error("nothing claimed");
    await recordOutcome(db, claim, { status: "retryable", error: "503" });

    const scheduled = (await rowFor(row.id))!.nextAttemptAt;
    // A "restarted" worker drains: the row is not due, so it is not
    // taken, and its schedule is untouched.
    const tick = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { lookup: publicLookup },
    });
    expect(tick.claimed).toBe(0);
    expect((await rowFor(row.id))!.nextAttemptAt.getTime()).toBe(
      scheduled.getTime(),
    );
  });
});

/* ------------------------------------------------------------------ */
/* Evidence and fencing                                                 */
/* ------------------------------------------------------------------ */

describe("every attempt leaves evidence", () => {
  it("writes the attempt row before anything can be sent", async () => {
    // The ordering is the guarantee: a worker that dies between the
    // claim and the send has still left a record that it took the row.
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");

    const [claim] = await claimDue(db, 1, actor.organizationId);
    expect(claim).toBeTruthy();
    const attempts = await attemptsOf(row.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe("claimed");
    expect(attempts[0]!.finishedAt).toBeNull();
    expect(attempts[0]!.fence).toBe(claim!.fence);
  });

  it("keeps one row per attempt, and no attempt overwrites another", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");

    for (const error of ["503: first", "503: second", "503: third"]) {
      await makeDue(row.id);
      const [claim] = await claimDue(db, 1, actor.organizationId);
      if (!claim) throw new Error("nothing claimed");
      await recordOutcome(db, claim, { status: "retryable", error });
    }

    const attempts = await attemptsOf(row.id);
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    // The outbox row keeps only the LAST error, which is exactly why
    // the evidence table exists.
    expect(attempts.map((a) => a.error)).toEqual([
      "503: first",
      "503: second",
      "503: third",
    ]);
    expect((await rowFor(row.id))?.lastError).toBe("503: third");
  });

  it("records an unknown outcome as unknown, not as a plain retry", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    const [claim] = await claimDue(db, 1, actor.organizationId);
    if (!claim) throw new Error("nothing claimed");

    await recordOutcome(db, claim, {
      status: "unknown",
      error: "The operation was aborted",
    });
    const [attempt] = await attemptsOf(row.id);
    expect(attempt?.outcome).toBe("unknown");
    // Retried like any other transient failure - at-least-once is the
    // promise - but the ledger says a duplicate cannot be ruled out.
    expect((await rowFor(row.id))?.state).toBe("queued");
  });

  it("closes an attempt whose worker never came back", async () => {
    // A crash after the send: the attempt row stays `claimed` forever,
    // which reads as "still in flight" and is the one state that means
    // "a request may have gone out and nobody knows what happened".
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    await claimDue(db, 1, actor.organizationId);

    await db
      .update(notificationAttempts)
      .set({ startedAt: new Date(Date.now() - 2 * 60 * 60 * 1_000) })
      .where(eq(notificationAttempts.outboxId, row.id));

    expect(
      await sweepStaleAttempts(db, new Date(Date.now() - 60 * 60 * 1_000)),
    ).toBeGreaterThanOrEqual(1);
    const [attempt] = await attemptsOf(row.id);
    expect(attempt?.outcome).toBe("unknown");
    expect(attempt?.finishedAt).not.toBeNull();
  });

  it("does not close an attempt that is legitimately still running", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    await claimDue(db, 1, actor.organizationId);

    await sweepStaleAttempts(db, new Date(Date.now() - 60 * 60 * 1_000));
    const [attempt] = await attemptsOf(row.id);
    expect(attempt?.outcome).toBe("claimed");
  });

  it("removes the attempt row when a deferral means nothing was sent", async () => {
    // A deferred message did nothing wrong and reached no provider, so
    // leaving evidence of an attempt would be evidence of a send that
    // never happened.
    const actor = await createTestOrg();
    const channel = await createChannel(db, actor, {
      name: "Slack",
      provider: "slack",
      config: {},
      secrets: {
        webhookUrl: `https://hooks.slack.com/services/T/B/${randomUUID()}`,
      },
      events: ["monitor"],
      enabled: true,
    });
    for (let i = 0; i < 12; i++) {
      await dispatchToChannels(db, {
        organizationId: actor.organizationId,
        event: "monitor.down",
        causeKey: `burst:${i}:${randomUUID()}`,
        subject: "Checkout API",
        detail: [],
        data: {},
        monitorType: "http",
      });
    }
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    const tick = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { fetchImpl, lookup: publicLookup },
    });
    expect(tick.deferred).toBeGreaterThan(0);

    const deferred = await db
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.organizationId, actor.organizationId),
          eq(notificationOutbox.channelId, channel.id),
          eq(notificationOutbox.attempts, 0),
          eq(notificationOutbox.state, "queued"),
        ),
      );
    expect(deferred.length).toBeGreaterThan(0);
    const orphans = await db
      .select()
      .from(notificationAttempts)
      .where(
        inArray(
          notificationAttempts.outboxId,
          deferred.map((row) => row.id),
        ),
      );
    expect(orphans).toHaveLength(0);
  });
});

describe("lease fencing", () => {
  it("refuses a write from a worker whose lease was taken over", async () => {
    // The exact race: worker A claims, is paused past its lease, worker
    // B re-claims and sends, then A wakes up and tries to write. Under
    // a lease alone A's result would land on B's send, and the ledger
    // would report the loser's outcome.
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");

    const [a] = await claimDue(db, 1, actor.organizationId);
    if (!a) throw new Error("A claimed nothing");

    // A's lease expires.
    await db
      .update(notificationOutbox)
      .set({ leasedUntil: new Date(Date.now() - 1_000) })
      .where(eq(notificationOutbox.id, row.id));

    const [b] = await claimDue(db, 1, actor.organizationId);
    if (!b) throw new Error("B claimed nothing");
    expect(b.fence).toBeGreaterThan(a.fence);

    // B delivers.
    const bResult = await recordOutcome(db, b, {
      status: "delivered",
      providerMessageId: "b-1",
    });
    expect(bResult.committed).toBe(true);

    // A wakes up and reports a failure. It must not win.
    const aResult = await recordOutcome(db, a, {
      status: "permanent",
      error: "401: stale worker's answer",
    });
    expect(aResult.committed).toBe(false);

    const after = await rowFor(row.id);
    expect(after?.state).toBe("delivered");
    expect(after?.providerMessageId).toBe("b-1");
    expect(after?.lastError).toBeNull();
  });

  it("records the superseded worker's attempt as unknown", async () => {
    // A cannot say "delivered" and cannot say "failed": it genuinely
    // does not know whether its own request arrived. `unknown` is the
    // only honest answer, and it is also the duplicate warning.
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");

    const [a] = await claimDue(db, 1, actor.organizationId);
    await db
      .update(notificationOutbox)
      .set({ leasedUntil: new Date(Date.now() - 1_000) })
      .where(eq(notificationOutbox.id, row.id));
    const [b] = await claimDue(db, 1, actor.organizationId);
    await recordOutcome(db, b!, {
      status: "delivered",
      providerMessageId: "b-1",
    });
    await recordOutcome(db, a!, { status: "retryable", error: "503" });

    const attempts = await attemptsOf(row.id);
    const first = attempts.find((x) => x.fence === a!.fence);
    expect(first?.outcome).toBe("unknown");
    expect(first?.error).toContain("superseded");

    // And the health view counts it, so an operator can see that a
    // duplicate is possible without reading the table.
    const health = await queueHealth(db, actor.organizationId);
    expect(health.unknownAttempts).toBeGreaterThanOrEqual(1);
  });

  it("refuses a lease renewal from a superseded worker", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    const [a] = await claimDue(db, 1, actor.organizationId);
    await db
      .update(notificationOutbox)
      .set({ leasedUntil: new Date(Date.now() - 1_000) })
      .where(eq(notificationOutbox.id, row.id));
    const [b] = await claimDue(db, 1, actor.organizationId);

    const { renewLease } = await import("@/modules/notifications/outbox");
    const bLease = (await rowFor(row.id))!.leasedUntil!;
    await renewLease(db, row.id, a!.fence);
    // A's renewal changed nothing: B's lease is intact.
    expect((await rowFor(row.id))!.leasedUntil!.getTime()).toBe(
      bLease.getTime(),
    );
    expect(b!.fence).toBeGreaterThan(a!.fence);
  });

  it("gives two concurrent claims of one row to exactly one worker", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");

    const [first, second] = await Promise.all([
      claimDue(db, 5, actor.organizationId),
      claimDue(db, 5, actor.organizationId),
    ]);
    const claimedIds = [...first, ...second].map((c) => c.row.id);
    expect(claimedIds.filter((id) => id === row.id)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Fairness                                                             */
/* ------------------------------------------------------------------ */

describe("fair draining", () => {
  it("does not let one tenant's fan-out starve another's single alert", async () => {
    // The starvation this replaces: under `order by next_attempt_at`, a
    // six-hundred-message fan-out queued a moment earlier owns the head
    // of the queue, and a small tenant's single page waits behind every
    // one of them.
    //
    // Asserted on the ORDERING rather than on a global claim, and the
    // reason is worth stating: the batch is a scarce resource shared
    // with every other tenant in the database, so "was it in the first
    // 250" measures how busy the test database happens to be. The
    // position the ranking gives it is the property this release
    // actually changed, and it is the same expression `claimDue` runs.
    const big = await createTestOrg();
    const small = await createTestOrg();

    const bulk = Array.from({ length: 600 }, () => message(big.organizationId));
    const bulkDue = new Date(Date.now() - 10_000);
    await db.insert(notificationOutbox).values(
      bulk.map((m) => ({
        organizationId: m.organizationId,
        idempotencyKey: m.idempotencyKey,
        channel: m.channel,
        destination: m.destination,
        event: m.event,
        payload: m.payload,
        // Queued ten seconds BEFORE the small tenant's message, so
        // first-come ordering would put every one of them first.
        nextAttemptAt: bulkDue,
      })),
    );
    const late = await enqueue(db, message(small.organizationId));
    if (!late) throw new Error("enqueue returned null");
    await db
      .update(notificationOutbox)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(notificationOutbox.id, late.id));

    const scope = [big.organizationId, small.organizationId];

    // What the old ordering would have done.
    const { rows: firstCome } = await db.execute<{ id: string }>(sql`
      select id from ${notificationOutbox}
      where state = 'queued'
        and organization_id in (${sql.join(
          scope.map((id) => sql`${id}`),
          sql`, `,
        )})
      order by next_attempt_at, id
    `);
    const oldPosition = firstCome.findIndex((r) => r.id === late.id) + 1;
    expect(oldPosition).toBeGreaterThan(500);

    // What fair selection does - using the EXPRESSION THE WORKER USES,
    // not a copy of it. An earlier version of this test rewrote the
    // ranking by hand, which meant it passed whatever `claimDue`
    // actually ordered by; deleting the `partition by` would have left
    // it green.
    const { rows: fair } = await db.execute<{ id: string }>(
      dueRankingSql(
        10_000,
        sql`and o.organization_id in (${sql.join(
          scope.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    );
    const fairPosition = fair.findIndex((r) => r.id === late.id) + 1;
    expect(fairPosition).toBeLessThanOrEqual(2);

    // And the big tenant is not penalised: it still takes almost all of
    // a batch, because this is round-robin, not an equal split.
    const firstBatch = fair.slice(0, 250);
    const bigShare = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.organizationId, big.organizationId),
          inArray(
            notificationOutbox.id,
            firstBatch.map((r) => r.id),
          ),
        ),
      );
    expect(bigShare[0]!.count).toBeGreaterThan(240);
  }, 60_000);

  it("stays oldest-first within one tenant", async () => {
    const actor = await createTestOrg();
    const older = await enqueue(db, message(actor.organizationId));
    const newer = await enqueue(db, message(actor.organizationId));
    if (!older || !newer) throw new Error("enqueue returned null");
    await db
      .update(notificationOutbox)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(notificationOutbox.id, older.id));

    const claimed = await claimDue(db, 1, actor.organizationId);
    expect(claimed.map((c) => c.row.id)).toEqual([older.id]);
  });
});

/* ------------------------------------------------------------------ */
/* Replay, retention and tenancy                                        */
/* ------------------------------------------------------------------ */

describe("replay", () => {
  async function terminalRow(actor: TestActor) {
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    const [claim] = await claimDue(db, 1, actor.organizationId);
    await recordOutcome(db, claim!, {
      status: "permanent",
      error: "401: bad credential",
    });
    return row;
  }

  it("creates new work and never rewinds the original", async () => {
    const actor = await createTestOrg();
    const original = await terminalRow(actor);

    const result = await replayDeliveries(db, actor, [original.id]);
    expect(result).toEqual({ replayed: 1, skipped: 0 });

    // The original is untouched: its state, its attempts and its reason
    // are the record of what happened, and a replay must not erase it.
    const after = await rowFor(original.id);
    expect(after?.state).toBe("failed");
    expect(after?.attempts).toBe(1);
    expect(after?.lastError).toContain("401");

    const [copy] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.replayOf, original.id));
    expect(copy?.state).toBe("queued");
    expect(copy?.attempts).toBe(0);
    expect(copy?.payload).toEqual(original.payload);
    expect(copy?.expiresAt).not.toBeNull();
  });

  it("replays twice into two deliveries, not one collapsed by the key", async () => {
    const actor = await createTestOrg();
    const original = await terminalRow(actor);
    await replayDeliveries(db, actor, [original.id]);
    await replayDeliveries(db, actor, [original.id]);
    const copies = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.replayOf, original.id));
    expect(copies).toHaveLength(2);
  });

  it("refuses to replay something still in progress", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    await expect(replayDeliveries(db, actor, [row.id])).rejects.toThrow(
      /still in progress/i,
    );
  });

  it("cannot replay another tenant's delivery", async () => {
    const mine = await createTestOrg();
    const theirs = await createTestOrg();
    const original = await terminalRow(theirs);
    await expect(replayDeliveries(db, mine, [original.id])).rejects.toThrow();
    const copies = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.replayOf, original.id));
    expect(copies).toHaveLength(0);
  });

  it("writes an audit row naming who replayed what", async () => {
    const actor = await createTestOrg();
    const original = await terminalRow(actor);
    await replayDeliveries(db, actor, [original.id]);
    const { rows } = await db.execute<{ action: string; actor_id: string }>(
      sql`select action, actor_id from audit_logs
          where organization_id = ${actor.organizationId}
            and action = 'notification_delivery.replayed'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(actor.userId);
  });
});

describe("retention", () => {
  it("removes finished deliveries and their evidence together", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    const [claim] = await claimDue(db, 1, actor.organizationId);
    await recordOutcome(db, claim!, {
      status: "delivered",
      providerMessageId: "x",
    });
    await db
      .update(notificationOutbox)
      .set({ createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000) })
      .where(eq(notificationOutbox.id, row.id));

    const pruned = await pruneNotificationHistory(db, 30);
    expect(pruned.deliveries).toBeGreaterThanOrEqual(1);
    expect(pruned.attempts).toBeGreaterThanOrEqual(1);
    expect(await rowFor(row.id)).toBeUndefined();
    expect(await attemptsOf(row.id)).toHaveLength(0);
  });

  it("never removes a message that is still going to be sent", async () => {
    // A late message is not an old one. Deleting a queued row would
    // silently drop a notification the outbox promised to deliver.
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    await db
      .update(notificationOutbox)
      .set({ createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1_000) })
      .where(eq(notificationOutbox.id, row.id));

    await pruneNotificationHistory(db, 30);
    expect((await rowFor(row.id))?.state).toBe("queued");
  });

  it("is bounded, and says when there is more to do", async () => {
    const actor = await createTestOrg();
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000);
    await db.insert(notificationOutbox).values(
      Array.from({ length: 5 }, () => {
        const m = message(actor.organizationId);
        return {
          organizationId: m.organizationId,
          idempotencyKey: m.idempotencyKey,
          channel: m.channel,
          destination: m.destination,
          payload: m.payload,
          state: "delivered" as const,
          createdAt: old,
        };
      }),
    );
    const first = await pruneNotificationHistory(db, 30, 2);
    expect(first.deliveries).toBe(2);
    expect(first.more).toBe(true);
  });
});

describe("the ledger an operator reads", () => {
  it("shows attempts, the next retry and why it stopped", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    const [claim] = await claimDue(db, 1, actor.organizationId);
    await recordOutcome(db, claim!, {
      status: "retryable",
      error: "503: upstream",
    });

    const page = await deliveryHistory(db, actor.organizationId);
    const entry = page.rows.find((r) => r.id === row.id);
    expect(entry?.attempts).toBe(1);
    expect(entry?.state).toBe("queued");
    expect(entry?.nextAttemptAt).not.toBeNull();
    expect(entry?.lastError).toContain("503");
    expect(entry?.expiresAt).not.toBeNull();
  });

  it("does not offer a next retry for a message that has stopped", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    const [claim] = await claimDue(db, 1, actor.organizationId);
    await recordOutcome(db, claim!, {
      status: "permanent",
      error: "401: nope",
    });
    const page = await deliveryHistory(db, actor.organizationId);
    expect(page.rows.find((r) => r.id === row.id)?.nextAttemptAt).toBeNull();
  });

  it("filters to everything that is not delivered", async () => {
    const actor = await createTestOrg();
    const good = await enqueue(db, message(actor.organizationId));
    const bad = await enqueue(db, message(actor.organizationId));
    if (!good || !bad) throw new Error("enqueue returned null");
    // One claim takes both, so the outcomes are recorded from that one
    // batch rather than by claiming twice.
    const claimed = await claimDue(db, 5, actor.organizationId);
    for (const claim of claimed) {
      await recordOutcome(
        db,
        claim,
        claim.row.id === good.id
          ? { status: "delivered", providerMessageId: "x" }
          : { status: "permanent", error: "401" },
      );
    }
    const page = await deliveryHistory(db, actor.organizationId, {
      state: "unhappy",
    });
    expect(page.rows.map((r) => r.id)).toEqual([bad.id]);
  });

  it("shows one tenant nothing of another's", async () => {
    const mine = await createTestOrg();
    const theirs = await createTestOrg();
    await enqueue(db, message(theirs.organizationId));
    const page = await deliveryHistory(db, mine.organizationId);
    expect(page.rows).toHaveLength(0);
    expect(page.total).toBe(0);
  });

  it("reports queue pressure without reading every row", async () => {
    const actor = await createTestOrg();
    await enqueue(db, message(actor.organizationId));
    await enqueue(db, message(actor.organizationId));
    const health = await queueHealth(db, actor.organizationId);
    expect(health.queued).toBe(2);
    expect(health.oldestQueuedAt).not.toBeNull();
  });
});

describe("configuration", () => {
  it("keeps both retry bounds reachable, whatever they are set to", () => {
    // Not a transcription of the defaults - a relationship that has to
    // hold for the two controls to be two controls. The attempt budget
    // must be spendable INSIDE the horizon (or the horizon never bites
    // and `expired` is unreachable), and the horizon must be able to
    // arrive first for a provider that is simply unreachable.
    const { maxAttempts, horizonHours } = retryPolicy();
    let shortest = 0;
    for (let attempt = 1; attempt < maxAttempts; attempt++) {
      shortest += backoffMs(attempt, () => 0);
    }
    expect(shortest).toBeLessThan(horizonHours * 60 * 60 * 1_000);
    // And long enough to be worth the name: a durable retry that gives
    // up in minutes is the thing this release replaced.
    expect(shortest).toBeGreaterThan(60 * 60 * 1_000);
  });
});

describe("a message past its horizon is never delivered", () => {
  it("is not claimed even when its lease was abandoned mid-flight", async () => {
    // The window the horizon predicate closes: a worker claims a minute
    // before the deadline and dies. The row stays `sending`, the sweep
    // will not touch a leased row, and when the lease expires the next
    // tick used to re-claim and deliver it - hours past a deadline the
    // product justifies on the grounds that a late page is a false one.
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    const [claim] = await claimDue(db, 1, actor.organizationId);
    expect(claim).toBeTruthy();

    // The worker dies; the deadline passes; the lease expires.
    await db
      .update(notificationOutbox)
      .set({
        expiresAt: new Date(Date.now() - 1_000),
        leasedUntil: new Date(Date.now() - 1_000),
      })
      .where(eq(notificationOutbox.id, row.id));

    expect(await claimDue(db, 10, actor.organizationId)).toHaveLength(0);
  });

  it("is retired by the sweep once nobody holds it, with the fence bumped", async () => {
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    const [claim] = await claimDue(db, 1, actor.organizationId);
    if (!claim) throw new Error("nothing claimed");
    await db
      .update(notificationOutbox)
      .set({
        expiresAt: new Date(Date.now() - 1_000),
        leasedUntil: new Date(Date.now() - 1_000),
      })
      .where(eq(notificationOutbox.id, row.id));

    expect(await expireOverdue(db, actor.organizationId)).toBe(1);
    const after = await rowFor(row.id);
    expect(after?.state).toBe("expired");
    // Bumped, so the worker that was holding it cannot commit over the
    // expiry when it wakes up.
    expect(after!.fence).toBeGreaterThan(claim.fence);
    const recorded = await recordOutcome(db, claim, {
      status: "delivered",
      providerMessageId: "too-late",
    });
    expect(recorded.committed).toBe(false);
    expect((await rowFor(row.id))?.state).toBe("expired");
  });
});

describe("a deferral that races the stale-claim sweep", () => {
  it("does not desync the attempt counter", async () => {
    // The counter and the evidence must agree, or the next claim
    // computes an attempt number that already exists. The delete is
    // narrower than the decrement - it also requires the attempt to
    // still read `claimed` - and the sweep can change that underneath.
    const actor = await createTestOrg();
    const row = await enqueue(db, message(actor.organizationId));
    if (!row) throw new Error("enqueue returned null");
    const [claim] = await claimDue(db, 1, actor.organizationId);
    if (!claim) throw new Error("nothing claimed");

    // The sweep gets there first.
    await db
      .update(notificationAttempts)
      .set({ outcome: "unknown", finishedAt: new Date() })
      .where(eq(notificationAttempts.outboxId, row.id));

    const { deferRow } = await import("@/modules/notifications/outbox");
    await deferRow(db, claim, 0);

    const after = await rowFor(row.id);
    const attempts = await attemptsOf(row.id);
    // The attempt was NOT given back, because its evidence survived.
    expect(after?.attempts).toBe(Math.max(...attempts.map((a) => a.attempt)));

    // And the next claim can still take it, which is the failure this
    // guards: a mismatch here made the insert violate the unique index
    // and rolled back the whole batch, every tick, forever.
    await makeDue(row.id);
    const [again] = await claimDue(db, 1, actor.organizationId);
    expect(again).toBeTruthy();
    expect(again!.attempt).toBeGreaterThan(claim.attempt);
  });
});
