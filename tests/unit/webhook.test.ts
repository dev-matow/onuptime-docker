import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  buildDeliveryBody,
  buildWebhookPayload,
  deliverWebhook,
  detectWebhookFormat,
  renderEventText,
  signBody,
  verifySignature,
  WEBHOOK_PAYLOAD_VERSION,
} from "@/modules/notifications/webhook";

const SECRET = "whsec_test_secret";

function okResponse(status = 200): Response {
  return new Response(null, { status });
}

describe("signBody / verifySignature", () => {
  it("produces the sha256=<hex> HMAC of the exact body", () => {
    const body = JSON.stringify({ hello: "world" });
    const expected =
      "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
    expect(signBody(SECRET, body)).toBe(expected);
  });

  it("verifies a matching signature and rejects tampering", () => {
    const body = '{"event":"incident.opened"}';
    const sig = signBody(SECRET, body);
    expect(verifySignature(SECRET, body, sig)).toBe(true);
    expect(verifySignature(SECRET, body + " ", sig)).toBe(false);
    expect(verifySignature("other-secret", body, sig)).toBe(false);
    expect(verifySignature(SECRET, body, "sha256=deadbeef")).toBe(false);
  });
});

describe("buildWebhookPayload", () => {
  it("wraps data in a versioned envelope with an ISO timestamp", () => {
    const timestamp = new Date("2026-07-02T12:00:00.000Z");
    const payload = buildWebhookPayload({
      event: "monitor.down",
      organizationId: "org_1",
      data: { monitor: { id: "m1" } },
      timestamp,
    });
    expect(payload).toEqual({
      version: WEBHOOK_PAYLOAD_VERSION,
      event: "monitor.down",
      timestamp: "2026-07-02T12:00:00.000Z",
      organization: { id: "org_1" },
      data: { monitor: { id: "m1" } },
    });
  });
});

describe("detectWebhookFormat", () => {
  it("detects Slack and Discord by exact host, case-insensitively", () => {
    expect(
      detectWebhookFormat("https://hooks.slack.com/services/T0/B0/xyz"),
    ).toBe("slack");
    expect(
      detectWebhookFormat("https://HOOKS.SLACK.COM/services/T0/B0/xyz"),
    ).toBe("slack");
    expect(
      detectWebhookFormat("https://discord.com/api/webhooks/1/token"),
    ).toBe("discord");
    expect(
      detectWebhookFormat("https://discordapp.com/api/webhooks/1/token"),
    ).toBe("discord");
  });

  it("never misclassifies other receivers, including lookalike hosts", () => {
    expect(detectWebhookFormat("https://example.com/hook")).toBe("vigil");
    expect(detectWebhookFormat("https://hooks.slack.com.evil.io/x")).toBe(
      "vigil",
    );
    expect(detectWebhookFormat("https://mydiscord.com/api/webhooks/1")).toBe(
      "vigil",
    );
    expect(detectWebhookFormat("not a url")).toBe("vigil");
  });
});

describe("renderEventText / buildDeliveryBody", () => {
  const incidentPayload = buildWebhookPayload({
    event: "incident.opened",
    organizationId: "org_1",
    data: {
      incident: {
        title: "Checkout Service is down",
        severity: "critical",
        url: "https://vigil.example/incidents/i1",
      },
      monitor: { name: "Checkout Service" },
    },
    timestamp: new Date("2026-07-02T12:00:00.000Z"),
  });

  it("renders a one-line summary with severity, monitor and link", () => {
    expect(renderEventText(incidentPayload)).toBe(
      "🔴 Incident opened — Checkout Service is down [critical] (Checkout Service)\n" +
        "https://vigil.example/incidents/i1",
    );
  });

  it("falls back to monitor name, then test message, then bare event", () => {
    const monitorOnly = buildWebhookPayload({
      event: "monitor.up",
      organizationId: "org_1",
      data: { monitor: { name: "API Gateway" } },
    });
    expect(renderEventText(monitorOnly)).toBe(
      "🟢 Monitor recovered — API Gateway",
    );

    const test = buildWebhookPayload({
      event: "webhook.test",
      organizationId: "org_1",
      data: { message: "This is a test delivery from Vigil." },
    });
    expect(renderEventText(test)).toBe(
      "✅ Test notification from Vigil — This is a test delivery from Vigil.",
    );

    const bare = buildWebhookPayload({
      event: "incident.updated",
      organizationId: "org_1",
      data: {},
    });
    expect(renderEventText(bare)).toBe("🟠 Incident updated");
  });

  it("wraps the summary for chat formats and ships the payload natively", () => {
    expect(JSON.parse(buildDeliveryBody("slack", incidentPayload))).toEqual({
      text: renderEventText(incidentPayload),
    });
    expect(JSON.parse(buildDeliveryBody("discord", incidentPayload))).toEqual({
      content: renderEventText(incidentPayload),
    });
    expect(JSON.parse(buildDeliveryBody("vigil", incidentPayload))).toEqual(
      incidentPayload,
    );
  });
});

describe("deliverWebhook", () => {
  const payload = buildWebhookPayload({
    event: "incident.opened",
    organizationId: "org_1",
    data: {},
    timestamp: new Date("2026-07-02T12:00:00.000Z"),
  });

  it("signs the request and reports success on 2xx", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(200));
    const result = await deliverWebhook(
      { url: "https://example.com/hook", secret: SECRET },
      payload,
      { fetchImpl },
    );

    expect(result).toEqual({ delivered: true, attempts: 1, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const init = fetchImpl.mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-vigil-event"]).toBe("incident.opened");
    expect(headers["x-vigil-signature"]).toBe(
      signBody(SECRET, init.body as string),
    );
    // Redirects must not be followed: fetch would drop the body+signature.
    expect(init.redirect).toBe("manual");
  });

  it("treats a 3xx redirect as a permanent failure, not success", async () => {
    // fetch with redirect:"manual" returns the real 3xx with ok:false;
    // following it would deliver an empty, unsigned GET.
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(301));
    const sleep = vi.fn(async () => {});
    const result = await deliverWebhook(
      { url: "https://example.com/hook", secret: SECRET },
      payload,
      { fetchImpl, sleep, attempts: 3 },
    );

    expect(result.delivered).toBe(false);
    expect(result.status).toBe(301);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient failures with exponential backoff, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(okResponse(503))
      .mockResolvedValueOnce(okResponse(200));
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });

    const result = await deliverWebhook(
      { url: "https://example.com/hook", secret: SECRET },
      payload,
      { fetchImpl, sleep, attempts: 3, backoffMs: 500 },
    );

    expect(result).toEqual({ delivered: true, attempts: 3, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // 500 * 2^0, 500 * 2^1 between the three attempts.
    expect(sleeps).toEqual([500, 1000]);
  });

  it("gives up after the attempt budget and never throws", async () => {
    const fetchImpl = vi.fn(async () => okResponse(500));
    const result = await deliverWebhook(
      { url: "https://example.com/hook", secret: SECRET },
      payload,
      { fetchImpl, sleep: async () => {}, attempts: 2 },
    );

    expect(result.delivered).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanent 4xx (misconfigured endpoint)", async () => {
    const fetchImpl = vi.fn(async () => okResponse(404));
    const sleep = vi.fn(async () => {});
    const result = await deliverWebhook(
      { url: "https://example.com/hook", secret: SECRET },
      payload,
      { fetchImpl, sleep, attempts: 3 },
    );

    expect(result.delivered).toBe(false);
    expect(result.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("sends the Slack body shape to a Slack URL, signed over that body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(200));
    const result = await deliverWebhook(
      { url: "https://hooks.slack.com/services/T0/B0/xyz", secret: SECRET },
      payload,
      { fetchImpl },
    );

    expect(result.delivered).toBe(true);
    const init = fetchImpl.mock.calls[0]![1]!;
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({ text: renderEventText(payload) });
    // The signature invariant holds for adapted bodies too.
    const headers = init.headers as Record<string, string>;
    expect(headers["x-vigil-signature"]).toBe(signBody(SECRET, body));
  });

  it("retries a 429 rate-limit response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse(429))
      .mockResolvedValueOnce(okResponse(200));
    const result = await deliverWebhook(
      { url: "https://example.com/hook", secret: SECRET },
      payload,
      { fetchImpl, sleep: async () => {}, attempts: 2 },
    );

    expect(result.delivered).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
