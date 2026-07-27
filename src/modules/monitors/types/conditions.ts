import type { Assertion, FactBag, ProbeResult } from "./contract";

/**
 * The shared condition engine.
 *
 * Every check type funnels through this one function, which is the
 * point: judgment is written once for all types instead of once per
 * type. A new type ships a probe and a list of assertions and inherits
 * every downstream behaviour — degraded handling, failure
 * classification, the reason string on the timeline — for free.
 *
 * It is a pure function of (assertions, config, facts), so a stored
 * observation can be re-judged later against a different spec version
 * without re-probing anything. That property is what forensic replay
 * will be built on, and it only holds because probes never judge.
 */

/** Why a check is not passing. `null` when it is. */
export type FailureClass =
  /** The probe could not reach or measure the target at all. */
  | "transport"
  /** The probe measured fine; a declared assertion did not hold. */
  | "assertion"
  /** The probe cannot run in this environment — an operator problem. */
  | "misconfigured"
  | null;

/**
 * `indeterminate` is the answer when Vigil does not know: the probe
 * could not run here. It is deliberately not `down`. A missing ICMP
 * capability is an operator error, and an operator error that looks
 * identical to an outage is the one failure a monitoring product may
 * not have.
 */
export type Verdict = "up" | "degraded" | "down" | "indeterminate";

export interface Judgment {
  verdict: Verdict;
  /** `up` or `degraded`. Kept because most call sites only care. */
  ok: boolean;
  degraded: boolean;
  failureClass: FailureClass;
  /** Operator-facing reason, or null when everything held. */
  error: string | null;
  /** Ids of every assertion that did not hold, in declaration order. */
  failedAssertions: string[];
}

const PASSING: Omit<Judgment, "verdict" | "ok" | "degraded"> = {
  failureClass: null,
  error: null,
  failedAssertions: [],
};

export function judge<Config>(
  assertions: readonly Assertion<Config>[],
  config: Config,
  result: ProbeResult,
): Judgment {
  // Order matters and is not arbitrary. "Cannot run here" outranks
  // "cannot reach", which outranks "reached it and disliked what I
  // found" — each later question is only meaningful if the earlier one
  // came back clean.
  if (result.unavailable) {
    return {
      verdict: "indeterminate",
      ok: false,
      degraded: false,
      failureClass: "misconfigured",
      error: result.unavailable,
      failedAssertions: [],
    };
  }

  if (result.error) {
    return {
      verdict: "down",
      ok: false,
      degraded: false,
      failureClass: "transport",
      error: result.error,
      failedAssertions: [],
    };
  }

  const failedDown: Array<{ id: string; message: string }> = [];
  const failedDegraded: Array<{ id: string; message: string }> = [];

  for (const assertion of assertions) {
    if (assertion.applies && !assertion.applies(config)) continue;
    const message = assertion.evaluate(result.facts[assertion.fact], config);
    if (message === null) continue;
    (assertion.severity === "down" ? failedDown : failedDegraded).push({
      id: assertion.id,
      message,
    });
  }

  const failedAssertions = [...failedDown, ...failedDegraded].map((f) => f.id);

  if (failedDown.length > 0) {
    return {
      verdict: "down",
      ok: false,
      degraded: false,
      failureClass: "assertion",
      // The first failure is the one worth reading; listing all of them
      // buries the cause. The full set is in `failedAssertions`.
      error: failedDown[0]!.message,
      failedAssertions,
    };
  }

  if (failedDegraded.length > 0) {
    return {
      verdict: "degraded",
      ok: true,
      degraded: true,
      // A degraded check is passing, so it has no failure class — but it
      // does have a reason, and hiding it is how "why is this amber?"
      // becomes unanswerable.
      failureClass: null,
      error: failedDegraded[0]!.message,
      failedAssertions,
    };
  }

  return { verdict: "up", ok: true, degraded: false, ...PASSING };
}

/** Reads a fact as a number, or null when it is absent or not numeric. */
export function numberFact(facts: FactBag, key: string): number | null {
  const value = facts[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reads a fact as a string list, tolerating a single string. */
export function listFact(facts: FactBag, key: string): string[] {
  const value = facts[key];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return typeof value === "string" ? [value] : [];
}
