import { EgressBlockedError, egressFetch } from "../../egress";
import type { ProbeContext, ProbeResult } from "../contract";
import type { GlobalpingConfig } from "../specs/globalping";
import { elapsedSince, monitorEgress } from "./guard";

/**
 * A ping run from somewhere else, through the Globalping API.
 *
 * Two requests: create the measurement, then poll it until the probes
 * report. The API is asynchronous by nature — it is dispatching work to
 * machines in other countries — so there is no single call that returns
 * a result, and pretending otherwise would mean holding a connection
 * open for the length of an ICMP run in São Paulo.
 *
 * Two rules govern what becomes a verdict:
 *
 * 1. **The API failing is never the target failing.** A spent quota, a
 *    rejected token, a location no probe matches, an API outage: none of
 *    them measured anything, so all of them report `misconfigured` with
 *    the reason. This is the whole reason the type is worth building
 *    carefully — a 429 that read as `down` would page an on-call
 *    engineer, at 3am, about a service that is fine.
 * 2. **The measurement is the probes' round trip, not ours.** Vigil's
 *    own wall clock here measures an API call and says nothing about the
 *    target, so `responseTimeMs` is the mean RTT the probes reported.
 *    The degraded threshold is therefore about the target's latency as
 *    the world sees it, which is the only reading of it that makes sense.
 */

/** How often the measurement is polled while it is still running. */
const POLL_INTERVAL_MS = 500;

/** A measurement document is a few KB of JSON; an unbounded read is not. */
const MAX_BODY_BYTES = 1_000_000;

interface ProbeLocation {
  city?: unknown;
  country?: unknown;
  network?: unknown;
  continent?: unknown;
}

interface PingStats {
  avg?: unknown;
  loss?: unknown;
  rcv?: unknown;
}

interface MeasurementResult {
  probe?: ProbeLocation;
  result?: {
    status?: unknown;
    resolvedAddress?: unknown;
    stats?: PingStats;
  };
}

interface Measurement {
  id?: unknown;
  status?: unknown;
  results?: unknown;
}

export async function globalpingProbe(
  ctx: ProbeContext<GlobalpingConfig>,
): Promise<ProbeResult> {
  const base = ctx.config.apiBaseUrl.replace(/\/+$/, "");
  if (!URL.canParse(base)) {
    return unavailable(`The Globalping API base URL is not a URL: ${base}`);
  }

  const deadline = Date.now() + ctx.timeoutMs;
  const startedAt = performance.now();

  let created: Awaited<ReturnType<typeof createMeasurement>>;
  try {
    created = await createMeasurement(ctx, base, deadline);
  } catch (error) {
    return unavailable(apiUnreachable(error, base));
  }
  if (created.kind === "refused") return unavailable(created.reason);

  for (;;) {
    let polled: Awaited<ReturnType<typeof readMeasurement>>;
    try {
      polled = await readMeasurement(ctx, base, created.id, deadline);
    } catch (error) {
      return unavailable(apiUnreachable(error, base));
    }
    if (polled.kind === "refused") return unavailable(polled.reason);

    if (polled.measurement.status === "finished") {
      const summary = summarise(polled.measurement);
      if (summary === null) {
        // Finished with nothing in it. Globalping accepted the request
        // and no probe reported, which says nothing whatsoever about the
        // target — reporting it as unreachable would be an invention.
        return unavailable(
          `Globalping finished the measurement with no probe results for ${ctx.config.location}.`,
        );
      }
      return {
        facts: { ...summary, apiTimeMs: elapsedSince(startedAt) },
        responseTimeMs: summary.responseTimeMs,
        statusCode: null,
        error: null,
      };
    }

    if (Date.now() + POLL_INTERVAL_MS >= deadline) {
      return unavailable(
        `Globalping did not finish the measurement within ${ctx.timeoutMs}ms. Raise the monitor's timeout, or ask for fewer probes.`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** The API said no, and the sentence that says why to an operator. */
interface Refusal {
  kind: "refused";
  reason: string;
}

async function createMeasurement(
  ctx: ProbeContext<GlobalpingConfig>,
  base: string,
  deadline: number,
): Promise<{ kind: "created"; id: string } | Refusal> {
  const { response, body } = await call(
    ctx,
    `${base}/v1/measurements`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "ping",
        target: ctx.target,
        limit: ctx.config.probeLimit,
        // `magic` is the API's own free-form location filter — the same
        // string the CLI takes after `from`.
        locations: [{ magic: ctx.config.location }],
        measurementOptions: { packets: ctx.config.packets },
      }),
    },
    deadline,
  );

  if (response.status === 202 || response.status === 200) {
    const parsed = parseJson(body);
    const id =
      parsed !== null && typeof (parsed as Measurement).id === "string"
        ? ((parsed as Measurement).id as string)
        : null;
    return id === null
      ? {
          kind: "refused",
          reason: "Globalping accepted the measurement but returned no id.",
        }
      : { kind: "created", id };
  }

  return { kind: "refused", reason: creationRefusal(response, body, ctx) };
}

async function readMeasurement(
  ctx: ProbeContext<GlobalpingConfig>,
  base: string,
  id: string,
  deadline: number,
): Promise<{ kind: "polled"; measurement: Measurement } | Refusal> {
  const { response, body } = await call(
    ctx,
    `${base}/v1/measurements/${encodeURIComponent(id)}`,
    { method: "GET" },
    deadline,
  );

  if (response.status !== 200) {
    return {
      kind: "refused",
      reason: `Globalping answered ${response.status} for the measurement it had just accepted${apiDetail(body)}.`,
    };
  }
  const parsed = parseJson(body);
  if (parsed === null) {
    return {
      kind: "refused",
      reason: "Globalping returned a measurement that is not JSON.",
    };
  }
  return { kind: "polled", measurement: parsed as Measurement };
}

/** One guarded request, bounded by whatever is left of the check's budget. */
async function call(
  ctx: ProbeContext<GlobalpingConfig>,
  url: string,
  init: { method: "GET" | "POST"; body?: string },
  deadline: number,
): Promise<{ response: Response; body: string }> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "vigil-monitor/1.0",
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  // A header, not `?token=`: a query string reaches access logs, proxies
  // and error messages, and this one is a credential.
  if (ctx.config.apiToken !== null) {
    headers.authorization = `Bearer ${ctx.config.apiToken}`;
  }

  const { response } = await egressFetch(
    url,
    {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      // At least a moment, so the last poll before the deadline is a
      // request rather than an instant abort.
      signal: AbortSignal.timeout(Math.max(250, deadline - Date.now())),
    },
    monitorEgress(ctx),
  );
  return { response, body: await readCapped(response, MAX_BODY_BYTES) };
}

/**
 * Why a rejected measurement request is this install's problem rather
 * than the target's. Exported: this mapping is the type's whole claim to
 * never crying outage over a quota.
 */
export function creationRefusal(
  response: Pick<Response, "status" | "headers">,
  body: string,
  ctx: Pick<ProbeContext<GlobalpingConfig>, "config">,
): string {
  if (response.status === 429) {
    const reset = response.headers.get("x-ratelimit-reset");
    const when = reset === null ? "shortly" : `in ${reset}s`;
    return `Globalping's rate limit is spent; it resets ${when}. Add an API token to this monitor, or check less often.`;
  }
  if (response.status === 401 || response.status === 403) {
    return "Globalping rejected the API token on this monitor.";
  }
  if (response.status === 422) {
    return `No Globalping probe matches "${ctx.config.location}"${apiDetail(body)}.`;
  }
  if (response.status === 400) {
    return `Globalping refused the measurement${apiDetail(body)}.`;
  }
  return `Globalping answered ${response.status}${apiDetail(body)}.`;
}

/** The API's own explanation, when it sent one worth repeating. */
function apiDetail(body: string): string {
  const parsed = parseJson(body);
  if (parsed === null || typeof parsed !== "object") return "";
  const error = (parsed as { error?: { message?: unknown } }).error;
  const message = error?.message;
  return typeof message === "string" && message.length > 0
    ? `: ${message.length > 200 ? `${message.slice(0, 200)}…` : message}`
    : "";
}

export interface GlobalpingSummary {
  probesTotal: number;
  probesReachable: number;
  packetLossPct: number;
  worstProbe: string | null;
  resolvedAddress: string | null;
  responseTimeMs: number | null;
}

/**
 * The facts a finished measurement carries, or null when it carries
 * none. Pure and exported: everything this check concludes is decided
 * here, and the HTTP around it is plumbing.
 *
 * A probe whose own run failed counts as 100% loss rather than being
 * dropped from the average. Dropping it would let a target that is
 * unreachable from three continents report perfect health from the one
 * probe that happened to answer.
 */
export function summarise(measurement: Measurement): GlobalpingSummary | null {
  const results = Array.isArray(measurement.results)
    ? (measurement.results as MeasurementResult[])
    : [];
  if (results.length === 0) return null;

  let reachable = 0;
  let lossTotal = 0;
  let latencyTotal = 0;
  let latencyCount = 0;
  let resolvedAddress: string | null = null;
  let worst: { label: string; loss: number; latency: number } | null = null;

  for (const entry of results) {
    const stats = entry.result?.stats;
    const loss = numberOr(stats?.loss, 100);
    const received = numberOr(stats?.rcv, 0);
    const average = numberOr(stats?.avg, null);
    const finished = entry.result?.status === "finished";

    if (finished && received > 0) reachable += 1;
    lossTotal += finished ? loss : 100;
    if (finished && average !== null && received > 0) {
      latencyTotal += average;
      latencyCount += 1;
    }
    if (
      resolvedAddress === null &&
      typeof entry.result?.resolvedAddress === "string"
    ) {
      resolvedAddress = entry.result.resolvedAddress;
    }

    const label = describeProbe(entry.probe);
    const candidate = {
      label,
      loss: finished ? loss : 100,
      latency: average ?? Number.POSITIVE_INFINITY,
    };
    // Worst by loss first, then by latency: an operator reading one
    // probe name wants the one that could not reach the target, not the
    // slowest of the ones that could.
    if (
      worst === null ||
      candidate.loss > worst.loss ||
      (candidate.loss === worst.loss && candidate.latency > worst.latency)
    ) {
      worst = candidate;
    }
  }

  return {
    probesTotal: results.length,
    probesReachable: reachable,
    packetLossPct: Math.round(lossTotal / results.length),
    worstProbe: worst?.label ?? null,
    resolvedAddress,
    responseTimeMs:
      latencyCount === 0 ? null : Math.round(latencyTotal / latencyCount),
  };
}

/** "Frankfurt, DE (Hetzner)" — enough to act on, short enough for an alert. */
function describeProbe(probe: ProbeLocation | undefined): string {
  const city = typeof probe?.city === "string" ? probe.city : null;
  const country = typeof probe?.country === "string" ? probe.country : null;
  const network = typeof probe?.network === "string" ? probe.network : null;
  const place = [city, country].filter((part) => part !== null).join(", ");
  const where = place.length > 0 ? place : "an unnamed location";
  return network === null ? where : `${where} (${network})`;
}

function numberOr<T extends number | null>(
  value: unknown,
  fallback: T,
): number | T {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Reads up to `maxBytes` of the body as text, then stops the download. */
async function readCapped(
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

function apiUnreachable(error: unknown, base: string): string {
  if (error instanceof EgressBlockedError) {
    return `The Globalping API at ${base} cannot be reached: ${error.message}`;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return `The Globalping API at ${base} did not answer in time.`;
  }
  const message =
    error instanceof Error
      ? error.cause instanceof Error
        ? error.cause.message
        : error.message
      : "the request failed";
  return `The Globalping API at ${base} could not be reached: ${message}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Vigil could not find out. Every API-side failure lands here rather
 * than in `error`, because `error` means down and none of them are
 * evidence about the target.
 */
function unavailable(reason: string): ProbeResult {
  return {
    facts: {},
    responseTimeMs: null,
    statusCode: null,
    error: null,
    unavailable: reason,
  };
}
