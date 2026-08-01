import type { Verdict } from "./types/conditions";

/**
 * The scheduler's only abstraction.
 *
 * `nextEvaluationAt(spec, recentObservations)` is deliberately the
 * entire interface. Today it returns something close to
 * `last + interval`; later it will return something derived from
 * observed volatility and a detection budget. The scheduler never
 * learns which, and never has to change.
 *
 * What this replaces is the real problem: `WHERE last_checked_at +
 * interval <= now()` encodes the *policy* inside the *selection*, so
 * changing the policy means rewriting the scheduler instead of swapping
 * a function.
 */

/**
 * A clamp, not a promise, and deliberately below anything this plane
 * delivers.
 *
 * The policy may ask for sooner than this — a suspicious monitor on the
 * 2s minimum asks for 125ms — and what that request means in practice is
 * "as soon as the queue will have me", which is pg-boss's poll at about
 * 2000ms measured. So this number is unreachable by construction on this
 * plane and always has been. It exists so that lowering the settable
 * minimum or raising SUSPICION_DIVISOR later cannot produce a nonsense
 * cadence. Nothing about the product should ever be described in terms
 * of it, and it is not the floor: MIN_INTERVAL_SECONDS is.
 *
 * That it happens to equal the high-frequency plane's floor is a
 * coincidence and not a connection. `highfreq/` does not read this
 * constant, does not go through `nextEvaluationAt`, and does not use
 * this scheduler at all — it has its own monotonic timer and its own
 * measured floor. If one of the two numbers moves, the other does not
 * follow it.
 */
export const MIN_EVALUATION_MS = 500;

/** Nothing is ever scheduled further out than this, whatever the maths. */
export const MAX_EVALUATION_MS = 6 * 60 * 60 * 1000;

/** How far a suspicious monitor tightens below its baseline. */
export const SUSPICION_DIVISOR = 16;

/** How far a monitor with a long clean run relaxes above its baseline. */
export const CALM_MULTIPLIER = 2;

/** Clean observations required before a monitor is treated as calm. */
export const CALM_RUN_LENGTH = 10;

export interface EvaluationSpec {
  intervalSeconds: number;
  /**
   * The monitor's derived status. Tightening exists to shorten the gap
   * between the first failure and the verdict; once the verdict is in,
   * there is nothing left to detect faster and the extra requests only
   * land on a target that is already struggling.
   */
  currentStatus?: "up" | "down" | "degraded" | "unknown";
}

export interface RecentObservation {
  ok: boolean;
  verdict?: Verdict | null;
}

/**
 * Whether the recent history warrants probing harder than the operator
 * asked for. Any failure at all in the recent window counts: the
 * expensive mistake is being slow to notice a real outage, not spending
 * a few extra requests on a target that blipped once.
 */
function suspicious(recent: readonly RecentObservation[]): boolean {
  return recent.some(
    (observation) => !observation.ok && observation.verdict !== "indeterminate",
  );
}

/**
 * A monitor is calm when it has a long unbroken run of clean, non-degraded
 * observations. `indeterminate` breaks the run without making the
 * monitor suspicious — not knowing is not the same as being fine.
 */
function calm(recent: readonly RecentObservation[]): boolean {
  if (recent.length < CALM_RUN_LENGTH) return false;
  return recent
    .slice(0, CALM_RUN_LENGTH)
    .every(
      (observation) => observation.ok && observation.verdict !== "degraded",
    );
}

/**
 * When this monitor should next be evaluated.
 *
 * Pure, so the policy can be tested without a database and — more
 * importantly — so a stored history can be replayed through a different
 * policy to see what it would have done.
 *
 * @param recentObservations newest first.
 */
export function nextEvaluationAt(
  spec: EvaluationSpec,
  recentObservations: readonly RecentObservation[],
  now: Date = new Date(),
): Date {
  const baselineMs = spec.intervalSeconds * 1000;

  // Already down: back to the baseline. The window worth spending
  // requests on is the one between the first failure and the incident —
  // after that, probing sixteen times as often changes nothing except
  // the load on something that is already broken. (Recovery has its own
  // verification probe and does not rely on this cadence.)
  const settled = spec.currentStatus === "down";

  const delayMs =
    !settled && suspicious(recentObservations)
      ? baselineMs / SUSPICION_DIVISOR
      : calm(recentObservations)
        ? baselineMs * CALM_MULTIPLIER
        : baselineMs;

  const clamped = Math.min(
    MAX_EVALUATION_MS,
    Math.max(MIN_EVALUATION_MS, Math.round(delayMs)),
  );
  return new Date(now.getTime() + clamped);
}
