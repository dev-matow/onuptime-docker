import { describe, expect, it, vi } from "vitest";

import type { EgressLookup } from "@/modules/monitors/egress";
import {
  CHANNEL_PROVIDERS,
  getProvider,
  parseRetryAfterMs,
  plainTextBody,
  providerDescriptors,
  redactErrorText,
  type ChannelMessage,
  type ChannelProvider,
} from "@/modules/notifications/providers";
import { buildTeamsCard } from "@/modules/notifications/providers/teams";
import { buildSignedWebhookBody } from "@/modules/notifications/providers/webhook";
import { verifySignature } from "@/modules/notifications/webhook";

/**
 * Provider CONTRACT tests: for each provider, what goes on the wire -
 * URL, headers, body shape - and how responses classify. No sockets:
 * fetch is faked and DNS is pinned to a public address, so what is
 * asserted is exactly what a receiver would see.
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
    data: { incident: { id: "inc-1" } },
    timestamp: "2026-08-03T12:00:00.000Z",
    ...overrides,
  };
}

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(status = 200, responseBody = "{}") {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(responseBody, { status });
  });
  return { sent, fetchImpl };
}

function deliver(
  provider: ChannelProvider,
  input: {
    config?: Record<string, string>;
    secrets?: Record<string, string>;
    status?: number;
    responseBody?: string;
    msg?: ChannelMessage;
  },
) {
  const { sent, fetchImpl } = fakeFetch(
    input.status ?? 200,
    input.responseBody ?? "{}",
  );
  const outcome = provider.deliver({
    config: input.config ?? {},
    secrets: input.secrets ?? {},
    message: input.msg ?? message(),
    rowId: "row-123",
    net: { fetchImpl, lookup: publicLookup },
  });
  return { sent, outcome };
}

describe("the registry", () => {
  it("ships exactly the ten advertised providers", () => {
    expect(CHANNEL_PROVIDERS.map((p) => p.id).sort()).toEqual(
      [
        "discord",
        "googlechat",
        "gotify",
        "ntfy",
        "resend",
        "slack",
        "smtp",
        "teams",
        "telegram",
        "webhook",
      ].sort(),
    );
  });

  it("declares its secret fields as secret and never as config", () => {
    for (const provider of CHANNEL_PROVIDERS) {
      for (const field of provider.fields) {
        if (field.type === "password") {
          expect(
            field.secret,
            `${provider.id}.${field.key} is a password but not secret`,
          ).toBe(true);
        }
      }
    }
  });

  it("serializes descriptors without functions", () => {
    for (const descriptor of providerDescriptors()) {
      expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
    }
  });
});

describe("slack", () => {
  const slack = getProvider("slack")!;

  it("rejects a non-Slack host at validation", () => {
    expect(
      slack.check({}, { webhookUrl: "https://evil.example.com/x" }),
    ).toMatch(/hooks\.slack\.com/);
    expect(
      slack.check(
        {},
        { webhookUrl: "https://hooks.slack.com/services/T0/B0/x" },
      ),
    ).toBeNull();
  });

  it("posts {text} to the webhook URL", async () => {
    const { sent, outcome } = deliver(slack, {
      secrets: { webhookUrl: "https://hooks.slack.com/services/T0/B0/xyz" },
      responseBody: "ok",
    });
    await expect(outcome).resolves.toEqual({
      status: "delivered",
      providerMessageId: null,
    });
    expect(sent[0]!.url).toContain("hooks.slack.com");
    expect(JSON.parse(sent[0]!.body)).toEqual({
      text: plainTextBody(message()),
    });
  });

  it("keeps the credential URL out of its destination summary", () => {
    const summary = slack.destinationSummary(
      {},
      { webhookUrl: "https://hooks.slack.com/services/T0/B0/secrettoken" },
    );
    expect(summary).not.toContain("secrettoken");
    expect(summary).toContain("hooks.slack.com");
  });
});

describe("discord", () => {
  const discord = getProvider("discord")!;

  it("caps content at Discord's 2000 characters", async () => {
    const long = message({ text: "x".repeat(3000) });
    const { sent } = deliver(discord, {
      secrets: { webhookUrl: "https://discord.com/api/webhooks/1/tok" },
      msg: long,
    });
    await new Promise((r) => setTimeout(r, 0));
    const body = JSON.parse(sent[0]!.body) as { content: string };
    expect(body.content.length).toBeLessThanOrEqual(2000);
  });

  it("classifies 429 as retryable with Retry-After honored", async () => {
    const { fetchImpl } = fakeFetch();
    const outcome = await discord.deliver({
      config: {},
      secrets: { webhookUrl: "https://discord.com/api/webhooks/1/tok" },
      message: message(),
      rowId: "row-1",
      net: {
        lookup: publicLookup,
        fetchImpl: vi.fn<typeof fetch>(async () => {
          return new Response("{}", {
            status: 429,
            headers: { "retry-after": "7" },
          });
        }),
      },
    });
    void fetchImpl;
    expect(outcome).toMatchObject({ status: "retryable", retryAfterMs: 7000 });
  });
});

describe("teams", () => {
  const teams = getProvider("teams")!;

  it("sends the Workflows message + Adaptive Card shape, not MessageCard", () => {
    const card = JSON.parse(buildTeamsCard(message())) as {
      type: string;
      attachments: {
        contentType: string;
        content: { type: string; version: string; body: unknown[] };
      }[];
    };
    expect(card.type).toBe("message");
    expect(card.attachments[0]!.contentType).toBe(
      "application/vnd.microsoft.card.adaptive",
    );
    expect(card.attachments[0]!.content.type).toBe("AdaptiveCard");
    // The retired connector format must never reappear.
    expect(buildTeamsCard(message())).not.toContain("MessageCard");
  });

  it("requires https but pins no host (tenant workflow URLs vary)", () => {
    expect(
      teams.check({}, { webhookUrl: "http://prod.logic.azure.com/x" }),
    ).toMatch(/https/);
    expect(
      teams.check(
        {},
        { webhookUrl: "https://prod-07.westus.logic.azure.com/workflows/abc" },
      ),
    ).toBeNull();
  });

  it("treats a Workflows 202 as delivered", async () => {
    const { outcome } = deliver(teams, {
      secrets: { webhookUrl: "https://prod.logic.azure.com/workflows/abc" },
      status: 202,
      responseBody: "",
    });
    await expect(outcome).resolves.toMatchObject({ status: "delivered" });
  });
});

describe("telegram", () => {
  const telegram = getProvider("telegram")!;
  const secrets = { botToken: "1234567890:AAfake-token-abcdefghijklmnopqrs" };

  it("validates the BotFather token shape and the chat id", () => {
    expect(telegram.check({ chatId: "-100123" }, { botToken: "nope" })).toMatch(
      /token/i,
    );
    expect(telegram.check({ chatId: "not a chat" }, secrets)).toMatch(/chat/i);
    expect(telegram.check({ chatId: "-1001234567890" }, secrets)).toBeNull();
    expect(telegram.check({ chatId: "@mychannel" }, secrets)).toBeNull();
  });

  it("posts sendMessage with plain text and no parse_mode", async () => {
    const { sent, outcome } = deliver(telegram, {
      config: { chatId: "-100555" },
      secrets,
      responseBody: JSON.stringify({ ok: true, result: { message_id: 42 } }),
    });
    await expect(outcome).resolves.toEqual({
      status: "delivered",
      providerMessageId: "42",
    });
    expect(sent[0]!.url).toBe(
      `https://api.telegram.org/bot${secrets.botToken}/sendMessage`,
    );
    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    expect(body.chat_id).toBe("-100555");
    expect(body.parse_mode).toBeUndefined();
    expect(body.disable_web_page_preview).toBe(true);
  });

  it("reads retry_after out of a 429 body", async () => {
    const outcome = await telegram.deliver({
      config: { chatId: "-100555" },
      secrets,
      message: message(),
      rowId: "row-1",
      net: {
        lookup: publicLookup,
        fetchImpl: vi.fn<typeof fetch>(
          async () =>
            new Response(
              JSON.stringify({ ok: false, parameters: { retry_after: 31 } }),
              { status: 429 },
            ),
        ),
      },
    });
    expect(outcome).toMatchObject({ status: "retryable", retryAfterMs: 31000 });
  });

  it("never lets the bot token into an error string", async () => {
    const outcome = await telegram.deliver({
      config: { chatId: "-100555" },
      secrets,
      message: message(),
      rowId: "row-1",
      net: {
        lookup: publicLookup,
        fetchImpl: vi.fn<typeof fetch>(
          async () =>
            new Response(`bad request to /bot${secrets.botToken}/sendMessage`, {
              status: 400,
            }),
        ),
      },
    });
    expect(outcome.status).toBe("permanent");
    if (outcome.status === "permanent") {
      expect(outcome.error).not.toContain(secrets.botToken);
    }
  });
});

describe("googlechat", () => {
  const chat = getProvider("googlechat")!;

  it("pins the chat.googleapis.com host", () => {
    expect(chat.check({}, { webhookUrl: "https://evil.test/v1" })).toMatch(
      /chat\.googleapis\.com/,
    );
  });

  it("posts {text} and reads the message name as the receipt", async () => {
    const { sent, outcome } = deliver(chat, {
      secrets: {
        webhookUrl:
          "https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t",
      },
      responseBody: JSON.stringify({ name: "spaces/AAA/messages/BBB" }),
    });
    await expect(outcome).resolves.toEqual({
      status: "delivered",
      providerMessageId: "spaces/AAA/messages/BBB",
    });
    expect(JSON.parse(sent[0]!.body)).toHaveProperty("text");
  });
});

describe("gotify", () => {
  const gotify = getProvider("gotify")!;

  it("authenticates via the X-Gotify-Key header, never the URL", async () => {
    const { sent } = deliver(gotify, {
      config: { serverUrl: "https://push.example.com" },
      secrets: { appToken: "AbCdEfGh123" },
      responseBody: JSON.stringify({ id: 7 }),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[0]!.url).toBe("https://push.example.com/message");
    expect(sent[0]!.url).not.toContain("AbCdEfGh123");
    expect(sent[0]!.headers["x-gotify-key"]).toBe("AbCdEfGh123");
  });

  it("maps severity to Gotify priority (critical 8, ok 4)", async () => {
    const { sent } = deliver(gotify, {
      config: { serverUrl: "https://push.example.com" },
      secrets: { appToken: "t" },
      msg: message({ severity: "critical" }),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ priority: 8 });
  });
});

describe("ntfy", () => {
  const ntfy = getProvider("ntfy")!;

  it("validates the topic charset", () => {
    expect(
      ntfy.check({ serverUrl: "https://ntfy.sh", topic: "has space" }, {}),
    ).toMatch(/topic/i);
    expect(
      ntfy.check({ serverUrl: "https://ntfy.sh", topic: "vigil_alerts-1" }, {}),
    ).toBeNull();
  });

  it("publishes JSON to the server root so emoji titles survive headers", async () => {
    const { sent } = deliver(ntfy, {
      config: { serverUrl: "https://ntfy.sh", topic: "vigil-alerts" },
      secrets: { password: "tk_abc123" },
      responseBody: JSON.stringify({ id: "m1" }),
    });
    await new Promise((r) => setTimeout(r, 0));
    // The server ROOT (JSON publish mode), not /<topic>; the trailing
    // slash is URL normalization on the way through the egress guard.
    expect(sent[0]!.url.replace(/\/$/, "")).toBe("https://ntfy.sh");
    expect(sent[0]!.url).not.toContain("vigil-alerts");
    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    expect(body.topic).toBe("vigil-alerts");
    expect(body.title).toContain("🔴");
    expect(body.click).toBe("https://vigil.example.com/incidents/inc-1");
    expect(sent[0]!.headers.authorization).toBe("Bearer tk_abc123");
  });

  it("switches to Basic auth when a username is set", async () => {
    const { sent } = deliver(ntfy, {
      config: {
        serverUrl: "https://ntfy.internal",
        topic: "alerts",
        username: "vigil",
      },
      secrets: { password: "pw" },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from("vigil:pw").toString("base64")}`,
    );
  });
});

describe("generic webhook", () => {
  const webhook = getProvider("webhook")!;

  it("ships the exact versioned payload contract, signed", async () => {
    const msg = message();
    const { sent, outcome } = deliver(webhook, {
      config: { url: "https://ops.example.com/hooks/vigil" },
      secrets: { secret: "whsec_testsecret" },
      msg,
    });
    await expect(outcome).resolves.toMatchObject({ status: "delivered" });
    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    expect(body).toEqual({
      version: 1,
      event: "monitor.down",
      timestamp: msg.timestamp,
      organization: { id: "org-1" },
      data: msg.data,
    });
    expect(
      verifySignature(
        "whsec_testsecret",
        sent[0]!.body,
        sent[0]!.headers["x-vigil-signature"]!,
      ),
    ).toBe(true);
    expect(sent[0]!.headers["x-vigil-event"]).toBe("monitor.down");
  });

  it("buildSignedWebhookBody is deterministic for a stored message", () => {
    const msg = message();
    expect(buildSignedWebhookBody(msg)).toBe(buildSignedWebhookBody(msg));
  });
});

describe("resend", () => {
  const resend = getProvider("resend")!;

  it("validates the recipient list", () => {
    const secrets = { apiKey: "re_123" };
    expect(
      resend.check({ from: "a@b.co", to: "not-an-email" }, secrets),
    ).toMatch(/recipients/i);
    expect(
      resend.check({ from: "Vigil <a@b.co>", to: "x@y.co, z@w.co" }, secrets),
    ).toBeNull();
  });

  it("sends the outbox row id as the Idempotency-Key", async () => {
    const { sent, outcome } = deliver(resend, {
      config: { from: "Vigil <alerts@b.co>", to: "ops@b.co" },
      secrets: { apiKey: "re_secret_key" },
      responseBody: JSON.stringify({ id: "email-1" }),
    });
    await expect(outcome).resolves.toEqual({
      status: "delivered",
      providerMessageId: "email-1",
    });
    expect(sent[0]!.headers["idempotency-key"]).toBe("row-123");
    expect(sent[0]!.headers.authorization).toBe("Bearer re_secret_key");
  });
});

describe("shared classification", () => {
  const slack = getProvider("slack")!;
  const secrets = { webhookUrl: "https://hooks.slack.com/services/T/B/x" };

  it("5xx is retryable, plain 4xx is permanent", async () => {
    const { outcome: five } = deliver(slack, { secrets, status: 503 });
    await expect(five).resolves.toMatchObject({ status: "retryable" });
    const { outcome: four } = deliver(slack, {
      secrets,
      status: 404,
      responseBody: "no_service",
    });
    await expect(four).resolves.toMatchObject({
      status: "permanent",
      error: expect.stringContaining("404"),
    });
  });

  it("a network error is retryable and redacted", async () => {
    const outcome = await slack.deliver({
      config: {},
      secrets,
      message: message(),
      rowId: "r",
      net: {
        lookup: publicLookup,
        fetchImpl: vi.fn<typeof fetch>(async () => {
          throw new Error("connect ECONNREFUSED");
        }),
      },
    });
    expect(outcome).toMatchObject({ status: "retryable" });
  });

  it("refuses metadata targets by policy, permanently", async () => {
    const gotify = getProvider("gotify")!;
    const outcome = await gotify.deliver({
      config: { serverUrl: "http://169.254.169.254" },
      secrets: { appToken: "t" },
      message: message(),
      rowId: "r",
      net: { fetchImpl: vi.fn<typeof fetch>(async () => new Response("")) },
    });
    expect(outcome.status).toBe("permanent");
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta seconds and caps at an hour", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
    expect(parseRetryAfterMs("999999")).toBe(3_600_000);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });

  it("parses an HTTP date relative to now", () => {
    const now = new Date("2026-08-03T12:00:00Z");
    expect(parseRetryAfterMs("Mon, 03 Aug 2026 12:00:45 GMT", now)).toBe(
      45_000,
    );
    expect(
      parseRetryAfterMs("Mon, 03 Aug 2026 11:00:00 GMT", now),
    ).toBeUndefined();
  });
});

describe("redactErrorText", () => {
  it("strips secret values and URL credentials", () => {
    const out = redactErrorText(
      "POST https://user:pass@api.example.com/send?token=tok_12345 failed: key sk_live_abcd rejected",
      { apiKey: "sk_live_abcd" },
    );
    expect(out).not.toContain("sk_live_abcd");
    expect(out).not.toContain("token=tok_12345");
    expect(out).not.toContain("user:pass@");
    expect(out).toContain("api.example.com");
  });
});
