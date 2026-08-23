import { createHmac, timingSafeEqual } from "node:crypto";

import { logger } from "@/lib/logger";
import {
  drainBodyCapped,
  EgressBlockedError,
  egressFetch,
  egressPolicyFor,
  MAX_DRAIN_BYTES,
  type EgressAuditSink,
  type EgressChannel,
  type EgressLookup,
} from "@/modules/monitors/egress";

import { sentNothing } from "./providers/types";

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
  // Three events and not one with a severity field, because a routing
  // rule matches on severity and an operator reading that rule has to be
  // able to tell what it will catch from the event name. Which of the
  // first two a burn alert uses is the rule's own `severity` column.
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
  "recovery.succeeded": "🟢 Recovery succeeded",
  "recovery.failed": "🔴 Recovery failed",
  "probe.partial_failure": "🟠 Probes disagree",
  "probe.insufficient_quorum": "🟠 Probe quorum not met",
  "slo.burn_critical": "🔴 Error budget burning fast",
  "slo.burn_warning": "🟠 Error budget burning",
  "slo.burn_resolved": "🟢 Error budget burn ended",
  "webhook.test": "✅ Test notification from Vigil",
  "recovery.execute": "🔧 Recovery action triggered",
  "recovery.test": "🔧 Test recovery trigger from Vigil",
};

/** The label a chat message leads with; exported for the dispatcher. */
export function eventLabel(event: WebhookEvent): string {
  return EVENT_LABELS[event] ?? event;
}

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
 * What one signed POST concluded, in the vocabulary the outbox already
 * uses for exactly this question.
 *
 * Four cases, and the fourth is why this was split out of
 * `deliverWebhook`. That function collapses everything into
 * `{delivered, error}`, which is the right shape for a caller that only
 * retries and gives up. It is the wrong shape for a caller that has to
 * decide whether an effect MAY HAVE HAPPENED, which is every runbook
 * step that reaches somebody else's infrastructure.
 *
 * The classification is `sentNothing`, the same walk of the cause chain
 * the provider transports use. Sharing it is the point: a timeout after
 * the body went out means something at the far end may have acted, and
 * two implementations of that judgement would eventually disagree about
 * the one call where it mattered.
 */
export type PostOutcome =
  | { status: "delivered"; httpStatus: number }
  /** It might succeed later, and NOTHING was sent that could have taken
   * effect: a refused connection, a name that does not resolve, or a
   * 5xx/429 the far end produced before doing anything. */
  | { status: "retryable"; error: string; httpStatus?: number }
  /** It will never succeed as configured: a 4xx, or an address the
   * egress policy refuses. */
  | { status: "permanent"; error: string; httpStatus?: number }
  /** The request went out and its fate is unknown. */
  | { status: "unknown"; error: string };

export interface SignedPostOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  channel?: EgressChannel;
  allowPrivate?: boolean;
  lookup?: EgressLookup;
  onException?: EgressAuditSink;
  /**
   * The stable execution identity, sent as `Idempotency-Key`.
   *
   * A statement about what the SENDER did, never a claim about what the
   * receiver does with it. A receiver that honours the header collapses
   * the duplicate; one that ignores it acts twice, which is why an
   * unknown outcome is never retried automatically whatever this header
   * says.
   */
  idempotencyKey?: string;
}

/**
 * One signed POST, classified. No retries and no sleeping: the caller
 * owns the schedule.
 */
export async function signedPostOnce(
  endpoint: WebhookEndpoint,
  payload: WebhookPayload,
  options: SignedPostOptions = {},
): Promise<PostOutcome> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  const body = buildDeliveryBody(detectWebhookFormat(endpoint.url), payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "vigil-webhooks/1.0",
    "x-vigil-event": payload.event,
    "x-vigil-signature": signBody(endpoint.secret, body),
    ...(options.idempotencyKey
      ? { "idempotency-key": options.idempotencyKey }
      : {}),
  };

  try {
    const { response } = await egressFetch(
      endpoint.url,
      {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      },
      {
        // Re-checked on every call rather than once before a retry loop:
        // a retry is a new connection minutes later, and the record it
        // resolves is the attacker's to change in between.
        policy: egressPolicyFor(
          options.channel ?? "webhook",
          options.allowPrivate,
        ),
        lookup: options.lookup,
        onException: options.onException,
        fetchImpl,
        // Never follow: a redirect would downgrade the POST to a GET and
        // drop the body and signature, silently delivering an empty
        // unsigned request — and it would move a signed request to a host
        // the operator never configured. Surfaced as a failure instead, so
        // the operator fixes the URL (e.g. an http→https endpoint).
        maxRedirects: 0,
      },
    );
    // The body is irrelevant — read and discarded with a cap, not
    // buffered. `arrayBuffer()` held the receiver's whole response in
    // memory for a delivery that only reads the status line, and a
    // webhook receiver is operator-configured, not trusted. There is no
    // keep-alive to preserve: the egress transport runs `agent: false`.
    await drainBodyCapped(response, MAX_DRAIN_BYTES);

    if (response.ok) {
      return { status: "delivered", httpStatus: response.status };
    }
    // Client errors other than rate limiting won't fix themselves.
    if (response.status < 500 && response.status !== 429) {
      return {
        status: "permanent",
        httpStatus: response.status,
        error: `endpoint returned ${response.status}`,
      };
    }
    return {
      status: "retryable",
      httpStatus: response.status,
      error: `endpoint returned ${response.status}`,
    };
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
      return { status: "permanent", error: error.message };
    }
    const message =
      error instanceof Error ? error.message : "webhook request failed";
    return sentNothing(error)
      ? { status: "retryable", error: message }
      : { status: "unknown", error: message };
  }
}

/**
 * POSTs the payload with retries. Succeeds on a 2xx; retries transient
 * failures (network errors, timeouts, 5xx, 429) with exponential
 * backoff and gives up after `attempts`. 4xx (except 429) is treated as
 * a permanent misconfiguration and not retried. Always resolves.
 *
 * A loop over {@link signedPostOnce}, which is where the request, the
 * signature and the classification now live. It was a second copy of
 * all three until the runbook engine needed the classification, and two
 * implementations of "did this arrive" is exactly the drift this
 * repository keeps finding.
 */
export async function deliverWebhook(
  endpoint: WebhookEndpoint,
  payload: WebhookPayload,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const attempts = options.attempts ?? 3;
  const backoffMs = options.backoffMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: string | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const outcome = await signedPostOnce(endpoint, payload, {
      timeoutMs: options.timeoutMs ?? 5_000,
      fetchImpl: options.fetchImpl,
      channel: options.channel,
      allowPrivate: options.allowPrivate,
      lookup: options.lookup,
      onException: options.onException,
    });

    if (outcome.status === "delivered") {
      return { delivered: true, attempts: attempt, status: outcome.httpStatus };
    }
    if (outcome.status === "permanent") {
      return {
        delivered: false,
        attempts: attempt,
        ...(outcome.httpStatus === undefined
          ? {}
          : { status: outcome.httpStatus }),
        error: outcome.error,
      };
    }
    lastError = outcome.error;
    if (outcome.status === "retryable" && outcome.httpStatus !== undefined) {
      lastStatus = outcome.httpStatus;
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
