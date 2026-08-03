import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  monitors,
  notificationChannels,
  notificationOutbox,
} from "@/db/schema";
import type { EgressLookup } from "@/modules/monitors/egress";
import { createMonitor } from "@/modules/monitors/service";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import {
  backfillChannelDestinations,
  createChannel,
  deleteChannel,
  dispatchToChannels,
  duplicateChannel,
  getChannel,
  listChannels,
  resolveRoutes,
  setChannelsEnabled,
  updateChannel,
} from "@/modules/notifications/channel-service";
import { runNotificationDelivery } from "@/worker/jobs/notification-delivery";

import { createTestOrg, db, type TestActor } from "../helpers";

/**
 * Routing, scale and the properties that only matter once the channel
 * count is unbounded. No provider is ever really contacted: `fetchImpl`
 * is faked and DNS is pinned, so what is measured here is Vigil's own
 * work — the query, the fan-out and the ledger — and nothing else.
 */

const publicLookup: EgressLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

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

function slackInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Slack - Operations",
    provider: "slack",
    config: {},
    secrets: {
      webhookUrl: `https://hooks.slack.com/services/T00/B00/${randomUUID()}`,
    },
    events: ["monitor", "incident"],
    enabled: true,
    ...overrides,
  } as Parameters<typeof createChannel>[2];
}

async function dispatch(
  actor: TestActor,
  overrides: Record<string, unknown> = {},
) {
  return dispatchToChannels(db, {
    organizationId: actor.organizationId,
    event: "monitor.down",
    causeKey: `incident:${randomUUID()}:monitor.down`,
    subject: "Checkout API",
    detail: [],
    data: {},
    monitorType: "http",
    ...overrides,
  });
}

describe("many-to-many routing", () => {
  it("sends to organization defaults and to channels targeting the monitor", async () => {
    const actor = await createTestOrg();
    const mine = await createMonitor(db, actor, monitorInput());
    const other = await createMonitor(db, actor, monitorInput());

    await createChannel(db, actor, slackInput({ name: "org default" }));
    await createChannel(
      db,
      actor,
      slackInput({ name: "targets mine", monitorIds: [mine.id] }),
    );
    await createChannel(
      db,
      actor,
      slackInput({ name: "targets other", monitorIds: [other.id] }),
    );

    const routes = await resolveRoutes(db, {
      organizationId: actor.organizationId,
      event: "monitor.down",
      monitorType: "http",
      monitorId: mine.id,
    });
    expect(routes.map((r) => r.name).sort()).toEqual([
      "org default",
      "targets mine",
    ]);
  });

  it("gives an event with no monitor to organization defaults only", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    await createChannel(db, actor, slackInput({ name: "org default" }));
    await createChannel(
      db,
      actor,
      slackInput({ name: "scoped", monitorIds: [monitor.id] }),
    );

    // A manually reported incident has no monitor. A channel that asked
    // for one monitor did not ask for this.
    const routes = await resolveRoutes(db, {
      organizationId: actor.organizationId,
      event: "incident.opened",
      monitorId: null,
    });
    expect(routes.map((r) => r.name)).toEqual(["org default"]);
  });

  it("delivers once to a channel matched by several rules", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    // Targeted at the monitor AND subscribed to two classes that both
    // describe this event's family. Overlap must not double-send.
    await createChannel(
      db,
      actor,
      slackInput({
        name: "overlapping",
        events: ["monitor", "incident"],
        monitorIds: [monitor.id],
      }),
    );

    const key = `incident:${randomUUID()}:monitor.down`;
    const first = await dispatch(actor, {
      causeKey: key,
      monitorId: monitor.id,
    });
    const replay = await dispatch(actor, {
      causeKey: key,
      monitorId: monitor.id,
    });

    expect(first).toBe(1);
    // The replay is the same logical event; idempotency collapses it.
    expect(replay).toBe(0);
    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    expect(rows).toHaveLength(1);
  });

  it("stops routing to a channel once it is disabled or deleted", async () => {
    const actor = await createTestOrg();
    const channel = await createChannel(db, actor, slackInput());
    expect(await dispatch(actor)).toBe(1);

    await setChannelsEnabled(db, actor, [channel.id], false);
    expect(await dispatch(actor)).toBe(0);

    await setChannelsEnabled(db, actor, [channel.id], true);
    expect(await dispatch(actor)).toBe(1);

    await deleteChannel(db, actor, channel.id);
    expect(await dispatch(actor)).toBe(0);
  });

  it("keeps routes out of other tenants and refuses foreign monitors", async () => {
    const alice = await createTestOrg();
    const mallory = await createTestOrg();
    const hers = await createMonitor(db, alice, monitorInput());

    await createChannel(db, alice, slackInput({ name: "alice" }));
    await createChannel(db, mallory, slackInput({ name: "mallory" }));

    const routes = await resolveRoutes(db, {
      organizationId: alice.organizationId,
      event: "monitor.down",
      monitorType: "http",
      monitorId: hers.id,
    });
    expect(routes.map((r) => r.name)).toEqual(["alice"]);

    // Mallory cannot scope her channel to Alice's monitor.
    await expect(
      createChannel(
        db,
        mallory,
        slackInput({ name: "sneaky", monitorIds: [hers.id] }),
      ),
    ).rejects.toThrow(/does not exist in this workspace/i);
  });

  it("does NOT widen a scoped channel when its last monitor is deleted", async () => {
    // The bug this pins. Scope is stored on the channel, not inferred
    // from "has any targeting rows", because those rows cascade when a
    // monitor is deleted. Inferring it meant an agency deleting one
    // client's monitors silently turned that client's Slack into a
    // workspace default and started feeding it every other client's
    // alerts. An alert audience must never widen because something else
    // was deleted.
    const actor = await createTestOrg();
    const clientA = await createMonitor(db, actor, monitorInput());
    const clientB = await createMonitor(db, actor, monitorInput());
    const channel = await createChannel(
      db,
      actor,
      slackInput({ name: "Slack - Client A", monitorIds: [clientA.id] }),
    );

    // Before: hears about A's monitor, not about B's.
    expect(
      (
        await resolveRoutes(db, {
          organizationId: actor.organizationId,
          event: "monitor.down",
          monitorType: "http",
          monitorId: clientB.id,
        })
      ).length,
    ).toBe(0);

    await db.delete(monitors).where(eq(monitors.id, clientA.id));

    // After: the cascade took the route, and the channel matches
    // NOTHING rather than everything.
    const after = await getChannel(db, actor.organizationId, channel.id);
    expect(after?.monitorIds).toHaveLength(0);
    expect(after?.scopedToMonitors).toBe(true);
    for (const monitorId of [clientB.id, null]) {
      expect(
        (
          await resolveRoutes(db, {
            organizationId: actor.organizationId,
            event: "monitor.down",
            monitorType: "http",
            monitorId,
          })
        ).length,
        `scoped channel leaked to ${monitorId ?? "an unscoped event"}`,
      ).toBe(0);
    }
    expect(await dispatch(actor)).toBe(0);
  });

  it("lets an emptied scoped channel be returned to the whole workspace", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, monitorInput());
    const channel = await createChannel(
      db,
      actor,
      slackInput({ monitorIds: [monitor.id] }),
    );
    await db.delete(monitors).where(eq(monitors.id, monitor.id));
    expect(await dispatch(actor)).toBe(0);

    // An empty list is an explicit "the whole workspace", not "leave it".
    await updateChannel(db, actor, channel.id, slackInput({ monitorIds: [] }));
    const after = await getChannel(db, actor.organizationId, channel.id);
    expect(after?.scopedToMonitors).toBe(false);
    expect(await dispatch(actor)).toBe(1);
  });
});

describe("duplicate instances of one provider", () => {
  it("routes to every copy, each with its own endpoint", async () => {
    const actor = await createTestOrg();
    for (let i = 0; i < 5; i++) {
      await createChannel(
        db,
        actor,
        slackInput({ name: `Slack - Client ${i}` }),
      );
    }
    expect(await dispatch(actor)).toBe(5);

    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    expect(rows).toHaveLength(5);
    // Five distinct channels, five distinct outbox rows, one event.
    expect(new Set(rows.map((r) => r.channelId)).size).toBe(5);
  });

  it("routes to two channels pointing at the SAME endpoint", async () => {
    const actor = await createTestOrg();
    const url = "https://hooks.slack.com/services/T00/B00/identical";
    await createChannel(
      db,
      actor,
      slackInput({ name: "one", secrets: { webhookUrl: url } }),
    );
    await createChannel(
      db,
      actor,
      slackInput({ name: "two", secrets: { webhookUrl: url } }),
    );
    // Deliberately allowed: identical destinations are two channels,
    // not one. Deduplication is per channel id, never per endpoint.
    expect(await dispatch(actor)).toBe(2);
  });

  it("duplicates a channel with its credentials, disabled", async () => {
    const actor = await createTestOrg();
    const original = await createChannel(db, actor, slackInput());
    const copy = await duplicateChannel(db, actor, original.id);

    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe("Slack - Operations (copy)");
    // Credentials came across...
    expect(copy.secretKeysSet).toEqual(["webhookUrl"]);
    expect(copy.destination).toBe(original.destination);
    // ...but a copy does not start paging anybody.
    expect(copy.enabled).toBe(false);
    expect(await dispatch(actor)).toBe(1);
  });
});

describe("secrets never reach a list", () => {
  it("returns no secret material from listChannels at any size", async () => {
    const actor = await createTestOrg();
    const marker = "SUPERSECRETTOKEN";
    for (let i = 0; i < 10; i++) {
      await createChannel(
        db,
        actor,
        slackInput({
          name: `c${i}`,
          secrets: {
            webhookUrl: `https://hooks.slack.com/services/T/B/${marker}${i}`,
          },
        }),
      );
    }
    const page = await listChannels(db, actor.organizationId, { limit: 200 });
    expect(page.rows).toHaveLength(10);
    expect(JSON.stringify(page)).not.toContain(marker);
    // The destination is present, redacted, and came from the column.
    expect(page.rows[0]!.destination).toBe("hooks.slack.com/[redacted]");
  });

  it("reports which secret keys are set without revealing values", async () => {
    const actor = await createTestOrg();
    const created = await createChannel(db, actor, slackInput());
    const view = await getChannel(db, actor.organizationId, created.id);
    expect(view!.secretKeysSet).toEqual(["webhookUrl"]);
    expect(JSON.stringify(view)).not.toContain("hooks.slack.com/services");
  });
});

describe("search, filters and paging", () => {
  it("filters by provider, status and text, and pages", async () => {
    const actor = await createTestOrg();
    for (let i = 0; i < 12; i++) {
      await createChannel(
        db,
        actor,
        slackInput({ name: `Slack - Client ${i}` }),
      );
    }
    await createChannel(db, actor, {
      name: "Ops pager",
      provider: "telegram",
      config: { chatId: "-1001234567890" },
      secrets: { botToken: "1234567890:AAfake-token-abcdefghijklmnopqrs" },
      events: ["incident"],
      enabled: false,
    });

    const byProvider = await listChannels(db, actor.organizationId, {
      provider: "telegram",
    });
    expect(byProvider.total).toBe(1);
    expect(byProvider.totalUnfiltered).toBe(13);

    const disabled = await listChannels(db, actor.organizationId, {
      status: "disabled",
    });
    expect(disabled.total).toBe(1);

    const searched = await listChannels(db, actor.organizationId, {
      search: "client 1",
    });
    // "Client 1", "Client 10", "Client 11"
    expect(searched.total).toBe(3);

    const firstPage = await listChannels(db, actor.organizationId, {
      limit: 5,
      offset: 0,
    });
    const secondPage = await listChannels(db, actor.organizationId, {
      limit: 5,
      offset: 5,
    });
    expect(firstPage.rows).toHaveLength(5);
    expect(secondPage.rows).toHaveLength(5);
    // Stable ordering: no row appears on both pages.
    const ids = new Set(firstPage.rows.map((r) => r.id));
    expect(secondPage.rows.some((r) => ids.has(r.id))).toBe(false);
  });

  it("shows the last delivery result per channel", async () => {
    const actor = await createTestOrg();
    await createChannel(db, actor, slackInput());
    await dispatch(actor);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { fetchImpl, lookup: publicLookup },
    });

    const page = await listChannels(db, actor.organizationId);
    expect(page.rows[0]!.lastResult?.state).toBe("delivered");
    expect(page.rows[0]!.lastResult?.at).toBeInstanceOf(Date);
  });
});

describe("failure isolation across many channels", () => {
  it("one failing destination does not stop the others", async () => {
    const actor = await createTestOrg();
    const bad = "https://hooks.slack.com/services/T/B/BAD";
    await createChannel(
      db,
      actor,
      slackInput({ name: "bad", secrets: { webhookUrl: bad } }),
    );
    for (let i = 0; i < 4; i++) {
      await createChannel(db, actor, slackInput({ name: `good ${i}` }));
    }
    expect(await dispatch(actor)).toBe(5);

    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("BAD")
        ? new Response("no_service", { status: 404 })
        : new Response("ok"),
    );
    const result = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { fetchImpl, lookup: publicLookup },
    });

    expect(result.delivered).toBe(4);
    expect(result.failed).toBe(1);
  });

  it("marks a row permanently failed when its channel was deleted mid-flight", async () => {
    const actor = await createTestOrg();
    const channel = await createChannel(db, actor, slackInput());
    await dispatch(actor);
    // Deleted after the row was queued, before the worker got to it.
    await deleteChannel(db, actor, channel.id);

    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    const result = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { fetchImpl, lookup: publicLookup },
    });
    expect(result.failed).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    // The ledger outlives the channel it describes.
    expect(row!.state).toBe("failed");
    expect(row!.channelId).toBeNull();
    expect(row!.provider).toBe("slack");
  });
});

describe("drain rate at scale", () => {
  it("clears a wide fan-out in one tick instead of dribbling it out", async () => {
    // The regression this pins. The drain used to take 25 messages a
    // minute globally, which was invisible while an organization could
    // own twenty channels: one incident always fitted in one tick. With
    // the cap gone, 60 channels meant the last one was paged three
    // minutes after the incident, and a thousand meant forty.
    const actor = await createTestOrg();
    for (let i = 0; i < 60; i++) {
      await createChannel(db, actor, slackInput({ name: `c${i}` }));
    }
    expect(await dispatch(actor)).toBe(60);

    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    const tick = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { fetchImpl, lookup: publicLookup },
    });
    expect(tick.claimed).toBe(60);
    expect(tick.delivered).toBe(60);

    // Nothing left over for a second tick.
    const second = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { fetchImpl, lookup: publicLookup },
    });
    expect(second.claimed).toBe(0);
  });

  it("still defers past the per-channel limit rather than flooding one provider", async () => {
    // Raising the batch size must not have raised what one channel can
    // be sent in a tick; those are different limits for different
    // reasons.
    const actor = await createTestOrg();
    await createChannel(db, actor, slackInput());
    for (let i = 0; i < 14; i++) {
      await dispatchToChannels(db, {
        organizationId: actor.organizationId,
        event: "monitor.down",
        causeKey: `burst:${i}:monitor.down`,
        subject: `Burst ${i}`,
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
    expect(tick.delivered).toBe(10);
    expect(tick.deferred).toBe(4);
  });
});

describe("concurrent dispatch", () => {
  it("produces one row per channel when the same event races itself", async () => {
    const actor = await createTestOrg();
    for (let i = 0; i < 5; i++) {
      await createChannel(db, actor, slackInput({ name: `c${i}` }));
    }
    const key = `incident:${randomUUID()}:monitor.down`;

    // Eight concurrent dispatches of ONE logical event. The unique
    // index is the arbiter; the totals must add up to exactly 5.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => dispatch(actor, { causeKey: key })),
    );
    expect(results.reduce((a, b) => a + b, 0)).toBe(5);

    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    expect(rows).toHaveLength(5);
  });
});

describe("backfill", () => {
  it("fills destinations for rows written before the column existed", async () => {
    const actor = await createTestOrg();
    const created = await createChannel(db, actor, slackInput());
    // Simulate a pre-0024 row.
    await db
      .update(notificationChannels)
      .set({ destination: "" })
      .where(eq(notificationChannels.id, created.id));

    const before = await listChannels(db, actor.organizationId);
    expect(before.rows[0]!.destination).toBe("");

    const filled = await backfillChannelDestinations(db);
    expect(filled).toBeGreaterThanOrEqual(1);

    const after = await listChannels(db, actor.organizationId);
    expect(after.rows[0]!.destination).toBe("hooks.slack.com/[redacted]");
  });

  it("keeps the destination current when the endpoint is edited", async () => {
    const actor = await createTestOrg();
    const created = await createChannel(db, actor, {
      name: "ntfy",
      provider: "ntfy",
      config: { serverUrl: "https://ntfy.sh", topic: "first-topic" },
      secrets: {},
      events: ["monitor"],
      enabled: true,
    });
    expect(created.destination).toContain("first-topic");

    const updated = await updateChannel(db, actor, created.id, {
      name: "ntfy",
      provider: "ntfy",
      config: { serverUrl: "https://ntfy.sh", topic: "second-topic" },
      secrets: {},
      events: ["monitor"],
      enabled: true,
    });
    expect(updated.destination).toContain("second-topic");
    const page = await listChannels(db, actor.organizationId);
    expect(page.rows[0]!.destination).toContain("second-topic");
  });
});
