import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { incidentEvidence, monitorChecks } from "@/db/schema";
import { logger } from "@/lib/logger";
import {
  makeRedactor,
  safeMessage,
  sealEvidence,
  type Redactor,
} from "@/lib/redact";
import { env } from "@/lib/env";
import type { CheckResult } from "@/modules/monitors/check";
import type { Monitor } from "@/modules/monitors/service";
import { describeMonitorTarget, targetPassword } from "@/modules/monitors/spec";
import { findDescriptor } from "@/modules/monitors/types/catalog";
import { secretValuesOf } from "@/modules/monitors/types/config";
import type { FactBag } from "@/modules/monitors/types/contract";
import { findSpec } from "@/modules/monitors/types/specs";

import { runBurst, type BurstTarget, type BurstTransport } from "./burst";
import { classifyStage, failureSignature } from "./classify";
import {
  findCorrelationCandidates,
  hostOfTarget,
  rankCorrelations,
  type CorrelationSubject,
} from "./correlate";
import { meaningfulChanges } from "./diff";
import {
  EVIDENCE_SCHEMA_VERSION,
  type BurstRecord,
  type EvidenceFacts,
  type EvidenceObservation,
  type IncidentEvidenceSnapshot,
} from "./types";

/**
 * Capturing what was known when an incident opened.
 *
 * This runs once per incident, from `applyOutcome`, after the page has
 * gone out. The ordering is deliberate and is the one thing in this
 * file that must not be rearranged for tidiness: paging a human is the
 * product's job and evidence is a convenience, so nothing here may sit
 * between an incident opening and somebody hearing about it. The cost
 * of that ordering is that a worker which dies in the gap loses the
 * snapshot, and that is the right trade - a lost snapshot costs an
 * operator a scroll through check history, a delayed page costs
 * minutes of an outage.
 *
 * There is deliberately **no repair path**. Every other level-triggered
 * consequence in this system re-derives itself on the next check;
 * evidence cannot, because what it records is the state of the world at
 * onset. Filling in a missing snapshot ten minutes later would produce
 * a row that says "at onset" about the middle of an outage, which is
 * worse than the empty state the UI already renders.
 *
 * Idempotent by construction: the row's primary key is the incident id
 * and the insert is `on conflict do nothing`, so a retried check, two
 * workers racing to repair the same unhandled incident, and a monitor
 * that flapped down twice inside one incident all produce exactly one
 * snapshot: the first one to commit, which is the one nearest the onset.
 */

const log = logger.child({ module: "incident-evidence" });

/**
 * The most bytes one snapshot may occupy.
 *
 * Generous for what this holds - a full snapshot with ten correlations
 * and four burst steps lands around 4KB - and it exists for the case
 * that is not typical: a check type whose facts include a long list, a
 * target that answers with a very long error, a future field nobody
 * bounded. The trim below is ordered so the least useful evidence goes
 * first and the snapshot always stays readable.
 */
export const MAX_SNAPSHOT_BYTES = 32_768;

/**
 * The check types whose diagnostic HTTP step is a fair comparison.
 *
 * A burst issues an unauthenticated request. For `http` that is exactly
 * what the monitor's own probe does, so the answer is comparable. For a
 * type that authenticates - `json-query` with a bearer token, an
 * Elasticsearch check with a password - it is not: the diagnostic would
 * come back 401 and an operator would read a fabricated authentication
 * failure as the cause of their outage. Those types still get the
 * resolve, connect and handshake steps, which is where a transport
 * failure is actually distinguished; what they do not get is a request
 * whose result would mean something different from the check's.
 */
const HTTP_STEP_TYPES: ReadonlySet<string> = new Set(["http"]);

/**
 * The longest error string kept.
 *
 * An error is the one field here whose length is decided by somebody
 * else's server: a driver that returns a whole query plan, a gateway
 * that inlines a stack trace. `fitSnapshot` would eventually contain
 * that by throwing away the rest of the snapshot, which is the wrong
 * thing to lose. Two thousand characters is far more than any real
 * message and small enough that the trim below never has to fire for
 * this reason.
 */
const MAX_ERROR_CHARS = 2_000;

/**
 * How far back a probe round may have been decided and still count as
 * evidence about this incident. Matches the correlation window: the same
 * question ("was this at the same moment?") deserves the same answer.
 */
const PROBE_EVIDENCE_WINDOW_MS = 10 * 60 * 1000;

/** Truncates visibly, so a reader knows the tail is missing. */
function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated]`;
}

/** Every secret value this monitor holds, in whatever form it stores them. */
function monitorSecrets(monitor: Monitor): string[] {
  const spec = findSpec(monitor.checkType);
  const values = spec === undefined ? [] : secretValuesOf(spec, monitor.config);
  // The target can be a connection string, and the password in it is a
  // credential that has never been through `secretFields` - it is part
  // of the url column. `describeMonitorTarget` strips it from the label;
  // this puts it in the redactor so it cannot survive anywhere else
  // either, including inside an error message that quoted the DSN back.
  //
  // Through the same parser the display and edit paths use, never a
  // second rule: an `@` is legal inside a password, and splitting on the
  // first one instead of the last one in the authority produced a
  // redactor holding a prefix of the USERNAME - masking every occurrence
  // of two letters across the whole snapshot while leaving the password
  // itself in plain text.
  const password = targetPassword(monitor.url);
  if (password !== null) {
    values.push(password);
    // And the form the wire actually carries. A DSN stores its password
    // percent-encoded - `p%40ss` for `p@ss`, because an unescaped `@`
    // would end the userinfo - and the driver decodes it before it
    // authenticates. So a server that rejects the credential and quotes
    // it back quotes the DECODED form, which is a different string from
    // the one stored. `encodingsOf` in the redactor covers the other
    // direction (raw to percent-encoded) and cannot cover this one,
    // because it never sees the target.
    try {
      const decoded = decodeURIComponent(password);
      if (decoded !== password) values.push(decoded);
    } catch {
      // Not percent-encoded, or not validly so. The raw form is already
      // registered, which is the form such a value takes.
    }
  }
  return values.filter((value) => value.length > 0);
}

/** A stored fact bag, sealed against this monitor's secrets. */
function sealFacts(facts: FactBag | unknown, redact: Redactor): EvidenceFacts {
  const sealed = sealEvidence(facts ?? {}, redact);
  if (typeof sealed !== "object" || sealed === null || Array.isArray(sealed)) {
    return {};
  }
  return sealed as EvidenceFacts;
}

/**
 * The fact bag a diff is computed from.
 *
 * `monitor_checks` keeps `status_code` and `response_time_ms` as their
 * own columns as well as inside `facts`, because they predate the fact
 * bag. Folding them back in means the diff does not need to know which
 * of the two places a given type happens to use, and a type that
 * reports both never shows the same change twice - the fact wins.
 */
function foldColumns(
  facts: EvidenceFacts,
  statusCode: number | null,
  responseTimeMs: number | null,
): EvidenceFacts {
  const out: EvidenceFacts = { ...facts };
  if (statusCode !== null && out.statusCode === undefined) {
    out.statusCode = statusCode;
  }
  if (responseTimeMs !== null && out.responseTimeMs === undefined) {
    out.responseTimeMs = responseTimeMs;
  }
  return out;
}

/** What a burst would dial for this monitor, or null when nothing would. */
export function burstTargetFor(monitor: Monitor): BurstTarget | null {
  const descriptor = findDescriptor(monitor.checkType);
  // Only an active type dials anything. A heartbeat is judged by
  // silence, a group by its members and a manual monitor by an
  // operator's say-so; re-probing any of them would be re-probing
  // nothing.
  if (!descriptor || descriptor.kind !== "active") return null;
  if (descriptor.target.kind === "label") return null;

  const host = hostOfTarget(monitor.url);
  if (host === null) return null;

  let port = monitor.port ?? descriptor.port?.default ?? null;
  let url: string | null = null;
  let tls = monitor.checkType === "tls-expiry";

  if (monitor.url.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(monitor.url);
    } catch {
      return { host, port, url: null, method: monitor.method, tls };
    }
    const https = parsed.protocol === "https:";
    if (https || parsed.protocol === "http:") {
      // The credential never travels with the diagnostic. Stripped
      // rather than trusted-to-be-absent, because `http` targets accept
      // userinfo and a diagnostic request is not the place to discover
      // that.
      parsed.username = "";
      parsed.password = "";
      tls = https;
      port = parsed.port === "" ? (https ? 443 : 80) : Number(parsed.port);
      url = HTTP_STEP_TYPES.has(monitor.checkType) ? parsed.toString() : null;
    } else if (parsed.port !== "") {
      // A connection string for one of the database types. The host and
      // the port are real; the protocol is not something to speak.
      port = Number(parsed.port);
    }
  }

  return { host, port, url, method: monitor.method, tls };
}

export interface CaptureDeps {
  now?: Date;
  /** Injected by the tests; production uses the real sockets. */
  transport?: BurstTransport;
  /** Overrides the installation setting, for the tests only. */
  burstEnabled?: boolean;
  allowPrivateTargets?: boolean;
}

export interface CaptureInput {
  organizationId: string;
  incidentId: string;
  monitor: Monitor;
  /** The observation that opened the incident. */
  outcome: CheckResult;
  /** True when this incident was opened in shadow mode. */
  shadow: boolean;
}

/**
 * The last check that reached the target.
 *
 * `ok` covers `up` and `degraded`, which is the honest reading: a
 * degraded check answered, and "the last time this responded at all" is
 * the comparison an operator wants. The verdict travels with it so the
 * page can say which of the two it was.
 */
async function lastSuccess(
  db: DbClient,
  monitorId: string,
  before: Date,
  redact: Redactor,
): Promise<EvidenceObservation | null> {
  const [row] = await db
    .select({
      checkedAt: monitorChecks.checkedAt,
      verdict: monitorChecks.verdict,
      statusCode: monitorChecks.statusCode,
      responseTimeMs: monitorChecks.responseTimeMs,
      facts: monitorChecks.facts,
    })
    .from(monitorChecks)
    .where(
      and(
        eq(monitorChecks.monitorId, monitorId),
        eq(monitorChecks.ok, true),
        lte(monitorChecks.checkedAt, before),
      ),
    )
    .orderBy(desc(monitorChecks.checkedAt))
    .limit(1);
  if (!row) return null;

  return {
    at: row.checkedAt.toISOString(),
    verdict: row.verdict,
    failureClass: null,
    error: null,
    statusCode: row.statusCode,
    responseTimeMs: row.responseTimeMs,
    failedAssertions: [],
    facts: foldColumns(
      sealFacts(row.facts, redact),
      row.statusCode,
      row.responseTimeMs,
    ),
  };
}

/**
 * Trims a snapshot down to the storage bound, least useful evidence
 * first, and says so when it had to.
 */
export function fitSnapshot(
  snapshot: IncidentEvidenceSnapshot,
  maxBytes = MAX_SNAPSHOT_BYTES,
): IncidentEvidenceSnapshot {
  // Bytes, not UTF-16 code units. `JSON.stringify(x).length` counts
  // code units, so a snapshot of a target that answers in Japanese or
  // emits an emoji in a header would be up to three times the stated cap
  // and would never trip the test - the row would be oversized AND would
  // not admit it, because `truncated` is only set on the trimming path.
  const size = (value: unknown): number =>
    Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size(snapshot) <= maxBytes) return snapshot;

  const trimmed: IncidentEvidenceSnapshot = { ...snapshot, truncated: true };

  if (trimmed.probes && size(trimmed) > maxBytes) delete trimmed.probes;
  while (trimmed.correlations.length > 0 && size(trimmed) > maxBytes) {
    trimmed.correlations = trimmed.correlations.slice(0, -1);
  }
  if (trimmed.burst && size(trimmed) > maxBytes) {
    trimmed.burst = {
      ...trimmed.burst,
      steps: trimmed.burst.steps.map((step) => ({ ...step, detail: {} })),
    };
  }
  if (size(trimmed) > maxBytes) trimmed.changes = [];
  if (size(trimmed) > maxBytes) {
    // Everything derived from other rows goes, leaving the failure.
    trimmed.lastSuccess = null;
    trimmed.failure = { ...trimmed.failure, facts: {} };
  }
  if (size(trimmed) > maxBytes) {
    // And finally the failure's own message, which is the one field
    // whose length a stranger's server decides. `buildSnapshot` already
    // clips it, so production never reaches this - but a function whose
    // contract is "fits in the cap" has to fit in the cap for every
    // input, not for the ones its usual caller happens to produce.
    // Without this the row could be written at twice the stated bound
    // while claiming to have been trimmed to it.
    trimmed.burst = null;
    trimmed.failure = {
      ...trimmed.failure,
      error:
        trimmed.failure.error === null
          ? null
          : clip(trimmed.failure.error, MAX_ERROR_CHARS),
    };
  }
  return trimmed;
}

/**
 * Builds the snapshot. Separated from the write so a test can assert on
 * what would be stored without a transaction, and so the write below
 * stays a single statement.
 */
export async function buildSnapshot(
  db: DbClient,
  input: CaptureInput,
  deps: CaptureDeps = {},
): Promise<IncidentEvidenceSnapshot> {
  const now = deps.now ?? new Date();
  const { monitor, outcome } = input;
  const redact = makeRedactor(monitorSecrets(monitor));
  const descriptor = findDescriptor(monitor.checkType);

  const failureFacts = foldColumns(
    sealFacts(outcome.facts, redact),
    outcome.statusCode,
    outcome.responseTimeMs,
  );
  const failure: EvidenceObservation = {
    at: (monitor.lastCheckedAt ?? now).toISOString(),
    verdict: outcome.verdict,
    failureClass: outcome.failureClass,
    error:
      outcome.error === null
        ? null
        : clip(safeMessage(outcome.error, redact), MAX_ERROR_CHARS),
    statusCode: outcome.statusCode,
    responseTimeMs: outcome.responseTimeMs,
    failedAssertions: outcome.failedAssertions.slice(0, 10),
    facts: failureFacts,
  };

  const onsetAt = monitor.firstFailureAt ?? now;

  const target = burstTargetFor(monitor);
  const burst = await captureBurst(input, target, deps, now);

  const browser =
    descriptor?.id === "synthetic-browser" || descriptor?.id === "real-browser";
  // A heartbeat, a group and a manual monitor never dial anything, so
  // no answer about a network layer can be true of them.
  const dials = descriptor?.kind === "active";
  const stage = classifyStage(
    {
      error: failure.error,
      failureClass: failure.failureClass,
      statusCode: failure.statusCode,
      browser,
      dials,
    },
    burst,
  );

  const previous = await lastSuccess(db, monitor.id, onsetAt, redact);

  const addresses = burst?.steps.find((step) => step.kind === "dns")?.detail
    .addresses;

  const subject: CorrelationSubject = {
    monitorId: monitor.id,
    monitorName: monitor.name,
    checkType: monitor.checkType,
    host: hostOfTarget(monitor.url),
    addresses: Array.isArray(addresses)
      ? addresses.filter((entry): entry is string => typeof entry === "string")
      : [],
    firstFailureAt: monitor.firstFailureAt,
    error: failure.error,
    statusCode: failure.statusCode,
    failureClass: failure.failureClass,
    incidentId: input.incidentId,
    stage: stage.stage,
  };
  /**
   * The fleet-wide half, and the only part of this function that reads
   * rows belonging to other monitors.
   *
   * Skipped entirely on the high-frequency plane. That plane calls
   * `applyOutcome` while holding a per-monitor promotion flag and
   * promotes nothing else for that monitor until it returns, at a
   * cadence measured in hundreds of milliseconds; a query over every
   * failing monitor in the tenant is not a cost it can absorb. Measured
   * rather than assumed: adding one round trip here moved three of that
   * plane's timing tests on a full-suite run that was green against
   * `main` on the same machine.
   *
   * The per-monitor half above - what failed, which layer, what changed
   * since the last success - is unaffected, and the snapshot records
   * that correlation did not run so an empty list is never read as
   * "nothing else was failing".
   */
  const correlate = !monitor.highFrequency;
  const candidates = correlate
    ? await findCorrelationCandidates(
        db,
        input.organizationId,
        monitor.id,
        onsetAt,
      )
    : [];


  const snapshot: IncidentEvidenceSnapshot = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    capturedAt: now.toISOString(),
    monitor: {
      id: monitor.id,
      name: monitor.name,
      checkType: monitor.checkType,
      target: describeMonitorTarget(monitor),
      host: subject.host,
      port: target?.port ?? monitor.port,
    },
    failure,
    stage,
    signature: failureSignature(failure),
    firstFailureAt: monitor.firstFailureAt?.toISOString() ?? null,
    lastSuccess: previous,
    lastSuccessNote: previous === null ? "none-retained" : "found",
    changes: meaningfulChanges(
      previous?.facts ?? null,
      failure.facts,
      descriptor?.facts ?? [],
    ),
    burst,
    correlations: rankCorrelations(subject, candidates),
    ...(correlate ? {} : { correlationsNote: "high-frequency" as const }),
  };


  return fitSnapshot(snapshot);
}

/**
 * Runs the diagnostic burst, or records why it did not.
 *
 * A shadow incident never dials anything. Shadow mode's promise is that
 * a fleet running beside the system it was migrated from has no
 * consequences outside Vigil, and an extra four requests per incident
 * to somebody's production endpoint - during a migration, when the
 * fleet is deliberately duplicated - is a consequence.
 */
async function captureBurst(
  input: CaptureInput,
  target: BurstTarget | null,
  deps: CaptureDeps,
  now: Date,
): Promise<BurstRecord | null> {
  const enabled = deps.burstEnabled ?? env.INCIDENT_EVIDENCE_BURST;
  const base = {
    ranAt: now.toISOString(),
    budgetMs: 0,
    maxSteps: 0,
    spentMs: 0,
    steps: [],
  };
  if (input.shadow) return { ...base, skipped: "shadow" as const };
  if (!enabled) return { ...base, skipped: "disabled" as const };
  // The high-frequency plane holds a per-monitor promotion flag across
  // the whole outcome call and promotes nothing else while it is held,
  // so seconds spent here would stall a cadence measured in hundreds of
  // milliseconds. Read from the monitor row rather than passed in,
  // because the row is what every other consumer of this decision reads.
  if (input.monitor.highFrequency) {
    return { ...base, skipped: "high-frequency" as const };
  }
  if (target === null) return { ...base, skipped: "no-target" as const };
  return runBurst({
    target,
    now,
    ...(deps.transport ? { transport: deps.transport } : {}),
    ...(deps.allowPrivateTargets === undefined
      ? {}
      : { allowPrivateTargets: deps.allowPrivateTargets }),
  });
}


/**
 * Builds and stores the snapshot. Never throws.
 *
 * The caller is an incident that has already opened and already paged.
 * Anything that goes wrong here - a burst that hangs past its budget, a
 * target row that vanished, a jsonb value Postgres will not take - must
 * cost the snapshot and nothing else.
 */
export async function captureIncidentEvidence(
  db: DbClient,
  input: CaptureInput,
  deps: CaptureDeps = {},
): Promise<IncidentEvidenceSnapshot | null> {
  try {
    const snapshot = await buildSnapshot(db, input, deps);
    const inserted = await db
      .insert(incidentEvidence)
      .values({
        incidentId: input.incidentId,
        organizationId: input.organizationId,
        monitorId: input.monitor.id,
        schemaVersion: snapshot.schemaVersion,
        capturedAt: new Date(snapshot.capturedAt),
        snapshot,
      })
      // The idempotency guarantee, stated to Postgres. Two workers
      // repairing the same unhandled incident both build a snapshot and
      // exactly one is stored; the loser's is discarded rather than
      // overwriting a record of an earlier moment with a later one.
      .onConflictDoNothing({ target: incidentEvidence.incidentId })
      .returning({ incidentId: incidentEvidence.incidentId });

    log.info(
      {
        incidentId: input.incidentId,
        monitorId: input.monitor.id,
        stage: snapshot.stage.stage,
        basis: snapshot.stage.basis,
        stored: inserted.length > 0,
        correlations: snapshot.correlations.length,
      },
      inserted.length > 0
        ? "incident evidence captured"
        : "incident evidence already captured",
    );
    return snapshot;
  } catch (error) {
    log.error(
      { err: error, incidentId: input.incidentId },
      "capturing incident evidence failed",
    );
    return null;
  }
}

export interface StoredIncidentEvidence {
  incidentId: string;
  capturedAt: Date;
  schemaVersion: number;
  snapshot: IncidentEvidenceSnapshot;
}

/**
 * One incident's evidence, tenant-scoped in the query.
 *
 * Scoped here rather than by the caller for the reason every other read
 * in this codebase is: an incident id is a uuid somebody can paste, and
 * "read it then compare the organisation" is one forgotten comparison
 * away from a cross-tenant read of another company's endpoints.
 */
export async function getIncidentEvidence(
  db: DbClient,
  organizationId: string,
  incidentId: string,
): Promise<StoredIncidentEvidence | null> {
  const [row] = await db
    .select()
    .from(incidentEvidence)
    .where(
      and(
        eq(incidentEvidence.incidentId, incidentId),
        eq(incidentEvidence.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    incidentId: row.incidentId,
    capturedAt: row.capturedAt,
    schemaVersion: row.schemaVersion,
    snapshot: row.snapshot,
  };
}

/**
 * How long a resolved incident keeps its evidence.
 *
 * Longer than `CHECK_RETENTION_DAYS` on purpose, and that gap is the
 * whole reason this table exists rather than a query over
 * `monitor_checks`. Ninety days after an outage the observations that
 * explained it have been pruned; the snapshot is a few kilobytes and
 * answers the question a year later, which is when somebody is writing
 * the post-incident review or arguing about an SLA.
 *
 * An UNRESOLVED incident's evidence is never pruned, whatever its age.
 * A year-old incident still open is a bookkeeping problem, and deleting
 * the only record of why it opened would not fix it.
 */
export const EVIDENCE_RETENTION_DAYS = 365;

/**
 * Drops evidence for incidents resolved before `cutoff`. Batched.
 *
 * `organizationId` narrows the sweep to one tenant and exists for the
 * reason `pruneOldChecks` grew the same option: a test that drives this
 * runs beside suites whose fixtures are dated into the past, and an
 * unscoped pass reaches over and deletes another suite's evidence
 * mid-assertion. The worker never passes it.
 */
export async function pruneIncidentEvidence(
  db: DbClient,
  cutoff: Date,
  batchSize: number,
  options: { organizationId?: string } = {},
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const result = await db.execute(sql`
      delete from ${incidentEvidence}
      where ctid in (
        select e.ctid from ${incidentEvidence} e
        join incidents i on i.id = e.incident_id
        where i.status = 'resolved'
          and i.resolved_at is not null
          and i.resolved_at < ${cutoff.toISOString()}::timestamptz
        ${
          options.organizationId
            ? sql`and e.organization_id = ${options.organizationId}`
            : sql``
        }
        limit ${batchSize}
      )
    `);
    const rows = result.rowCount ?? 0;
    deleted += rows;
    if (rows < batchSize) break;
  }
  return deleted;
}
