import { EgressBlockedError, egressFetch } from "../../egress";
import type { ProbeContext, ProbeResult } from "../contract";
import { RABBITMQ_HEALTH_PATH, type RabbitmqConfig } from "../specs/rabbitmq";
import { elapsedSince, monitorEgress } from "./guard";

/**
 * One GET against a RabbitMQ node's health-check endpoint.
 *
 * HTTP, so this goes through `modules/monitors/egress.ts` rather than
 * opening its own socket: the guard classifies the address it then
 * connects to, which is the half `refusesPrivate` cannot do. It matters
 * more here than for most types — the request carries an Authorization
 * header, and a management URL that resolves somewhere unexpected would
 * be handed a broker credential.
 *
 * What counts as an answer is the subtle part. A node with a memory
 * alarm in effect answers 503 and is *up*: the process is running, the
 * API is serving, and it is telling us precisely what is wrong. That is
 * an assertion failure with a reason an operator can act on, not a
 * transport failure. Conversely a 401 is neither — the broker is fine
 * and the stored credential is not, which is an operator error, and an
 * operator error that reads as `down` is indistinguishable from the
 * broker being gone.
 */

/**
 * A health-check document is a hundred bytes. The cap is protection
 * against whatever is actually on the other end of a URL somebody typed,
 * not a limit RabbitMQ approaches.
 */
const MAX_BODY_BYTES = 64 * 1024;

/** How much of the node's own words are kept as a fact. */
const MAX_REASON_CHARS = 200;

export async function rabbitmqProbe(
  ctx: ProbeContext<RabbitmqConfig>,
): Promise<ProbeResult> {
  // Checked here so the probe reports it in its own words: `egressFetch`
  // parses the target too, but a malformed one would surface as a raw
  // TypeError from the transport branch below.
  if (!URL.canParse(ctx.target)) {
    return blank("Not a management API URL");
  }

  const startedAt = performance.now();
  try {
    const { response } = await egressFetch(
      healthUrl(ctx.target),
      {
        method: "GET",
        signal: AbortSignal.timeout(ctx.timeoutMs),
        headers: requestHeaders(ctx.config),
      },
      {
        ...monitorEgress(ctx),
        // The health path does not redirect. A 3xx means the URL names a
        // proxy or the wrong scheme, and following it would either drop
        // the credential at the origin boundary — surfacing as a 401,
        // which reads as "wrong password" — or carry a broker credential
        // to an origin the operator never typed. Reporting the 3xx says
        // what actually happened.
        maxRedirects: 0,
      },
    );

    // Read inside the try, uncaught: a body that stops arriving mid-read
    // is a transport failure, and swallowing it would hand the parser an
    // empty string and report a network problem as an unreadable answer.
    const body = await readCappedText(response, MAX_BODY_BYTES);
    return healthResult(response.status, body, elapsedSince(startedAt));
  } catch (error) {
    // A policy refusal is not a measurement: nothing was sent, so there
    // is no response time to report and no fact to store.
    if (error instanceof EgressBlockedError) return blank(error.message);
    const responseTimeMs = elapsedSince(startedAt);
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return {
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: `Timed out after ${ctx.timeoutMs}ms`,
      };
    }
    return {
      facts: { responseTimeMs },
      responseTimeMs,
      statusCode: null,
      error: transportMessage(error),
    };
  }
}

/**
 * The health path appended to the operator's base URL.
 *
 * Appended rather than resolved with `new URL(path, base)`: a management
 * UI behind a reverse proxy is routinely mounted under a prefix
 * (`https://ops.example.com/rabbitmq`), and resolving an absolute path
 * against it would throw that prefix away and ask the proxy's root for a
 * RabbitMQ endpoint it has never heard of.
 */
export function healthUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}${RABBITMQ_HEALTH_PATH}`;
}

function requestHeaders(config: RabbitmqConfig): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "vigil-monitor/1.0 (+https://github.com)",
  };
  // Basic carries one `user:password` field, so there is nothing to send
  // without a user name — `rabbitmqStoredSchema` refuses that pairing,
  // and this is the second line for a config blob written by hand.
  if (config.username !== null) {
    const credential = `${config.username}:${config.password ?? ""}`;
    headers.authorization = `Basic ${Buffer.from(credential, "utf8").toString("base64")}`;
  }
  return headers;
}

/**
 * Turns one response into facts. Pure, and exported, because reading the
 * answer is the whole check — the request around it is plumbing.
 *
 * The 200/503 split is the endpoint's documented contract, and the body
 * is read as well rather than instead: a proxy that rewrites the status
 * code cannot also rewrite `{"status":"failed"}`, and the node's own
 * `reason` is the only part of this an operator can act on.
 */
export function healthResult(
  statusCode: number,
  body: string,
  responseTimeMs: number,
): ProbeResult {
  // Neither of these is a statement about the broker, so neither may be
  // judged as one. `unavailable` reads as `misconfigured`: Vigil is
  // saying it could not make the measurement, which is the truth.
  if (statusCode === 401 || statusCode === 403) {
    return unavailable(
      "The management API refused the stored credentials. Give this monitor a user with the monitoring tag.",
      statusCode,
      responseTimeMs,
    );
  }
  if (statusCode === 404) {
    return unavailable(
      `No health check at ${RABBITMQ_HEALTH_PATH}. The management plugin is disabled, this is not its base URL, or the node predates RabbitMQ 3.8.4.`,
      statusCode,
      responseTimeMs,
    );
  }

  const document = parseDocument(body);

  if (statusCode === 200) {
    if (document === null || typeof document.status !== "string") {
      // Something answered 200 at the health path and it was not this
      // API. Reporting that as `up` is the false green this branch
      // exists to prevent; reporting it as `down` would invent an outage
      // out of a URL somebody mistyped.
      return unavailable(
        "The management API answered 200, but not with a health-check result. Check that this is the management plugin's base URL.",
        statusCode,
        responseTimeMs,
      );
    }
    return document.status === "ok"
      ? {
          facts: {
            statusCode,
            alarmsClear: true,
            alarmReason: null,
            responseTimeMs,
          },
          responseTimeMs,
          statusCode,
          error: null,
        }
      : failed(
          statusCode,
          reasonOf(document) ?? document.status,
          responseTimeMs,
        );
  }

  if (statusCode === 503) {
    return failed(
      statusCode,
      reasonOf(document) ?? "the node did not say why",
      responseTimeMs,
    );
  }

  // Every other code is the management plugin or something in front of
  // it talking about itself. It is recorded as a fact and the declared
  // assertion decides what it means — the probe does not judge.
  return {
    facts: {
      statusCode,
      alarmsClear: null,
      alarmReason: null,
      responseTimeMs,
    },
    responseTimeMs,
    statusCode,
    error: null,
  };
}

function failed(
  statusCode: number,
  reason: string,
  responseTimeMs: number,
): ProbeResult {
  return {
    facts: {
      statusCode,
      alarmsClear: false,
      // Never the empty string: the assertion treats an empty reason as
      // "nothing to say" and would pass a node that just told us it is
      // unhealthy.
      alarmReason: summarise(reason) || "the node did not say why",
      responseTimeMs,
    },
    responseTimeMs,
    statusCode,
    error: null,
  };
}

/**
 * The probe could not make the measurement here. The status code is
 * still recorded — it is the one fact that explains the message.
 */
function unavailable(
  message: string,
  statusCode: number,
  responseTimeMs: number,
): ProbeResult {
  return {
    facts: { statusCode, responseTimeMs },
    responseTimeMs,
    statusCode,
    error: null,
    unavailable: message,
  };
}

interface HealthDocument {
  status?: unknown;
  reason?: unknown;
}

function parseDocument(body: string): HealthDocument | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as HealthDocument)
      : null;
  } catch {
    return null;
  }
}

function reasonOf(document: HealthDocument | null): string | null {
  const reason = document?.reason;
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}

/** Reads up to `maxBytes` of the body as text, then stops the download. */
async function readCappedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/**
 * The node's own words, kept short and printable. This lands in the
 * ledger and in an incident email, and the far end chose every byte.
 */
function summarise(reason: string): string {
  const printable = reason.replace(/[^\x20-\x7e]/g, " ").trim();
  return printable.length > MAX_REASON_CHARS
    ? `${printable.slice(0, MAX_REASON_CHARS)}…`
    : printable;
}

/**
 * `fetch` reports every transport failure as a TypeError carrying the
 * real error as its cause, and that cause is the sentence worth showing.
 */
function transportMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.cause instanceof Error && error.cause.message) {
      return error.cause.message;
    }
    if (error.message) return error.message;
  }
  return "The request failed";
}

function blank(error: string): ProbeResult {
  return { facts: {}, responseTimeMs: null, statusCode: null, error };
}
