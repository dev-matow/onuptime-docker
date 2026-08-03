import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { notificationChannels, notificationOutbox } from "@/db/schema";
import type { EgressLookup } from "@/modules/monitors/egress";
import {
  createChannel,
  deliverChannelRow,
  dispatchToChannels,
  listChannels,
  resolveRoutes,
} from "@/modules/notifications/channel-service";
import {
  CHANNEL_PROVIDERS,
  getProvider,
  nativeProviders,
} from "@/modules/notifications/providers";
import { sealSecrets } from "@/modules/notifications/secretbox";
import { runNotificationDelivery } from "@/worker/jobs/notification-delivery";

import { createTestOrg, db, type TestActor } from "../helpers";

/**
 * The 1.17.0 provider wave, exercised through the real pipeline: the
 * routing query, the outbox, the worker drain and the ledger. No
 * provider is ever contacted - `fetchImpl` is faked and DNS is pinned -
 * so what is measured is Vigil's own work.
 *
 * The properties here are the ones that could only break by adding
 * providers: that twenty-six of them still share one pipeline, that a
 * mixed fan-out costs what the published drain rate says it costs, that
 * a lifecycle provider's resolve matches its trigger across two separate
 * outbox rows, and that no new credential shape found its way into a
 * ledger row.
 */

const publicLookup: EgressLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

/**
 * A valid configuration for every provider in the registry.
 *
 * Exhaustive on purpose, and asserted to be: a provider added without a
 * fixture here would otherwise be a provider with no integration
 * coverage, which is exactly how the last one would have slipped
 * through.
 */
function fixtures(): Record<
  string,
  { config: Record<string, string>; secrets: Record<string, string> }
> {
  const id = randomUUID();
  return {
    slack: {
      config: {},
      secrets: { webhookUrl: `https://hooks.slack.com/services/T/B/${id}` },
    },
    discord: {
      config: {},
      secrets: { webhookUrl: `https://discord.com/api/webhooks/1/${id}` },
    },
    teams: {
      config: {},
      secrets: { webhookUrl: `https://prod-1.westus.logic.azure.com/w/${id}` },
    },
    telegram: {
      config: { chatId: "-1001234567890" },
      secrets: { botToken: `1234567890:${"A".repeat(35)}` },
    },
    googlechat: {
      config: {},
      secrets: {
        webhookUrl: `https://chat.googleapis.com/v1/spaces/AAA/messages?key=${id}`,
      },
    },
    mattermost: {
      config: {
        serverUrl: "https://mm.example.com",
        channelId: "abcdefghijklmnopqrstuvwxyz",
      },
      secrets: { accessToken: `mm-${id}` },
    },
    rocketchat: {
      config: {
        serverUrl: "https://chat.example.com",
        channel: "#alerts",
        userId: "abc12345",
      },
      secrets: { authToken: `rc-${id}` },
    },
    matrix: {
      config: {
        homeserverUrl: "https://matrix.example.org",
        roomId: "!room:example.org",
      },
      secrets: { accessToken: `syt-${id}` },
    },
    zulip: {
      config: {
        serverUrl: "https://example.zulipchat.com",
        channel: "monitoring",
        topic: "Alerts",
        botEmail: "bot@example.com",
      },
      secrets: { apiKey: `zulip-${id}` },
    },
    line: {
      config: { to: "U1234567890abcdef1234567890abcdef" },
      secrets: { channelAccessToken: `line-${id}` },
    },
    pagerduty: {
      config: { region: "us" },
      secrets: { routingKey: "R0123456789abcdef0123456789abcdef" },
    },
    jira: {
      config: {
        siteUrl: "https://example.atlassian.net",
        projectKey: "OPS",
        issueType: "Task",
        email: "ops@example.com",
      },
      secrets: { apiToken: `jira-${id}` },
    },
    pushover: {
      config: {},
      secrets: { apiToken: "a".repeat(30), userKey: "u".repeat(30) },
    },
    gotify: {
      config: { serverUrl: "https://gotify.example.com" },
      secrets: { appToken: `gotify-${id}` },
    },
    ntfy: {
      config: { serverUrl: "https://ntfy.sh", topic: "vigil-alerts" },
      secrets: {},
    },
    pushbullet: { config: {}, secrets: { accessToken: `o.${id}` } },
    bark: {
      config: { serverUrl: "https://bark.example.com" },
      secrets: { deviceKey: `bark-${id}` },
    },
    webpush: {
      config: {
        vapidSubject: "mailto:ops@example.com",
        vapidPublicKey: VAPID.publicKey,
      },
      secrets: {
        subscription: JSON.stringify(SUBSCRIPTION),
        vapidPrivateKey: VAPID.privateKey,
      },
    },
    homeassistant: {
      config: { baseUrl: "https://ha.example.com", service: "notify" },
      secrets: { accessToken: `ha-${id}` },
    },
    twilio: {
      config: {
        accountSid: `AC${"0".repeat(32)}`,
        to: "+15551234567",
        from: "+15557654321",
      },
      secrets: { authToken: `twilio-${id}` },
    },
    "twilio-whatsapp": {
      config: {
        accountSid: `AC${"0".repeat(32)}`,
        to: "+15551234567",
        from: "+15557654321",
      },
      secrets: { authToken: `twilio-wa-${id}` },
    },
    smtp: {
      config: {
        host: "smtp.example.com",
        port: "587",
        security: "starttls",
        from: "vigil@example.com",
        to: "ops@example.com",
        username: "vigil",
      },
      secrets: { password: `smtp-${id}` },
    },
    resend: {
      config: { from: "vigil@example.com", to: "ops@example.com" },
      secrets: { apiKey: `re_${id}` },
    },
    webhook: {
      config: { url: "https://ops.example.com/hooks/vigil" },
      secrets: {},
    },
    sns: {
      config: {
        region: "eu-west-1",
        topicArn: "arn:aws:sns:eu-west-1:123456789012:alerts",
      },
      secrets: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: `sns-${id}`,
      },
    },
    apprise: {
      config: { serverUrl: "https://apprise.example.com", configKey: "ops" },
      secrets: {},
    },
  };
}

/**
 * A fixed VAPID pair and browser subscription. Generated once rather
 * than per test: key generation is the slowest thing in this file and
 * none of these assertions depend on the values.
 */
const VAPID = {
  publicKey:
    "BAgXWo28pzNcc3tG-rdBv7EDWfMAiomjIV0D_RYsmFKRd9Xvh3BQKa2AfhQehr4BSH2E187XmErbDp7uwIz3LRA",
  privateKey: "rqT-2T6pv9Z8yXlmbKXdJV7DIT22IyJMswpfbR0R9N8",
};
const SUBSCRIPTION = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: {
    p256dh:
      "BMSg743QrbZNBQr7SCKwjJ7uAIteo-pQRjzpRcpXpv9NJiobCwT-XPOQ3DbppzeOZshuGO8XiYkxNSMKPX8Z-Tw",
    auth: "MTIzNDU2Nzg5MGFiY2RlZg",
  },
};

function input(provider: string, name: string) {
  const fixture = fixtures()[provider];
  if (!fixture) throw new Error(`no fixture for provider ${provider}`);
  return {
    name,
    provider,
    config: fixture.config,
    secrets: fixture.secrets,
    events: ["monitor", "incident"],
    enabled: true,
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
    detail: ["Checkout API is not responding."],
    data: {},
    monitorType: "http",
    ...overrides,
  });
}

describe("the registry as a whole", () => {
  it("has an integration fixture for every provider it ships", () => {
    expect(Object.keys(fixtures()).sort()).toEqual(
      CHANNEL_PROVIDERS.map((p) => p.id).sort(),
    );
  });

  it("accepts, stores and routes a channel of every provider type", async () => {
    const actor = await createTestOrg();
    for (const provider of CHANNEL_PROVIDERS) {
      await createChannel(db, actor, input(provider.id, `ch-${provider.id}`));
    }

    const routes = await resolveRoutes(db, {
      organizationId: actor.organizationId,
      event: "monitor.down",
      monitorType: "http",
      monitorId: null,
    });
    expect(routes).toHaveLength(CHANNEL_PROVIDERS.length);

    // The list page must still be free of credential material at 26
    // providers, including the shapes added this release: a pasted push
    // subscription, an AWS key pair, an Apprise URL list.
    const page = await listChannels(db, actor.organizationId, { limit: 200 });
    const rendered = JSON.stringify(page);
    const all = fixtures();
    for (const provider of CHANNEL_PROVIDERS) {
      for (const secret of Object.values(all[provider.id]!.secrets)) {
        if (secret.length < 8) continue;
        expect(
          rendered,
          `${provider.id} leaked a secret into the settings list`,
        ).not.toContain(secret);
      }
    }
  });

  it("writes a destination for every provider, and none of them is a credential", async () => {
    const actor = await createTestOrg();
    const all = fixtures();
    for (const provider of CHANNEL_PROVIDERS) {
      const view = await createChannel(
        db,
        actor,
        input(provider.id, `d-${provider.id}`),
      );
      expect(view.destination, provider.id).toMatch(/\S/);
      for (const secret of Object.values(all[provider.id]!.secrets)) {
        if (secret.length < 8) continue;
        expect(view.destination, provider.id).not.toContain(secret);
      }
    }
  });
});

describe("a lifecycle provider across two outbox rows", () => {
  it("resolves with the key its trigger used, one incident later", async () => {
    // The trigger and the resolve are two independent dispatches, two
    // outbox rows and two worker deliveries. Nothing carries state
    // between them except the incident id in the payload - which is the
    // whole design, and the thing that would break silently.
    const actor = await createTestOrg();
    await createChannel(db, actor, input("pagerduty", "PagerDuty"));
    const incidentId = randomUUID();
    const data = { incident: { id: incidentId } };

    expect(
      await dispatch(actor, {
        event: "monitor.down",
        causeKey: `incident:${incidentId}:monitor.down`,
        data,
      }),
    ).toBe(1);
    expect(
      await dispatch(actor, {
        event: "monitor.up",
        causeKey: `incident:${incidentId}:monitor.up`,
        data,
      }),
    ).toBe(1);

    const bodies: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return new Response('{"status":"success","dedup_key":"k"}', {
        status: 202,
      });
    });
    const tick = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { fetchImpl, lookup: publicLookup },
    });
    expect(tick.delivered).toBe(2);

    const parsed = bodies.map(
      (b) => JSON.parse(b) as { event_action: string; dedup_key: string },
    );
    const actions = parsed.map((p) => p.event_action).sort();
    expect(actions).toEqual(["resolve", "trigger"]);
    expect(new Set(parsed.map((p) => p.dedup_key)).size).toBe(1);
    expect(parsed[0]!.dedup_key).toBe(
      `vigil/${actor.organizationId}/incident/${incidentId}`,
    );
  });
});

describe("a mixed fan-out at scale", () => {
  it("fans one event out to a thousand channels of every provider type", async () => {
    // Inserted directly rather than through `createChannel`: a thousand
    // service calls is a thousand transactions and an audit row each,
    // and what is under test here is the routing query and the drain,
    // not the writer. `scopedToMonitors` is set explicitly because this
    // path bypasses the service that would set it.
    const actor = await createTestOrg();
    const all = fixtures();
    // Every provider except SMTP, which is the one that is not an HTTP
    // request: a faked `fetch` does not reach its own client, so
    // thirty-odd SMTP rows would each spend a real ten-second connect
    // timeout against a hostname that does not exist. Its place in the
    // pipeline is covered by the ledger test below and by its own suite.
    const ids = CHANNEL_PROVIDERS.filter((p) => p.id !== "smtp").map(
      (p) => p.id,
    );
    const rows = Array.from({ length: 1_000 }, (_, i) => {
      const providerId = ids[i % ids.length]!;
      const fixture = all[providerId]!;
      const provider = getProvider(providerId)!;
      return {
        organizationId: actor.organizationId,
        name: `bulk-${i}`,
        provider: providerId,
        config: fixture.config,
        secrets: sealSecrets(fixture.secrets),
        destination: provider.destinationSummary(
          fixture.config,
          fixture.secrets,
        ),
        scopedToMonitors: false,
        events: ["monitor", "incident"],
        enabled: true,
      };
    });
    await db.insert(notificationChannels).values(rows);

    const routes = await resolveRoutes(db, {
      organizationId: actor.organizationId,
      event: "monitor.down",
      monitorType: "http",
      monitorId: null,
    });
    expect(routes).toHaveLength(1_000);

    const queued = await dispatch(actor);
    expect(queued).toBe(1_000);

    // The published drain rate, unchanged by this release: 250 a tick,
    // so ceil(1000 / 250) = four ticks. `docs/NOTIFICATIONS.md` states
    // that number, and this is what makes the statement true.
    // One body that satisfies every provider that puts its verdict in
    // the body rather than the status line - Pushover's `status`,
    // Zulip's `result`, Rocket.Chat's `success`, Bark's `code`. A plain
    // `{}` is a REJECTION to four of them, which is the check doing its
    // job and the reason this stub is not `{}`.
    const ok = '{"status":1,"result":"success","success":true,"code":200}';
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(ok));
    let ticks = 0;
    let delivered = 0;
    for (;;) {
      const tick = await runNotificationDelivery(db, {
        organizationId: actor.organizationId,
        net: { fetchImpl, lookup: publicLookup },
      });
      if (tick.claimed === 0) break;
      expect(tick.claimed).toBeLessThanOrEqual(250);
      expect(
        {
          failed: tick.failed,
          retrying: tick.retrying,
          deferred: tick.deferred,
        },
        "every row in a mixed fan-out should deliver against a stub",
      ).toEqual({ failed: 0, retrying: 0, deferred: 0 });
      delivered += tick.delivered;
      ticks += 1;
      if (ticks > 8) break;
    }
    expect(delivered).toBe(1_000);
    expect(ticks).toBe(4);
    // Every one of them was a real provider call, not a skipped row.
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(1_000);
  }, 120_000);
});

describe("the ledger after a failure", () => {
  it("records why every provider failed, with no credential in the row", async () => {
    const actor = await createTestOrg();
    const all = fixtures();
    // SMTP excluded for the same reason as above: it is not an HTTP
    // request, so a faked `fetch` never reaches it.
    const httpProviders = CHANNEL_PROVIDERS.filter((p) => p.id !== "smtp");
    for (const provider of httpProviders) {
      await createChannel(db, actor, input(provider.id, `f-${provider.id}`));
    }
    expect(await dispatch(actor)).toBe(httpProviders.length);

    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      // The worst realistic case: the service echoes the credential it
      // just rejected, and the URL that carried it, into the body.
      const body = typeof init?.body === "string" ? init.body : "";
      return new Response(
        `unauthorized for ${body.slice(0, 400)} at https://x.test/p?token=leak`,
        { status: 401 },
      );
    });
    await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { fetchImpl, lookup: publicLookup },
    });

    const ledger = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    expect(ledger).toHaveLength(httpProviders.length);
    for (const row of ledger) {
      // A 401 is a rejected credential; it will not fix itself.
      expect(row.state, `${row.provider}`).toBe("failed");
      expect(row.lastError, `${row.provider}`).toMatch(/\S/);
      const fixture = all[row.provider!]!;
      for (const secret of Object.values(fixture.secrets)) {
        if (secret.length < 8) continue;
        expect(
          row.lastError,
          `${row.provider} wrote a credential into the ledger`,
        ).not.toContain(secret);
      }
      // The query string is stripped wherever it appears, because
      // several providers carry the credential there.
      expect(row.lastError).not.toContain("token=leak");
      expect(row.destination).toMatch(/\S/);
    }
  }, 60_000);
});

describe("upgrading an installation that is already on 1.16.0", () => {
  it("needs no migration: a 1.16-shaped channel row keeps routing and delivering", async () => {
    // `notification_channels.provider` is a text column precisely so
    // that adding providers is not a schema change. This asserts the
    // consequence rather than the intention: a row written by 1.16.0,
    // with a provider that existed then, routes and delivers unchanged
    // after the wave.
    const actor = await createTestOrg();
    const legacy = fixtures().slack!;
    const [row] = await db
      .insert(notificationChannels)
      .values({
        organizationId: actor.organizationId,
        name: "Slack from 1.16.0",
        provider: "slack",
        config: legacy.config,
        secrets: sealSecrets(legacy.secrets),
        destination: "hooks.slack.com/[redacted]",
        scopedToMonitors: false,
        events: ["monitor", "incident"],
        enabled: true,
      })
      .returning();

    expect(await dispatch(actor)).toBe(1);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    const tick = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { fetchImpl, lookup: publicLookup },
    });
    expect(tick.delivered).toBe(1);
    expect(row!.provider).toBe("slack");
  });

  it("fails a row whose provider is not in this build, rather than retrying forever", async () => {
    // The downgrade case: an installation that added a 1.17 provider and
    // then rolled back. The row must be visibly failed, not queued
    // against a provider that will never exist again.
    const actor = await createTestOrg();
    const [channel] = await db
      .insert(notificationChannels)
      .values({
        organizationId: actor.organizationId,
        name: "From the future",
        provider: "not-a-provider",
        config: {},
        secrets: "",
        destination: "somewhere",
        scopedToMonitors: false,
        events: ["monitor"],
        enabled: true,
      })
      .returning();

    // Dispatch skips it, because a row nobody can deliver should not be
    // written in the first place.
    expect(await dispatch(actor)).toBe(0);

    // And a row already queued from before the rollback is permanent.
    const [outboxRow] = await db
      .insert(notificationOutbox)
      .values({
        organizationId: actor.organizationId,
        idempotencyKey: `stale:${randomUUID()}`,
        channel: "channel",
        channelId: channel!.id,
        provider: "not-a-provider",
        event: "monitor.down",
        destination: "somewhere",
        payload: {
          kind: "channel",
          event: "monitor.down",
          title: "t",
          text: "",
          severity: "critical",
          organizationId: actor.organizationId,
          data: {},
          timestamp: new Date().toISOString(),
        },
      })
      .returning();
    const outcome = await deliverChannelRow(db, outboxRow!, {
      lookup: publicLookup,
    });
    expect(outcome.status).toBe("permanent");
  });
});

describe("the Apprise bridge inside the pipeline", () => {
  it("is routed, retried, redacted and recorded like any other provider", async () => {
    const actor = await createTestOrg();
    await createChannel(db, actor, {
      ...input("apprise", "Apprise"),
      secrets: { authorization: "Basic apprise-proxy-secret-value" },
    });
    expect(await dispatch(actor)).toBe(1);

    // First a 503, so the row goes back to the queue rather than failing.
    const failing = vi.fn<typeof fetch>(
      async () =>
        new Response("gateway is down for Basic apprise-proxy-secret-value", {
          status: 503,
        }),
    );
    const first = await runNotificationDelivery(db, {
      organizationId: actor.organizationId,
      net: { fetchImpl: failing, lookup: publicLookup },
    });
    expect(first.retrying).toBe(1);

    const [queued] = await db
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.organizationId, actor.organizationId),
          eq(notificationOutbox.provider, "apprise"),
        ),
      );
    expect(queued!.state).toBe("queued");
    expect(queued!.attempts).toBe(1);
    expect(queued!.lastError).not.toContain("apprise-proxy-secret-value");

    // It is a channel like any other, so it counts toward nothing
    // special and appears in the same ledger.
    expect(queued!.destination).toContain("Apprise");
  });

  it("is not counted among the native providers anywhere", () => {
    expect(nativeProviders().map((p) => p.id)).not.toContain("apprise");
    expect(nativeProviders()).toHaveLength(CHANNEL_PROVIDERS.length - 1);
  });
});
