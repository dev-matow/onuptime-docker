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
import type { ProviderKind } from "./kinds";

/** Re-exported so a provider imports its whole contract from one place. */
export type { SecretValues };

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
  /**
   * `textarea` exists for exactly one shape: a credential the operator
   * cannot retype, only paste, because a browser produced it. The Web
   * Push subscription is the only such field, and the rule stated in
   * the goal applies - raw JSON only where the format is not ours to
   * choose, and then validated in `check` rather than trusted.
   */
  type: "text" | "url" | "password" | "select" | "textarea";
  /** Secret fields live in the sealed envelope, never in config, and
   * are never sent back to the browser. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

/**
 * What a provider can actually do, as four facts rather than prose.
 *
 * These exist because the product publishes claims about them - the
 * duplicate-suppression table in `docs/NOTIFICATIONS.md` used to be
 * hand-maintained, and a hand-maintained table about twenty-six
 * providers is a table that is wrong. The editor renders these as
 * badges, the docs generator reads them, and `npm run facts` fails if
 * a page disagrees with the registry.
 */
export interface ProviderCapabilities {
  /**
   * Vigil speaks this service's own API, against its own documented
   * request and response shapes.
   *
   * False for exactly one entry: the Apprise bridge, which forwards to
   * an Apprise server the customer runs. Whatever that server reaches
   * is between the customer and Apprise - Vigil has not implemented,
   * pinned or tested any of it, and no surface may count those services
   * as Vigil providers.
   */
  native: boolean;
  /**
   * Down opens something on the provider and up closes it. A provider
   * without this is told twice, which is the right shape for a chat
   * room and the wrong shape for a pager.
   */
  lifecycle: boolean;
  /**
   * A redelivery of the same outbox row collapses at the provider,
   * because the request carries a key derived from that row. This is
   * the honest half of at-least-once, and it is per provider.
   */
  duplicateSuppression: boolean;
  /** A 2xx carries an id worth keeping; it goes in the ledger. */
  receipt: boolean;
}

/** What the channel editor needs to render a provider - serializable. */
export interface ProviderDescriptor {
  id: string;
  label: string;
  /**
   * Groups the picker, which has to stay usable at twenty-six entries.
   * `incident` is the on-call class (a pager, a ticket), `bridge` is
   * the one entry that is not Vigil's implementation of anything.
   */
  kind: ProviderKind;
  blurb: string;
  docsUrl: string;
  /**
   * The API version this provider is written against, shown in the
   * editor and published in the docs.
   *
   * Pinned on purpose and visible on purpose: "we call PagerDuty" is
   * not a checkable statement and "Events API v2" is. When a provider
   * has no version in its URL the string names the documented surface
   * instead, which is still something an operator can verify.
   */
  apiVersion: string;
  /** What the operator must already have. One line, shown above the
   * fields, because most failed setups fail before the first field. */
  prerequisite: string;
  capabilities: ProviderCapabilities;
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
    if (value.length < 4) continue;
    out = out.split(value).join("[redacted]");
    // The same secret in the form it actually goes on the wire. Jira,
    // Zulip, Twilio and ntfy send HTTP Basic, which is base64 of
    // `user:secret` - a scrub of the raw value cannot see it, and a
    // server that echoes its request headers into an error body (a
    // reverse proxy's block page, a WAF, a debug endpoint) would put a
    // decodable credential in the ledger. The pair form is not known
    // here, so the value alone is scrubbed and the blanket rule below
    // catches the rest.
    out = out
      .split(Buffer.from(value, "utf8").toString("base64"))
      .join("[redacted]");
  }
  // Any credential-shaped Authorization value, whoever composed it.
  // This is the backstop for the pair encodings the loop above cannot
  // reconstruct, and it costs nothing when there is no header to find.
  out = out.replace(
    /\b(Basic|Bearer|vapid)\s+[A-Za-z0-9+/=._~-]{8,}/gi,
    "$1 [redacted]",
  );
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
  method?: "GET" | "POST" | "PUT";
  headers: Record<string, string>;
  /**
   * Omitted for GET; a GET with a body is refused by several of these
   * services and signed by none of them. `Uint8Array` is for Web Push,
   * whose body is an encrypted binary record, not text.
   */
  body?: string | Uint8Array;
  secrets: SecretValues;
  net: ProviderNet;
  /**
   * Pulls a provider receipt out of a 2xx body. Optional; a provider
   * with no useful receipt returns null receipts.
   */
  messageId?: (body: string) => string | null;
  /** Extra retry-after signal from a 429 body (Telegram's style). */
  retryAfterFromBody?: (body: string) => number | undefined;
  /**
   * A 2xx that means failure.
   *
   * Several of these APIs answer 200 and put the verdict in the body -
   * Pushover's `status`, Zulip's `result`, Rocket.Chat's `success`,
   * Bark's `code`. Reporting those as delivered would put a lie in the
   * ledger, which is the one thing the outbox exists to prevent.
   * Returns the reason, or null when the body agrees with the status
   * line. A body-level rejection is permanent: the service is saying
   * the request was wrong, and waiting does not make it right.
   */
  bodyProblem?: (body: string) => string | null;
  /**
   * Non-2xx statuses that mean the message WAS accepted.
   *
   * One provider needs this and the reason is the whole point of the
   * lease. LINE deduplicates on `X-Line-Retry-Key`, and the way it says
   * "I already have this one" is **409 Conflict** - which the classifier
   * below would otherwise record as a permanent failure. The sequence
   * that produces it is the exact window the outbox exists for: LINE
   * accepts the push, the response is lost, the lease expires, the row
   * is re-claimed, and the retry carries the same key. Without this the
   * operator is paged and the ledger says they were not, which is a
   * worse lie than the duplicate the retry key prevents.
   */
  acceptedStatuses?: readonly number[];
}

/**
 * The result of one guarded request: either a 2xx and its body, or the
 * classified failure, already redacted.
 *
 * This exists because two providers need to look at a response before
 * they know what to send next - Jira asks whether the issue for this
 * cause already exists before it decides between creating one and
 * commenting on it. Giving them the raw `fetch` back would give them
 * their own egress policy and their own error classification, which is
 * exactly the duplication the one-pipeline rule exists to prevent. So
 * they get the same single attempt every other provider makes, and the
 * only extra thing they get is the body.
 */
export type HttpAttempt =
  | { ok: true; status: number; body: string }
  | { ok: false; outcome: DeliveryOutcome };

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
export async function httpAttempt(
  request: HttpDeliveryRequest,
): Promise<HttpAttempt> {
  const timeoutMs = request.net.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const method = request.method ?? "POST";
  try {
    const { response } = await egressFetch(
      request.url,
      {
        method,
        headers: request.headers,
        ...(method === "GET" ? {} : { body: request.body ?? "" }),
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

    if (
      response.ok ||
      request.acceptedStatuses?.includes(response.status) === true
    ) {
      return { ok: true, status: response.status, body: bodyText };
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
        ok: false,
        outcome: {
          status: "retryable",
          error: detail,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      };
    }
    return { ok: false, outcome: { status: "permanent", error: detail } };
  } catch (error) {
    if (error instanceof EgressBlockedError) {
      return {
        ok: false,
        outcome: {
          status: "permanent",
          error: redactErrorText(error.message, request.secrets),
        },
      };
    }
    return {
      ok: false,
      outcome: {
        status: "retryable",
        error: redactErrorText(
          error instanceof Error ? error.message : "provider request failed",
          request.secrets,
        ),
      },
    };
  }
}

export async function httpDeliver(
  request: HttpDeliveryRequest,
): Promise<DeliveryOutcome> {
  const attempt = await httpAttempt(request);
  if (!attempt.ok) return attempt.outcome;
  const problem = request.bodyProblem?.(attempt.body);
  if (problem) {
    return {
      status: "permanent",
      error: redactErrorText(
        `${problem}: ${attempt.body.slice(0, ERROR_BODY_LIMIT)}`,
        request.secrets,
      ),
    };
  }
  return {
    status: "delivered",
    providerMessageId: request.messageId?.(attempt.body) ?? null,
  };
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

/** Reads a JSON body without letting a malformed one throw. */
export function parseJsonBody<T>(body: string): T | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Alert lifecycle: what a pager or a ticket needs and a chat room does not */
/* ------------------------------------------------------------------ */

/**
 * Whether this message says the problem is over.
 *
 * Derived from the severity the event classifier already assigns rather
 * than from a second list of event names, so a new event cannot end up
 * resolving alerts because somebody forgot to add it here. `ok` is the
 * class the classifier gives `monitor.up`, `incident.resolved` and
 * `recovery.succeeded`, and it is exactly the set that should close a
 * PagerDuty alert or transition a Jira issue.
 */
export function isResolution(message: ChannelMessage): boolean {
  return message.severity === "ok";
}

/**
 * The stable identity of the underlying problem, for providers that
 * correlate rather than append.
 *
 * The whole value of a pager integration is that the third alert about
 * one outage joins the first two and the recovery closes all of them,
 * and that only works if the key is derived from the CAUSE. So:
 *
 *  - an incident id when the event has one, which covers `monitor.down`
 *    and `incident.opened` for the same outage landing on one alert,
 *    and `incident.resolved` closing it;
 *  - a monitor id when there is no incident;
 *  - the outbox row id otherwise, which is the test-delivery case. A
 *    test must not reopen or resolve a real alert, and a row id is
 *    unique per delivery, so it cannot.
 *
 * The organization id is in the key because two tenants of one
 * self-hosted Vigil must never collide on a shared PagerDuty service,
 * and the `vigil/` prefix keeps Vigil's keys distinguishable from every
 * other tool pointed at the same integration.
 */
export function alertKey(message: ChannelMessage, rowId: string): string {
  const data = message.data as {
    incident?: { id?: unknown };
    monitor?: { id?: unknown };
    recovery?: { incidentId?: unknown };
  };
  // Recovery results name their incident in a different place, because
  // the signed webhook payload for `recovery.*` was published before
  // any provider correlated anything, and its shape is a wire contract.
  // Reading both here rather than changing that payload keeps the
  // correlation in ONE function. Without it a `recovery.succeeded`
  // resolved `monitor/<id>` while the outage had opened
  // `incident/<id>` - so PagerDuty closed nothing, Jira wrote nothing,
  // and `recovery.failed` opened a SECOND ticket for one outage.
  const incidentId =
    typeof data?.incident?.id === "string"
      ? data.incident.id
      : typeof data?.recovery?.incidentId === "string"
        ? data.recovery.incidentId
        : null;
  const monitorId =
    typeof data?.monitor?.id === "string" ? data.monitor.id : null;
  const scope = incidentId
    ? `incident/${incidentId}`
    : monitorId
      ? `monitor/${monitorId}`
      : `delivery/${rowId}`;
  return `vigil/${message.organizationId}/${scope}`;
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
