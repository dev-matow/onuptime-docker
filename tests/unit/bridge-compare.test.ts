import { describe, expect, it } from "vitest";

import {
  MATCH_GRACE_SECONDS,
  MAX_CONSECUTIVE_POLL_FAILURES,
  MIN_COMPARISON_HOURS,
  compareBridge,
  mergeCoverage,
  type ComparisonInput,
  type ComparisonPair,
  type CoverageWindow,
  type EventFinding,
  type SourceEvent,
  type VigilEvent,
} from "@/modules/importers/bridge/compare";

/**
 * The comparison engine, pinned on the rows that decide a verdict.
 *
 * Everything here is an object literal against `compareBridge`, because
 * the module's two rules only mean something at the edges: an incident
 * the coverage cannot see must stay unknown, and SAFE must be the
 * absence of every written reason rather than the default.
 */

/** The report window closes here; one hour into the second day. */
const AT = new Date("2026-08-02T01:00:00Z");

/** Twenty-five covered hours ending exactly at the report time. */
function fullDay(): CoverageWindow[] {
  return [
    {
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-08-02T01:00:00Z"),
    },
  ];
}

function makePair(patch: Partial<ComparisonPair> = {}): ComparisonPair {
  return {
    sourceId: "src-1",
    sourceName: "API uptime",
    sourceType: "status",
    monitorId: "mon-1",
    outcome: "imported",
    detail: "Imported as an http monitor.",
    compared: true,
    observedSince: new Date("2026-08-01T00:00:00Z"),
    failureWindowSeconds: 60,
    vigilChecks: 480,
    sourceEvents: [],
    vigilEvents: [],
    ...patch,
  };
}

function sourceEvent(patch: Partial<SourceEvent> = {}): SourceEvent {
  const end =
    patch.end === undefined ? new Date("2026-08-01T10:30:00Z") : patch.end;
  return {
    id: "s-1",
    resourceId: "src-1",
    start: new Date("2026-08-01T10:00:00Z"),
    cause: null,
    ...patch,
    end,
    // An observed resolution pins the copy's accuracy at the end; an
    // open copy defaults to freshly-refreshed at the report time.
    observedUntil: patch.observedUntil ?? end ?? AT,
  };
}

function vigilEvent(patch: Partial<VigilEvent> = {}): VigilEvent {
  return {
    id: "v-1",
    start: new Date("2026-08-01T10:01:30Z"),
    end: new Date("2026-08-01T10:31:00Z"),
    ...patch,
  };
}

function makeInput(patch: Partial<ComparisonInput> = {}): ComparisonInput {
  return {
    at: AT,
    pairs: [],
    coverage: fullDay(),
    manualNotes: [],
    consecutivePollFailures: 0,
    ...patch,
  };
}

/** The single finding of a kind, or a loud failure naming what was seen. */
function only(findings: EventFinding[], kind: string): EventFinding {
  const matching = findings.filter((finding) => finding.kind === kind);
  const [first] = matching;
  if (first === undefined || matching.length !== 1) {
    throw new Error(
      `expected exactly one "${kind}" finding, saw ${findings
        .map((finding) => finding.kind)
        .join(", ")}`,
    );
  }
  return first;
}

describe("the published constants", () => {
  it("hold the values the doc comments promise", () => {
    expect(MATCH_GRACE_SECONDS).toBe(300);
    expect(MIN_COMPARISON_HOURS).toBe(24);
    expect(MAX_CONSECUTIVE_POLL_FAILURES).toBe(4);
  });
});

describe("mergeCoverage", () => {
  it("merges overlapping and touching windows, whatever order they arrive in", () => {
    const merged = mergeCoverage([
      {
        from: new Date("2026-08-01T01:00:00Z"),
        to: new Date("2026-08-01T03:00:00Z"),
      },
      {
        from: new Date("2026-08-01T00:00:00Z"),
        to: new Date("2026-08-01T02:00:00Z"),
      },
      // Touches the end of the union exactly; touching merges.
      {
        from: new Date("2026-08-01T03:00:00Z"),
        to: new Date("2026-08-01T04:00:00Z"),
      },
      // Entirely inside; must not shrink the union.
      {
        from: new Date("2026-08-01T01:30:00Z"),
        to: new Date("2026-08-01T02:30:00Z"),
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(merged[0]?.to.toISOString()).toBe("2026-08-01T04:00:00.000Z");
  });

  it("keeps disjoint windows apart: a gap is a gap", () => {
    const merged = mergeCoverage([
      {
        from: new Date("2026-08-01T00:00:00Z"),
        to: new Date("2026-08-01T10:00:00Z"),
      },
      {
        from: new Date("2026-08-01T10:05:00Z"),
        to: new Date("2026-08-01T20:00:00Z"),
      },
    ]);
    // Two windows five minutes apart never become one; a span crossing
    // the gap is not covered, and the unprovable case below leans on it.
    expect(merged).toHaveLength(2);
    expect(merged[0]?.to.toISOString()).toBe("2026-08-01T10:00:00.000Z");
    expect(merged[1]?.from.toISOString()).toBe("2026-08-01T10:05:00.000Z");
  });

  it("drops zero-length and negative windows", () => {
    const merged = mergeCoverage([
      {
        from: new Date("2026-08-01T05:00:00Z"),
        to: new Date("2026-08-01T05:00:00Z"),
      },
      {
        from: new Date("2026-08-01T06:00:00Z"),
        to: new Date("2026-08-01T05:30:00Z"),
      },
    ]);
    expect(merged).toEqual([]);
  });
});

describe("matching", () => {
  it("pairs overlapping incidents and reports both deltas signed", () => {
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair({
            sourceEvents: [sourceEvent()],
            vigilEvents: [vigilEvent()],
          }),
        ],
      }),
    );
    const finding = only(report.findings, "matched");
    expect(finding.sourceEventId).toBe("s-1");
    expect(finding.vigilEventId).toBe("v-1");
    // Vigil opened 90s after the source and recovered 60s after it.
    expect(finding.detectionDeltaSeconds).toBe(90);
    expect(finding.recoveryDeltaSeconds).toBe(60);
    expect(report.totals.matched).toBe(1);
  });

  it("leaves the recovery delta null while the Vigil incident is open", () => {
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair({
            sourceEvents: [sourceEvent()],
            vigilEvents: [vigilEvent({ end: null })],
          }),
        ],
      }),
    );
    const finding = only(report.findings, "matched");
    expect(finding.detectionDeltaSeconds).toBe(90);
    expect(finding.recoveryDeltaSeconds).toBeNull();
  });

  it("leaves the recovery delta null when the source end was never observed", () => {
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair({
            sourceEvents: [
              sourceEvent({
                end: null,
                observedUntil: new Date("2026-08-01T18:00:00Z"),
              }),
            ],
            vigilEvents: [vigilEvent()],
          }),
        ],
      }),
    );
    const finding = only(report.findings, "matched");
    expect(finding.recoveryDeltaSeconds).toBeNull();
    expect(report.timing.recoveryMedianSeconds).toBeNull();
  });

  it("refuses to match across a gap wider than the grace itself", () => {
    // The tolerance is the constant, not twice it: a padding bug that
    // extended BOTH intervals matched a miss to an unrelated blip up to
    // ten minutes away and reported the pair as agreement.
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair({
            sourceEvents: [
              sourceEvent({ end: new Date("2026-08-01T10:02:00Z") }),
            ],
            // 400s after the source recovered: beyond 300s, two events.
            vigilEvents: [
              vigilEvent({
                start: new Date("2026-08-01T10:08:40Z"),
                end: new Date("2026-08-01T10:20:00Z"),
              }),
            ],
          }),
        ],
      }),
    );
    expect(report.totals.matched).toBe(0);
    expect(report.totals.missed).toBe(1);
    expect(report.totals.extra).toBe(1);
  });

  it("still matches a near miss inside the grace", () => {
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair({
            sourceEvents: [
              sourceEvent({ end: new Date("2026-08-01T10:02:00Z") }),
            ],
            // Starts 240s after the source recovered, inside the 300s grace.
            vigilEvents: [
              vigilEvent({
                start: new Date("2026-08-01T10:06:00Z"),
                end: new Date("2026-08-01T10:30:00Z"),
              }),
            ],
          }),
        ],
      }),
    );
    const finding = only(report.findings, "matched");
    expect(finding.detectionDeltaSeconds).toBe(360);
  });

  it("refuses to match two events far beyond the grace", () => {
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair({
            sourceEvents: [
              sourceEvent({ end: new Date("2026-08-01T10:02:00Z") }),
            ],
            // Starts 720s after the source recovered; two events are two
            // events, so one reads missed and the other reads extra.
            vigilEvents: [
              vigilEvent({
                start: new Date("2026-08-01T10:14:00Z"),
                end: new Date("2026-08-01T10:40:00Z"),
              }),
            ],
          }),
        ],
      }),
    );
    expect(report.totals.matched).toBe(0);
    expect(report.totals.missed).toBe(1);
    expect(report.totals.extra).toBe(1);
  });
});

describe("the excuses, in order", () => {
  it("counts a covered, observed, long-enough unmatched source outage as missed", () => {
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair({
            sourceEvents: [sourceEvent({ cause: "HTTP 500" })],
          }),
        ],
      }),
    );
    const finding = only(report.findings, "missed");
    expect(finding.detail).toContain("HTTP 500");
    expect(report.verdict).toBe("not-safe");
    expect(
      report.reasons.some((reason) =>
        reason.includes("provably not detected by Vigil"),
      ),
    ).toBe(true);
  });

  it("excuses a blip shorter than the failure window, and it alone keeps SAFE", () => {
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair({
            failureWindowSeconds: 60,
            sourceEvents: [
              sourceEvent({ end: new Date("2026-08-01T10:00:30Z") }),
            ],
          }),
        ],
      }),
    );
    const finding = only(report.findings, "below-window");
    expect(finding.detail).toContain("30s blip");
    expect(report.totals.belowWindow).toBe(1);
    expect(report.totals.missed).toBe(0);
    // Everything else about this input is clean, so the blip by itself
    // must not flip the verdict: Vigil not opening below the window is
    // the documented trade, not a disagreement.
    expect(report.verdict).toBe("safe");
  });

  it("counts a miss even when the outage straddles a poll-coverage gap", () => {
    // Coverage gates source SILENCE, never a copied source row: the row
    // itself is the evidence the outage happened, and a coverage
    // requirement here would excuse exactly the outages a flaky
    // evidence feed makes hardest to see.
    const report = compareBridge(
      makeInput({
        coverage: [
          {
            from: new Date("2026-08-01T00:00:00Z"),
            to: new Date("2026-08-01T10:00:00Z"),
          },
          {
            from: new Date("2026-08-01T10:05:00Z"),
            to: new Date("2026-08-02T01:00:00Z"),
          },
        ],
        pairs: [
          makePair({
            sourceEvents: [
              sourceEvent({
                start: new Date("2026-08-01T09:50:00Z"),
                end: new Date("2026-08-01T10:10:00Z"),
              }),
            ],
          }),
        ],
      }),
    );
    only(report.findings, "missed");
    expect(report.totals.missed).toBe(1);
    expect(report.verdict).toBe("not-safe");
  });

  it("counts a still-open source outage as missed once it provably outlived the window", () => {
    // No end was ever observed, but the copy was seen still open two
    // hours after it started: the duration's lower bound clears any
    // sane failure window, and 'unresolved' must not read as 'unknown'.
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair({
            sourceEvents: [
              sourceEvent({
                start: new Date("2026-08-01T10:00:00Z"),
                end: null,
                observedUntil: new Date("2026-08-01T12:00:00Z"),
              }),
            ],
          }),
        ],
      }),
    );
    const finding = only(report.findings, "missed");
    expect(finding.detail).toContain("still unresolved when last observed");
    expect(report.totals.missed).toBe(1);
  });

  it("cannot judge an open copy that went stale inside the failure window", () => {
    // Last seen 30s after it started, against a 60s window, end never
    // observed: it may have been a blip Vigil rightly ignored. Unknown
    // stays unknown - for either side.
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair({
            failureWindowSeconds: 60,
            sourceEvents: [
              sourceEvent({
                start: new Date("2026-08-01T10:00:00Z"),
                end: null,
                observedUntil: new Date("2026-08-01T10:00:30Z"),
              }),
            ],
          }),
        ],
      }),
    );
    const finding = only(report.findings, "unprovable");
    expect(finding.detail).toContain("cannot be counted either way");
    expect(report.totals.missed).toBe(0);
    expect(report.totals.belowWindow).toBe(0);
  });

  it("reports an incident from before observation began as unprovable", () => {
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair({
            observedSince: new Date("2026-08-01T12:00:00Z"),
            sourceEvents: [
              sourceEvent({
                start: new Date("2026-08-01T08:00:00Z"),
                end: new Date("2026-08-01T08:30:00Z"),
              }),
            ],
          }),
        ],
      }),
    );
    const finding = only(report.findings, "unprovable");
    expect(finding.detail).toContain("predates");
    expect(report.totals.missed).toBe(0);
  });
});

describe("extras", () => {
  it("reports a closed Vigil-only incident as extra without flipping the verdict", () => {
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair({
            vigilEvents: [
              vigilEvent({
                start: new Date("2026-08-01T05:00:00Z"),
                end: new Date("2026-08-01T05:30:00Z"),
              }),
            ],
          }),
        ],
      }),
    );
    const finding = only(report.findings, "extra");
    expect(finding.sourceEventId).toBeNull();
    expect(finding.vigilEventId).toBe("v-1");
    expect(report.totals.extra).toBe(1);
    expect(report.totals.openExtra).toBe(0);
    // A historical disagreement is a report line, not a blocker.
    expect(report.verdict).toBe("safe");
  });

  it("reads a still-open extra as a live disagreement and blocks", () => {
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair({
            vigilEvents: [
              vigilEvent({
                start: new Date("2026-08-01T05:00:00Z"),
                end: null,
              }),
            ],
          }),
        ],
      }),
    );
    expect(report.totals.extra).toBe(1);
    expect(report.totals.openExtra).toBe(1);
    expect(report.verdict).toBe("not-safe");
    expect(
      report.reasons.some((reason) =>
        reason.includes("read down in Vigil right now"),
      ),
    ).toBe(true);
  });

  it("flags a live disagreement even though coverage always lags the report", () => {
    // In production every poll window closes BEFORE the report is
    // generated, so an open incident's span can never be covered up to
    // `at`. The claim is honest up to the last successful poll, and
    // requiring more once made this blocker dead code: a fleet reading
    // down all week reported SAFE because "now" was never covered.
    const report = compareBridge(
      makeInput({
        at: new Date("2026-08-02T01:00:00Z"),
        coverage: [
          {
            from: new Date("2026-08-01T00:00:00Z"),
            // The last poll finished half an hour before the report.
            to: new Date("2026-08-02T00:30:00Z"),
          },
        ],
        pairs: [
          makePair({
            vigilEvents: [
              vigilEvent({
                start: new Date("2026-08-01T05:00:00Z"),
                end: null,
              }),
            ],
          }),
        ],
      }),
    );
    expect(report.totals.openExtra).toBe(1);
    expect(report.verdict).toBe("not-safe");
  });

  it("keeps an open incident the polls never saw past unprovable", () => {
    // Started after the last successful poll: whether the source also
    // sees it is genuinely unknown.
    const report = compareBridge(
      makeInput({
        at: new Date("2026-08-02T01:00:00Z"),
        coverage: [
          {
            from: new Date("2026-08-01T00:00:00Z"),
            to: new Date("2026-08-02T00:30:00Z"),
          },
        ],
        pairs: [
          makePair({
            vigilEvents: [
              vigilEvent({
                start: new Date("2026-08-02T00:45:00Z"),
                end: null,
              }),
            ],
          }),
        ],
      }),
    );
    expect(report.totals.openExtra).toBe(0);
    only(report.findings, "unprovable");
  });
});

describe("deleted monitors", () => {
  it("keeps a deleted pair in the verdict instead of letting it slip out", () => {
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair(),
          makePair({
            sourceId: "src-gone",
            sourceName: "Deleted API",
            monitorId: null,
            compared: false,
            observedSince: null,
            vigilChecks: 0,
          }),
        ],
      }),
    );
    expect(report.totals.deleted).toBe(1);
    expect(report.verdict).toBe("not-safe");
    expect(
      report.reasons.some(
        (reason) =>
          reason.includes("deleted here since the import") &&
          reason.includes("Deleted API"),
      ),
    ).toBe(true);
    expect(
      report.manualWork.some(
        (entry) =>
          entry.startsWith("Deleted API") &&
          entry.includes("has since been deleted here"),
      ),
    ).toBe(true);
  });
});

describe("the verdict", () => {
  it("refuses SAFE on thin coverage", () => {
    const report = compareBridge(
      makeInput({
        at: new Date("2026-08-01T10:00:00Z"),
        coverage: [
          {
            from: new Date("2026-08-01T00:00:00Z"),
            to: new Date("2026-08-01T10:00:00Z"),
          },
        ],
        pairs: [makePair()],
      }),
    );
    expect(report.coveredHours).toBe(10);
    expect(report.verdict).toBe("not-safe");
    expect(
      report.reasons.some((reason) =>
        reason.includes(
          `under ${MIN_COMPARISON_HOURS} hours of overlap between the source evidence and Vigil's own observation`,
        ),
      ),
    ).toBe(true);
  });

  it("refuses SAFE when source coverage is wide but the pair is newly observed", () => {
    // The first poll reaches a day into the past, so raw coverage can
    // exceed the floor minutes after a bridge is created. What must not
    // pass the floor is the OVERLAP with Vigil's own watching.
    const report = compareBridge(
      makeInput({
        at: new Date("2026-08-02T01:00:00Z"),
        coverage: [
          {
            from: new Date("2026-08-01T00:00:00Z"),
            to: new Date("2026-08-02T01:00:00Z"),
          },
        ],
        pairs: [
          makePair({
            observedSince: new Date("2026-08-02T00:30:00Z"),
            vigilChecks: 3,
          }),
        ],
      }),
    );
    expect(report.coveredHours).toBe(25);
    expect(report.verdict).toBe("not-safe");
    expect(
      report.reasons.some((reason) => reason.includes("hours of overlap")),
    ).toBe(true);
    expect(report.pairs[0]!.overlapHours).toBe(0.5);
  });

  it("refuses SAFE when the evidence feed itself is failing", () => {
    const failing = compareBridge(
      makeInput({
        pairs: [makePair()],
        consecutivePollFailures: MAX_CONSECUTIVE_POLL_FAILURES,
      }),
    );
    expect(failing.verdict).toBe("not-safe");
    expect(
      failing.reasons.some((reason) =>
        reason.includes("evidence feed itself is failing"),
      ),
    ).toBe(true);

    const belowCeiling = compareBridge(
      makeInput({
        pairs: [makePair()],
        consecutivePollFailures: MAX_CONSECUTIVE_POLL_FAILURES - 1,
      }),
    );
    expect(belowCeiling.verdict).toBe("safe");
  });

  it("refuses SAFE for a compared monitor with no observations at all", () => {
    const report = compareBridge(
      makeInput({ pairs: [makePair({ vigilChecks: 0 })] }),
    );
    expect(report.verdict).toBe("not-safe");
    expect(
      report.reasons.some(
        (reason) =>
          reason.includes("no observations during the comparison") &&
          reason.includes("API uptime"),
      ),
    ).toBe(true);
  });

  it("refuses SAFE while any source record became no monitor", () => {
    for (const outcome of ["unsupported", "skipped"]) {
      const report = compareBridge(
        makeInput({
          manualNotes: ["Status page X must be rebuilt by hand."],
          pairs: [
            makePair(),
            makePair({
              sourceId: "src-2",
              sourceName: "Old TCP check",
              sourceType: "tcp",
              monitorId: null,
              outcome,
              compared: false,
              observedSince: null,
              failureWindowSeconds: null,
              vigilChecks: 0,
              detail: "No Vigil equivalent.",
            }),
          ],
        }),
      );
      expect(report.verdict, outcome).toBe("not-safe");
      expect(
        report.reasons.some((reason) =>
          reason.includes("did not become Vigil monitors"),
        ),
        outcome,
      ).toBe(true);
      expect(report.manualWork).toContain(
        "Old TCP check (tcp): No Vigil equivalent.",
      );
      expect(report.manualWork).toContain(
        "Status page X must be rebuilt by hand.",
      );
    }
  });

  it("refuses SAFE for an imported record it cannot compare, and demands the repoint", () => {
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair(),
          makePair({
            sourceId: "src-hb",
            sourceName: "Nightly backup",
            sourceType: "heartbeat",
            monitorId: "mon-hb",
            compared: false,
          }),
        ],
      }),
    );
    expect(report.verdict).toBe("not-safe");
    expect(
      report.reasons.some((reason) =>
        reason.includes("cannot be compared from here"),
      ),
    ).toBe(true);
    expect(
      report.manualWork.some(
        (entry) =>
          entry.startsWith("Nightly backup (heartbeat):") &&
          entry.includes("Repoint it at the Vigil push endpoint"),
      ),
    ).toBe(true);
  });

  it("says SAFE, once, when everything is watched and everything agrees", () => {
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair({
            sourceEvents: [sourceEvent()],
            vigilEvents: [vigilEvent()],
          }),
          makePair({
            sourceId: "src-2",
            sourceName: "Docs",
            monitorId: "mon-2",
          }),
        ],
      }),
    );
    expect(report.verdict).toBe("safe");
    expect(report.reasons).toHaveLength(1);
    expect(report.reasons[0]).toContain("Every comparable monitor was watched");
    expect(report.coveredHours).toBe(25);
    expect(report.window.from?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(report.window.to).toBe(AT);
  });
});

describe("timing", () => {
  it("takes the median over matched pairs and the worst by magnitude, signed", () => {
    const report = compareBridge(
      makeInput({
        pairs: [
          makePair({
            sourceId: "src-a",
            sourceEvents: [
              sourceEvent({
                id: "s-a",
                start: new Date("2026-08-01T10:00:00Z"),
                end: new Date("2026-08-01T10:10:00Z"),
              }),
            ],
            vigilEvents: [
              vigilEvent({
                id: "v-a",
                start: new Date("2026-08-01T10:00:30Z"),
                end: new Date("2026-08-01T10:10:10Z"),
              }),
            ],
          }),
          makePair({
            sourceId: "src-b",
            monitorId: "mon-b",
            sourceEvents: [
              sourceEvent({
                id: "s-b",
                start: new Date("2026-08-01T12:00:00Z"),
                end: new Date("2026-08-01T12:30:00Z"),
              }),
            ],
            // Vigil saw both edges before the source did.
            vigilEvents: [
              vigilEvent({
                id: "v-b",
                start: new Date("2026-08-01T11:58:30Z"),
                end: new Date("2026-08-01T12:29:40Z"),
              }),
            ],
          }),
          makePair({
            sourceId: "src-c",
            monitorId: "mon-c",
            sourceEvents: [
              sourceEvent({
                id: "s-c",
                start: new Date("2026-08-01T14:00:00Z"),
                end: new Date("2026-08-01T14:30:00Z"),
              }),
            ],
            // Still open in Vigil: a detection sample, no recovery sample.
            vigilEvents: [
              vigilEvent({
                id: "v-c",
                start: new Date("2026-08-01T14:00:45Z"),
                end: null,
              }),
            ],
          }),
        ],
      }),
    );
    // Detection deltas are 30, -90 and 45 seconds.
    expect(report.timing.samples).toBe(3);
    expect(report.timing.detectionMedianSeconds).toBe(30);
    expect(report.timing.detectionWorstSeconds).toBe(-90);
    // Recovery deltas are 10 and -20 seconds; the open incident adds none.
    expect(report.timing.recoveryMedianSeconds).toBe(-5);
    expect(report.timing.recoveryWorstSeconds).toBe(-20);
  });
});

describe("the totals", () => {
  it("agree with the findings list and the pair count", () => {
    const input = makeInput({
      pairs: [
        makePair({
          sourceId: "src-a",
          sourceName: "Alpha",
          sourceEvents: [
            sourceEvent({ id: "s-1" }),
            sourceEvent({
              id: "s-2",
              start: new Date("2026-08-01T15:00:00Z"),
              end: new Date("2026-08-01T15:20:00Z"),
            }),
          ],
          vigilEvents: [vigilEvent({ id: "v-1" })],
        }),
        makePair({
          sourceId: "src-b",
          sourceName: "Beta",
          monitorId: "mon-b",
          observedSince: new Date("2026-08-01T20:00:00Z"),
          sourceEvents: [
            // Predates observation: unprovable.
            sourceEvent({
              id: "s-3",
              start: new Date("2026-08-01T08:00:00Z"),
              end: new Date("2026-08-01T08:30:00Z"),
            }),
            // Thirty seconds against a sixty second window: below-window.
            sourceEvent({
              id: "s-4",
              start: new Date("2026-08-01T22:00:00Z"),
              end: new Date("2026-08-01T22:00:30Z"),
            }),
          ],
          vigilEvents: [
            vigilEvent({
              id: "v-2",
              start: new Date("2026-08-01T21:00:00Z"),
              end: new Date("2026-08-01T21:30:00Z"),
            }),
          ],
        }),
      ],
    });
    const report = compareBridge(input);

    expect(report.totals).toEqual({
      sourceRecords: 2,
      imported: 2,
      transformed: 0,
      skipped: 0,
      unsupported: 0,
      deleted: 0,
      comparedPairs: 2,
      matched: 1,
      missed: 1,
      extra: 1,
      openExtra: 0,
      unprovable: 1,
      belowWindow: 1,
    });

    const count = (kind: string): number =>
      report.findings.filter((finding) => finding.kind === kind).length;
    expect(count("matched")).toBe(report.totals.matched);
    expect(count("missed")).toBe(report.totals.missed);
    expect(count("extra")).toBe(report.totals.extra);
    expect(count("unprovable")).toBe(report.totals.unprovable);
    expect(count("below-window")).toBe(report.totals.belowWindow);
    expect(report.findings).toHaveLength(5);
    expect(report.totals.sourceRecords).toBe(input.pairs.length);

    const alpha = report.pairs.find((pair) => pair.sourceId === "src-a");
    expect(alpha?.matched).toBe(1);
    expect(alpha?.missed).toBe(1);
    const beta = report.pairs.find((pair) => pair.sourceId === "src-b");
    expect(beta?.extra).toBe(1);
    expect(beta?.unprovable).toBe(1);
    expect(beta?.belowWindow).toBe(1);
  });
});
