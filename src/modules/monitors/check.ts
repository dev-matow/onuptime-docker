import dns from "node:dns/promises";

import { isPrivateAddress } from "./net";

export interface CheckTarget {
  url: string;
  method: "GET" | "HEAD";
  timeoutMs: number;
  degradedThresholdMs: number;
  expectedStatusCode: number | null;
  /** Substring the response body must contain (or must not — see below). */
  bodyKeyword?: string | null;
  /** When true, the keyword must be ABSENT for the check to pass. */
  keywordAbsent?: boolean;
}

/**
 * Cap on how much of a response body we read for a keyword assertion.
 * Bounds worker memory against a hostile or huge response; a health
 * endpoint's keyword appears far inside this window.
 */
const MAX_KEYWORD_BODY_BYTES = 1_000_000;

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
 * Applies a keyword/content assertion to a body. Pure so it is unit
 * tested directly. Returns null when the assertion holds, or an error
 * string when it fails.
 */
export function evaluateKeyword(
  keyword: string,
  absent: boolean,
  body: string,
): string | null {
  const present = body.includes(keyword);
  if (absent) {
    return present ? `Body unexpectedly contains "${keyword}"` : null;
  }
  return present ? null : `Body does not contain "${keyword}"`;
}

export interface CheckOutcome {
  ok: boolean;
  degraded: boolean;
  statusCode: number | null;
  responseTimeMs: number | null;
  error: string | null;
}

export interface CheckOptions {
  /** Permit private/loopback targets (development only). */
  allowPrivateTargets?: boolean;
  fetchImpl?: typeof fetch;
}

export function evaluateResponse(
  target: Pick<CheckTarget, "expectedStatusCode" | "degradedThresholdMs">,
  statusCode: number,
  responseTimeMs: number,
): Pick<CheckOutcome, "ok" | "degraded"> {
  const ok =
    target.expectedStatusCode !== null
      ? statusCode === target.expectedStatusCode
      : statusCode >= 200 && statusCode <= 399;
  return { ok, degraded: ok && responseTimeMs > target.degradedThresholdMs };
}

/**
 * One HTTP probe. Resolves DNS first and refuses targets that point
 * into private address space — a domain-validated URL can still resolve
 * to 10.0.0.1. (Known limit: the subsequent fetch re-resolves, so a
 * rebinding DNS server could still flip records between the two
 * lookups; production hardening would pin the resolved IP or route
 * probes through an egress proxy.)
 */
export async function performHttpCheck(
  target: CheckTarget,
  options: CheckOptions = {},
): Promise<CheckOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { hostname } = new URL(target.url);

  if (!options.allowPrivateTargets) {
    try {
      const addresses = await dns.lookup(hostname, { all: true });
      if (addresses.some(({ address }) => isPrivateAddress(address))) {
        return failure("Target resolves to a private address");
      }
    } catch {
      return failure("DNS resolution failed");
    }
  }

  const startedAt = performance.now();
  try {
    const response = await fetchImpl(target.url, {
      method: target.method,
      redirect: "follow",
      signal: AbortSignal.timeout(target.timeoutMs),
      headers: { "user-agent": "vigil-monitor/1.0 (+https://github.com)" },
    });

    // A keyword assertion needs the body (GET only); otherwise drain and
    // discard so keep-alive sockets are reusable.
    const wantsKeyword = Boolean(target.bodyKeyword) && target.method === "GET";
    let body = "";
    if (wantsKeyword) {
      body = await readCappedText(response, MAX_KEYWORD_BODY_BYTES).catch(
        () => "",
      );
    } else {
      await response.arrayBuffer().catch(() => undefined);
    }

    const responseTimeMs = Math.round(performance.now() - startedAt);
    const { ok: statusOk, degraded } = evaluateResponse(
      target,
      response.status,
      responseTimeMs,
    );

    // Status must pass first; then the keyword assertion (if any). A
    // keyword failure is a hard down, not degraded.
    const keywordError =
      statusOk && wantsKeyword
        ? evaluateKeyword(
            target.bodyKeyword!,
            target.keywordAbsent ?? false,
            body,
          )
        : null;
    const ok = statusOk && keywordError === null;

    return {
      ok,
      degraded: ok && degraded,
      statusCode: response.status,
      responseTimeMs,
      error: !statusOk ? `Unexpected status ${response.status}` : keywordError,
    };
  } catch (error) {
    const responseTimeMs = Math.round(performance.now() - startedAt);
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return {
        ...failure(`Timed out after ${target.timeoutMs}ms`),
        responseTimeMs,
      };
    }
    const message =
      error instanceof Error
        ? error.cause instanceof Error
          ? error.cause.message
          : error.message
        : "Request failed";
    return { ...failure(message), responseTimeMs };
  }
}

function failure(error: string): CheckOutcome {
  return {
    ok: false,
    degraded: false,
    statusCode: null,
    responseTimeMs: null,
    error,
  };
}
