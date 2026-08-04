import { randomUUID } from "node:crypto";

import { and, eq, sql, type SQL } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  incidentEvents,
  incidents,
  notificationIntents,
  notificationOutbox,
  statusPages,
} from "@/db/schema";
import {
  changeIncidentStatus,
  claimIncidentNotification,
  openMonitorIncident,
  resolveMonitorIncidents,
  type Incident,
} from "@/modules/incidents/service";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import {
  createMonitor,
  deleteMonitor,
  recordCheckOutcome,
  type Monitor,
} from "@/modules/monitors/service";
import { claimOpenedNotifications } from "@/modules/monitors/outcome";
import { describeMonitorTarget } from "@/modules/monitors/spec";
import { type EmailMessage, setEmailTransport } from "@/modules/notifications";
import { dispatchToChannels } from "@/modules/notifications/channel-service";
import { createChannel } from "@/modules/notifications/channel-service";
import { expandPendingIntents } from "@/modules/notifications/intent-expansion";
import {
  openedIntent,
  recordDispatchIntent,
} from "@/modules/notifications/intents";
import { enqueueSubscriberEmails } from "@/modules/notifications/subscriber-emails";
import {
  confirmSubscription,
  subscribeToStatusPage,
  unsubscribeByToken,
} from "@/modules/status-pages/subscribers";
import { runNotificationDelivery } from "@/worker/jobs/notification-delivery";

import {
  createTestOrg,
  db,
  failResult,
  okResult,
  withRowLocked,
} from "../helpers";
import type { TestActor } from "../helpers";

/**
 * The windows between "the incident changed" and "somebody was told".
 *
 * Every test here fails on the v1.18.1 tree, and each one is a state a
 * real process can be left in rather than a state a mock can be put in.
 * A crash is not simulated with an injected exception: it is reproduced
 * by stopping at the exact boundary the crash would have stopped at, and
 * then asking what the next worker to come along finds. That is the only
 * question that matters, because in production nothing is left running
 * to be asked anything else.
 *
 * The three boundaries, in the order a delivery crosses them:
 *
 *   1. before the transition commits    - nothing happened at all
 *   2. after it commits, before expansion - an intent, and no messages
 *   3. during expansion                  - some messages, no marker
 *
 * The property under test is the same at each: no notification is lost,
 * and re-entry produces no duplicate.
 */

const sent: EmailMessage[] = [];
setEmailTransport({
  async send(message) {
    sent.push(message);
    return { status: "delivered", providerMessageId: `test-${sent.length}` };
  },
});
beforeEach(() => {
  sent.length = 0;
});
afterAll(() => {
  setEmailTransport({
    async send() {
      return { status: "delivered", providerMessageId: null } as const;
    },
  });
});

function monitorInput(
  overrides: Partial<CreateMonitorInput> = {},
): CreateMonitorInput {
  return {
    name: `Monitor ${randomUUID().slice(0, 8)}`,
    url: "https://vigil-tests.example.com/health",
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
    failureWindowSeconds: 60,
    ...overrides,
  };
}

/** A monitor the database agrees is down, with an open incident. */
async function downMonitorWithIncident(
  actor: TestActor,
): Promise<{ monitor: Monitor; incident: Incident }> {
  const created = await createMonitor(db, actor, monitorInput());
  const { monitor } = await recordCheckOutcome(db, created, failResult());
  const incident = await openMonitorIncident(db, monitor, "connection refused");
  if (!incident) throw new Error("incident was not opened");
  return { monitor, incident };
}

async function intentsFor(incidentId: string) {
  return db
    .select()
    .from(notificationIntents)
    .where(eq(notificationIntents.incidentId, incidentId));
}

async function outboxFor(organizationId: string) {
  return db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.organizationId, organizationId));
}

/**
 * The database's own refusal, unwrapped.
 *
 * Drizzle wraps a driver error in a `DrizzleQueryError` whose message is
 * the SQL, so asserting on `toThrow(/terminal/)` passes against any
 * failure at all - including the query being malformed. The message that
 * proves the trigger fired is on the cause.
 */
async function refusalFor(statement: SQL): Promise<string> {
  try {
    await db.execute(statement);
  } catch (error) {
    for (let cursor = error, depth = 0; cursor && depth < 5; depth++) {
      const message = (cursor as { message?: unknown }).message;
      if (typeof message === "string" && !message.startsWith("Failed query")) {
        return message;
      }
      cursor =
        typeof cursor === "object" && cursor !== null && "cause" in cursor
          ? (cursor as { cause?: unknown }).cause
          : undefined;
    }
    return "the statement failed with no message";
  }
  return "the statement was ACCEPTED";
}

async function timelineFor(incidentId: string): Promise<string[]> {
  const rows = await db
    .select({ message: incidentEvents.message })
    .from(incidentEvents)
    .where(eq(incidentEvents.incidentId, incidentId));
  return rows.map((r) => r.message);
}

describe("1. the claim and what it owes commit together", () => {
  it("a worker that dies after claiming leaves a repairable intent, not silence", async () => {
    const actor = await createTestOrg();
    const { monitor, incident } = await downMonitorWithIncident(actor);

    // The transition. On the old tree this was two transactions - the
    // claim, then the notifications - and a process killed between them
    // left `notified_at` spent with nothing queued. Nothing repaired it
    // either: `findUnhandledAutoIncident` requires `notified_at is
    // null`, so the incident was open, marked notified, and silent
    // forever.
    const claimed = await claimIncidentNotification(
      db,
      incident.id,
      async (tx, row) => {
        await recordDispatchIntent(tx, {
          organizationId: actor.organizationId,
          causeKey: `incident:${row.id}:incident.opened`,
          kind: "incident",
          incidentId: row.id,
          payload: openedIntent({
            incident: row,
            monitor: { ...monitor, failureWindowSeconds: 60 },
            monitorTarget: describeMonitorTarget(monitor),
          }),
        });
      },
    );
    expect(claimed).not.toBeNull();

    // THE CRASH. Nothing expanded it; the process is gone.
    expect(await outboxFor(actor.organizationId)).toHaveLength(0);
    const [pending] = await intentsFor(incident.id);
    expect(pending?.state).toBe("pending");

    // The next worker along finds the debt and pays it.
    const result = await expandPendingIntents(db, {
      organizationId: actor.organizationId,
    });
    expect(result.expanded).toBe(1);
    const rows = await outboxFor(actor.organizationId);
    // One responder email for the org's single owner; no channels are
    // configured and no status page exists.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe("incident.opened");
    // And the debt is marked paid, so the next tick does not pay it
    // again for the rest of the intent's retention.
    const [after] = await intentsFor(incident.id);
    expect(after?.state).toBe("expanded");
    expect(after?.expandedAt).toBeInstanceOf(Date);
  });

  it("a claim whose consequences cannot be written is not spent", async () => {
    const actor = await createTestOrg();
    const { incident } = await downMonitorWithIncident(actor);

    await expect(
      claimIncidentNotification(db, incident.id, async () => {
        throw new Error("the worker died mid-transaction");
      }),
    ).rejects.toThrow("the worker died mid-transaction");

    // `notified_at` is still null, so the next caller can win the claim.
    // Without the shared transaction the claim would have committed and
    // this incident could never be paged for by anything.
    const after = await db.query.incidents.findFirst({
      where: eq(incidents.id, incident.id),
    });
    expect(after?.notifiedAt).toBeNull();
    expect(await intentsFor(incident.id)).toHaveLength(0);
  });
});

describe("2. expansion is idempotent", () => {
  it("a crash between the outbox rows and the marker duplicates nothing", async () => {
    const actor = await createTestOrg();
    const { monitor, incident } = await downMonitorWithIncident(actor);
    await claimOpenedNotifications(incident, monitor);

    const first = await outboxFor(actor.organizationId);
    expect(first.length).toBeGreaterThan(0);

    // The exact state a worker killed after the inserts and before the
    // UPDATE leaves behind: rows written, intent still pending.
    await db
      .update(notificationIntents)
      .set({ state: "pending", expandedAt: null })
      .where(eq(notificationIntents.incidentId, incident.id));

    const again = await expandPendingIntents(db, {
      organizationId: actor.organizationId,
    });
    expect(again.expanded).toBe(1);
    // Re-expanded, and nobody hears about the outage twice.
    const second = await outboxFor(actor.organizationId);
    expect(second.map((r) => r.id).sort()).toEqual(
      first.map((r) => r.id).sort(),
    );
  });

  it("a partially expanded intent finishes the rest without repeating the start", async () => {
    const actor = await createTestOrg();
    await createChannel(db, actor, {
      name: "Ops",
      provider: "slack",
      config: {},
      secrets: {
        webhookUrl: "https://hooks.slack.com/services/T00/B00/xxxxxxxx",
      },
      events: ["incident", "monitor"],
      enabled: true,
    });
    const { monitor, incident } = await downMonitorWithIncident(actor);

    const payload = openedIntent({
      incident,
      monitor: { ...monitor, failureWindowSeconds: 60 },
      monitorTarget: describeMonitorTarget(monitor),
    });
    await db.transaction(async (tx) => {
      await recordDispatchIntent(tx, {
        organizationId: actor.organizationId,
        causeKey: `incident:${incident.id}:incident.opened`,
        kind: "incident",
        incidentId: incident.id,
        payload,
      });
    });

    // Half an expansion: the first dispatch lands, then the process
    // dies. This is the state, written by hand because a real crash
    // cannot be paused.
    const half = payload.dispatches[0]!;
    await dispatchToChannels(db, {
      organizationId: actor.organizationId,
      event: half.event,
      causeKey: half.causeKey,
      subject: half.subject,
      detail: half.detail,
      data: half.data,
      monitorId: half.monitorId ?? null,
    });
    expect(await outboxFor(actor.organizationId)).toHaveLength(1);

    await expandPendingIntents(db, { organizationId: actor.organizationId });

    const rows = await outboxFor(actor.organizationId);
    const keys = rows.map((r) => r.idempotencyKey);
    // Exactly one row per (event, channel) plus the responder email; the
    // half that had already been written is not written again.
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k.startsWith(half.causeKey))).toHaveLength(1);
    expect(rows).toHaveLength(3); // monitor.down, incident.opened, email
  });
});

describe("3. the resolve path", () => {
  it("closes the incident and owes the all-clear in one commit", async () => {
    const actor = await createTestOrg();
    const { monitor, incident } = await downMonitorWithIncident(actor);
    await claimOpenedNotifications(incident, monitor);
    await db
      .delete(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));

    // The monitor comes back.
    const { monitor: up } = await recordCheckOutcome(db, monitor, okResult());
    const resolved = await resolveMonitorIncidents(db, up);
    expect(resolved).toHaveLength(1);

    // THE CRASH, immediately after the resolve committed. On the old
    // tree the all-clear was four transactions that had not run yet, and
    // every repair predicate in the incident module reads `status <>
    // 'resolved'` - so a resolved incident was invisible to all of them
    // and subscribers who heard the outage start never heard it end.
    const [intent] = await intentsFor(incident.id).then((rows) =>
      rows.filter((r) => r.causeKey.endsWith("incident.resolved")),
    );
    expect(intent?.state).toBe("pending");

    await expandPendingIntents(db, { organizationId: actor.organizationId });
    const rows = await outboxFor(actor.organizationId);
    expect(rows.map((r) => r.event)).toContain("incident.resolved");
  });

  it("resolving twice owes one all-clear", async () => {
    const actor = await createTestOrg();
    const { monitor, incident } = await downMonitorWithIncident(actor);
    await claimOpenedNotifications(incident, monitor);
    const { monitor: up } = await recordCheckOutcome(db, monitor, okResult());

    await resolveMonitorIncidents(db, up);
    await resolveMonitorIncidents(db, up);

    const resolvedIntents = await intentsFor(incident.id).then((rows) =>
      rows.filter((r) => r.causeKey.endsWith("incident.resolved")),
    );
    expect(resolvedIntents).toHaveLength(1);
  });

  it("an incident nobody was paged about resolves quietly", async () => {
    const actor = await createTestOrg();
    const { monitor, incident } = await downMonitorWithIncident(actor);
    const { monitor: up } = await recordCheckOutcome(db, monitor, okResult());

    await resolveMonitorIncidents(db, up);

    expect(await intentsFor(incident.id)).toHaveLength(0);
  });
});

describe("4. a resolve racing an open", () => {
  it("never owes an all-clear for an incident that was never announced", async () => {
    const actor = await createTestOrg();
    const { monitor, incident } = await downMonitorWithIncident(actor);

    // A third writer resolves the incident while the claim is blocked on
    // the incident row, so the claim commits into a resolved world.
    let claimed: Incident | null = null;
    await withRowLocked(
      "incidents",
      incident.id,
      1,
      async () => {
        claimed = await claimOpenedNotifications(incident, monitor);
      },
      async (client) => {
        await client.query(
          `update incidents set status = 'resolved', resolved_at = now(),
             status_revision = status_revision + 1 where id = $1`,
          [incident.id],
        );
      },
    );

    // The claim still wins - `notified_at` was null - and the intent it
    // wrote is the OPEN one. What must not happen is two intents with
    // the same cause, or an all-clear for a page that never went out.
    const rows = await intentsFor(incident.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.causeKey).toContain("incident.opened");
    expect(claimed).not.toBeNull();
  });
});

describe("5. resolved is terminal at the database", () => {
  it("refuses to reopen a resolved incident even from raw SQL", async () => {
    const actor = await createTestOrg();
    const { monitor } = await downMonitorWithIncident(actor);
    const { monitor: up } = await recordCheckOutcome(db, monitor, okResult());
    const [resolved] = await resolveMonitorIncidents(db, up);
    if (!resolved) throw new Error("nothing was resolved");

    // Not through the service, which has always refused: straight at the
    // table, which is what a support script, a restore or the next
    // writer nobody has written yet would do.
    expect(
      await refusalFor(
        sql`update ${incidents} set status = 'investigating' where id = ${resolved.id}`,
      ),
    ).toMatch(/terminal/);

    const after = await db.query.incidents.findFirst({
      where: eq(incidents.id, resolved.id),
    });
    expect(after?.status).toBe("resolved");
  });

  it("refuses to move the resolution time", async () => {
    const actor = await createTestOrg();
    const { monitor } = await downMonitorWithIncident(actor);
    const { monitor: up } = await recordCheckOutcome(db, monitor, okResult());
    const [resolved] = await resolveMonitorIncidents(db, up);
    if (!resolved) throw new Error("nothing was resolved");

    expect(
      await refusalFor(
        sql`update ${incidents} set resolved_at = now() + interval '1 hour' where id = ${resolved.id}`,
      ),
    ).toMatch(/cannot move/);
  });

  it("still allows a postmortem, and still allows the monitor to be deleted", async () => {
    // Both are legitimate updates to a closed incident, and a blanket
    // immutability trigger - the shape used for genuinely frozen tables
    // in this schema - would break the second one, because `monitor_id`
    // is ON DELETE SET NULL and a referential SET NULL is an UPDATE.
    const actor = await createTestOrg();
    const { monitor } = await downMonitorWithIncident(actor);
    const { monitor: up } = await recordCheckOutcome(db, monitor, okResult());
    const [resolved] = await resolveMonitorIncidents(db, up);
    if (!resolved) throw new Error("nothing was resolved");

    await db
      .update(incidents)
      .set({ postmortem: "The deploy was bad." })
      .where(eq(incidents.id, resolved.id));

    await expect(deleteMonitor(db, actor, monitor.id)).resolves.toMatchObject(
      {},
    );

    const after = await db.query.incidents.findFirst({
      where: eq(incidents.id, resolved.id),
    });
    expect(after?.monitorId).toBeNull();
    expect(after?.postmortem).toBe("The deploy was bad.");
  });
});

describe("6. deleting a monitor mid-outage", () => {
  it("closes the incident and owes the all-clear in the same transaction", async () => {
    const actor = await createTestOrg();
    const { monitor, incident } = await downMonitorWithIncident(actor);
    await claimOpenedNotifications(incident, monitor);
    await db
      .delete(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));

    await deleteMonitor(db, actor, monitor.id);

    const after = await db.query.incidents.findFirst({
      where: eq(incidents.id, incident.id),
    });
    expect(after?.status).toBe("resolved");
    // Closed AND announced. Before this, an operator retiring a service
    // mid-outage left every status-page subscriber believing it was
    // still down, permanently: no monitor left to recover, and no path
    // that re-examines a resolved incident.
    const resolvedIntents = await intentsFor(incident.id).then((rows) =>
      rows.filter((r) => r.causeKey.endsWith("incident.resolved")),
    );
    expect(resolvedIntents).toHaveLength(1);
    expect(await timelineFor(incident.id)).toContainEqual(
      expect.stringContaining("was deleted"),
    );
  });
});

describe("7. an operator resolving by hand", () => {
  it("sends the all-clear to the people who were paged", async () => {
    const actor = await createTestOrg();
    const { monitor, incident } = await downMonitorWithIncident(actor);
    await claimOpenedNotifications(incident, monitor);

    await changeIncidentStatus(db, actor, incident.id, {
      status: "resolved",
      message: "Fixed by hand.",
    });

    const [intent] = await intentsFor(incident.id).then((rows) =>
      rows.filter((r) => r.causeKey.endsWith("incident.resolved")),
    );
    // `notifyIncidentResolved` had exactly one caller - the automatic
    // path - so anyone woken at 3am by an auto-opened incident that a
    // human then closed never got told it was over.
    const payload = intent?.payload as { memberEmail?: { subject: string } };
    expect(payload?.memberEmail?.subject).toBeTruthy();
  });

  it("stays quiet for an incident nobody was paged about", async () => {
    const actor = await createTestOrg();
    const { incident } = await downMonitorWithIncident(actor);

    await changeIncidentStatus(db, actor, incident.id, {
      status: "resolved",
      message: "Never mind.",
    });

    const [intent] = await intentsFor(incident.id).then((rows) =>
      rows.filter((r) => r.causeKey.endsWith("incident.resolved")),
    );
    const payload = intent?.payload as { memberEmail?: unknown };
    expect(payload?.memberEmail).toBeUndefined();
  });

  it("gives concurrent updates different keys so neither is dropped", async () => {
    const actor = await createTestOrg();
    const { incident } = await downMonitorWithIncident(actor);

    await changeIncidentStatus(db, actor, incident.id, {
      status: "identified",
      message: "We know what it is.",
    });
    await changeIncidentStatus(db, actor, incident.id, {
      status: "monitoring",
      message: "Watching the fix.",
    });

    const updates = await intentsFor(incident.id).then((rows) =>
      rows.filter((r) => r.causeKey.includes("incident.updated")),
    );
    // Two transitions, two intents...
    expect(updates).toHaveLength(2);
    expect(new Set(updates.map((r) => r.causeKey)).size).toBe(2);

    // ...and, which is the part an operator feels, two MESSAGES. The
    // intent key and the key each dispatch carries are separate
    // expressions, and asserting only on the first left the one that
    // reaches the outbox untested: the transition key used to be read
    // from the timeline AFTER the commit, so two concurrent updates
    // computed the same one and the unique index silently dropped the
    // second broadcast.
    const dispatchKeys = updates.flatMap((row) =>
      (row.payload as { dispatches: { causeKey: string }[] }).dispatches.map(
        (d) => d.causeKey,
      ),
    );
    expect(new Set(dispatchKeys).size).toBe(dispatchKeys.length);

    await createChannel(db, actor, {
      name: "Ops",
      provider: "slack",
      config: {},
      secrets: { webhookUrl: "https://hooks.slack.com/services/T00/B00/xxxx" },
      events: ["incident"],
      enabled: true,
    });
    await expandPendingIntents(db, { organizationId: actor.organizationId });
    const broadcast = await outboxFor(actor.organizationId).then((rows) =>
      rows.filter((r) => r.event === "incident.updated"),
    );
    expect(broadcast).toHaveLength(2);
  });
});

describe("8. subscriber mail is queued work, not a fan-out", () => {
  async function publicPageWith(
    actor: TestActor,
    addresses: string[],
  ): Promise<{ pageId: string; tokens: string[] }> {
    const slug = `sp-${randomUUID().slice(0, 8)}`;
    const [page] = await db
      .insert(statusPages)
      .values({
        organizationId: actor.organizationId,
        slug,
        name: `Status ${slug}`,
        published: true,
        visibility: "public",
      })
      .returning({ id: statusPages.id });
    const tokens: string[] = [];
    for (const address of addresses) {
      const sub = await subscribeToStatusPage(db, page!.id, address);
      await confirmSubscription(db, sub.token);
      tokens.push(sub.token);
    }
    return { pageId: page!.id, tokens };
  }

  async function queueFor(
    actor: TestActor,
    incidentId: string,
  ): Promise<number> {
    return db.transaction((tx) =>
      enqueueSubscriberEmails(tx, actor.organizationId, {
        kind: "opened",
        causeKey: `incident:${incidentId}:subscribers:opened`,
        incidentId,
        incidentTitle: "Checkout is failing",
        monitorId: null,
        source: "manual",
      }),
    );
  }

  it("one recipient failing cannot stop the rest", async () => {
    const actor = await createTestOrg();
    await publicPageWith(actor, [
      "one@example.com",
      "two@example.com",
      "three@example.com",
    ]);
    const incidentId = randomUUID();
    expect(await queueFor(actor, incidentId)).toBe(3);

    // The middle one's provider refuses. Separate rows, so it takes
    // nothing with it - the old `Promise.allSettled` over a transport
    // that never rejected could not even report this.
    const result = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      async send(message) {
        if (message.to === "two@example.com") {
          return { status: "permanent", error: "mailbox does not exist" };
        }
        sent.push(message);
        return { status: "delivered", providerMessageId: "ok" };
      },
    });
    expect(result.delivered).toBe(2);
    expect(result.failed).toBe(1);
    expect(sent.map((m) => m.to).sort()).toEqual([
      "one@example.com",
      "three@example.com",
    ]);
  });

  it("does not deliver to somebody who unsubscribed while it was queued", async () => {
    const actor = await createTestOrg();
    const { tokens } = await publicPageWith(actor, [
      "staying@example.com",
      "leaving@example.com",
    ]);
    await queueFor(actor, randomUUID());

    // The window between deciding and delivering was milliseconds when
    // this was a direct send. Through a queue it is up to the retry
    // horizon, so consent has to be re-checked at the moment of sending.
    await unsubscribeByToken(db, tokens[1]!);

    await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
    });

    expect(sent.map((m) => m.to)).toEqual(["staying@example.com"]);
    const rows = await outboxFor(actor.organizationId);
    const refused = rows.find((r) => r.state === "failed");
    expect(refused?.lastError).toMatch(/unsubscribed/);
  });

  it("keeps no unsubscribe token and no plain address in the queued row", async () => {
    const actor = await createTestOrg();
    await publicPageWith(actor, ["private@example.com"]);
    await queueFor(actor, randomUUID());

    const [row] = await outboxFor(actor.organizationId);
    // The link is a bearer credential that never expires, and this table
    // is read by the operator UI, kept for the retention period and
    // present in every backup. It is minted at delivery instead.
    expect(JSON.stringify(row?.payload)).not.toMatch(/token=/);
    expect(row?.destination).not.toBe("private@example.com");
    expect(row?.destination).toContain("@example.com");
  });

  it("queues each subscriber once however often the intent is expanded", async () => {
    const actor = await createTestOrg();
    await publicPageWith(actor, ["a@example.com", "b@example.com"]);
    const incidentId = randomUUID();

    expect(await queueFor(actor, incidentId)).toBe(2);
    expect(await queueFor(actor, incidentId)).toBe(0);
    expect(await outboxFor(actor.organizationId)).toHaveLength(2);
  });
});

describe("9. an intent that cannot be expanded is visible, not silent", () => {
  it("retires a poisoned intent after its attempts and says so", async () => {
    const actor = await createTestOrg();
    const { incident } = await downMonitorWithIncident(actor);
    await db.insert(notificationIntents).values({
      organizationId: actor.organizationId,
      causeKey: `broken:${randomUUID()}`,
      kind: "incident",
      incidentId: incident.id,
      // A payload no builder produces: `dispatches` is not an array, so
      // expansion throws rather than quietly doing nothing.
      payload: { dispatches: "not an array", memberEmail: null },
      attempts: 9,
    });

    const result = await expandPendingIntents(db, {
      organizationId: actor.organizationId,
    });

    expect(result.failed).toBe(1);
    const [row] = await db
      .select()
      .from(notificationIntents)
      .where(
        and(
          eq(notificationIntents.organizationId, actor.organizationId),
          eq(notificationIntents.state, "failed"),
        ),
      );
    expect(row?.lastError).toBeTruthy();
  });
});
