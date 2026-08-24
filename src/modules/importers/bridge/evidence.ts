import {
  ProviderApiError,
  ProviderTransport,
  type Fetcher,
  type TransportOptions,
} from "../transport";
import { arr, obj, str, type Json } from "../providers/json";

/**
 * The read-only Better Stack evidence client.
 *
 * The one-time importer reads an account's configuration; the bridge
 * also has to read its history, because the cutover report compares
 * outcomes, not settings. Everything here is a GET against the Uptime
 * API and nothing else: the bridge's whole trust posture is that it
 * cannot mutate the system being migrated from, and the narrowest way
 * to keep that promise is a client with no method that could.
 *
 * Incidents live under `/api/v3` while everything the importer reads
 * lives under `/api/v2`, so this module's base is the `/api` root and
 * the version is part of each path. Incident pagination also differs
 * from the rest of the API: 50 per page is the documented maximum,
 * against 250 elsewhere.
 */

const API_ROOT = "https://uptime.betterstack.com/api";

/** The incidents API's own page-size ceiling, not the general one. */
const INCIDENTS_PER_PAGE = 50;

/**
 * One incident as the source system tells it, reduced to the fields the
 * comparison needs. Deliberately not the whole payload: an incident's
 * `response_content` is the customer's page body and has no business in
 * a second database, and `screenshot_url` is a link into an account the
 * bridge should not be re-serving.
 */
export interface SourceIncident {
  /** Better Stack's own id, verbatim. */
  id: string;
  /** `monitor`, `heartbeat`, or whatever resource kind answered. */
  resourceType: string | null;
  /** The id of that resource, in the source's id space. */
  resourceId: string | null;
  cause: string | null;
  /** Verbatim status word; Better Stack capitalises: `Started`, `Resolved`. */
  status: string;
  startedAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
}

/**
 * A UTC calendar date, because that is the only granularity the
 * incidents list accepts for its `from`/`to` filters.
 */
export function utcDateString(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function dateOf(value: Json): Date | null {
  const text = str(value);
  if (text === undefined) return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The monitor or heartbeat an incident is about, from its JSON:API
 * `relationships` block. Better Stack does not put a flat `monitor_id`
 * on the incident; the linkage lives in `relationships.<kind>.data`.
 */
function resourceOf(row: Record<string, Json>): {
  resourceType: string | null;
  resourceId: string | null;
} {
  const relationships = obj(row.relationships);
  for (const kind of Object.keys(relationships)) {
    const data = obj(obj(relationships[kind]).data);
    const id = str(data.id);
    if (id !== undefined) {
      return { resourceType: str(data.type) ?? kind, resourceId: id };
    }
  }
  return { resourceType: null, resourceId: null };
}

function toIncident(row: Record<string, Json>): SourceIncident | null {
  const id = str(row.id);
  const attributes = obj(row.attributes);
  const startedAt = dateOf(attributes.started_at);
  // An incident with no id or no start is not something the comparison
  // can hold anywhere; skipping the row is the only honest option, and
  // the poll's request count still records that the read happened.
  if (id === undefined || startedAt === null) return null;
  return {
    id,
    ...resourceOf(row),
    cause: str(attributes.cause) ?? null,
    status: str(attributes.status) ?? "unknown",
    startedAt,
    acknowledgedAt: dateOf(attributes.acknowledged_at),
    resolvedAt: dateOf(attributes.resolved_at),
  };
}

export interface EvidenceRead {
  incidents: SourceIncident[];
  requestCount: number;
  /**
   * Rows the source returned that could not be read (no id, or a start
   * that is not a timestamp). One malformed row is the vendor's bug; a
   * page of them is a format change that has silently blinded the
   * feed, and the caller must not record such a poll as coverage.
   */
  skipped: number;
}

export interface EvidenceClientOptions {
  transport?: TransportOptions;
}

/** The transport for one evidence read. The token never leaves it. */
function evidenceTransport(
  token: string,
  options: EvidenceClientOptions,
): ProviderTransport {
  return new ProviderTransport(
    API_ROOT,
    {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    { ...(options.transport ?? {}) },
  );
}

async function readIncidentPages(
  transport: ProviderTransport,
  query: Readonly<Record<string, string | number>>,
): Promise<{ incidents: SourceIncident[]; skipped: number }> {
  const incidents: SourceIncident[] = [];
  let skipped = 0;
  let page = 1;
  for (;;) {
    const response = await transport.json<{ data?: Json; pagination?: Json }>(
      "/v3/incidents",
      { ...query, page, per_page: INCIDENTS_PER_PAGE },
    );
    for (const row of arr(response.data)) {
      const incident = toIncident(obj(row));
      if (incident !== null) incidents.push(incident);
      else skipped += 1;
    }
    const next = str(obj(response.pagination).next);
    if (next === undefined) break;
    page += 1;
  }
  return { incidents, skipped };
}

/**
 * Every incident the source holds for a date window, resolved and
 * unresolved alike - the API returns both when neither filter is set,
 * which is exactly what history reconstruction needs.
 *
 * `from`/`to` are inclusive UTC dates. The caller overlaps consecutive
 * windows by a day, because a date boundary in an unstated timezone is
 * exactly the kind of edge that quietly loses the one incident that
 * mattered.
 */
export async function readIncidentsWindow(
  token: string,
  from: Date,
  to: Date,
  options: EvidenceClientOptions = {},
): Promise<EvidenceRead> {
  const transport = evidenceTransport(token, options);
  const { incidents, skipped } = await readIncidentPages(transport, {
    from: utcDateString(from),
    to: utcDateString(to),
  });
  return { incidents, requestCount: transport.requestCount, skipped };
}

/**
 * Every incident the source still considers open, with no date bound.
 *
 * Asked on every poll in addition to the window, because an incident
 * that opened before the bridge existed and is still open is evidence
 * the window query cannot see, and its eventual resolution has to be
 * observed to compare recovery at all.
 */
export async function readOpenIncidents(
  token: string,
  options: EvidenceClientOptions = {},
): Promise<EvidenceRead> {
  const transport = evidenceTransport(token, options);
  const { incidents, skipped } = await readIncidentPages(transport, {
    resolved: "false",
  });
  return { incidents, requestCount: transport.requestCount, skipped };
}

/**
 * One incident by id, or null when the source no longer has it.
 *
 * The list feeds cannot finish a long story: the window query filters
 * by START date, so an incident that opened days ago and resolved
 * today is in neither the open sweep (it resolved) nor the window (it
 * did not start there). The poller asks after every stored copy that
 * is still open but absent from both feeds, one request each, so a
 * multi-day outage's resolution is observed rather than lost - and a
 * copy the source deleted stays exactly as last seen, which the
 * comparison reads as "end never observed" rather than "still open".
 */
export async function readIncidentById(
  token: string,
  id: string,
  options: EvidenceClientOptions = {},
): Promise<{ incident: SourceIncident | null; requestCount: number }> {
  const transport = evidenceTransport(token, options);
  try {
    const response = await transport.json<{ data?: Json }>(
      `/v3/incidents/${encodeURIComponent(id)}`,
    );
    return {
      incident: toIncident(obj(response.data)),
      requestCount: transport.requestCount,
    };
  } catch (error) {
    if (error instanceof ProviderApiError && error.status === 404) {
      return { incident: null, requestCount: transport.requestCount };
    }
    throw error;
  }
}

/**
 * A cheap authenticated read that proves the token works: the first
 * page of monitors, one request. Used at connect time so a mistyped
 * token is a form error now rather than a failed poll tonight.
 */
export async function verifyToken(
  token: string,
  options: EvidenceClientOptions = {},
): Promise<{ monitorCount: number }> {
  const transport = evidenceTransport(token, options);
  const response = await transport.json<{ data?: Json }>("/v2/monitors", {
    per_page: 1,
  });
  return { monitorCount: arr(response.data).length };
}

/**
 * Whether a token can see one specific record this bridge has mapped.
 *
 * Reconnection's identity check: a replacement token that merely WORKS
 * is not enough, because a token from a different Better Stack account
 * also works, and that account's incident ids are plain integers that
 * can collide with the stored mapping and fabricate comparison rows.
 * Asking for a record the bridge already knows pins the account: only
 * a token for the same data can answer 200 for it.
 */
export async function sourceHasRecord(
  token: string,
  sourceId: string,
  options: EvidenceClientOptions = {},
): Promise<boolean> {
  const transport = evidenceTransport(token, options);
  const heartbeat = sourceId.startsWith("heartbeat:");
  const bare = heartbeat ? sourceId.slice("heartbeat:".length) : sourceId;
  const path = heartbeat
    ? `/v2/heartbeats/${encodeURIComponent(bare)}`
    : `/v2/monitors/${encodeURIComponent(bare)}`;
  try {
    await transport.json<{ data?: Json }>(path);
    return true;
  } catch (error) {
    if (error instanceof ProviderApiError && error.status === 404) {
      return false;
    }
    throw error;
  }
}

/**
 * The test seam: when `VIGIL_BETTERSTACK_TEST_BASE` is set, every
 * Better Stack request - the bridge's evidence reads and the adapter's
 * import read alike - is sent to that base instead of the real API,
 * with the path preserved.
 *
 * This exists for the end-to-end proof and for local development
 * against a stub, and it deliberately changes no production code path:
 * unset, this function returns undefined and the ordinary transport
 * fetches the real host over https. The variable is read from the
 * environment the server was started with, never from any form, so it
 * is an operator's own deployment choice, like pointing a proxy.
 */
export function betterStackTestFetcher(): Fetcher | undefined {
  const base = process.env.VIGIL_BETTERSTACK_TEST_BASE;
  if (base === undefined || base.trim().length === 0) return undefined;
  const stub = base.trim().replace(/\/+$/, "");
  return async (request) => {
    const url = new URL(request.url);
    const target = `${stub}${url.pathname.replace(/^\/api/, "")}${url.search}`;
    const response = await fetch(target, {
      method: request.method ?? "GET",
      headers: request.headers as Record<string, string> | undefined,
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, headerName) => {
      headers[headerName.toLowerCase()] = value;
    });
    return { status: response.status, headers, body: await response.text() };
  };
}
