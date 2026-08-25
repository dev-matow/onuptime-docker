import type { FactValue } from "@/modules/monitors/types/contract";

/**
 * What an incident's evidence snapshot says, and nothing more.
 *
 * The whole point of this module is that an operator opening an
 * incident at 3am should not have to reconstruct the outage from a
 * scrolling list of check rows that retention will eventually delete.
 * So the moment an incident opens, what was known is copied here: the
 * observation that failed, the last one that did not, what changed
 * between them, and which other monitors were failing at the same
 * moment for a reason we can name.
 *
 * Three rules hold the shape together, and every field below is a
 * consequence of one of them.
 *
 * **Facts, never conclusions.** Nothing here is a probability, a score
 * or a guess dressed as a measurement. {@link EvidenceStageVerdict}
 * carries a `basis` saying how the layer was established, and `unknown`
 * is a legal, frequently correct answer. A timeout does not say which
 * layer stalled, so a timeout that nothing re-probed is filed as
 * `unknown` rather than as whatever the reader would have assumed.
 *
 * **Written once, at onset.** This is a snapshot of what was true when
 * the incident opened, not a live view. Repairing a missing snapshot on
 * a later check would fill it with the state of the world ten minutes
 * into an outage and label it "onset", which is worse than an absence.
 *
 * **Storage-shaped.** Everything is JSON-safe and bounded: no Dates, no
 * unbounded arrays, no response bodies. The row is `jsonb` and is read
 * by a server component; a value that cannot round-trip through JSON
 * was never going to survive the trip.
 */

/** The current snapshot format. Bumped when a reader must branch. */
export const EVIDENCE_SCHEMA_VERSION = 1;

/**
 * Where the failure was observed, when the evidence supports saying so.
 *
 * Deliberately coarse. These are the layers a probe can actually
 * distinguish from outside a target: a name that did not resolve, a
 * port that refused, a handshake that failed, a response that arrived
 * and was wrong. `application` means the transport worked end to end
 * and a declared assertion did not hold; `browser` means a scripted
 * journey failed inside a page. Anything finer would be a claim about
 * the inside of somebody else's system.
 */
export type EvidenceStage =
  "dns" | "tcp" | "tls" | "http" | "application" | "browser" | "unknown";

/**
 * How the stage above was established. This is the field that keeps the
 * classification honest, and it is why the stage may be stated at all.
 *
 * - `measured` - a diagnostic step re-probed the layer and it failed.
 * - `reported` - the probe's own error names the layer (`ENOTFOUND` is
 *   a resolver answer; `ECONNREFUSED` is a kernel answer).
 * - `assertion` - the target answered and a declared assertion did not
 *   hold, so the transport is proven working by the same observation.
 * - `unknown` - nothing established it. Paired with `stage: "unknown"`.
 */
export type EvidenceStageBasis =
  "measured" | "reported" | "assertion" | "unknown";

export interface EvidenceStageVerdict {
  stage: EvidenceStage;
  basis: EvidenceStageBasis;
  /** One sentence an operator reads. Says what was seen, not what it means. */
  reason: string;
}

/** A fact bag as it is stored: JSON-safe, already redacted. */
export type EvidenceFacts = Record<string, FactValue | FactValue[]>;

export interface EvidenceObservation {
  /** When the check was recorded. Null when nothing was found. */
  at: string | null;
  verdict: string | null;
  failureClass: string | null;
  /** Redacted before it is written. */
  error: string | null;
  statusCode: number | null;
  responseTimeMs: number | null;
  failedAssertions: string[];
  facts: EvidenceFacts;
}

/**
 * One difference between the last success and the failure.
 *
 * `note` is the whole reason this is a structured row rather than a
 * rendered string: the UI decides how to show it, and a test can assert
 * on the change without matching prose.
 */
export interface EvidenceChange {
  key: string;
  label: string;
  unit?: string;
  before: FactValue | FactValue[] | null;
  after: FactValue | FactValue[] | null;
  note: "changed" | "appeared" | "disappeared" | "slower" | "faster";
}

/** Why two failures are being shown together. Never a score. */
export type CorrelationSignalKind =
  /** Same hostname in the target. */
  | "same-host"
  /** Same registrable domain, different hostname. */
  | "same-domain"
  /** A diagnostic step resolved both targets to the same address. */
  | "same-address"
  /** The same normalised failure signature. */
  | "same-signature"
  /** The same remote probe location reported both. */
  | "same-probe-location"
  /** The same classified stage. */
  | "same-stage"
  /** The same check type. */
  | "same-check-type";

export interface CorrelationSignal {
  kind: CorrelationSignalKind;
  /** The shared value, so the reader can check the claim. */
  detail: string;
}

export interface CorrelatedFailure {
  monitorId: string;
  monitorName: string;
  checkType: string;
  /** The other monitor's open incident, when it has one. */
  incidentId: string | null;
  firstFailureAt: string | null;
  /** Signals in a fixed order: the strong ones first. */
  signals: CorrelationSignal[];
}

/** Which diagnostic step this is. One per layer, in this order. */
export type BurstStepKind = "dns" | "tcp" | "tls" | "http";

export interface BurstStep {
  kind: BurstStepKind;
  ok: boolean;
  durationMs: number;
  /** Redacted, bounded, and never a body or a credential-bearing header. */
  detail: EvidenceFacts;
  error: string | null;
  /**
   * True when the step failed because of one of Vigil's own limits
   * rather than because of anything the target did: the budget ran out,
   * or egress policy refused the address.
   *
   * It exists so the classifier cannot turn our own bound into a finding
   * about somebody else's system. "The TLS handshake failed" and "we
   * stopped waiting for the TLS handshake" are different sentences, and
   * only the first is evidence about the target - so a self-inflicted
   * step is recorded in full and is skipped when the failing layer is
   * decided.
   */
  selfInflicted?: true;
}

/**
 * Why no diagnostic step ran, when none did. An absent burst is a fact
 * about Vigil, not about the target, and the reader is told which.
 */
export type BurstSkipReason =
  /** The installation has the burst switched off. */
  | "disabled"
  /** The incident was opened in shadow mode; nothing extra is dialled. */
  | "shadow"
  /** Too many bursts already running. The bound, working. */
  | "concurrency"
  /** This check type has no host and port to re-probe. */
  | "no-target"
  /**
   * The monitor is on the high-frequency plane, which cannot wait.
   *
   * That plane holds a per-monitor promotion flag across the whole
   * outcome call and promotes nothing else while it is held, so seconds
   * of diagnostics there would stall a cadence measured in hundreds of
   * milliseconds. A monitor probed twice a second also has far more
   * evidence of its own than a burst could add.
   */
  | "high-frequency"
  /** Whatever we would have dialled, egress policy refuses. */
  | "refused";

export interface BurstRecord {
  ranAt: string;
  /** The bounds this burst ran under, recorded so the row explains itself. */
  budgetMs: number;
  maxSteps: number;
  /** Wall-clock spent across every step. */
  spentMs: number;
  steps: BurstStep[];
  /**
   * Why the burst stopped short, when something declined to run it.
   *
   * Usually paired with an empty `steps`, but NOT always, and a reader
   * must not assume it. An egress refusal is decided after the resolve
   * step, and that step is the finding - "the name now points at
   * 10.0.0.1" is precisely what an operator needs - so the record keeps
   * both. Anything rendering this must read `skipped` whatever `steps`
   * holds; the first version of the card read it only when `steps` was
   * empty, and a refused target therefore showed a green resolve step
   * and no explanation at all.
   */
  skipped?: BurstSkipReason;
}

/** Commercial enrichment: a scripted journey's failed step. */
export interface SyntheticEvidence {
  runId: string;
  flavour: string;
  outcome: string | null;
  failedStepIndex: number | null;
  failedStepLabel: string | null;
  durationMs: number | null;
  /**
   * A reference to an artifact the run already captured, never a copy of
   * the bytes. The artifact route enforces its own tenancy check and the
   * artifact retention window is shorter than this snapshot's, so the
   * reader may find it gone - which the UI says rather than hides.
   */
  screenshot: {
    artifactId: string;
    stepIndex: number;
    label: string;
    byteLength: number;
    sha256: string;
  } | null;
}

/** Commercial enrichment: which remote probes saw the failure. */
export interface ProbeEvidenceReport {
  probeId: string;
  probeName: string;
  location: string | null;
  ok: boolean;
  verdict: string;
  error: string | null;
  responseTimeMs: number | null;
}

export interface ProbeEvidence {
  roundId: string;
  /** One entry per probe that reported, in name order. */
  reports: ProbeEvidenceReport[];
}

export interface IncidentEvidenceSnapshot {
  schemaVersion: number;
  capturedAt: string;
  monitor: {
    id: string;
    name: string;
    checkType: string;
    /** Already through `describeMonitorTarget`: no userinfo, no secrets. */
    target: string;
    /** The hostname the target addresses, when it addresses one. */
    host: string | null;
    port: number | null;
  };
  failure: EvidenceObservation;
  stage: EvidenceStageVerdict;
  /** A normalised form of the failure, used for correlation. Null when unreadable. */
  signature: string | null;
  firstFailureAt: string | null;
  /**
   * The last check that reached the target, or null.
   *
   * Null has two possible causes - the monitor has never succeeded, or
   * its last success aged out of the retention window - and the schema
   * cannot tell them apart, because a pruned success leaves nothing
   * behind to distinguish it from a success that never happened. So the
   * note says the one thing that IS known: none is retained. Claiming
   * more than that would be exactly the kind of confident-sounding
   * absence this module exists to avoid.
   */
  lastSuccess: EvidenceObservation | null;
  lastSuccessNote: "found" | "none-retained";
  changes: EvidenceChange[];
  burst: BurstRecord | null;
  correlations: CorrelatedFailure[];
  /**
   * Set when correlation was not run at all, so an empty list is never
   * read as "nothing else was failing".
   *
   * `high-frequency` is the only reason today. Correlation is the
   * fleet-wide half of the snapshot and costs a query over every failing
   * monitor in the tenant; the high-frequency plane calls the outcome
   * path while holding a per-monitor promotion flag, at a cadence
   * measured in hundreds of milliseconds, and it may not spend that. The
   * per-monitor half - what failed, which layer, what changed since the
   * last success - is unaffected and is captured as usual.
   */
  correlationsNote?: "high-frequency";
  synthetic?: SyntheticEvidence;
  probes?: ProbeEvidence;
  /** Set when the snapshot was trimmed to fit the storage bound. */
  truncated?: true;
}
