import { createHmac, timingSafeEqual } from "node:crypto";

import { logger } from "@/lib/logger";
import {
  EgressBlockedError,
  egressFetch,
  egressPolicyFor,
  type EgressAuditSink,
  type EgressChannel,
  type EgressLookup,
} from "@/modules/monitors/egress";

/**
 * Outbound webhook delivery: compact versioned payloads, HMAC-SHA-256
 * signatures, and bounded exponential-backoff retries. Slack and Discord
 * webhook URLs are detected by host and receive that service's message
 * shape instead of the native payload. Every function here is pure or
 * takes its side effects by injection (`fetchImpl`, `sleep`) so signing
 * and retry behaviour are unit-testable without a network or real
 * timers. `deliverWebhook` never throws — a failing endpoint must never
 * affect incident processing.
 *
 * Delivery is also egress, and until 1.13 it was the one outbound path
 * with no address policy at all: an org webhook URL is operator-typed
 * and a recovery trigger URL is stored, so both were a signed POST to
 * wherever a hostname happened to point that minute. Both now go
 * through `modules/monitors/egress.ts`, which resolves, classifies and
 * pins before the socket opens. Private space stays reachable by
 * default on both channels — a receiver on your own network is the
 * normal deployment — but metadata and link-local space does not,
 * whatever the URL says or resolves to.
 */

export const WEBHOOK_EVENTS = [
  "incident.opened",
  "incident.updated",
  "incident.resolved",
  "monitor.down",
  "monitor.up",
] as const;

export type WebhookEvent =
  | (typeof WEBHOOK_EVENTS)[number]
  | "webhook.test"
  // Recovery triggers reuse the delivery/signature machinery but are
  // sent to the monitor's recovery endpoint, not the org webhook.
  // `recovery.test` verifies the wiring — receivers should not act on it.
  | "recovery.execute"
  | "recovery.test";

/** Bumped only on a breaking change to the payload shape. */
export const WEBHOOK_PAYLOAD_VERSION = 1;

export interface WebhookPayload {
  version: number;
  event: WebhookEvent;
  timestamp: string;
  organization: { id: string };
  data: Record<string, unknown>;
}

export function buildWebhookPayload(input: {
  event: WebhookEvent;
  organizationId: string;
  data: Record<string, unknown>;
  timestamp?: Date;
}): WebhookPayload {
  return {
    version: WEBHOOK_PAYLOAD_VERSION,
    event: input.event,
    timestamp: (input.timestamp ?? new Date()).toISOString(),
    organization: { id: input.organizationId },
    data: input.data,
  };
}

/** `sha256=<hex>` over the exact request body, keyed by the endpoint secret. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * Constant-time signature check for receivers implemented in this repo
 * (the settings UI documents the same scheme for external receivers).
 */
export function verifySignature(
  secret: string,
  body: string,
  signature: string,
): boolean {
  const expected = signBody(secret, body);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export type WebhookFormat = "vigil" | "slack" | "discord";

/**
 * Chat services only accept their own body shape, so the saved URL decides
 * the wire format: a Slack or Discord webhook URL gets that service's JSON,
 * anything else gets the native versioned payload. Detection is by exact
 * host so an unrelated receiver can never be misclassified.
 */
export function detectWebhookFormat(url: string): WebhookFormat {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "hooks.slack.com") return "slack";
    if (host === "discord.com" || host === "discordapp.com") return "discord";
    return "vigil";
  } catch {
    return "vigil";
  }
}

const EVENT_LABELS: Record<string, string> = {
  "incident.opened": "🔴 Incident opened",
  "incident.updated": "🟠 Incident updated",
  "incident.resolved": "🟢 Incident resolved",
  "monitor.down": "🔴 Monitor down",
  "monitor.up": "🟢 Monitor recovered",
  "webhook.test": "✅ Test notification from Vigil",
  "recovery.execute": "🔧 Recovery action triggered",
  "recovery.test": "🔧 Test recovery trigger from Vigil",
};

/** One-line human rendering of a payload for chat destinations. */
export function renderEventText(payload: WebhookPayload): string {
  const data = payload.data as {
    incident?: { title?: string; severity?: string; url?: string };
    monitor?: { name?: string };
    message?: string;
  };
  const parts = [EVENT_LABELS[payload.event] ?? payload.event];
  if (data.incident?.title) {
    parts.push(`- ${data.incident.title}`);
    if (data.incident.severity) parts.push(`[${data.incident.severity}]`);
    if (data.monitor?.name) parts.push(`(${data.monitor.name})`);
  } else if (data.monitor?.name) {
    parts.push(`- ${data.monitor.name}`);
  } else if (typeof data.message === "string") {
    parts.push(`- ${data.message}`);
  }
  const line = parts.join(" ");
  return data.incident?.url ? `${line}\n${data.incident.url}` : line;
}

/**
 * The exact request body for the wire: chat formats wrap the human line,
 * the native format ships the full versioned payload. The signature is
 * always computed over whatever body is actually sent.
 */
export function buildDeliveryBody(
  format: WebhookFormat,
  payload: WebhookPayload,
): string {
  if (format === "slack") {
    return JSON.stringify({ text: renderEventText(payload) });
  }
  if (format === "discord") {
    return JSON.stringify({ content: renderEventText(payload) });
  }
  return JSON.stringify(payload);
}

export interface WebhookEndpoint {
  url: string;
  secret: string;
}

export interface DeliveryOptions {
  attempts?: number;
  timeoutMs?: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Which egress policy applies. Recovery triggers reuse this machinery
   * but are a different channel with its own switch, so the caller has
   * to say which one it is rather than inheriting the org webhook's.
   */
  channel?: EgressChannel;
  /** Overrides the channel's private-network default, for tests. */
  allowPrivate?: boolean;
  lookup?: EgressLookup;
  onException?: EgressAuditSink;
}

export interface DeliveryResult {
  delivered: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POSTs the payload with retries. Succeeds on a 2xx; retries transient
 * failures (network errors, timeouts, 5xx, 429) with exponential
 * backoff and gives up after `attempts`. 4xx (except 429) is treated as
 * a permanent misconfiguration and not retried. Always resolves.
 */
export async function deliverWebhook(
  endpoint: WebhookEndpoint,
  payload: WebhookPayload,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const backoffMs = options.backoffMs ?? 500;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  const body = buildDeliveryBody(detectWebhookFormat(endpoint.url), payload);
  const headers = {
    "content-type": "application/json",
    "user-agent": "vigil-webhooks/1.0",
    "x-vigil-event": payload.event,
    "x-vigil-signature": signBody(endpoint.secret, body),
  };

  const egress = {
    // Re-checked on every attempt rather than once before the loop: a
    // retry is a new connection minutes later, and the record it
    // resolves is the attacker's to change in between.
    policy: egressPolicyFor(options.channel ?? "webhook", options.allowPrivate),
    lookup: options.lookup,
    onException: options.onException,
    fetchImpl,
    // Never follow: a redirect would downgrade the POST to a GET and
    // drop the body and signature, silently delivering an empty
    // unsigned request — and it would move a signed request to a host
    // the operator never configured. Surfaced as a failure instead, so
    // the operator fixes the URL (e.g. an http→https endpoint).
    maxRedirects: 0,
  };

  let lastError: string | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { response } = await egressFetch(
        endpoint.url,
        {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        },
        egress,
      );
      lastStatus = response.status;
      // Drain so keep-alive sockets are reusable; body is irrelevant.
      await response.arrayBuffer().catch(() => undefined);

      if (response.ok) {
        return { delivered: true, attempts: attempt, status: response.status };
      }
      // Client errors other than rate limiting won't fix themselves.
      if (response.status < 500 && response.status !== 429) {
        return {
          delivered: false,
          attempts: attempt,
          status: response.status,
          error: `endpoint returned ${response.status}`,
        };
      }
      lastError = `endpoint returned ${response.status}`;
    } catch (error) {
      // A policy refusal is a misconfiguration, not a transient fault:
      // the same URL resolves to the same forbidden place next time, so
      // retrying it is three log lines and no delivery. Reported
      // verbatim — the operator needs to read which address it landed
      // on to fix the endpoint.
      if (error instanceof EgressBlockedError) {
        logger.warn(
          { event: payload.event, err: error.message },
          "webhook delivery refused by egress policy",
        );
        return { delivered: false, attempts: attempt, error: error.message };
      }
      lastError =
        error instanceof Error ? error.message : "webhook request failed";
    }

    if (attempt < attempts) {
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }

  logger.warn(
    { event: payload.event, attempts, status: lastStatus, err: lastError },
    "webhook delivery failed",
  );
  return {
    delivered: false,
    attempts,
    status: lastStatus,
    error: lastError ?? "delivery failed",
  };
}
