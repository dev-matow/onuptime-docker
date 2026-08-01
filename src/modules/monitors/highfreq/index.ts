/**
 * The high-frequency check data plane.
 *
 * A second scheduler, beside pg-boss rather than instead of it, for the
 * cheap check types at sub-second cadence. `plane.ts` explains what it
 * is and what it deliberately is not; `docs/HIGH-FREQUENCY.md` reports
 * what it was measured to achieve, and states — at length, because this
 * is the whole point of the feature — why a configured interval is not a
 * detection time.
 *
 * Isomorphic split, like the rest of `monitors/`: `capabilities` and
 * `limits` are safe in a browser bundle (the monitor form imports them),
 * everything else touches the database or the network and is not.
 */
export {
  highFrequencyCapability,
  supportsHighFrequency,
  HIGH_FREQUENCY_CAPABILITIES,
  HIGH_FREQUENCY_TYPE_IDS,
  HF_MAX_INTERVAL_MS,
  HF_MIN_INTERVAL_MS,
  type CostClass,
  type HighFrequencyCapability,
} from "./capabilities";
export { HighFrequencyPlane, highFrequencyClaims } from "./plane";
export { runHighFrequencyRollup, type RollupResult } from "./rollup";
export {
  achievedCadence,
  ACHIEVED_WINDOW_MINUTES,
  type AchievedCadence,
} from "./stats";
export { setHighFrequency, type HighFrequencySettings } from "./service";
