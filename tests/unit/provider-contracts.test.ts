import {
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  generateKeyPairSync,
  hkdfSync,
  verify as verifyWith,
} from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { EgressLookup } from "@/modules/monitors/egress";
import {
  CHANNEL_PROVIDERS,
  getProvider,
  type ChannelMessage,
  type ChannelProvider,
} from "@/modules/notifications/providers";
import { appriseProvider } from "@/modules/notifications/providers/apprise";
import { barkProvider } from "@/modules/notifications/providers/bark";
import { homeassistantProvider } from "@/modules/notifications/providers/homeassistant";
import { jiraProvider } from "@/modules/notifications/providers/jira";
import {
  lineProvider,
  lineRetryKey,
} from "@/modules/notifications/providers/line";
import {
  matrixProvider,
  matrixTxnId,
} from "@/modules/notifications/providers/matrix";
import { mattermostProvider } from "@/modules/notifications/providers/mattermost";
import {
  pagerdutyEventBody,
  pagerdutyProvider,
} from "@/modules/notifications/providers/pagerduty";
import { pushbulletProvider } from "@/modules/notifications/providers/pushbullet";
import { pushoverProvider } from "@/modules/notifications/providers/pushover";
import { rocketchatProvider } from "@/modules/notifications/providers/rocketchat";
import { signSigV4, snsProvider } from "@/modules/notifications/providers/sns";
import { twilioProvider } from "@/modules/notifications/providers/twilio";
import { twilioWhatsappProvider } from "@/modules/notifications/providers/twilio-whatsapp";
import {
  encryptWebPush,
  vapidAuthorization,
  webpushProvider,
} from "@/modules/notifications/providers/webpush";
import { sentNothing } from "@/modules/notifications/providers/types";
import { zulipProvider } from "@/modules/notifications/providers/zulip";

/**
 * Contract tests for the providers added in 1.17.0, written from the
 * official request and response shapes rather than from the
 * implementation: the PagerDuty Events API v2 OpenAPI document, the
 * Matrix client-server specification, Mattermost's own `posts.yaml`,
 * the Zulip, Rocket.Chat, Pushover, Pushbullet, Twilio, LINE, Bark,
 * Home Assistant and apprise-api references, the SNS Query API and
 * SigV4 documents, and RFCs 8188, 8291 and 8292.
 *
 * No sockets anywhere. `fetch` is faked and DNS is pinned to a public
 * address, so what is asserted is exactly the bytes a receiver sees.
 */

const publicLookup: EgressLookup = async () => [
  { address: "93.184.216.34", family: 4 },
];

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    kind: "channel",
    event: "monitor.down",
    title: "🔴 Monitor down - Checkout API",
    text: "Checkout API is not responding.",
    url: "https://vigil.example.com/incidents/inc-1",
    severity: "critical",
    organizationId: "org-1",
    data: {
      incident: { id: "inc-1" },
      monitor: { id: "mon-1", name: "Checkout API", url: "https://shop.test" },
    },
    timestamp: "2026-08-03T12:00:00.000Z",
    ...overrides,
  };
}

/** The same outage's recovery: the classifier gives `monitor.up` "ok". */
function recovery(): ChannelMessage {
  return message({
    event: "monitor.up",
    title: "🟢 Monitor up - Checkout API",
    severity: "ok",
  });
}

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  bytes: Uint8Array | null;
}

/** Replies in order; the last reply repeats for any further request. */
function fakeFetch(replies: { status?: number; body?: string }[]) {
  const sent: Sent[] = [];
  let call = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const raw = init?.body;
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof raw === "string" ? raw : "",
      bytes: raw instanceof Uint8Array ? raw : null,
    });
    const reply = replies[Math.min(call, replies.length - 1)] ?? {};
    call += 1;
    return new Response(reply.body ?? "{}", { status: reply.status ?? 200 });
  });
  return { sent, fetchImpl };
}

function deliver(
  provider: ChannelProvider,
  input: {
    config?: Record<string, string>;
    secrets?: Record<string, string>;
    replies?: { status?: number; body?: string }[];
    msg?: ChannelMessage;
    rowId?: string;
  },
) {
  const { sent, fetchImpl } = fakeFetch(input.replies ?? [{}]);
  const outcome = provider.deliver({
    config: input.config ?? {},
    secrets: input.secrets ?? {},
    message: input.msg ?? message(),
    rowId: input.rowId ?? "01924b1e-0000-7000-8000-000000000001",
    net: { fetchImpl, lookup: publicLookup },
  });
  return { sent, outcome };
}

function form(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

/* ------------------------------------------------------------------ */
/* PagerDuty                                                           */
/* ------------------------------------------------------------------ */

describe("PagerDuty", () => {
  const config = { region: "us" };
  const secrets = { routingKey: "R0123456789abcdef0123456789abcdef" };

  it("posts a trigger event to the enqueue endpoint", async () => {
    const { sent, outcome } = deliver(pagerdutyProvider, {
      config,
      secrets,
      replies: [
        {
          status: 202,
          body: JSON.stringify({
            status: "success",
            message: "Event processed",
            dedup_key: "vigil/org-1/incident/inc-1",
          }),
        },
      ],
    });
    await outcome;
    expect(sent[0]!.url).toBe("https://events.pagerduty.com/v2/enqueue");
    expect(sent[0]!.method).toBe("POST");
    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    expect(body.event_action).toBe("trigger");
    expect(body.routing_key).toBe(secrets.routingKey);
    expect(body.client).toBe("Vigil");
    const payload = body.payload as Record<string, unknown>;
    // summary, source and severity are the API's required fields.
    expect(payload.summary).toContain("Checkout API");
    expect(payload.source).toBe("Checkout API");
    expect(payload.severity).toBe("critical");
    expect(payload.timestamp).toBe("2026-08-03T12:00:00.000Z");
  });

  it("uses the EU host when the account is in the EU region", async () => {
    const { sent, outcome } = deliver(pagerdutyProvider, {
      config: { region: "eu" },
      secrets,
    });
    await outcome;
    expect(sent[0]!.url).toBe("https://events.eu.pagerduty.com/v2/enqueue");
  });

  it("resolves with the SAME dedup key the trigger used", async () => {
    // The whole point of the integration: one outage is one alert, and
    // the recovery closes it rather than opening a second one.
    const trigger = pagerdutyEventBody(message(), "row-a", "k");
    const resolve = pagerdutyEventBody(recovery(), "row-b", "k");
    expect(resolve.event_action).toBe("resolve");
    expect(resolve.dedup_key).toBe(trigger.dedup_key);
    expect(trigger.dedup_key).toBe("vigil/org-1/incident/inc-1");
    // A resolve carries no payload; the API takes the key alone.
    expect(resolve.payload).toBeUndefined();
  });

  it("never sends acknowledge", async () => {
    for (const severity of ["critical", "warning", "ok", "info"] as const) {
      const body = pagerdutyEventBody(message({ severity }), "r", "k");
      expect(body.event_action).not.toBe("acknowledge");
    }
  });


  it("keys a test delivery on the row, so it cannot resolve a real alert", () => {
    const test = pagerdutyEventBody(
      message({ event: "webhook.test", severity: "info", data: {} }),
      "row-xyz",
      "k",
    );
    expect(test.dedup_key).toBe("vigil/org-1/delivery/row-xyz");
  });

  it("reports the dedup key as the receipt", async () => {
    const { outcome } = deliver(pagerdutyProvider, {
      config,
      secrets,
      replies: [
        { status: 202, body: '{"status":"success","dedup_key":"abc"}' },
      ],
    });
    expect(await outcome).toMatchObject({
      status: "delivered",
      providerMessageId: "abc",
    });
  });

  it("treats a 400 as permanent and a 429 as retryable", async () => {
    const bad = await deliver(pagerdutyProvider, {
      config,
      secrets,
      replies: [{ status: 400, body: '{"status":"invalid event"}' }],
    }).outcome;
    expect(bad.status).toBe("permanent");
    const limited = await deliver(pagerdutyProvider, {
      config,
      secrets,
      replies: [{ status: 429, body: "" }],
    }).outcome;
    expect(limited.status).toBe("retryable");
  });

  it("refuses a routing key that is not one", () => {
    expect(
      pagerdutyProvider.check({ region: "us" }, { routingKey: "nope" }),
    ).toMatch(/routing key/i);
    expect(pagerdutyProvider.check({ region: "mars" }, secrets)).toMatch(
      /service region/i,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Jira Service Management                                             */
/* ------------------------------------------------------------------ */

describe("Jira Service Management", () => {
  const config = {
    siteUrl: "https://example.atlassian.net",
    projectKey: "OPS",
    issueType: "Task",
    email: "ops@example.com",
  };
  const secrets = { apiToken: "atlassian-token-value" };

  it("searches for an open issue before writing anything", async () => {
    const { sent, outcome } = deliver(jiraProvider, {
      config,
      secrets,
      replies: [
        { body: '{"issues":[]}' },
        { status: 201, body: '{"id":"10000","key":"OPS-24"}' },
      ],
    });
    const result = await outcome;
    expect(sent[0]!.url).toBe(
      "https://example.atlassian.net/rest/api/3/search/jql",
    );
    const jql = (JSON.parse(sent[0]!.body) as { jql: string }).jql;
    expect(jql).toContain('project = "OPS"');
    expect(jql).toContain("statusCategory != Done");
    expect(jql).toMatch(/labels = "vigil-[0-9a-f]{24}"/);

    expect(sent[1]!.url).toBe("https://example.atlassian.net/rest/api/3/issue");
    const created = JSON.parse(sent[1]!.body) as {
      fields: Record<string, unknown>;
    };
    expect((created.fields.project as { key: string }).key).toBe("OPS");
    expect((created.fields.issuetype as { name: string }).name).toBe("Task");
    // Jira's description field is Atlassian Document Format, not a string.
    expect(created.fields.description).toMatchObject({
      type: "doc",
      version: 1,
    });
    expect(result).toEqual({
      status: "delivered",
      providerMessageId: "OPS-24",
    });
  });

  it("comments on the existing issue instead of opening a second one", async () => {
    const { sent, outcome } = deliver(jiraProvider, {
      config,
      secrets,
      replies: [{ body: '{"issues":[{"key":"OPS-24"}]}' }, { status: 201 }],
    });
    expect(await outcome).toMatchObject({
      status: "delivered",
      providerMessageId: "OPS-24",
    });
    expect(sent[1]!.url).toBe(
      "https://example.atlassian.net/rest/api/3/issue/OPS-24/comment",
    );
    expect(sent).toHaveLength(2);
  });

  it("uses one label for the outage and its recovery", () => {
    // Derived from the incident id, so the recovery finds the ticket the
    // outage opened. Asserted through the JQL each produces.
    const keyOf = async (msg: ChannelMessage) => {
      const { sent, outcome } = deliver(jiraProvider, {
        config,
        secrets,
        replies: [{ body: '{"issues":[]}' }, { status: 201, body: "{}" }],
        msg,
      });
      await outcome;
      const { jql } = JSON.parse(sent[0]!.body) as { jql: string };
      return /labels = "(vigil-[0-9a-f]+)"/.exec(jql)?.[1];
    };
    return Promise.all([keyOf(message()), keyOf(recovery())]).then(
      ([down, up]) => {
        expect(down).toBeTruthy();
        expect(up).toBe(down);
      },
    );
  });

  it("applies the named transition on recovery, by looking up its id", async () => {
    const { sent, outcome } = deliver(jiraProvider, {
      config: { ...config, resolveTransition: "Done" },
      secrets,
      msg: recovery(),
      replies: [
        { body: '{"issues":[{"key":"OPS-24"}]}' },
        { status: 201 },
        { body: '{"transitions":[{"id":"31","name":"Done"}]}' },
        { status: 204 },
      ],
    });
    await outcome;
    expect(sent[2]!.method).toBe("GET");
    expect(sent[2]!.url).toContain("/issue/OPS-24/transitions");
    expect(JSON.parse(sent[3]!.body)).toEqual({ transition: { id: "31" } });
  });

  it("does nothing when a recovery has no open issue", async () => {
    const { sent, outcome } = deliver(jiraProvider, {
      config,
      secrets,
      msg: recovery(),
      replies: [{ body: '{"issues":[]}' }],
    });
    expect(await outcome).toMatchObject({
      status: "delivered",
      providerMessageId: null,
    });
    expect(sent).toHaveLength(1);
  });

  it("does not create a duplicate ticket when the search itself fails", async () => {
    const { sent, outcome } = deliver(jiraProvider, {
      config,
      secrets,
      replies: [{ status: 503, body: "upstream down" }],
    });
    expect((await outcome).status).toBe("retryable");
    expect(sent).toHaveLength(1);
  });

  it("does not fail the delivery when only the transition fails", async () => {
    // The comment already landed; failing here would retry the whole
    // delivery and comment again, six times.
    const { outcome } = deliver(jiraProvider, {
      config: { ...config, resolveTransition: "Nonexistent" },
      secrets,
      msg: recovery(),
      replies: [
        { body: '{"issues":[{"key":"OPS-24"}]}' },
        { status: 201 },
        { body: '{"transitions":[{"id":"31","name":"Done"}]}' },
      ],
    });
    expect((await outcome).status).toBe("delivered");
  });

  it("sends the API token as HTTP Basic with the account email", async () => {
    const { sent, outcome } = deliver(jiraProvider, {
      config,
      secrets,
      replies: [{ body: '{"issues":[]}' }, { status: 201, body: "{}" }],
    });
    await outcome;
    const expected = Buffer.from(
      "ops@example.com:atlassian-token-value",
    ).toString("base64");
    expect(sent[0]!.headers.authorization).toBe(`Basic ${expected}`);
  });
});

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

describe("Matrix", () => {
  const config = {
    homeserverUrl: "https://matrix.example.org",
    roomId: "!AbCdEf:example.org",
  };
  const secrets = { accessToken: "syt_token" };

  it("PUTs to the versioned send path with a transaction id", async () => {
    const { sent, outcome } = deliver(matrixProvider, {
      config,
      secrets,
      replies: [{ body: '{"event_id":"$evt"}' }],
      rowId: "row-1",
    });
    expect(await outcome).toMatchObject({
      status: "delivered",
      providerMessageId: "$evt",
    });
    expect(sent[0]!.method).toBe("PUT");
    expect(sent[0]!.url).toBe(
      `https://matrix.example.org/_matrix/client/v3/rooms/${encodeURIComponent(
        "!AbCdEf:example.org",
      )}/send/m.room.message/${matrixTxnId("row-1")}`,
    );
    expect(sent[0]!.headers.authorization).toBe("Bearer syt_token");
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ msgtype: "m.text" });
  });

  it("derives a stable transaction id from the outbox row", () => {
    expect(matrixTxnId("row-1")).toBe(matrixTxnId("row-1"));
    expect(matrixTxnId("row-1")).not.toBe(matrixTxnId("row-2"));
    expect(matrixTxnId("row-1")).toMatch(/^vigil-[0-9a-f]{32}$/);
  });

  it("honours retry_after_ms from the rate-limit body", async () => {
    const outcome = await deliver(matrixProvider, {
      config,
      secrets,
      replies: [
        {
          status: 429,
          body: '{"errcode":"M_LIMIT_EXCEEDED","error":"slow down","retry_after_ms":5000}',
        },
      ],
    }).outcome;
    expect(outcome).toMatchObject({ status: "retryable", retryAfterMs: 5000 });
  });

  it("refuses a room alias, which this endpoint cannot resolve", () => {
    expect(
      matrixProvider.check(
        { ...config, roomId: "#general:example.org" },
        secrets,
      ),
    ).toMatch(/room ID/i);
  });
});

describe("Mattermost", () => {
  it("creates a post through the v4 API with a bot token", async () => {
    const { sent, outcome } = deliver(mattermostProvider, {
      config: {
        serverUrl: "https://mm.example.com/",
        channelId: "abcdefghijklmnopqrstuvwxyz",
      },
      secrets: { accessToken: "bot-token" },
      replies: [{ status: 201, body: '{"id":"post-1"}' }],
    });
    expect(await outcome).toMatchObject({
      status: "delivered",
      providerMessageId: "post-1",
    });
    expect(sent[0]!.url).toBe("https://mm.example.com/api/v4/posts");
    expect(sent[0]!.headers.authorization).toBe("Bearer bot-token");
    expect(JSON.parse(sent[0]!.body)).toMatchObject({
      channel_id: "abcdefghijklmnopqrstuvwxyz",
    });
  });

  it("refuses a channel name where an id is required", () => {
    expect(
      mattermostProvider.check(
        { serverUrl: "https://mm.example.com", channelId: "town-square" },
        { accessToken: "t" },
      ),
    ).toMatch(/26 lowercase/);
  });
});

describe("Rocket.Chat", () => {
  const config = {
    serverUrl: "https://chat.example.com",
    channel: "#alerts",
    userId: "abc12345",
  };
  const secrets = { authToken: "rc-token" };

  it("posts through chat.postMessage with the token header pair", async () => {
    const { sent, outcome } = deliver(rocketchatProvider, {
      config,
      secrets,
      replies: [{ body: '{"success":true,"message":{"_id":"m1"}}' }],
    });
    expect(await outcome).toMatchObject({
      status: "delivered",
      providerMessageId: "m1",
    });
    expect(sent[0]!.url).toBe(
      "https://chat.example.com/api/v1/chat.postMessage",
    );
    expect(sent[0]!.headers["x-auth-token"]).toBe("rc-token");
    expect(sent[0]!.headers["x-user-id"]).toBe("abc12345");
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ channel: "#alerts" });
  });

  it("does not call a 200 with success:false a delivery", async () => {
    const outcome = await deliver(rocketchatProvider, {
      config,
      secrets,
      replies: [{ body: '{"success":false,"error":"invalid-channel"}' }],
    }).outcome;
    expect(outcome.status).toBe("permanent");
  });
});

describe("Zulip", () => {
  const config = {
    serverUrl: "https://example.zulipchat.com",
    channel: "monitoring",
    topic: "Vigil alerts",
    botEmail: "bot@example.zulipchat.com",
  };
  const secrets = { apiKey: "zulip-key" };

  it("form-posts a channel message with a topic and Basic auth", async () => {
    const { sent, outcome } = deliver(zulipProvider, {
      config,
      secrets,
      replies: [{ body: '{"result":"success","id":42}' }],
    });
    expect(await outcome).toMatchObject({
      status: "delivered",
      providerMessageId: "42",
    });
    expect(sent[0]!.url).toBe("https://example.zulipchat.com/api/v1/messages");
    const fields = form(sent[0]!.body);
    // `stream`, not `channel`: only `stream` works on servers that
    // predate the rename.
    expect(fields.get("type")).toBe("stream");
    expect(fields.get("to")).toBe("monitoring");
    expect(fields.get("topic")).toBe("Vigil alerts");
    expect(fields.get("content")).toContain("Checkout API");
    expect(sent[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from("bot@example.zulipchat.com:zulip-key").toString("base64")}`,
    );
  });

  it("does not call a 200 with result:error a delivery", async () => {
    const outcome = await deliver(zulipProvider, {
      config,
      secrets,
      replies: [{ body: '{"result":"error","code":"STREAM_DOES_NOT_EXIST"}' }],
    }).outcome;
    expect(outcome.status).toBe("permanent");
  });
});

describe("LINE", () => {
  const config = { to: "U1234567890abcdef1234567890abcdef" };
  const secrets = { channelAccessToken: "line-token" };

  it("pushes a text message with a retry key", async () => {
    const { sent, outcome } = deliver(lineProvider, {
      config,
      secrets,
      rowId: "row-1",
    });
    expect((await outcome).status).toBe("delivered");
    expect(sent[0]!.url).toBe("https://api.line.me/v2/bot/message/push");
    expect(sent[0]!.headers.authorization).toBe("Bearer line-token");
    expect(sent[0]!.headers["x-line-retry-key"]).toBe(lineRetryKey("row-1"));
    expect(JSON.parse(sent[0]!.body)).toMatchObject({
      to: config.to,
      messages: [{ type: "text" }],
    });
  });

  it("derives a retry key that is a UUID and stable per row", () => {
    expect(lineRetryKey("row-1")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(lineRetryKey("row-1")).toBe(lineRetryKey("row-1"));
    expect(lineRetryKey("row-1")).not.toBe(lineRetryKey("row-2"));
  });

  it("records LINE's 409 as delivered, because it means the first one arrived", async () => {
    // The window this closes: LINE accepts the push, the response is
    // lost, the lease expires, the row is re-claimed, and the retry
    // carries the same key. LINE answers 409 "The retry key is already
    // accepted". Classified as a permanent 4xx, the ledger would say
    // "not delivered" about a message the operator was paged with -
    // which is a worse lie than the duplicate the key prevents.
    const outcome = await deliver(lineProvider, {
      config,
      secrets,
      replies: [
        {
          status: 409,
          body: '{"message":"The retry key is already accepted"}',
        },
      ],
    }).outcome;
    expect(outcome.status).toBe("delivered");
  });

  it("still treats LINE's other 4xx as permanent", async () => {
    const outcome = await deliver(lineProvider, {
      config,
      secrets,
      replies: [{ status: 400, body: '{"message":"Invalid to"}' }],
    }).outcome;
    expect(outcome.status).toBe("permanent");
  });

  it("refuses a display name where a destination id belongs", () => {
    expect(lineProvider.check({ to: "@vigil" }, secrets)).toMatch(
      /destination id/i,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Push                                                                */
/* ------------------------------------------------------------------ */

describe("Pushover", () => {
  const secrets = {
    apiToken: "a".repeat(30),
    userKey: "u".repeat(30),
  };

  it("form-posts the documented parameters", async () => {
    const { sent, outcome } = deliver(pushoverProvider, {
      secrets,
      replies: [{ body: '{"status":1,"request":"req-1"}' }],
    });
    expect(await outcome).toMatchObject({
      status: "delivered",
      providerMessageId: "req-1",
    });
    expect(sent[0]!.url).toBe("https://api.pushover.net/1/messages.json");
    const fields = form(sent[0]!.body);
    expect(fields.get("token")).toBe(secrets.apiToken);
    expect(fields.get("user")).toBe(secrets.userKey);
    expect(fields.get("priority")).toBe("1");
    expect(fields.get("url")).toBe("https://vigil.example.com/incidents/inc-1");
  });

  it("sends retry and expire with emergency priority, which Pushover requires", async () => {
    const { sent, outcome } = deliver(pushoverProvider, {
      config: { criticalPriority: "emergency" },
      secrets,
    });
    await outcome;
    const fields = form(sent[0]!.body);
    expect(fields.get("priority")).toBe("2");
    expect(fields.get("retry")).toBe("60");
    expect(fields.get("expire")).toBe("3600");
  });

  it("does not escalate a recovery to emergency", async () => {
    const { sent, outcome } = deliver(pushoverProvider, {
      config: { criticalPriority: "emergency" },
      secrets,
      msg: recovery(),
    });
    await outcome;
    expect(form(sent[0]!.body).get("priority")).toBe("0");
    expect(form(sent[0]!.body).get("retry")).toBeNull();
  });

  it("does not call a 200 with status 0 a delivery", async () => {
    const outcome = await deliver(pushoverProvider, {
      secrets,
      replies: [
        { body: '{"status":0,"errors":["user identifier is invalid"]}' },
      ],
    }).outcome;
    expect(outcome.status).toBe("permanent");
  });
});

describe("Pushbullet", () => {
  const secrets = { accessToken: "o.abcdef" };

  it("creates a note push with the Access-Token header", async () => {
    const { sent, outcome } = deliver(pushbulletProvider, {
      secrets,
      replies: [{ body: '{"iden":"push-1"}' }],
    });
    expect(await outcome).toMatchObject({
      status: "delivered",
      providerMessageId: "push-1",
    });
    expect(sent[0]!.url).toBe("https://api.pushbullet.com/v2/pushes");
    expect(sent[0]!.headers["access-token"]).toBe("o.abcdef");
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ type: "note" });
  });

  it("sends exactly one target parameter, named by the target type", async () => {
    const { sent, outcome } = deliver(pushbulletProvider, {
      config: { targetType: "channel_tag", target: "ops" },
      secrets,
    });
    await outcome;
    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    expect(body.channel_tag).toBe("ops");
    expect(body.email).toBeUndefined();
    expect(body.device_iden).toBeUndefined();
  });
});

describe("Bark", () => {
  const config = { serverUrl: "https://bark.example.com" };
  const secrets = { deviceKey: "device-key-value" };

  it("keeps the device key in the body, never in the URL", async () => {
    const { sent, outcome } = deliver(barkProvider, {
      config,
      secrets,
      replies: [{ body: '{"code":200,"message":"success"}' }],
    });
    expect((await outcome).status).toBe("delivered");
    expect(sent[0]!.url).toBe("https://bark.example.com/push");
    expect(sent[0]!.url).not.toContain("device-key-value");
    expect(JSON.parse(sent[0]!.body)).toMatchObject({
      device_key: "device-key-value",
      level: "timeSensitive",
    });
  });

  it("does not call a 200 with a non-200 code a delivery", async () => {
    const outcome = await deliver(barkProvider, {
      config,
      secrets,
      replies: [{ body: '{"code":400,"message":"device key is invalid"}' }],
    }).outcome;
    expect(outcome.status).toBe("permanent");
  });
});

describe("Home Assistant", () => {
  it("can only call the notify domain", async () => {
    const { sent, outcome } = deliver(homeassistantProvider, {
      config: {
        baseUrl: "http://homeassistant.local:8123",
        service: "mobile_app_pixel",
      },
      secrets: { accessToken: "ha-token" },
    });
    expect((await outcome).status).toBe("delivered");
    expect(sent[0]!.url).toBe(
      "http://homeassistant.local:8123/api/services/notify/mobile_app_pixel",
    );
    expect(sent[0]!.headers.authorization).toBe("Bearer ha-token");
  });

  it("refuses a service name that could escape the notify domain", () => {
    for (const service of ["../homeassistant/stop", "lock.unlock", "a/b"]) {
      expect(
        homeassistantProvider.check(
          { baseUrl: "http://ha.local:8123", service },
          { accessToken: "t" },
        ),
        service,
      ).toMatch(/service name/i);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Web Push - RFC 8291 encryption and RFC 8292 VAPID                   */
/* ------------------------------------------------------------------ */

describe("Web Push", () => {
  /** A subscription as a browser would produce one. */
  function subscription() {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    return {
      privateKey: ua.getPrivateKey(),
      json: {
        endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
        keys: {
          p256dh: ua.getPublicKey().toString("base64url"),
          auth: Buffer.from("0123456789abcdef", "utf8").toString("base64url"),
        },
      },
    };
  }

  /** A VAPID pair in the base64url form the field takes. */
  function vapidKeys() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const jwk = privateKey.export({ format: "jwk" }) as {
      d: string;
      x: string;
      y: string;
    };
    return {
      privateKey: jwk.d,
      publicKey: Buffer.concat([
        Buffer.from([0x04]),
        Buffer.from(jwk.x, "base64url"),
        Buffer.from(jwk.y, "base64url"),
      ]).toString("base64url"),
      keyObject: publicKey,
    };
  }

  /**
   * The user agent's half of RFC 8291, written from the RFC rather than
   * from the encryptor. If this decrypts, the record is one a real
   * browser could read.
   */
  function decrypt(record: Buffer, uaPrivate: Buffer, authSecret: Buffer) {
    const salt = record.subarray(0, 16);
    const recordSize = record.readUInt32BE(16);
    const idLength = record[20]!;
    const asPublic = record.subarray(21, 21 + idLength);
    const ciphertext = record.subarray(21 + idLength);
    expect(idLength).toBe(65);
    expect(recordSize).toBeGreaterThan(ciphertext.length);

    const ua = createECDH("prime256v1");
    ua.setPrivateKey(uaPrivate);
    const shared = ua.computeSecret(asPublic);
    const keyInfo = Buffer.concat([
      Buffer.from("WebPush: info\0", "utf8"),
      ua.getPublicKey(),
      asPublic,
    ]);
    const ikm = Buffer.from(
      hkdfSync("sha256", shared, authSecret, keyInfo, 32),
    );
    const cek = Buffer.from(
      hkdfSync(
        "sha256",
        ikm,
        salt,
        Buffer.from("Content-Encoding: aes128gcm\0", "utf8"),
        16,
      ),
    );
    const nonce = Buffer.from(
      hkdfSync(
        "sha256",
        ikm,
        salt,
        Buffer.from("Content-Encoding: nonce\0", "utf8"),
        12,
      ),
    );
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
      decipher.final(),
    ]);
    // The last octet is the record delimiter, 0x02 for a final record.
    expect(plaintext[plaintext.length - 1]).toBe(0x02);
    return plaintext.subarray(0, plaintext.length - 1).toString("utf8");
  }

  it("produces a record a user agent can decrypt", () => {
    const sub = subscription();
    const record = encryptWebPush('{"title":"hello"}', sub.json);
    expect(
      decrypt(
        record,
        sub.privateKey,
        Buffer.from(sub.json.keys.auth, "base64url"),
      ),
    ).toBe('{"title":"hello"}');
  });

  it("uses a fresh ephemeral key and salt for every message", () => {
    const sub = subscription();
    const a = encryptWebPush("x", sub.json);
    const b = encryptWebPush("x", sub.json);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
  });

  it("signs a VAPID token the push service can verify", () => {
    const keys = vapidKeys();
    const header = vapidAuthorization(
      "https://fcm.googleapis.com/fcm/send/abc123",
      keys.publicKey,
      keys.privateKey,
      "mailto:ops@example.com",
      1_000_000,
    );
    const parsed = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(parsed, header).toBeTruthy();
    const [, jwt, k] = parsed!;
    expect(k).toBe(keys.publicKey);

    const [h, p, sig] = jwt!.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString()) as {
      aud: string;
      exp: number;
      sub: string;
    };
    // The audience is the ORIGIN, not the endpoint. A token scoped to
    // the full URL is rejected by every push service.
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("mailto:ops@example.com");
    expect(claims.exp - 1_000_000).toBeLessThanOrEqual(86_400);

    // Verified against the public key, in the raw r||s encoding JWS
    // requires - a DER signature would pass a naive test and fail in
    // production.
    expect(
      verifyWith(
        "sha256",
        Buffer.from(`${h}.${p}`, "utf8"),
        { key: keys.keyObject, dsaEncoding: "ieee-p1363" },
        Buffer.from(sig!, "base64url"),
      ),
    ).toBe(true);
  });

  it("sends aes128gcm bytes with a vapid Authorization header", async () => {
    const sub = subscription();
    const keys = vapidKeys();
    const { sent, outcome } = deliver(webpushProvider, {
      config: {
        vapidSubject: "mailto:ops@example.com",
        vapidPublicKey: keys.publicKey,
      },
      secrets: {
        subscription: JSON.stringify(sub.json),
        vapidPrivateKey: keys.privateKey,
      },
      replies: [{ status: 201 }],
    });
    expect((await outcome).status).toBe("delivered");
    expect(sent[0]!.url).toBe(sub.json.endpoint);
    expect(sent[0]!.headers["content-encoding"]).toBe("aes128gcm");
    expect(sent[0]!.headers.authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(sent[0]!.headers.urgency).toBe("high");
    expect(sent[0]!.bytes).toBeInstanceOf(Uint8Array);
    expect(
      decrypt(
        Buffer.from(sent[0]!.bytes!),
        sub.privateKey,
        Buffer.from(sub.json.keys.auth, "base64url"),
      ),
    ).toContain("Checkout API");
  });

  it("treats a 410 Gone as permanent, because the subscription is dead", async () => {
    const sub = subscription();
    const keys = vapidKeys();
    const outcome = await deliver(webpushProvider, {
      config: {
        vapidSubject: "mailto:ops@example.com",
        vapidPublicKey: keys.publicKey,
      },
      secrets: {
        subscription: JSON.stringify(sub.json),
        vapidPrivateKey: keys.privateKey,
      },
      replies: [{ status: 410, body: "push subscription has unsubscribed" }],
    }).outcome;
    expect(outcome.status).toBe("permanent");
  });

  it("rejects a malformed subscription before anything is stored", () => {
    const keys = vapidKeys();
    const base = {
      vapidSubject: "mailto:ops@example.com",
      vapidPublicKey: keys.publicKey,
    };
    const bad = [
      "not json",
      "{}",
      '{"endpoint":"http://insecure.example.com","keys":{"p256dh":"AA","auth":"AA"}}',
      '{"endpoint":"https://a.example.com","keys":{"p256dh":"AA","auth":"AA"}}',
    ];
    for (const subscription of bad) {
      expect(
        webpushProvider.check(base, {
          subscription,
          vapidPrivateKey: keys.privateKey,
        }),
        subscription,
      ).toBeTruthy();
    }
  });

  it("rejects a VAPID pair whose halves do not match", () => {
    const a = vapidKeys();
    const b = vapidKeys();
    const sub = subscription();
    expect(
      webpushProvider.check(
        { vapidSubject: "mailto:ops@example.com", vapidPublicKey: a.publicKey },
        {
          subscription: JSON.stringify(sub.json),
          vapidPrivateKey: b.privateKey,
        },
      ),
    ).toMatch(/does not match/i);
  });
});

/* ------------------------------------------------------------------ */
/* SMS and buses                                                       */
/* ------------------------------------------------------------------ */

describe("Twilio SMS", () => {
  const config = {
    accountSid: `AC${"0".repeat(32)}`,
    to: "+15551234567",
    from: "+15557654321",
  };
  const secrets = { authToken: "twilio-auth-token" };

  it("posts to the versioned Messages resource with Basic auth", async () => {
    const { sent, outcome } = deliver(twilioProvider, {
      config,
      secrets,
      replies: [{ status: 201, body: '{"sid":"SM123","status":"queued"}' }],
    });
    expect(await outcome).toMatchObject({
      status: "delivered",
      providerMessageId: "SM123",
    });
    expect(sent[0]!.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
    );
    const fields = form(sent[0]!.body);
    expect(fields.get("To")).toBe("+15551234567");
    expect(fields.get("From")).toBe("+15557654321");
    expect(fields.get("Body")).toContain("Checkout API");
    expect(sent[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from(`${config.accountSid}:twilio-auth-token`).toString("base64")}`,
    );
  });

  it("authenticates with the API key SID when one is given", async () => {
    const authSid = `SK${"1".repeat(32)}`;
    const { sent, outcome } = deliver(twilioProvider, {
      config,
      secrets: { ...secrets, authSid },
      replies: [{ status: 201, body: '{"sid":"SM1"}' }],
    });
    await outcome;
    expect(sent[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from(`${authSid}:twilio-auth-token`).toString("base64")}`,
    );
    // The account SID still addresses the resource.
    expect(sent[0]!.url).toContain(config.accountSid);
  });

  it("prefers a Messaging Service over a sender number", async () => {
    const { sent, outcome } = deliver(twilioProvider, {
      config: { ...config, messagingServiceSid: `MG${"2".repeat(32)}` },
      secrets,
      replies: [{ status: 201, body: "{}" }],
    });
    await outcome;
    const fields = form(sent[0]!.body);
    expect(fields.get("MessagingServiceSid")).toBe(`MG${"2".repeat(32)}`);
    expect(fields.get("From")).toBeNull();
  });

  it("insists on E.164 and on having some sender", () => {
    expect(twilioProvider.check({ ...config, to: "5551234" }, secrets)).toMatch(
      /E.164/,
    );
    expect(
      twilioProvider.check(
        { accountSid: config.accountSid, to: config.to },
        secrets,
      ),
    ).toMatch(/sender number or a Messaging Service/);
  });
});

describe("Twilio WhatsApp", () => {
  const config = {
    accountSid: `AC${"0".repeat(32)}`,
    to: "+15551234567",
    from: "+15557654321",
  };
  const secrets = { authToken: "twilio-auth-token" };

  it("prefixes both ends with whatsapp:", async () => {
    const { sent, outcome } = deliver(twilioWhatsappProvider, {
      config,
      secrets,
      replies: [{ status: 201, body: '{"sid":"MM1"}' }],
    });
    await outcome;
    const fields = form(sent[0]!.body);
    expect(fields.get("To")).toBe("whatsapp:+15551234567");
    expect(fields.get("From")).toBe("whatsapp:+15557654321");
  });

  it("sends a template instead of a body when a Content SID is set", async () => {
    const contentSid = `HX${"3".repeat(32)}`;
    const { sent, outcome } = deliver(twilioWhatsappProvider, {
      config: { ...config, contentSid },
      secrets,
      replies: [{ status: 201, body: "{}" }],
    });
    await outcome;
    const fields = form(sent[0]!.body);
    expect(fields.get("ContentSid")).toBe(contentSid);
    expect(fields.get("Body")).toBeNull();
    expect(JSON.parse(fields.get("ContentVariables")!)).toEqual({
      "1": "🔴 Monitor down - Checkout API",
      "2": "Checkout API is not responding.",
      "3": "https://vigil.example.com/incidents/inc-1",
    });
  });
});

describe("Amazon SNS", () => {
  const config = {
    region: "eu-west-1",
    topicArn: "arn:aws:sns:eu-west-1:123456789012:alerts",
  };
  const secrets = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };

  it("signs the Publish query with Signature Version 4", async () => {
    const { sent, outcome } = deliver(snsProvider, {
      config,
      secrets,
      replies: [
        {
          body: "<PublishResponse><PublishResult><MessageId>mid-1</MessageId></PublishResult></PublishResponse>",
        },
      ],
    });
    expect(await outcome).toMatchObject({
      status: "delivered",
      providerMessageId: "mid-1",
    });
    expect(sent[0]!.url).toBe("https://sns.eu-west-1.amazonaws.com/");
    const fields = form(sent[0]!.body);
    expect(fields.get("Action")).toBe("Publish");
    expect(fields.get("Version")).toBe("2010-03-31");
    expect(fields.get("TopicArn")).toBe(config.topicArn);
    expect(fields.get("Subject")).not.toContain("\n");
    const auth = sent[0]!.headers.authorization!;
    expect(auth).toContain("AWS4-HMAC-SHA256");
    expect(auth).toContain("Credential=AKIAIOSFODNN7EXAMPLE/");
    expect(auth).toContain("/eu-west-1/sns/aws4_request");
    expect(auth).toContain(
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date",
    );
    // Signed over `host`, never sent as a header: the transport sets it
    // from the URL, and setting it twice is how signatures break.
    expect(sent[0]!.headers.host).toBeUndefined();
  });

  it("adds FIFO ordering and deduplication only on a .fifo topic", async () => {
    const standard = deliver(snsProvider, { config, secrets });
    await standard.outcome;
    expect(form(standard.sent[0]!.body).get("MessageGroupId")).toBeNull();

    const fifo = deliver(snsProvider, {
      config: { ...config, topicArn: `${config.topicArn}.fifo` },
      secrets,
      rowId: "row-9",
    });
    await fifo.outcome;
    const fields = form(fifo.sent[0]!.body);
    expect(fields.get("MessageGroupId")).toBe("vigil/org-1/incident/inc-1");
    expect(fields.get("MessageDeduplicationId")).toBe("row-9");
  });

  it("produces the signature AWS documents for a known request", () => {
    // The signature is recomputed here from the SigV4 specification -
    // canonical request, string to sign, four-stage key - by code that
    // shares nothing with the implementation. That is the assertion:
    // this test used to check `Signature=[0-9a-f]{64}`, a SHAPE, which
    // a wrong header order, a missing blank line or a wrong scope would
    // all have passed.
    const headers = signSigV4({
      method: "POST",
      host: "sns.eu-west-1.amazonaws.com",
      path: "/",
      body: "Action=Publish&Version=2010-03-31",
      region: "eu-west-1",
      service: "sns",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: new Date("2026-08-03T12:00:00.000Z"),
    });
    expect(headers["x-amz-date"]).toBe("20260803T120000Z");
    // The payload hash is SHA-256 of the exact body, computed here
    // independently rather than read back out of the function.
    expect(headers["x-amz-content-sha256"]).toBe(
      createHash("sha256")
        .update("Action=Publish&Version=2010-03-31", "utf8")
        .digest("hex"),
    );

    const body = "Action=Publish&Version=2010-03-31";
    const payloadHash = createHash("sha256").update(body, "utf8").digest("hex");
    const canonicalRequest = [
      "POST",
      "/",
      "",
      "content-type:application/x-www-form-urlencoded; charset=utf-8",
      "host:sns.eu-west-1.amazonaws.com",
      `x-amz-content-sha256:${payloadHash}`,
      "x-amz-date:20260803T120000Z",
      "",
      "content-type;host;x-amz-content-sha256;x-amz-date",
      payloadHash,
    ].join("\n");
    const scope = "20260803/eu-west-1/sns/aws4_request";
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      "20260803T120000Z",
      scope,
      createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
    ].join("\n");
    const hmac = (key: Buffer | string, value: string) =>
      createHmac("sha256", key).update(value, "utf8").digest();
    const signingKey = hmac(
      hmac(
        hmac(
          hmac("AWS4wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "20260803"),
          "eu-west-1",
        ),
        "sns",
      ),
      "aws4_request",
    );
    const signature = createHmac("sha256", signingKey)
      .update(stringToSign, "utf8")
      .digest("hex");

    expect(headers.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/${scope}, ` +
        `SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ` +
        `Signature=${signature}`,
    );
  });

  it("includes the session token in the signature when there is one", () => {
    const withToken = signSigV4({
      method: "POST",
      host: "sns.eu-west-1.amazonaws.com",
      path: "/",
      body: "x=1",
      region: "eu-west-1",
      service: "sns",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      sessionToken: "session-token",
      now: new Date("2026-08-03T12:00:00.000Z"),
    });
    expect(withToken["x-amz-security-token"]).toBe("session-token");
    expect(withToken.authorization).toContain("x-amz-security-token");
  });

  it("refuses an ARN whose region contradicts the region field", () => {
    expect(
      snsProvider.check(
        {
          region: "eu-west-1",
          topicArn: "arn:aws:sns:us-east-1:123456789012:a",
        },
        secrets,
      ),
    ).toMatch(/region/i);
  });
});

/* ------------------------------------------------------------------ */
/* The Apprise bridge                                                  */
/* ------------------------------------------------------------------ */

describe("the Apprise bridge", () => {
  it("is the only entry that is not native, and says so", () => {
    expect(appriseProvider.capabilities.native).toBe(false);
    expect(appriseProvider.kind).toBe("bridge");
    expect(appriseProvider.blurb.toLowerCase()).toContain("you run");
    expect(appriseProvider.prerequisite.toLowerCase()).toContain(
      "vigil runs no apprise server",
    );
  });

  it("posts to a saved configuration key, keeping the URLs on your server", async () => {
    const { sent, outcome } = deliver(appriseProvider, {
      config: {
        serverUrl: "http://apprise.internal:8000",
        configKey: "ops",
        tag: "devops",
      },
      secrets: {},
    });
    expect((await outcome).status).toBe("delivered");
    expect(sent[0]!.url).toBe("http://apprise.internal:8000/notify/ops");
    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    expect(body.tag).toBe("devops");
    expect(body.type).toBe("failure");
    expect(body.urls).toBeUndefined();
  });

  it("falls back to inline URLs, which are a secret field", async () => {
    const { sent, outcome } = deliver(appriseProvider, {
      config: { serverUrl: "http://apprise.internal:8000" },
      secrets: { urls: "discord://id/token" },
    });
    await outcome;
    expect(sent[0]!.url).toBe("http://apprise.internal:8000/notify");
    expect(JSON.parse(sent[0]!.body)).toMatchObject({
      urls: "discord://id/token",
    });
    const urlsField = appriseProvider.fields.find((f) => f.key === "urls");
    expect(urlsField?.secret).toBe(true);
  });

  it("refuses a configuration with neither a key nor URLs, or with both", () => {
    const base = { serverUrl: "http://apprise.internal:8000" };
    expect(appriseProvider.check(base, {})).toMatch(/key, or the Apprise URLs/);
    expect(
      appriseProvider.check({ ...base, configKey: "ops" }, { urls: "x://y" }),
    ).toMatch(/not both/);
  });

  it("sends the proxy Authorization header when one is configured", async () => {
    const { sent, outcome } = deliver(appriseProvider, {
      config: { serverUrl: "http://apprise.internal:8000", configKey: "ops" },
      secrets: { authorization: "Basic dXNlcjpwYXNz" },
    });
    await outcome;
    expect(sent[0]!.headers.authorization).toBe("Basic dXNlcjpwYXNz");
  });

  it("maps severity onto Apprise's four message types", async () => {
    const types: Record<string, string> = {};
    for (const severity of ["critical", "warning", "ok", "info"] as const) {
      const { sent, outcome } = deliver(appriseProvider, {
        config: { serverUrl: "http://apprise.internal:8000", configKey: "ops" },
        secrets: {},
        msg: message({ severity }),
      });
      await outcome;
      types[severity] = (JSON.parse(sent[0]!.body) as { type: string }).type;
    }
    expect(types).toEqual({
      critical: "failure",
      warning: "warning",
      ok: "success",
      info: "info",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Cross-cutting: redaction, egress, and the shared pipeline           */
/* ------------------------------------------------------------------ */

describe("every provider in the wave", () => {
  /** Enough configuration for each to attempt a delivery. */
  const FIXTURES: Record<
    string,
    { config: Record<string, string>; secrets: Record<string, string> }
  > = {
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
      secrets: { apiToken: "jira-secret-token-value" },
    },
    matrix: {
      config: {
        homeserverUrl: "https://matrix.example.org",
        roomId: "!AbCdEf:example.org",
      },
      secrets: { accessToken: "matrix-secret-token-value" },
    },
    mattermost: {
      config: {
        serverUrl: "https://mm.example.com",
        channelId: "abcdefghijklmnopqrstuvwxyz",
      },
      secrets: { accessToken: "mattermost-secret-token-value" },
    },
    rocketchat: {
      config: {
        serverUrl: "https://chat.example.com",
        channel: "#alerts",
        userId: "abc12345",
      },
      secrets: { authToken: "rocketchat-secret-token-value" },
    },
    zulip: {
      config: {
        serverUrl: "https://example.zulipchat.com",
        channel: "monitoring",
        topic: "Alerts",
        botEmail: "bot@example.com",
      },
      secrets: { apiKey: "zulip-secret-key-value" },
    },
    line: {
      config: { to: "U1234567890abcdef1234567890abcdef" },
      secrets: { channelAccessToken: "line-secret-token-value" },
    },
    pushover: {
      config: {},
      secrets: { apiToken: "a".repeat(30), userKey: "u".repeat(30) },
    },
    pushbullet: {
      config: {},
      secrets: { accessToken: "pushbullet-secret-token-value" },
    },
    bark: {
      config: { serverUrl: "https://bark.example.com" },
      secrets: { deviceKey: "bark-secret-device-key" },
    },
    homeassistant: {
      config: { baseUrl: "https://ha.example.com", service: "notify" },
      secrets: { accessToken: "homeassistant-secret-token-value" },
    },
    twilio: {
      config: {
        accountSid: `AC${"0".repeat(32)}`,
        to: "+15551234567",
        from: "+15557654321",
      },
      secrets: { authToken: "twilio-secret-auth-token" },
    },
    "twilio-whatsapp": {
      config: {
        accountSid: `AC${"0".repeat(32)}`,
        to: "+15551234567",
        from: "+15557654321",
      },
      secrets: { authToken: "twilio-secret-auth-token" },
    },
    sns: {
      config: {
        region: "eu-west-1",
        topicArn: "arn:aws:sns:eu-west-1:123456789012:alerts",
      },
      secrets: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "sns-secret-access-key-value",
      },
    },
    apprise: {
      config: { serverUrl: "https://apprise.example.com", configKey: "ops" },
      secrets: { authorization: "Basic apprise-secret-header" },
    },
  };

  const wave = Object.keys(FIXTURES);

  it("has a fixture for every provider added in this release", () => {
    // Web Push is exercised in its own describe, because its fixture
    // needs generated keys; everything else is here.
    const added = CHANNEL_PROVIDERS.map((p) => p.id).filter(
      (id) =>
        ![
          "slack",
          "discord",
          "teams",
          "telegram",
          "googlechat",
          "gotify",
          "ntfy",
          "webhook",
          "smtp",
          "resend",
          "webpush",
        ].includes(id),
    );
    expect(wave.sort()).toEqual(added.sort());
  });

  it("never lets a secret reach the ledger, whatever the provider echoes", async () => {
    for (const id of wave) {
      const provider = getProvider(id)!;
      const fixture = FIXTURES[id]!;
      // The nastiest realistic case, and the one this test used to
      // miss: the service echoes the credential back in the form it
      // arrived in. Four providers send HTTP Basic, so the value on the
      // wire is base64 of `user:secret` - a scrub of the raw value
      // cannot see it, and a reverse proxy's block page or a WAF
      // reflecting request headers would put a decodable token in the
      // ledger. Both encodings are echoed here.
      const raw = Object.values(fixture.secrets);
      const echoed = [
        ...raw,
        ...raw.map((v) => Buffer.from(v, "utf8").toString("base64")),
        `Basic ${Buffer.from(`user:${raw[0] ?? ""}`, "utf8").toString("base64")}`,
        `Bearer ${raw[0] ?? ""}`,
      ].join(" and ");
      const { outcome } = deliver(provider, {
        ...fixture,
        replies: [
          {
            status: 401,
            body: `rejected credential ${echoed} for https://x.test/p?token=${raw[0] ?? ""}`,
          },
        ],
      });
      const result = await outcome;
      expect(result.status, id).not.toBe("delivered");
      const error = "error" in result ? result.error : "";
      for (const secret of Object.values(fixture.secrets)) {
        expect(error, `${id} leaked a secret into the ledger`).not.toContain(
          secret,
        );
        expect(
          error,
          `${id} leaked a base64-encoded secret into the ledger`,
        ).not.toContain(Buffer.from(secret, "utf8").toString("base64"));
      }
      // Nothing that decodes back to a credential, whoever composed it.
      for (const match of error.matchAll(
        /\b(?:Basic|Bearer)\s+([A-Za-z0-9+/=._-]{8,})/gi,
      )) {
        const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
        for (const secret of Object.values(fixture.secrets)) {
          expect(decoded, `${id} left a decodable credential`).not.toContain(
            secret,
          );
        }
      }
    }
  });

  it("classifies 5xx as retryable and 4xx as permanent, consistently", async () => {
    for (const id of wave) {
      const provider = getProvider(id)!;
      const fixture = FIXTURES[id]!;
      const server = await deliver(provider, {
        ...fixture,
        replies: [{ status: 503, body: "down" }],
      }).outcome;
      expect(server.status, `${id} on 503`).toBe("retryable");

      const client = await deliver(provider, {
        ...fixture,
        // Jira's first call is the search; a 403 there is the outcome.
        replies: [{ status: 403, body: "forbidden" }],
      }).outcome;
      expect(client.status, `${id} on 403`).toBe("permanent");
    }
  });

  it("honours Retry-After on a 429", async () => {
    for (const id of wave) {
      const provider = getProvider(id)!;
      const fixture = FIXTURES[id]!;
      const sent: string[] = [];
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        sent.push(String(input));
        return new Response("slow down", {
          status: 429,
          headers: { "retry-after": "120" },
        });
      });
      const outcome = await provider.deliver({
        config: fixture.config,
        secrets: fixture.secrets,
        message: message(),
        rowId: "row-1",
        net: { fetchImpl, lookup: publicLookup },
      });
      expect(outcome, id).toMatchObject({
        status: "retryable",
        retryAfterMs: 120_000,
      });
    }
  });

  it("refuses a metadata address on every operator-typed endpoint", async () => {
    // The egress policy is shared, so this is not a per-provider claim -
    // it is a check that no provider found a way around it.
    const metadata: EgressLookup = async () => [
      { address: "169.254.169.254", family: 4 },
    ];
    // Every provider whose endpoint comes from an operator-typed field,
    // not only the ones added in this wave: Teams', Gotify's, ntfy's and
    // the signed webhook's URLs are operator-supplied too, and the
    // policy is shared, so leaving them out left the shared claim
    // half-checked.
    const alsoOperatorTyped: Record<
      string,
      { config: Record<string, string>; secrets: Record<string, string> }
    > = {
      gotify: {
        config: { serverUrl: "https://gotify.example.com" },
        secrets: { appToken: "gotify-token" },
      },
      ntfy: {
        config: { serverUrl: "https://ntfy.example.com", topic: "alerts" },
        secrets: {},
      },
      webhook: {
        config: { url: "https://ops.example.com/hooks/vigil" },
        secrets: { secret: "whsec_x" },
      },
      teams: {
        config: {},
        secrets: {
          webhookUrl: "https://prod-1.westus.logic.azure.com/workflows/x",
        },
      },
    };
    const operatorTyped = [
      "jira",
      "matrix",
      "mattermost",
      "rocketchat",
      "zulip",
      "bark",
      "homeassistant",
      "apprise",
      ...Object.keys(alsoOperatorTyped),
    ];
    for (const id of operatorTyped) {
      const provider = getProvider(id)!;
      const fixture = (FIXTURES[id] ?? alsoOperatorTyped[id])!;
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}"));
      const outcome = await provider.deliver({
        config: fixture.config,
        secrets: fixture.secrets,
        message: message(),
        rowId: "row-1",
        net: { fetchImpl, lookup: metadata },
      });
      expect(outcome.status, id).toBe("permanent");
      expect(
        fetchImpl,
        `${id} connected to a metadata address`,
      ).not.toHaveBeenCalled();
    }
  });

  it("summarizes its destination without revealing a credential", () => {
    for (const id of wave) {
      const provider = getProvider(id)!;
      const fixture = FIXTURES[id]!;
      const summary = provider.destinationSummary(
        fixture.config,
        fixture.secrets,
      );
      expect(summary, id).toMatch(/\S/);
      for (const secret of Object.values(fixture.secrets)) {
        expect(summary, `${id} destination leaks a secret`).not.toContain(
          secret,
        );
      }
    }
  });

  it("validates a good configuration and rejects an empty one", () => {
    for (const id of wave) {
      const provider = getProvider(id)!;
      const fixture = FIXTURES[id]!;
      expect(provider.check(fixture.config, fixture.secrets), id).toBeNull();
      expect(provider.check({}, {}), id).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------------ */
/* The published tables have to match the registry                     */
/* ------------------------------------------------------------------ */

describe("the published provider tables", () => {
  it("state the same API version the code is written against", async () => {
    const { readFileSync } = await import("node:fs");
    const doc = readFileSync("docs/NOTIFICATIONS.md", "utf8");
    for (const provider of CHANNEL_PROVIDERS) {
      // The doc renders paths in backticks; compare on the text with
      // backticks stripped so the prose can stay readable.
      const flat = doc.replace(/`/g, "");
      expect(
        flat,
        `docs/NOTIFICATIONS.md does not state ${provider.id}'s API version (${provider.apiVersion})`,
      ).toContain(provider.apiVersion);
    }
  });

  it("mark Closes, Dedupes and Receipt exactly as the registry does", async () => {
    const { readFileSync } = await import("node:fs");
    const doc = readFileSync("docs/NOTIFICATIONS.md", "utf8");
    for (const provider of CHANNEL_PROVIDERS) {
      const row = doc
        .split("\n")
        .find(
          (line) =>
            line.startsWith("| ") &&
            line.split("|")[1]?.trim() === provider.label,
        );
      expect(row, `no table row for ${provider.label}`).toBeTruthy();
      const cells = row!.split("|").map((c) => c.trim());
      const [closes, dedupes, receipt] = cells.slice(3, 6);
      expect(closes, `${provider.label} Closes`).toBe(
        provider.capabilities.lifecycle ? "yes" : "no",
      );
      expect(dedupes, `${provider.label} Dedupes`).toBe(
        provider.capabilities.duplicateSuppression ? "yes" : "no",
      );
      expect(receipt, `${provider.label} Receipt`).toBe(
        provider.capabilities.receipt ? "yes" : "no",
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* The failure classifier: retryable vs unknown                        */
/* ------------------------------------------------------------------ */

describe("classifying a transport failure", () => {
  // The distinction the release advertises, and the one that had no
  // test at all: `retryable` means nothing was sent that could have
  // taken effect; `unknown` means the request may have arrived and a
  // duplicate cannot be ruled out. Both retry. Only `unknown` puts an
  // amber count in front of the operator.
  //
  // These go through the REAL error shapes, because that is where the
  // first version was wrong: `fetch` rejects with
  // `TypeError("fetch failed", { cause })`, so a classifier reading
  // only the top-level error matched nothing and called every network
  // failure a possible duplicate.

  it("calls a refused connection retryable, through the wrapper fetch uses", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), {
      code: "ECONNREFUSED",
    });
    const wrapped = new TypeError("fetch failed", { cause: inner });
    expect(sentNothing(wrapped)).toBe(true);
    expect(sentNothing(inner)).toBe(true);
  });

  it("calls an unresolvable name retryable", () => {
    const inner = Object.assign(new Error("getaddrinfo ENOTFOUND nope.test"), {
      code: "ENOTFOUND",
    });
    expect(sentNothing(new TypeError("fetch failed", { cause: inner }))).toBe(
      true,
    );
  });

  it("calls a rejected certificate retryable", () => {
    const inner = Object.assign(new Error("certificate has expired"), {
      code: "CERT_HAS_EXPIRED",
    });
    expect(sentNothing(new TypeError("fetch failed", { cause: inner }))).toBe(
      true,
    );
  });

  it("calls a timeout unknown, because the request may have landed", () => {
    const abort = Object.assign(new Error("The operation was aborted"), {
      name: "TimeoutError",
    });
    expect(sentNothing(abort)).toBe(false);
    expect(sentNothing(new TypeError("fetch failed", { cause: abort }))).toBe(
      false,
    );
  });

  it("calls a reset mid-response unknown", () => {
    // The bytes went out. Whatever happened next, the far end may have
    // acted on them.
    const inner = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    expect(sentNothing(new TypeError("fetch failed", { cause: inner }))).toBe(
      false,
    );
  });

  it("does not loop forever on a self-referencing cause", () => {
    const looping: { cause?: unknown; message: string } = {
      message: "round and round",
    };
    looping.cause = looping;
    expect(sentNothing(looping)).toBe(false);
  });

  it("reports the classification a real delivery gets", async () => {
    // End to end through `httpDeliver`, with a transport that fails the
    // way a refused connection fails.
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      });
    });
    const outcome = await getProvider("slack")!.deliver({
      config: {},
      secrets: { webhookUrl: "https://hooks.slack.com/services/T/B/x" },
      message: message(),
      rowId: "row-1",
      net: { fetchImpl, lookup: publicLookup },
    });
    expect(outcome.status).toBe("retryable");

    const timedOut = vi.fn<typeof fetch>(async () => {
      throw Object.assign(new Error("The operation was aborted"), {
        name: "TimeoutError",
      });
    });
    const second = await getProvider("slack")!.deliver({
      config: {},
      secrets: { webhookUrl: "https://hooks.slack.com/services/T/B/x" },
      message: message(),
      rowId: "row-1",
      net: { fetchImpl: timedOut, lookup: publicLookup },
    });
    expect(second.status).toBe("unknown");
  });
});
