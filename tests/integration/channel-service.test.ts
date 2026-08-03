import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  auditLogs,
  notificationChannels,
  notificationOutbox,
} from "@/db/schema";
import type { EgressLookup } from "@/modules/monitors/egress";
import {
  createChannel,
  deleteChannel,
  dispatchToChannels,
  listChannels,
  sealPlainChannelSecrets,
  testChannel,
  updateChannel,
  MAX_CHANNELS_PER_ORG,
} from "@/modules/notifications/channel-service";
import { openSecrets } from "@/modules/notifications/secretbox";
import { sendIncidentWebhook } from "@/modules/notifications/webhook-service";
import { createIncident } from "@/modules/incidents/service";
import { runNotificationDelivery } from "@/worker/jobs/notification-delivery";

import { createTestOrg, db } from "../helpers";

const publicLookup: EgressLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

const SLACK_URL = "https://hooks.slack.com/services/T00/B00/secret-token";

function slackInput(
  overrides: Partial<Parameters<typeof createChannel>[2]> = {},
) {
  return {
    name: "Ops room",
    provider: "slack",
    config: {},
    secrets: { webhookUrl: SLACK_URL },
    events: ["monitor", "incident"],
    enabled: true,
    ...overrides,
  };
}

describe("channel CRUD", () => {
  it("creates a channel with sealed secrets and an audit row", async () => {
    const actor = await createTestOrg();
    const view = await createChannel(db, actor, slackInput());

    expect(view.provider).toBe("slack");
    expect(view.secretKeysSet).toEqual(["webhookUrl"]);
    // The view never carries the secret, and the summary is redacted.
    expect(JSON.stringify(view)).not.toContain("secret-token");

    const [row] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, view.id));
    expect(row!.secrets.startsWith("enc1:")).toBe(true);
    expect(row!.secrets).not.toContain("secret-token");
    expect(openSecrets(row!.secrets)).toEqual({ webhookUrl: SLACK_URL });

    const audit = await db.query.auditLogs.findMany({
      where: and(
        eq(auditLogs.organizationId, actor.organizationId),
        eq(auditLogs.action, "notification_channel.created"),
      ),
    });
    expect(audit).toHaveLength(1);
  });

  it("keeps stored secrets when an update leaves them blank", async () => {
    const actor = await createTestOrg();
    const created = await createChannel(db, actor, slackInput());
    const updated = await updateChannel(db, actor, created.id, {
      ...slackInput({ name: "Renamed" }),
      secrets: {},
    });
    expect(updated.name).toBe("Renamed");
    const [row] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, created.id));
    expect(openSecrets(row!.secrets)).toEqual({ webhookUrl: SLACK_URL });
  });

  it("refuses a provider change on update", async () => {
    const actor = await createTestOrg();
    const created = await createChannel(db, actor, slackInput());
    await expect(
      updateChannel(db, actor, created.id, {
        ...slackInput(),
        provider: "discord",
      }),
    ).rejects.toThrow(/cannot change provider/i);
  });

  it("generates a signing secret for a generic webhook left blank", async () => {
    const actor = await createTestOrg();
    const view = await createChannel(db, actor, {
      name: "Receiver",
      provider: "webhook",
      config: { url: "https://ops.example.com/hook" },
      secrets: {},
      events: ["incident"],
      enabled: true,
    });
    const [row] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, view.id));
    expect(openSecrets(row!.secrets).secret).toMatch(/^whsec_[0-9a-f]{48}$/);
  });

  it("refuses forbidden egress hosts at save time", async () => {
    const actor = await createTestOrg();
    await expect(
      createChannel(db, actor, {
        name: "Sneaky",
        provider: "webhook",
        config: { url: "http://169.254.169.254/latest/meta-data" },
        secrets: {},
        events: ["incident"],
        enabled: true,
      }),
    ).rejects.toThrow(/cannot be used/i);
  });

  it("requires at least one event class and a known provider", async () => {
    const actor = await createTestOrg();
    await expect(
      createChannel(db, actor, slackInput({ events: [] })),
    ).rejects.toThrow(/event class/i);
    await expect(
      createChannel(db, actor, slackInput({ provider: "pigeon" })),
    ).rejects.toThrow(/unknown provider/i);
    await expect(
      createChannel(db, actor, slackInput({ events: ["party"] })),
    ).rejects.toThrow(/unknown event class/i);
  });

  it("bounds channels per organization", async () => {
    const actor = await createTestOrg();
    for (let i = 0; i < MAX_CHANNELS_PER_ORG; i++) {
      await createChannel(db, actor, slackInput({ name: `c${i}` }));
    }
    await expect(
      createChannel(db, actor, slackInput({ name: "one too many" })),
    ).rejects.toThrow(/at most/i);
  });

  it("scopes reads, updates and deletes to the tenant", async () => {
    const alice = await createTestOrg();
    const mallory = await createTestOrg();
    const channel = await createChannel(db, alice, slackInput());

    await expect(
      updateChannel(db, mallory, channel.id, slackInput()),
    ).rejects.toThrow(/not found/i);
    await expect(deleteChannel(db, mallory, channel.id)).rejects.toThrow(
      /not found/i,
    );
    expect(await listChannels(db, mallory.organizationId)).toHaveLength(0);
  });
});

describe("sealPlainChannelSecrets", () => {
  it("re-seals migration-style plain envelopes", async () => {
    const actor = await createTestOrg();
    const [row] = await db
      .insert(notificationChannels)
      .values({
        organizationId: actor.organizationId,
        name: "Migrated",
        provider: "slack",
        config: {},
        secrets: `plain:${JSON.stringify({ webhookUrl: SLACK_URL })}`,
        events: ["monitor", "incident", "expiry"],
        enabled: true,
      })
      .returning();

    const sealed = await sealPlainChannelSecrets(db);
    expect(sealed).toBeGreaterThanOrEqual(1);

    const [after] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, row!.id));
    expect(after!.secrets.startsWith("enc1:")).toBe(true);
    expect(openSecrets(after!.secrets)).toEqual({ webhookUrl: SLACK_URL });
  });
});

describe("dispatch and delivery", () => {
  it("fans one event out to subscribed channels only, idempotently", async () => {
    const actor = await createTestOrg();
    await createChannel(db, actor, slackInput({ name: "monitor+incident" }));
    await createChannel(
      db,
      actor,
      slackInput({ name: "expiry only", events: ["expiry"] }),
    );
    await createChannel(
      db,
      actor,
      slackInput({ name: "disabled", enabled: false }),
    );
    const bystander = await createTestOrg();
    await createChannel(db, bystander, slackInput({ name: "other tenant" }));

    const dispatch = () =>
      dispatchToChannels(db, {
        organizationId: actor.organizationId,
        event: "monitor.down",
        causeKey: "incident:inc-1:monitor.down",
        subject: "Checkout API",
        detail: ["It broke."],
        url: "https://vigil.test/incidents/inc-1",
        data: { incident: { id: "inc-1" } },
        monitorType: "http",
      });

    expect(await dispatch()).toBe(1);
    // Replay: the idempotency key absorbs the duplicate dispatch.
    expect(await dispatch()).toBe(0);

    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("channel");
    expect(rows[0]!.provider).toBe("slack");
    expect(rows[0]!.event).toBe("monitor.down");
    // Neither the destination nor the payload may carry the credential.
    expect(rows[0]!.destination).not.toContain("secret-token");
    expect(JSON.stringify(rows[0]!.payload)).not.toContain("secret-token");
  });

  it("routes expiry-kind monitor events to the expiry class", async () => {
    const actor = await createTestOrg();
    await createChannel(
      db,
      actor,
      slackInput({ name: "outages", events: ["monitor"] }),
    );
    await createChannel(
      db,
      actor,
      slackInput({ name: "expiry", events: ["expiry"] }),
    );

    const queued = await dispatchToChannels(db, {
      organizationId: actor.organizationId,
      event: "monitor.down",
      causeKey: "incident:inc-cert:monitor.down",
      subject: "example.com certificate",
      detail: [],
      data: {},
      monitorType: "tls-expiry",
    });
    expect(queued).toBe(1);
    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.destination).toBeDefined();
  });

  it("delivers a claimed row through the provider and records the receipt", async () => {
    const actor = await createTestOrg();
    await createChannel(db, actor, slackInput());
    await dispatchToChannels(db, {
      organizationId: actor.organizationId,
      event: "incident.opened",
      causeKey: "incident:inc-2:incident.opened",
      subject: "Manual incident",
      detail: [],
      data: { incident: { id: "inc-2" } },
    });

    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    const result = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { fetchImpl, lookup: publicLookup },
    });
    expect(result).toMatchObject({ claimed: 1, delivered: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [row] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    expect(row!.state).toBe("delivered");
    expect(row!.deliveredAt).not.toBeNull();
  });

  it("honors Retry-After on a 429 and never schedules earlier", async () => {
    const actor = await createTestOrg();
    await createChannel(db, actor, slackInput());
    await dispatchToChannels(db, {
      organizationId: actor.organizationId,
      event: "incident.opened",
      causeKey: "incident:inc-3:incident.opened",
      subject: "Rate limited",
      detail: [],
      data: {},
    });

    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "120" },
        }),
    );
    const before = Date.now();
    const result = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { fetchImpl, lookup: publicLookup },
    });
    expect(result).toMatchObject({ claimed: 1, retrying: 1 });

    const [row] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    expect(row!.state).toBe("queued");
    expect(row!.attempts).toBe(1);
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      before + 120_000,
    );
  });

  it("fails permanently on a plain 4xx with a redacted error", async () => {
    const actor = await createTestOrg();
    await createChannel(db, actor, slackInput());
    await dispatchToChannels(db, {
      organizationId: actor.organizationId,
      event: "incident.opened",
      causeKey: "incident:inc-4:incident.opened",
      subject: "Bad hook",
      detail: [],
      data: {},
    });

    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(`no_service for ${SLACK_URL}`, { status: 404 }),
    );
    const result = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { fetchImpl, lookup: publicLookup },
    });
    expect(result).toMatchObject({ claimed: 1, failed: 1 });

    const [row] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    expect(row!.state).toBe("failed");
    expect(row!.lastError).not.toContain("secret-token");
  });

  it("marks rows for deleted and disabled channels permanent, not retried", async () => {
    const actor = await createTestOrg();
    const channel = await createChannel(db, actor, slackInput());
    await dispatchToChannels(db, {
      organizationId: actor.organizationId,
      event: "incident.opened",
      causeKey: "incident:inc-5:incident.opened",
      subject: "Doomed",
      detail: [],
      data: {},
    });
    await deleteChannel(db, actor, channel.id);

    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    const result = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { fetchImpl, lookup: publicLookup },
    });
    expect(result).toMatchObject({ claimed: 1, failed: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("defers rows beyond the per-channel rate limit without spending attempts", async () => {
    const actor = await createTestOrg();
    await createChannel(db, actor, slackInput());
    for (let i = 0; i < 12; i++) {
      await dispatchToChannels(db, {
        organizationId: actor.organizationId,
        event: "incident.opened",
        causeKey: `incident:burst-${i}:incident.opened`,
        subject: `Burst ${i}`,
        detail: [],
        data: {},
      });
    }

    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    const result = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { fetchImpl, lookup: publicLookup },
    });
    expect(result.delivered).toBe(10);
    expect(result.deferred).toBe(2);

    const deferred = await db
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.organizationId, actor.organizationId),
          eq(notificationOutbox.state, "queued"),
        ),
      );
    expect(deferred).toHaveLength(2);
    for (const row of deferred) {
      expect(row.attempts).toBe(0);
    }
  });
});

describe("sendIncidentWebhook (the dispatcher entry)", () => {
  it("enqueues for subscribed channels and drains inline", async () => {
    const actor = await createTestOrg();
    await createChannel(db, actor, slackInput({ events: ["incident"] }));
    const incident = await createIncident(db, actor, {
      title: "Manual incident",
      severity: "major",
    });

    // The inline drain runs with the real fetch seam, which this test
    // cannot intercept, so the row may end delivered=false; what must
    // hold is that dispatch created the row and never threw.
    await expect(
      sendIncidentWebhook(db, { event: "incident.opened", incident }),
    ).resolves.toBeUndefined();

    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toBe("incident.opened");
  });

  it("is a no-op with no channels", async () => {
    const actor = await createTestOrg();
    const incident = await createIncident(db, actor, {
      title: "Quiet incident",
      severity: "minor",
    });
    await expect(
      sendIncidentWebhook(db, { event: "incident.opened", incident }),
    ).resolves.toBeUndefined();
    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    expect(rows).toHaveLength(0);
  });
});

describe("testChannel", () => {
  it("delivers a synthetic test through the provider without persisting", async () => {
    const actor = await createTestOrg();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    const result = await testChannel(
      db,
      actor,
      {
        name: "Trial",
        provider: "slack",
        config: {},
        secrets: { webhookUrl: SLACK_URL },
      },
      { fetchImpl, lookup: publicLookup },
    );
    expect(result).toEqual({ delivered: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    expect(rows).toHaveLength(0);
  });

  it("falls back to stored secrets when testing a saved channel", async () => {
    const actor = await createTestOrg();
    const channel = await createChannel(db, actor, slackInput());
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toContain("hooks.slack.com");
      return new Response("ok");
    });
    const result = await testChannel(
      db,
      actor,
      {
        name: "Ops room",
        provider: "slack",
        config: {},
        secrets: {},
        channelId: channel.id,
      },
      { fetchImpl, lookup: publicLookup },
    );
    expect(result.delivered).toBe(true);
  });

  it("reports validation problems instead of throwing", async () => {
    const actor = await createTestOrg();
    const result = await testChannel(db, actor, {
      name: "Broken",
      provider: "slack",
      config: {},
      secrets: { webhookUrl: "https://evil.example.com/x" },
    });
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/hooks\.slack\.com/);
  });
});
