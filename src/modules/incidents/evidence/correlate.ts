import { and, eq, gte, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { monitors } from "@/db/schema";
import { registrableDomain } from "@/modules/monitors/types/targets";

import { classifyStage, failureSignature } from "./classify";
import type {
  CorrelatedFailure,
  CorrelationSignal,
  CorrelationSignalKind,
  EvidenceStage,
} from "./types";

/**
 * "Is anything else broken for the same reason?"
 *
 * The honest version of a question every incident tool answers badly.
 * The dishonest version joins everything that failed in the same five
 * minutes, calls it a correlation and puts a percentage on it; the
 * operator then learns to ignore the panel, because in a fleet of two
 * hundred monitors something always fails in the same five minutes.
 *
 * So this asks for two things at once, and neither on its own is
 * enough:
 *
 * 1. **Time proximity.** The other monitor's failure run began within
 *    {@link CORRELATION_WINDOW_MS} of this one's. Failure runs, not
 *    incidents: a monitor with a twenty-minute failure window has not
 *    opened an incident yet and is still the best evidence available
 *    that a shared dependency is going.
 * 2. **At least one strong signal.** Same hostname, same registrable
 *    domain, same resolved address, same failure signature, or the same
 *    remote probe location. Two monitors failing at once with nothing
 *    in common are two failures, and saying otherwise is the noise this
 *    is built to avoid.
 *
 * Weak signals - same stage, same check type - are listed when they
 * hold, because they are useful reading once a strong signal has
 * already earned the row a place. They never earn one on their own.
 *
 * Every signal carries the value it matched on, so the reader can check
 * the claim rather than trust it. There is no score anywhere in this
 * file, and there is deliberately nowhere to put one.
 */

/** How far apart two failure runs may start and still be "at once". */
export const CORRELATION_WINDOW_MS = 10 * 60 * 1000;

/** The most rows a snapshot carries. Ordered, so the cap is the tail. */
export const MAX_CORRELATIONS = 10;

/**
 * How many failing monitors are examined before the ranking runs.
 *
 * A correlated outage can take a whole fleet down, and this query runs
 * inside the check loop of a system that is already having its worst
 * minute. The cap bounds the work; the ordering below makes which rows
 * survive it deterministic rather than whatever Postgres returned
 * first.
 */
const MAX_CANDIDATES = 50;

const STRONG: ReadonlySet<CorrelationSignalKind> = new Set([
  "same-host",
  "same-domain",
  "same-address",
  "same-signature",
  "same-probe-location",
]);

/**
 * Signatures that two unrelated monitors share every day.
 *
 * A shared signature is a strong signal because it is usually specific:
 * two targets both answering `ECONNREFUSED` at the same minute is worth
 * a line on an incident page. A timeout is not specific. It is the most
 * common failure a monitor has, it names no layer (see `classify.ts`)
 * and every slow endpoint in the fleet produces it - so counting it as
 * strong would relate every unrelated timeout to every other one, which
 * is precisely the noise this module exists to avoid. Written down as
 * data rather than left to the reader, because "both timed out" reads
 * like evidence right up until you check how often it is true.
 *
 * The signal is still LISTED when a genuinely strong one has already
 * earned the row: "same host, and both timed out" is a better sentence
 * than "same host".
 */
const GENERIC_SIGNATURES: ReadonlySet<string> = new Set([
  "TIMED_OUT",
  "ETIMEDOUT",
  "TIMEOUTERROR",
  "THE_OPERATION_WAS_ABORTED",
]);

/**
 * Whether this signal, with this value, can earn a row on its own.
 *
 * `HTTP_*` never does, and that is the same judgement as the timeout
 * rule above rather than a second one. A status code is a statement
 * about one endpoint's own opinion of one request: two unrelated
 * services both answering 503 during a busy hour is the single most
 * ordinary thing in a fleet, and relating them would put a confident
 * "these share a cause" on an incident page on the strength of a number
 * every overloaded app in the world returns. When two monitors really do
 * share a cause they share a host, a domain, an address or a probe
 * location as well, and the status then appears as the extra line it
 * deserves to be.
 */
function isStrong(signal: CorrelationSignal): boolean {
  if (!STRONG.has(signal.kind)) return false;
  if (signal.kind === "same-signature") {
    return (
      !GENERIC_SIGNATURES.has(signal.detail) &&
      !signal.detail.startsWith("HTTP_")
    );
  }
  return true;
}

/** One failing monitor, reduced to the facts a signal can be computed from. */
export interface CorrelationCandidate {
  monitorId: string;
  monitorName: string;
  checkType: string;
  host: string | null;
  addresses: readonly string[];
  firstFailureAt: Date | null;
  error: string | null;
  statusCode: number | null;
  failureClass: string | null;
  incidentId: string | null;
  /**
   * The remote probe locations that did NOT see this target healthy.
   *
   * Filled in by `probe-signal.ts`, which is commercial, so it is
   * permanently absent in Core and the signal simply never fires there.
   * Optional rather than an empty array for that reason: absent means
   * "this edition does not measure that", and an empty array would mean
   * "measured, and nothing matched".
   */
  probeLocations?: readonly string[];
}

export interface CorrelationSubject extends CorrelationCandidate {
  stage: EvidenceStage;
}

function sharedValue(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): string | null {
  if (!a || !b) return null;
  const set = new Set(b);
  // Sorted so two runs over the same data pick the same shared value
  // when there is more than one.
  for (const entry of [...a].sort()) {
    if (set.has(entry)) return entry;
  }
  return null;
}

/**
 * Why these two failures are being shown together, or an empty list
 * when they are not.
 *
 * Pure, and exported, because this is the part worth testing: the
 * queries around it are plumbing and this is the claim.
 */
export function signalsBetween(
  subject: CorrelationSubject,
  candidate: CorrelationCandidate,
): CorrelationSignal[] {
  const signals: CorrelationSignal[] = [];

  if (
    subject.host !== null &&
    candidate.host !== null &&
    subject.host === candidate.host
  ) {
    signals.push({ kind: "same-host", detail: subject.host });
  } else {
    const a = subject.host === null ? null : registrableDomain(subject.host);
    const b =
      candidate.host === null ? null : registrableDomain(candidate.host);
    if (a !== null && a === b) signals.push({ kind: "same-domain", detail: a });
  }

  const address = sharedValue(subject.addresses, candidate.addresses);
  if (address !== null) signals.push({ kind: "same-address", detail: address });

  const mine = failureSignature(subject);
  const theirs = failureSignature(candidate);
  // Null never matches null. "Neither of them said anything" is an
  // absence of evidence, and treating it as a match would relate every
  // silent failure in the fleet to every other one.
  if (mine !== null && mine === theirs) {
    signals.push({ kind: "same-signature", detail: mine });
  }

  const location = sharedValue(
    subject.probeLocations,
    candidate.probeLocations,
  );
  if (location !== null) {
    signals.push({ kind: "same-probe-location", detail: location });
  }

  // Weak from here down: listed, never sufficient.
  if (!signals.some(isStrong)) return [];

  const stage = classifyStage(candidate).stage;
  if (stage !== "unknown" && stage === subject.stage) {
    signals.push({ kind: "same-stage", detail: stage });
  }
  if (subject.checkType === candidate.checkType) {
    signals.push({ kind: "same-check-type", detail: subject.checkType });
  }
  // Strong first, and stable within each half. The reader gets the
  // reason this row is here before the colour commentary, and the UI
  // needs no ordering rule of its own.
  return [...signals.filter(isStrong), ...signals.filter((s) => !isStrong(s))];
}

/**
 * Ranks and caps. Strong signals first, then total signals, then the
 * earliest failure, then the id - so the list is a function of the data
 * and not of the order the database happened to return rows in.
 */
export function rankCorrelations(
  subject: CorrelationSubject,
  candidates: readonly CorrelationCandidate[],
): CorrelatedFailure[] {
  const scored: { row: CorrelatedFailure; strong: number; at: number }[] = [];
  for (const candidate of candidates) {
    const signals = signalsBetween(subject, candidate);
    if (signals.length === 0) continue;
    scored.push({
      row: {
        monitorId: candidate.monitorId,
        monitorName: candidate.monitorName,
        checkType: candidate.checkType,
        incidentId: candidate.incidentId,
        firstFailureAt: candidate.firstFailureAt?.toISOString() ?? null,
        signals,
      },
      strong: signals.filter(isStrong).length,
      at: candidate.firstFailureAt?.getTime() ?? Number.MAX_SAFE_INTEGER,
    });
  }

  scored.sort((a, b) => {
    if (a.strong !== b.strong) return b.strong - a.strong;
    if (a.row.signals.length !== b.row.signals.length) {
      return b.row.signals.length - a.row.signals.length;
    }
    if (a.at !== b.at) return a.at - b.at;
    return a.row.monitorId < b.row.monitorId ? -1 : 1;
  });

  return scored.slice(0, MAX_CORRELATIONS).map((entry) => entry.row);
}

/**
 * The failing monitors this tenant has right now, near this incident's
 * onset.
 *
 * Tenant-scoped inside the query, and that is not a formality: this is
 * a cross-monitor read run from a worker with no session, so the
 * organisation predicate is the only thing standing between an incident
 * page and another company's monitor names. It is stated on `monitors`
 * directly rather than joined in from the incident.
 *
 * Shadow monitors are excluded. A monitor running beside the system it
 * was migrated from is a second copy of a monitor that is already in
 * this list, so including it would report one outage twice - and shadow
 * mode's whole promise is that the fleet has no consequences elsewhere.
 */
export async function findCorrelationCandidates(
  db: DbClient,
  organizationId: string,
  monitorId: string,
  onsetAt: Date,
): Promise<CorrelationCandidate[]> {
  const from = new Date(onsetAt.getTime() - CORRELATION_WINDOW_MS);
  const until = new Date(onsetAt.getTime() + CORRELATION_WINDOW_MS);

  const rows = await db
    .select({
      id: monitors.id,
      name: monitors.name,
      checkType: monitors.checkType,
      url: monitors.url,
      firstFailureAt: monitors.firstFailureAt,
    })
    .from(monitors)
    .where(
      and(
        eq(monitors.organizationId, organizationId),
        ne(monitors.id, monitorId),
        eq(monitors.paused, false),
        isNull(monitors.shadowBridgeId),
        isNotNull(monitors.firstFailureAt),
        gte(monitors.firstFailureAt, from),
        lte(monitors.firstFailureAt, until),
      ),
    )
    .orderBy(monitors.firstFailureAt, monitors.id)
    .limit(MAX_CANDIDATES);

  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);

  // One row per monitor: its most recent observation, which is what the
  // signature and the stage are computed from. `distinct on` rather than
  // a query per monitor, because this runs on the check path and fifty
  // round trips there is fifty round trips during an outage.
  const latest = await db.execute<{
    monitor_id: string;
    error: string | null;
    status_code: number | null;
    failure_class: string | null;
  }>(sql`
    select distinct on (monitor_id)
      monitor_id, error, status_code, failure_class
    from monitor_checks
    where monitor_id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
    order by monitor_id, checked_at desc
  `);
  const checks = new Map(
    latest.rows.map((row) => [
      row.monitor_id,
      {
        error: row.error,
        statusCode: row.status_code,
        failureClass: row.failure_class,
      },
    ]),
  );

  /**
   * Each candidate's open incident, and what that incident's own onset
   * diagnostics resolved its host to.
   *
   * ONE query, and the join is the point rather than a tidiness. Without
   * the addresses the `same-address` signal is unreachable - only the
   * subject ever runs a burst, and a shared value needs both sides - but
   * reading them in a second round trip put an extra query inside
   * `applyOutcome`, which the high-frequency plane calls while holding a
   * per-monitor promotion flag. That measurably moved a plane whose
   * cadence is a few hundred milliseconds: three of its timing tests
   * went red on a full-suite run and were green on the same machine
   * against `main`. The information is worth having; a round trip on
   * that path is not.
   *
   * "Two targets on different hostnames that both resolve to
   * 203.0.113.9" is what catches a shared load balancer or CDN edge, and
   * it is the one thing hostname and domain cannot see.
   */
  const openIncidents = await db.execute<{
    id: string;
    monitor_id: string | null;
    addresses: unknown;
  }>(sql`
    select i.id,
           i.monitor_id,
           jsonb_path_query_array(
             e.snapshot,
             '$.burst.steps[*] ? (@.kind == "dns").detail.addresses[*]'
           ) as addresses
    from incidents i
    left join incident_evidence e on e.incident_id = i.id
    where i.organization_id = ${organizationId}
      and i.source = 'monitor'
      and i.status <> 'resolved'
      and i.monitor_id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);

  const incidentByMonitor = new Map<string, string>();
  const addressesByMonitor = new Map<string, string[]>();
  for (const row of openIncidents.rows) {
    if (row.monitor_id === null) continue;
    incidentByMonitor.set(row.monitor_id, row.id);
    if (!Array.isArray(row.addresses)) continue;
    const found = row.addresses.filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (found.length > 0) addressesByMonitor.set(row.monitor_id, found);
  }

  return rows.map((row) => {
    const check = checks.get(row.id);
    return {
      monitorId: row.id,
      monitorName: row.name,
      checkType: row.checkType,
      host: hostOfTarget(row.url),
      addresses: addressesByMonitor.get(row.id) ?? [],
      firstFailureAt: row.firstFailureAt,
      error: check?.error ?? null,
      statusCode: check?.statusCode ?? null,
      failureClass: check?.failureClass ?? null,
      incidentId: incidentByMonitor.get(row.id) ?? null,
    } satisfies CorrelationCandidate;
  });
}

/**
 * The hostname a target addresses, or null when it addresses none.
 *
 * Lenient on purpose. A target is a URL for some types, a bare hostname
 * for most, a connection string for the database ones and free text for
 * a manual monitor, and this has to give the same answer for all of
 * them without a table of special cases. Anything that is not a
 * plausible hostname comes back null, which costs a correlation signal
 * and never produces a wrong one.
 */
export function hostOfTarget(target: string): string | null {
  const trimmed = target.trim();
  if (trimmed === "") return null;
  if (trimmed.includes("://")) {
    try {
      const url = new URL(trimmed);
      // Strips the brackets an IPv6 literal carries in a URL, so the
      // same address written two ways compares equal.
      return url.hostname.replace(/^\[|\]$/g, "").toLowerCase() || null;
    } catch {
      return null;
    }
  }
  // A bare host, possibly with a port. Anything with a space, a slash or
  // a query is a label rather than an address.
  const bare = trimmed.split("/")[0]!.split("?")[0]!;
  if (/[\s@]/.test(bare)) return null;
  const withoutPort = /^\[.*\]:\d+$/.test(bare)
    ? bare.slice(1, bare.lastIndexOf("]"))
    : bare.includes(":") && bare.split(":").length === 2
      ? bare.split(":")[0]!
      : bare.replace(/^\[|\]$/g, "");
  return withoutPort === "" ? null : withoutPort.toLowerCase();
}
