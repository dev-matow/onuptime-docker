export const QUEUES = {
  /** Cron fan-out: finds due monitors and enqueues individual checks. */
  monitorTick: "monitor-tick",
  /** One HTTP probe of one monitor. */
  monitorCheck: "monitor-check",
  /** Verify-still-down, then fire the monitor's recovery trigger. */
  recoveryExecute: "recovery-execute",
  /** Post-trigger probe that decides whether recovery worked. */
  recoveryVerify: "recovery-verify",
  /** Failsafe: pages operators if held alerts outlive the recovery chain. */
  recoveryEscalate: "recovery-escalate",
  /** One escalation-policy step: page its target unless the incident is acked. */
  escalationStep: "escalation-step",
  /** Nightly pruning of old check results. */
  retention: "retention",
} as const;

export interface MonitorCheckJob {
  monitorId: string;
}

export interface RecoveryExecuteJob {
  incidentId: string;
  monitorId: string;
  attemptNumber: number;
}

export interface RecoveryVerifyJob extends RecoveryExecuteJob {
  attemptId: string;
}

export interface RecoveryEscalateJob {
  incidentId: string;
  monitorId: string;
}

/** The rung, as it stood when the ladder was scheduled. */
export interface EscalationStepSnapshot {
  target: "on_call" | "responders" | "user";
  channel: "email" | "sms" | "voice";
  scheduleId: string | null;
  userId: string | null;
}

export interface EscalationStepJob {
  incidentId: string;
  monitorId: string;
  stepIndex: number;
  /**
   * Carried on the job rather than re-read by `stepIndex` at fire time.
   * The index is a position in a list the operator can edit while the
   * incident is still open: reorder or shorten a policy mid-ladder and
   * position 2 is a different rung — fired at the delay the old one
   * asked for, over whatever channel the new one uses — or no rung at
   * all, which used to return silently.
   *
   * Optional because jobs enqueued before 1.10.1 are already sitting in
   * the queue with a `startAfter` of up to a day; those still resolve
   * by index. `stepIndex` is kept regardless — it is what numbers the
   * step in the incident timeline.
   */
  step?: EscalationStepSnapshot;
}

export const CHECK_RETENTION_DAYS = 90;
