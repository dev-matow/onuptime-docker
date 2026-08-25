/**
 * Incident evidence: what was known when a monitor opened an incident.
 *
 * The barrel exists so the rest of the product imports one name rather
 * than five files, and so the seam is visible: `outcome.ts` calls
 * `captureIncidentEvidence`, the incident page calls
 * `getIncidentEvidence`, the retention job calls
 * `pruneIncidentEvidence`, and nothing else in the codebase knows this
 * module has parts.
 */
export {
  buildSnapshot,
  burstTargetFor,
  captureIncidentEvidence,
  EVIDENCE_RETENTION_DAYS,
  fitSnapshot,
  getIncidentEvidence,
  MAX_SNAPSHOT_BYTES,
  pruneIncidentEvidence,
  type CaptureDeps,
  type CaptureInput,
  type StoredIncidentEvidence,
} from "./capture";
export {
  BURST_BUDGET_MS,
  BURST_MAX_STEPS,
  BURST_STEP_TIMEOUT_MS,
  burstsInFlight,
  MAX_CONCURRENT_BURSTS,
  runBurst,
  systemTransport,
  type BurstTarget,
  type BurstTransport,
} from "./burst";
export { classifyStage, failureSignature } from "./classify";
export {
  CORRELATION_WINDOW_MS,
  findCorrelationCandidates,
  hostOfTarget,
  MAX_CORRELATIONS,
  rankCorrelations,
  signalsBetween,
  type CorrelationCandidate,
  type CorrelationSubject,
} from "./correlate";
export { meaningfulChanges } from "./diff";
export * from "./types";
