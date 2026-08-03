import {
  EgressBlockedError,
  egressFetch,
  egressPolicyFor,
  type EgressLookup,
} from "@/modules/monitors/egress";

import type { MessageSeverity } from "../events";
import type { DeliveryOutcome } from "../outbox";
import type { SecretValues } from "../secretbox";
import type { WebhookEvent } from "../webhook";

/**
 * The provider contract. One registry, one delivery pipeline: a provider
 * describes its fields for the editor, validates a configuration,
 * summarizes where it sends (redacted), and turns one ChannelMessage
 * into one DeliveryOutcome. Everything else - queueing, retries,
 * idempotency, rate limits, the ledger - is the outbox's, shared by all
 * of them. A provider that needed its own queue would be wrong here.
 */

/** The rendered notification, stored in the outbox row at enqueue time.
 * A retry re-sends what was decided, not what would render today. */
export interface ChannelMessage {
  kind: "channel";
  event: WebhookEvent;
  /** One line: event label plus subject, e.g. "🔴 Monitor down - API". */
  title: string;
  /** A few short lines of detail. May be empty. */
  text: string;
  /** Deep link into Vigil, when the event has a page. */
  url?: string;
  severity: MessageSeverity;
  organizationId: string;
  /** The native webhook payload's `data` - what signed webhooks send. */
  data: Record<string, unknown>;
  /** Decided at enqueue; the signed webhook payload carries it. */
  timestamp: string;
}

export interface ProviderField {
  key: string;
  label: string;
  type: "text" | "url" | "password" | "select";
  /** Secret fields live in the sealed envelope, never in config, and
   * are never sent back to the browser. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

/** What the channel editor needs to render a provider - serializable. */
export interface ProviderDescriptor {
  id: string;
  label: string;
  kind: "chat" | "email" | "push" | "webhook";
  blurb: string;
  docsUrl: string;
  fields: ProviderField[];
}

/** Injection points so provider contracts are testable without a network. */
export interface ProviderNet {
  fetchImpl?: typeof fetch;
  lookup?: EgressLookup;
  timeoutMs?: number;
}

export interface DeliverInput {
  config: SecretValues;
  secrets: SecretValues;
  message: ChannelMessage;
  /** Outbox row id - the Idempotency-Key where a provider honors one. */
  rowId: string;
  net: ProviderNet;
}

export interface ChannelProvider extends ProviderDescriptor {
  /** Cross-field validation beyond required/URL checks; null when fine. */
  check(config: SecretValues, secrets: SecretValues): string | null;
  /** Redacted "where does this go" line for lists and the ledger. */
  destinationSummary(config: SecretValues, secrets: SecretValues): string;
  deliver(input: DeliverInput): Promise<DeliveryOutcome>;
}

/* ------------------------------------------------------------------ */
/* Shared delivery mechanics                                           */
/* ------------------------------------------------------------------ */

export const PROVIDER_TIMEOUT_MS = 10_000;
/** How much of an error response body is kept for the ledger. */
const ERROR_BODY_LIMIT = 300;
/** Longest Retry-After honored; beyond this the normal backoff rules. */
const RETRY_AFTER_CAP_MS = 3_600_000;

/**
 * Scrubs credentials from text bound for the ledger or a log line:
 * every secret value is replaced, and any URL loses its query string
 * and userinfo, because providers echo their own URLs into error
 * bodies and several providers carry the credential there.
 */
export function redactErrorText(text: string, secrets: SecretValues): string {
  let out = text;
  for (const value of Object.values(secrets)) {
    if (value.length >= 4) out = out.split(value).join("[redacted]");
  }
  out = out.replace(
    /(https?:\/\/)(?:[^\s/@]+@)?([^\s?#"']+)(?:[?#][^\s"']*)?/gi,
    (_, proto: string, rest: string) => `${proto}${rest}`,
  );
  return out.slice(0, 500);
}

/** Parses Retry-After (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfterMs(
  value: string | null,
  now: Date = new Date(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1_000), RETRY_AFTER_CAP_MS);
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  const ms = date - now.getTime();
  return ms > 0 ? Math.min(ms, RETRY_AFTER_CAP_MS) : undefined;
}

export interface HttpDeliveryRequest {
  url: string;
  method?: "POST" | "PUT";
  headers: Record<string, string>;
  body: string;
  secrets: SecretValues;
  net: ProviderNet;
  /**
   * Pulls a provider receipt out of a 2xx body. Optional; a provider
   * with no useful receipt returns null receipts.
   */
  messageId?: (body: string) => string | null;
  /** Extra retry-after signal from a 429 body (Telegram's style). */
  retryAfterFromBody?: (body: string) => number | undefined;
}

/**
 * One guarded HTTP delivery attempt, classified for the outbox.
 *
 * Every URL-based provider goes through here, so every one of them gets
 * the same egress policy as the org webhook: resolve, classify, pin,
 * refuse metadata and link-local space, never follow a redirect (a
 * redirect would re-target a credentialed request and, for signed
 * payloads, drop the method and body). The outbox owns retries, so this
 * makes exactly one attempt and reports what happened:
 *
 *  - 2xx: delivered.
 *  - 429, 408, any 5xx: retryable, honoring Retry-After when present.
 *  - any other 4xx: permanent - a rejected credential or payload does
 *    not fix itself by waiting.
 *  - network error, timeout: retryable.
 *  - egress refusal: permanent, because the same URL resolves to the
 *    same forbidden place on every retry.
 *
 * Every error string is redacted before it leaves this function.
 */
export async function httpDeliver(
  request: HttpDeliveryRequest,
): Promise<DeliveryOutcome> {
  const timeoutMs = request.net.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  try {
    const { response } = await egressFetch(
      request.url,
      {
        method: request.method ?? "POST",
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(timeoutMs),
      },
      {
        policy: egressPolicyFor("webhook"),
        lookup: request.net.lookup,
        fetchImpl: request.net.fetchImpl,
        maxRedirects: 0,
      },
    );

    const bodyText = await response
      .text()
      .then((t) => t.slice(0, 2_000))
      .catch(() => "");

    if (response.ok) {
      return {
        status: "delivered",
        providerMessageId: request.messageId?.(bodyText) ?? null,
      };
    }

    const detail = redactErrorText(
      `${response.status}: ${bodyText.slice(0, ERROR_BODY_LIMIT) || response.statusText}`,
      request.secrets,
    );

    if (
      response.status === 429 ||
      response.status === 408 ||
      response.status >= 500
    ) {
      const retryAfterMs =
        parseRetryAfterMs(response.headers.get("retry-after")) ??
        request.retryAfterFromBody?.(bodyText);
      return {
        status: "retryable",
        error: detail,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    }
    return { status: "permanent", error: detail };
  } catch (error) {
    if (error instanceof EgressBlockedError) {
      return {
        status: "permanent",
        error: redactErrorText(error.message, request.secrets),
      };
    }
    return {
      status: "retryable",
      error: redactErrorText(
        error instanceof Error ? error.message : "provider request failed",
        request.secrets,
      ),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Shared validation and rendering helpers                             */
/* ------------------------------------------------------------------ */

export function requireHttpsUrl(
  value: string,
  what: string,
  allowedHosts?: readonly string[],
): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${what} is not a valid URL.`;
  }
  if (url.protocol !== "https:") return `${what} must use https.`;
  if (allowedHosts && !allowedHosts.includes(url.hostname.toLowerCase())) {
    return `${what} must be on ${allowedHosts.join(" or ")}.`;
  }
  return null;
}

export function requireHttpUrl(value: string, what: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return `${what} must use http or https.`;
    }
  } catch {
    return `${what} is not a valid URL.`;
  }
  return null;
}

/** Host plus a fixed marker, for summarizing a URL that is a credential. */
export function redactedUrlSummary(value: string): string {
  try {
    return `${new URL(value).hostname}/[redacted]`;
  } catch {
    return "[redacted]";
  }
}

/** `title`, blank line, `text`, then the link - the plain-text shape
 * every chat and push provider renders. */
export function plainTextBody(message: ChannelMessage): string {
  const parts = [message.title];
  if (message.text) parts.push(message.text);
  if (message.url) parts.push(message.url);
  return parts.join("\n");
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validates a comma-separated recipient list; returns the parsed list. */
export function parseRecipients(value: string): string[] | null {
  const list = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (list.length === 0 || list.length > 20) return null;
  return list.every((v) => EMAIL_PATTERN.test(v)) ? list : null;
}
