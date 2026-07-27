import type { ProbeContext, ProbeResult } from "../contract";
import type { JsonQueryConfig } from "../specs/json-query";
import { elapsedSince, refusesPrivate } from "./guard";

/**
 * Fetch a JSON endpoint, read one value out of the body and compare it
 * to what the operator expects.
 *
 * The difference from `http` is which part of the response is the
 * evidence. A status code says the server is answering; `{"status":"ok",
 * "db":{"connected":true}}` says the thing behind it is actually working,
 * which is the question a health endpoint was published to answer.
 */

/**
 * Cap on how much of a response body is read. Same bound and same reason
 * as the keyword read in `http`: an unbounded read lets one hostile or
 * accidentally enormous endpoint exhaust the worker, and a health
 * document is orders of magnitude inside this window.
 */
const MAX_JSON_BODY_BYTES = 1_000_000;

/** How much of the resolved value is kept as a fact. */
const MAX_VALUE_CHARS = 200;

export async function jsonQueryProbe(
  ctx: ProbeContext<JsonQueryConfig>,
): Promise<ProbeResult> {
  let hostname: string;
  try {
    ({ hostname } = new URL(ctx.target));
  } catch {
    return blank("Invalid URL");
  }

  const guard = await refusesPrivate(hostname, ctx.allowPrivateTargets);
  if (guard) return blank(guard);

  const startedAt = performance.now();
  try {
    const response = await ctx.fetchImpl(ctx.target, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(ctx.timeoutMs),
      headers: {
        accept: "application/json",
        "user-agent": "vigil-monitor/1.0 (+https://github.com)",
      },
    });

    // Read inside the try, uncaught: a body that stops arriving mid-read
    // is a transport failure, and swallowing it would hand the parser an
    // empty string and report a network problem as "not valid JSON".
    const body = await readCappedText(response, MAX_JSON_BODY_BYTES);
    const responseTimeMs = elapsedSince(startedAt);

    // A non-2xx is not automatically a failure here. An endpoint that
    // answers 503 with {"status":"draining","db":{"connected":true}} is
    // saying precisely what this check exists to read, and refusing to
    // parse it would throw the evidence away. The status is recorded as
    // a fact; the declared assertions decide what it means.
    const measured = { statusCode: response.status, responseTimeMs };

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // The remaining facts are omitted rather than set false: there is
      // no path to look for in a body that never parsed, and emitting
      // `pathFound: false` here would fire a second assertion about a
      // consequence of the one already failing.
      return {
        facts: { ...measured, jsonValid: false },
        responseTimeMs,
        statusCode: response.status,
        error: null,
      };
    }

    const resolved = resolvePath(parsed, ctx.config.jsonPath);
    if (!resolved.found) {
      return {
        facts: {
          ...measured,
          jsonValid: true,
          pathFound: false,
          actualValue: null,
          matches: false,
        },
        responseTimeMs,
        statusCode: response.status,
        error: null,
      };
    }

    // The comparison runs on the truncated string, which is also the
    // string the assertion reads, so the fact and the message it prints
    // can never disagree. Truncation cannot create a false match either:
    // a value long enough to be cut carries the ellipsis and so exceeds
    // the 200-character bound on `expectedValue`.
    const actualValue = truncate(stringifyValue(resolved.value));
    return {
      facts: {
        ...measured,
        jsonValid: true,
        pathFound: true,
        actualValue,
        matches: actualValue === ctx.config.expectedValue,
      },
      responseTimeMs,
      statusCode: response.status,
      error: null,
    };
  } catch (error) {
    const responseTimeMs = elapsedSince(startedAt);
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return {
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: `Timed out after ${ctx.timeoutMs}ms`,
      };
    }
    const message =
      error instanceof Error
        ? error.cause instanceof Error
          ? error.cause.message
          : error.message
        : "Request failed";
    return {
      facts: { responseTimeMs },
      responseTimeMs,
      statusCode: null,
      error: message,
    };
  }
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

type PathToken = string | number;

interface Resolution {
  /** False when nothing lives at the path — distinct from a `null` value. */
  found: boolean;
  value: unknown;
}

const NOT_FOUND: Resolution = { found: false, value: undefined };

/**
 * The path syntax: `a.b.c` and `a.items[0].name`, and nothing else.
 *
 * Not JSONPath. The full grammar — `$`, wildcards, recursive descent,
 * filter expressions — is a dependency, and it buys a feature nobody
 * monitoring a health endpoint asked for: the value being watched sits
 * at a known, fixed place, which is what makes it worth alerting on. A
 * dotted path with array indices covers that in thirty lines and no
 * megabytes.
 *
 * Returns null for a path that is not well formed (`a..b`, `a.`), which
 * the caller reports the same way as a path that simply is not there —
 * both mean "this monitor is watching something that does not exist".
 */
function parsePath(path: string): PathToken[] | null {
  const tokens: PathToken[] = [];
  for (const segment of path.split(".")) {
    const parts = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
    if (!parts) return null;
    const [, key = "", indices = ""] = parts;
    if (key.length === 0 && indices.length === 0) return null;
    if (key.length > 0) tokens.push(key);
    for (const index of indices.matchAll(/\[(\d+)\]/g)) {
      tokens.push(Number(index[1]));
    }
  }
  return tokens.length > 0 ? tokens : null;
}

function resolvePath(root: unknown, path: string): Resolution {
  const tokens = parsePath(path);
  if (tokens === null) return NOT_FOUND;

  let current: unknown = root;
  for (const token of tokens) {
    if (typeof token === "number") {
      if (!Array.isArray(current) || token >= current.length) return NOT_FOUND;
      current = current[token];
      continue;
    }
    if (current === null || typeof current !== "object") return NOT_FOUND;
    // A string key is refused against an array on purpose: `items.length`
    // would otherwise resolve, and every JS-intrinsic property would
    // become monitorable data the endpoint never sent.
    if (Array.isArray(current)) return NOT_FOUND;
    // `hasOwnProperty`, not a truthiness test: `false`, `0`, `""` and
    // `null` are all values a health endpoint legitimately publishes, and
    // "the key is absent" has to stay distinguishable from all of them.
    if (!Object.prototype.hasOwnProperty.call(current, token)) return NOT_FOUND;
    current = (current as Record<string, unknown>)[token];
  }
  return { found: true, value: current };
}

/**
 * The resolved value as the string the expectation is compared against.
 * Objects and arrays are re-serialised rather than coerced, so a path
 * that lands on a subtree shows what is there instead of
 * "[object Object]".
 */
function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value) ?? "";
}

function truncate(value: string): string {
  return value.length <= MAX_VALUE_CHARS
    ? value
    : `${value.slice(0, MAX_VALUE_CHARS)}…`;
}

function blank(error: string): ProbeResult {
  return { facts: {}, responseTimeMs: null, statusCode: null, error };
}
