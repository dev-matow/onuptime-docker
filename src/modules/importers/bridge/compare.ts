/**
 * The comparison: what the source system saw against what Vigil saw,
 * over the window both were watching.
 *
 * Pure and free of I/O, like `translate.ts`, and for the same reason:
 * the rows that decide a verdict are the edge cases, and edge cases are
 * only affordable to test when producing one costs an object literal
 * rather than a database.
 *
 * Two rules run through every classification, and each direction leans
 * on different evidence:
 *
 * 1. **A copied source incident is evidence by itself.** Counting a
 *    MISS needs no poll-coverage argument: the row was read from the
 *    source's own API, and Vigil's absence is queryable. What a miss
 *    does need is proof Vigil was in a position to see the outage (it
 *    was observing before the start) and proof the outage outlived the
 *    failure window the import recorded.
 * 2. **Source silence needs coverage.** Counting an EXTRA asserts the
 *    source recorded nothing over a span, and absence is only provable
 *    where the polls actually looked. A span the coverage cannot vouch
 *    for stays unprovable, for either side.
 *
 * The verdict is conservative: SAFE requires positive evidence of
 * enough overlapping watching, and every disqualifier is a written
 * reason. An operator can overrule a cautious NOT SAFE; nobody can
 * un-trust a cheerful SAFE that was wrong.
 */

/** An incident-equivalent event as the source system recorded it. */
export interface SourceEvent {
  id: string;
  /** Matches `bridge_monitors.sourceId`. */
  resourceId: string;
  start: Date;
  /** The source's resolution time, or null while none was observed. */
  end: Date | null;
  /**
   * The last instant the copy is known to have been accurate: the
   * resolution time when one was observed, otherwise the last moment a
   * poll refreshed the row. An open incident's duration is therefore
   * known to be AT LEAST `observedUntil - start`, which is what lets a
   * still-open or gone-stale outage be judged against the failure
   * window without inventing an end for it.
   */
  observedUntil: Date;
  cause: string | null;
}

/** An incident Vigil opened for the paired monitor. */
export interface VigilEvent {
  id: string;
  start: Date;
  end: Date | null;
}

/** One source record and what became of it, from `bridge_monitors`. */
export interface ComparisonPair {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  /** Null when nothing was created, or when it was deleted here since. */
  monitorId: string | null;
  outcome: string;
  detail: string;
  /** Whether incident comparison applies (false for heartbeats). */
  compared: boolean;
  /** When the Vigil monitor began observing, when one exists. */
  observedSince: Date | null;
  /**
   * The failure window recorded when the record was imported, seconds.
   * The import-time value on purpose: judging last month's outage
   * against a window the operator widened yesterday would let a
   * settings edit retroactively excuse a recorded miss.
   */
  failureWindowSeconds: number | null;
  /** Observations Vigil recorded for this monitor during the bridge. */
  vigilChecks: number;
  sourceEvents: SourceEvent[];
  vigilEvents: VigilEvent[];
}

/** A half-open span of proven evidence coverage. */
export interface CoverageWindow {
  from: Date;
  to: Date;
}

export interface ComparisonInput {
  /** When the comparison window closes; effectively "now". */
  at: Date;
  pairs: ComparisonPair[];
  /** Union-mergeable `ok` poll windows. */
  coverage: CoverageWindow[];
  /** Blockers the import itself reported: policies, status pages. */
  manualNotes: string[];
  /** Consecutive failed polls, from the bridge row. */
  consecutivePollFailures: number;
}

export type MatchKind =
  "matched" | "missed" | "extra" | "unprovable" | "below-window";

export interface EventFinding {
  kind: MatchKind;
  sourceId: string;
  monitorName: string;
  sourceEventId: string | null;
  vigilEventId: string | null;
  /** Seconds from source start to Vigil start; negative = Vigil earlier. */
  detectionDeltaSeconds: number | null;
  /** Seconds from source end to Vigil end; negative = Vigil earlier. */
  recoveryDeltaSeconds: number | null;
  detail: string;
}

export interface PairSummary {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  outcome: string;
  compared: boolean;
  monitorId: string | null;
  vigilChecks: number;
  /** Hours both systems provably watched this pair. */
  overlapHours: number;
  matched: number;
  missed: number;
  extra: number;
  unprovable: number;
  belowWindow: number;
  detail: string;
}

export interface ComparisonReport {
  window: { from: Date | null; to: Date };
  coverage: CoverageWindow[];
  coveredHours: number;
  totals: {
    sourceRecords: number;
    imported: number;
    transformed: number;
    skipped: number;
    unsupported: number;
    /** Imported records whose Vigil monitor was deleted here since. */
    deleted: number;
    comparedPairs: number;
    matched: number;
    missed: number;
    extra: number;
    openExtra: number;
    unprovable: number;
    belowWindow: number;
  };
  /** Median and worst timing deltas across matched pairs, seconds. */
  timing: {
    detectionMedianSeconds: number | null;
    detectionWorstSeconds: number | null;
    recoveryMedianSeconds: number | null;
    recoveryWorstSeconds: number | null;
    samples: number;
  };
  pairs: PairSummary[];
  findings: EventFinding[];
  manualWork: string[];
  verdict: "safe" | "not-safe";
  reasons: string[];
}

/**
 * How far apart two incident intervals may sit and still be the same
 * outage: the gap between them, at most this. Vigil confirms over the
 * monitor's failure window and checks on an interval, so its incident
 * legitimately trails the source's; beyond the grace, two events are
 * two events. Applied to the gap once, not once per side, so the
 * effective tolerance is exactly what this constant says.
 */
export const MATCH_GRACE_SECONDS = 300;

/**
 * The least overlap a SAFE verdict can rest on, per compared pair:
 * hours during which the source evidence covers a span Vigil was also
 * observing. Source history alone is not enough - the first poll can
 * legitimately cover a day the bridge did not exist for, because the
 * source's API answers about the past - and Vigil observation alone is
 * not enough either. Agreement is only provable where both watched.
 */
export const MIN_COMPARISON_HOURS = 24;

/** Poll failures in a row past which the evidence feed counts as down. */
export const MAX_CONSECUTIVE_POLL_FAILURES = 4;

/** Merge poll windows into non-overlapping spans, earliest first. */
export function mergeCoverage(windows: CoverageWindow[]): CoverageWindow[] {
  const sorted = [...windows]
    .filter((w) => w.to.getTime() > w.from.getTime())
    .sort((a, b) => a.from.getTime() - b.from.getTime());
  const merged: CoverageWindow[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && window.from.getTime() <= last.to.getTime()) {
      if (window.to.getTime() > last.to.getTime()) last.to = window.to;
      continue;
    }
    merged.push({ from: new Date(window.from), to: new Date(window.to) });
  }
  return merged;
}

/** Hours of `coverage` that fall inside [from, to]. */
export function overlapHours(
  coverage: CoverageWindow[],
  from: Date,
  to: Date,
): number {
  let ms = 0;
  for (const window of coverage) {
    const start = Math.max(window.from.getTime(), from.getTime());
    const end = Math.min(window.to.getTime(), to.getTime());
    if (end > start) ms += end - start;
  }
  return ms / 3_600_000;
}

function covered(coverage: CoverageWindow[], from: Date, to: Date): boolean {
  // A span is covered when one merged window contains all of it. Two
  // adjacent windows with a gap between them do not cover a span that
  // crosses the gap, and that is the point.
  return coverage.some(
    (w) => w.from.getTime() <= from.getTime() && w.to.getTime() >= to.getTime(),
  );
}

/**
 * Whether two intervals are the same outage: they overlap, or the gap
 * between them is at most the grace. Open ends read as "still going at
 * `at`". The gap is padded once - the later interval's start against
 * the earlier one's end - so the tolerance is the constant, not twice
 * it: a source outage and an unrelated Vigil blip nine minutes later
 * must stay two events, or a miss and a false alarm would quietly fuse
 * into one "matched".
 */
function overlapsOrNear(
  a: { start: Date; end: Date | null },
  b: { start: Date; end: Date | null },
  at: Date,
  graceMs: number,
): boolean {
  const aEnd = (a.end ?? at).getTime();
  const bEnd = (b.end ?? at).getTime();
  return (
    a.start.getTime() <= bEnd + graceMs && b.start.getTime() <= aEnd + graceMs
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function worst(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((acc, v) => (Math.abs(v) > Math.abs(acc) ? v : acc));
}

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

interface PairFindings {
  findings: EventFinding[];
  matched: number;
  missed: number;
  extra: number;
  /** Extras still open at report time: a live disagreement, not history. */
  openExtra: number;
  unprovable: number;
  belowWindow: number;
  detectionDeltas: number[];
  recoveryDeltas: number[];
}

function comparePair(
  pair: ComparisonPair,
  coverage: CoverageWindow[],
  at: Date,
): PairFindings {
  const out: PairFindings = {
    findings: [],
    matched: 0,
    missed: 0,
    extra: 0,
    openExtra: 0,
    unprovable: 0,
    belowWindow: 0,
    detectionDeltas: [],
    recoveryDeltas: [],
  };
  const graceMs = MATCH_GRACE_SECONDS * 1000;
  const coverageEnd = coverage[coverage.length - 1]?.to ?? null;
  const claimedVigil = new Set<string>();

  // Source events first: every one is matched, excused, or counted
  // against Vigil. Greedy by start order is deterministic and, with
  // one open incident per monitor per side, unambiguous in practice.
  const sourceEvents = [...pair.sourceEvents].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
  const vigilEvents = [...pair.vigilEvents].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );

  for (const event of sourceEvents) {
    const match = vigilEvents.find(
      (v) => !claimedVigil.has(v.id) && overlapsOrNear(event, v, at, graceMs),
    );
    if (match !== undefined) {
      claimedVigil.add(match.id);
      out.matched += 1;
      const detection = seconds(match.start.getTime() - event.start.getTime());
      out.detectionDeltas.push(detection);
      let recovery: number | null = null;
      if (event.end !== null && match.end !== null) {
        recovery = seconds(match.end.getTime() - event.end.getTime());
        out.recoveryDeltas.push(recovery);
      }
      out.findings.push({
        kind: "matched",
        sourceId: pair.sourceId,
        monitorName: pair.sourceName,
        sourceEventId: event.id,
        vigilEventId: match.id,
        detectionDeltaSeconds: detection,
        recoveryDeltaSeconds: recovery,
        detail:
          recovery === null
            ? `Both systems saw this outage. Vigil confirmed it ${describeDelta(detection)}.`
            : `Both systems saw this outage. Vigil confirmed it ${describeDelta(detection)} and saw recovery ${describeDelta(recovery)}.`,
      });
      continue;
    }

    // No match. The excuses, in order of how much they excuse. What is
    // deliberately NOT here is a poll-coverage requirement: the copied
    // row is itself the evidence the outage happened, and requiring
    // coverage on top would excuse exactly the long outages a coverage
    // gap or a stale copy makes hardest to see.
    const observedHere =
      pair.observedSince !== null &&
      pair.observedSince.getTime() <= event.start.getTime() - graceMs;
    if (!observedHere) {
      out.unprovable += 1;
      out.findings.push({
        kind: "unprovable",
        sourceId: pair.sourceId,
        monitorName: pair.sourceName,
        sourceEventId: event.id,
        vigilEventId: null,
        detectionDeltaSeconds: null,
        recoveryDeltaSeconds: null,
        detail:
          "This incident predates the point Vigil began observing this monitor, so no comparison is possible for it.",
      });
      continue;
    }

    // The outage's duration, as far as it is actually known: exact when
    // a resolution was observed, otherwise at least as long as the copy
    // was seen still open.
    const knownForMs =
      (event.end ?? event.observedUntil).getTime() - event.start.getTime();
    const window = pair.failureWindowSeconds;
    if (window !== null && knownForMs < window * 1000) {
      if (event.end !== null) {
        out.belowWindow += 1;
        out.findings.push({
          kind: "below-window",
          sourceId: pair.sourceId,
          monitorName: pair.sourceName,
          sourceEventId: event.id,
          vigilEventId: null,
          detectionDeltaSeconds: null,
          recoveryDeltaSeconds: null,
          detail: `The source recorded a ${Math.round(knownForMs / 1000)}s blip, shorter than the ${window}s failure window this monitor was imported with. Vigil does not open an incident for it by design; the import report carried that trade.`,
        });
      } else {
        out.unprovable += 1;
        out.findings.push({
          kind: "unprovable",
          sourceId: pair.sourceId,
          monitorName: pair.sourceName,
          sourceEventId: event.id,
          vigilEventId: null,
          detectionDeltaSeconds: null,
          recoveryDeltaSeconds: null,
          detail: `The source's copy of this incident was last seen ${Math.round(knownForMs / 1000)}s after it started, inside the ${window}s failure window, and its end was never observed. It may have been a blip Vigil rightly ignored; it cannot be counted either way.`,
        });
      }
      continue;
    }

    out.missed += 1;
    out.findings.push({
      kind: "missed",
      sourceId: pair.sourceId,
      monitorName: pair.sourceName,
      sourceEventId: event.id,
      vigilEventId: null,
      detectionDeltaSeconds: null,
      recoveryDeltaSeconds: null,
      detail: `The source recorded an outage${event.cause === null ? "" : ` (${event.cause})`} starting ${event.start.toISOString()}${event.end === null ? ", still unresolved when last observed," : ""} and Vigil, watching the same target over the same period, recorded nothing. Until this is explained, cutting over risks missing the same outage for real.`,
    });
  }

  for (const event of vigilEvents) {
    if (claimedVigil.has(event.id)) continue;
    // An extra asserts source silence, and silence is only provable
    // where the polls looked. For a closed event that is its own span;
    // for one still open, the claim is honest up to the last successful
    // poll: "as of then, the source read fine while Vigil read down".
    const proofEnd = event.end ?? coverageEnd;
    if (
      proofEnd === null ||
      // An open incident the polls have never seen past its start has
      // an inverted proof span, which containment would pass vacuously.
      proofEnd.getTime() <= event.start.getTime() ||
      !covered(coverage, event.start, proofEnd)
    ) {
      out.unprovable += 1;
      out.findings.push({
        kind: "unprovable",
        sourceId: pair.sourceId,
        monitorName: pair.sourceName,
        sourceEventId: null,
        vigilEventId: event.id,
        detectionDeltaSeconds: null,
        recoveryDeltaSeconds: null,
        detail:
          "Vigil recorded an outage inside a span the source evidence does not cover, so whether the source also saw it cannot be proven. It is not counted for either side.",
      });
      continue;
    }
    out.extra += 1;
    if (event.end === null) out.openExtra += 1;
    out.findings.push({
      kind: "extra",
      sourceId: pair.sourceId,
      monitorName: pair.sourceName,
      sourceEventId: null,
      vigilEventId: event.id,
      detectionDeltaSeconds: null,
      recoveryDeltaSeconds: null,
      detail:
        event.end === null
          ? `Vigil reads this monitor as down right now (incident open since ${event.start.toISOString()}) while the source, as of the last successful poll, records nothing. A monitor that is wrong before cutover will be wrong after it; the import report line usually names the cause.`
          : `Vigil recorded an outage starting ${event.start.toISOString()} that the source did not. Either Vigil caught something the source missed, or the imported check asserts something stricter; the monitor's check history has the evidence either way.`,
    });
  }

  return out;
}

function describeDelta(deltaSeconds: number): string {
  if (deltaSeconds === 0) return "at the same moment";
  const magnitude = Math.abs(deltaSeconds);
  const spelled =
    magnitude < 120 ? `${magnitude}s` : `${Math.round(magnitude / 60)}m`;
  return deltaSeconds > 0 ? `${spelled} later` : `${spelled} earlier`;
}

/** The whole comparison, and the verdict it supports. */
export function compareBridge(input: ComparisonInput): ComparisonReport {
  const coverage = mergeCoverage(input.coverage);
  const coveredMs = coverage.reduce(
    (acc, w) => acc + (w.to.getTime() - w.from.getTime()),
    0,
  );
  const coveredHours = coveredMs / 3_600_000;

  const totals = {
    sourceRecords: input.pairs.length,
    imported: 0,
    transformed: 0,
    skipped: 0,
    unsupported: 0,
    deleted: 0,
    comparedPairs: 0,
    matched: 0,
    missed: 0,
    extra: 0,
    openExtra: 0,
    unprovable: 0,
    belowWindow: 0,
  };
  const pairSummaries: PairSummary[] = [];
  const findings: EventFinding[] = [];
  const detectionDeltas: number[] = [];
  const recoveryDeltas: number[] = [];
  const deletedPairs: ComparisonPair[] = [];

  for (const pair of input.pairs) {
    if (pair.outcome === "imported") totals.imported += 1;
    else if (pair.outcome === "transformed") totals.transformed += 1;
    else if (pair.outcome === "skipped") totals.skipped += 1;
    else totals.unsupported += 1;

    // An imported record whose monitor is gone is not "not compared",
    // it is a hole in the fleet: the source still watches this target
    // and, after cutover, nothing here would. It must not slip out of
    // the verdict by losing its monitor id.
    const wasImported =
      pair.outcome === "imported" || pair.outcome === "transformed";
    if (wasImported && pair.monitorId === null) {
      totals.deleted += 1;
      deletedPairs.push(pair);
    }

    if (!pair.compared || pair.monitorId === null) {
      pairSummaries.push({
        sourceId: pair.sourceId,
        sourceName: pair.sourceName,
        sourceType: pair.sourceType,
        outcome: pair.outcome,
        compared: false,
        monitorId: pair.monitorId,
        vigilChecks: pair.vigilChecks,
        overlapHours: 0,
        matched: 0,
        missed: 0,
        extra: 0,
        unprovable: 0,
        belowWindow: 0,
        detail: pair.detail,
      });
      continue;
    }

    totals.comparedPairs += 1;
    const pairOverlap =
      pair.observedSince === null
        ? 0
        : overlapHours(coverage, pair.observedSince, input.at);
    const result = comparePair(pair, coverage, input.at);
    totals.matched += result.matched;
    totals.missed += result.missed;
    totals.extra += result.extra;
    totals.openExtra += result.openExtra;
    totals.unprovable += result.unprovable;
    totals.belowWindow += result.belowWindow;
    detectionDeltas.push(...result.detectionDeltas);
    recoveryDeltas.push(...result.recoveryDeltas);
    findings.push(...result.findings);
    pairSummaries.push({
      sourceId: pair.sourceId,
      sourceName: pair.sourceName,
      sourceType: pair.sourceType,
      outcome: pair.outcome,
      compared: true,
      monitorId: pair.monitorId,
      vigilChecks: pair.vigilChecks,
      overlapHours: Math.round(pairOverlap * 10) / 10,
      matched: result.matched,
      missed: result.missed,
      extra: result.extra,
      unprovable: result.unprovable,
      belowWindow: result.belowWindow,
      detail: pair.detail,
    });
  }

  const manualWork: string[] = [...input.manualNotes];
  for (const pair of input.pairs) {
    if (pair.outcome === "unsupported" || pair.outcome === "skipped") {
      manualWork.push(
        `${pair.sourceName} (${pair.sourceType}): ${pair.detail}`,
      );
    } else if (pair.monitorId === null) {
      manualWork.push(
        `${pair.sourceName} (${pair.sourceType}): was imported and its Vigil monitor has since been deleted here. Re-import it, or consciously retire the coverage before cutover.`,
      );
    } else if (!pair.compared) {
      manualWork.push(
        `${pair.sourceName} (${pair.sourceType}): imported, but its job still reports to the source system. Repoint it at the Vigil push endpoint at cutover; until then its silence here proves nothing.`,
      );
    }
  }

  // The verdict. Every reason is written; SAFE is the absence of all of
  // them plus positive evidence of enough watching.
  const reasons: string[] = [];
  if (totals.missed > 0) {
    reasons.push(
      `${totals.missed} outage(s) the source recorded were provably not detected by Vigil. Each one is listed; cutting over before they are explained risks missing the same outage in production.`,
    );
  }
  if (totals.openExtra > 0) {
    reasons.push(
      `${totals.openExtra} imported monitor(s) read down in Vigil right now while the source, as of the last successful poll, reads them fine. A monitor that is wrong before cutover will be wrong after it; each one's import report line usually names the cause (an uncarried credential, header or certificate setting).`,
    );
  }
  if (totals.deleted > 0) {
    reasons.push(
      `${totals.deleted} imported monitor(s) have been deleted here since the import: ${deletedPairs
        .slice(0, 5)
        .map((p) => p.sourceName)
        .join(
          ", ",
        )}${totals.deleted > 5 ? ` and ${totals.deleted - 5} more` : ""}. The source still watches those targets and, after cutover, nothing would.`,
    );
  }
  if (input.consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
    reasons.push(
      `The evidence feed itself is failing: the last ${input.consecutivePollFailures} polls did not complete, so recent source history is unknown.`,
    );
  }
  const thin = pairSummaries.filter(
    (p) => p.compared && p.overlapHours < MIN_COMPARISON_HOURS,
  );
  if (thin.length > 0) {
    reasons.push(
      `${thin.length} compared monitor(s) have under ${MIN_COMPARISON_HOURS} hours of overlap between the source evidence and Vigil's own observation, so their quiet proves little yet: ${thin
        .slice(0, 5)
        .map((p) => `${p.sourceName} (${p.overlapHours}h)`)
        .join(
          ", ",
        )}${thin.length > 5 ? ` and ${thin.length - 5} more` : ""}. Source history reaches back before the bridge existed; agreement is only provable where both systems watched.`,
    );
  }
  const silent = pairSummaries.filter((p) => p.compared && p.vigilChecks === 0);
  if (silent.length > 0) {
    reasons.push(
      `${silent.length} imported monitor(s) have recorded no observations during the comparison, so nothing about them has been compared: ${silent
        .slice(0, 5)
        .map((p) => p.sourceName)
        .join(
          ", ",
        )}${silent.length > 5 ? ` and ${silent.length - 5} more` : ""}.`,
    );
  }
  if (totals.unsupported + totals.skipped > 0) {
    reasons.push(
      `${totals.unsupported + totals.skipped} source record(s) did not become Vigil monitors. Their coverage disappears at cutover unless it is recreated or consciously retired; the manual work list names each one.`,
    );
  }
  const uncomparedImported = pairSummaries.filter(
    (p) => !p.compared && p.monitorId !== null,
  );
  if (uncomparedImported.length > 0) {
    reasons.push(
      `${uncomparedImported.length} imported record(s) cannot be compared from here (heartbeat jobs still report to the source). They need their own cutover step.`,
    );
  }

  const verdict: "safe" | "not-safe" =
    reasons.length === 0 ? "safe" : "not-safe";
  if (verdict === "safe") {
    reasons.push(
      `Every comparable monitor was watched by both systems for at least ${MIN_COMPARISON_HOURS} hours of overlapping evidence, every incident either matched or is excused by a documented semantic difference, and nothing the source recorded went unexplained.`,
    );
  }

  return {
    window: { from: coverage[0]?.from ?? null, to: input.at },
    coverage,
    coveredHours: Math.round(coveredHours * 10) / 10,
    totals,
    timing: {
      detectionMedianSeconds: median(detectionDeltas),
      detectionWorstSeconds: worst(detectionDeltas),
      recoveryMedianSeconds: median(recoveryDeltas),
      recoveryWorstSeconds: worst(recoveryDeltas),
      samples: detectionDeltas.length,
    },
    pairs: pairSummaries,
    findings,
    manualWork,
    verdict,
    reasons,
  };
}
