import { EgressBlockedError, egressFetch } from "../../egress";
import type { FactBag, ProbeContext, ProbeResult } from "../contract";
import type { ElasticsearchConfig } from "../specs/elasticsearch";
import { elapsedSince, monitorEgress } from "./guard";

/**
 * One GET of `_cluster/health`.
 *
 * Through `modules/monitors/egress.ts` like every other HTTP-family
 * probe, and not merely out of consistency: this one sends an
 * `Authorization` header, so an unvalidated redirect would hand a
 * cluster credential to whatever host the redirect named. The egress
 * module validates every hop and strips origin-bound headers when a hop
 * crosses origins; a probe that called `fetch` directly would do
 * neither.
 *
 * The cluster's answer is recorded as facts and judged by the spec's
 * assertions. In particular a red cluster is not an error here — it is
 * a successful measurement of a bad state, which is the distinction
 * that lets the same reading be re-judged later against a different
 * threshold.
 */

/**
 * A health document is a few hundred bytes. The cap is protection
 * against whatever else might answer on this URL — a proxy error page,
 * an SSO login screen — not a limit any cluster approaches.
 */
const MAX_BODY_BYTES = 256 * 1024;

/** How much of an unexpected status string is kept as a fact. */
const MAX_STATUS_CHARS = 40;

/** How much of the cluster name is kept. Names are short; peers lie. */
const MAX_NAME_CHARS = 120;

/**
 * The health endpoint for a cluster base URL, or null when the target
 * will not parse.
 *
 * The path is *appended* rather than resolved: `new URL("_cluster/health",
 * base)` replaces the last segment, so a cluster published behind
 * `https://example.com/search` would be asked `https://example.com/_cluster/health`
 * — a 404 from someone else's application, reported as an Elasticsearch
 * outage. Any query string on the target is dropped: the base URL of a
 * cluster has no parameters, and carrying one into the health request
 * would let a typo change what is being asked.
 */
export function clusterHealthUrl(target: string): URL | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/_cluster/health`;
  url.search = "";
  url.hash = "";
  return url;
}

/**
 * The `Authorization` header this monitor's credentials produce, or null
 * when it has none.
 *
 * The API key wins if both are somehow present. The stored schema
 * refuses that combination, but a row can predate the schema or survive
 * a downgrade, and "whichever the code happened to write last" is not a
 * rule anyone can reason about.
 */
export function authorizationHeader(
  config: ElasticsearchConfig,
): string | null {
  if (config.apiKey !== null) return `ApiKey ${config.apiKey}`;
  if (config.username === null || config.password === null) return null;
  const basic = Buffer.from(
    `${config.username}:${config.password}`,
    "utf8",
  ).toString("base64");
  return `Basic ${basic}`;
}

function printable(value: string, max: number): string {
  const clean = value.replace(/\p{Cc}/gu, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The health document's own numbers, as facts. Pure, and exported,
 * because reading the answer is the whole check — the request around it
 * is plumbing.
 *
 * The colour is recorded exactly as the cluster reported it, including
 * a value that is not one of the three Elasticsearch defines. Deciding
 * here that an unrecognised colour is "not a health document" would
 * throw away the one piece of evidence an operator needs to work out
 * what is actually answering on that URL; the assertion says what it
 * means, and this says what it was.
 */
export function healthFacts(document: unknown): FactBag {
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document)
  ) {
    return {};
  }
  const record = document as Record<string, unknown>;
  const facts: FactBag = {};

  if (typeof record.status === "string") {
    facts.clusterStatus = printable(record.status, MAX_STATUS_CHARS);
  }
  if (typeof record.cluster_name === "string") {
    facts.clusterName = printable(record.cluster_name, MAX_NAME_CHARS);
  }

  const nodes = numberField(record, "number_of_nodes");
  if (nodes !== null) facts.nodeCount = nodes;

  const unassigned = numberField(record, "unassigned_shards");
  if (unassigned !== null) facts.unassignedShards = unassigned;

  const active = numberField(record, "active_shards_percent_as_number");
  // One decimal, because the raw value is a float with sixteen of them
  // and a timeline reading "66.66666666666667%" is a number nobody can
  // compare to the last one at a glance.
  if (active !== null) facts.activeShardsPercent = Math.round(active * 10) / 10;

  return facts;
}

export async function elasticsearchProbe(
  ctx: ProbeContext<ElasticsearchConfig>,
): Promise<ProbeResult> {
  const url = clusterHealthUrl(ctx.target);
  // The target schema rejects this already, but a row can predate the
  // schema or survive a downgrade, and a `TypeError` escaping the probe
  // on the worker's hot path is a check that never reports at all.
  if (url === null) return blank("Invalid cluster URL");

  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "vigil-monitor/1.0 (+https://github.com)",
  };
  const authorization = authorizationHeader(ctx.config);
  if (authorization !== null) headers.authorization = authorization;

  const startedAt = performance.now();
  try {
    const { response } = await egressFetch(
      url.toString(),
      { method: "GET", signal: AbortSignal.timeout(ctx.timeoutMs), headers },
      monitorEgress(ctx),
    );

    // Read inside the try, uncaught: a body that stops arriving mid-read
    // is a transport failure, and swallowing it would hand the parser an
    // empty string and report a network problem as "not a health
    // document".
    const body = await readCappedText(response, MAX_BODY_BYTES);
    const responseTimeMs = elapsedSince(startedAt);
    const measured = { statusCode: response.status, responseTimeMs };

    // A credential the operator has to fix must never be
    // indistinguishable from an outage — the cluster is up, answering,
    // and refusing *us*. `misconfigured`, not `down`.
    if (response.status === 401) {
      return {
        facts: measured,
        responseTimeMs,
        statusCode: response.status,
        error: null,
        unavailable: "Elasticsearch refused the stored credentials (401)",
      };
    }
    if (response.status === 403) {
      return {
        facts: measured,
        responseTimeMs,
        statusCode: response.status,
        error: null,
        unavailable:
          "The stored credentials may not read cluster health (403). The `monitor` cluster privilege is what this check needs.",
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // No colour is recorded, and the `cluster-status` assertion reads
      // that absence as "whatever answered was not a cluster". Emitting
      // a false colour here would be a probe deciding the verdict.
      return {
        facts: measured,
        responseTimeMs,
        statusCode: response.status,
        error: null,
      };
    }

    return {
      facts: { ...measured, ...healthFacts(parsed) },
      responseTimeMs,
      statusCode: response.status,
      error: null,
    };
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

function blank(error: string): ProbeResult {
  return { facts: {}, responseTimeMs: null, statusCode: null, error };
}
