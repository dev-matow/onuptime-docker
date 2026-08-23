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
  /**
   * Drains the notification outbox. A queue whose payload is empty on
   * purpose: the work is the table, and the tick only wakes a worker up
   * to look at it.
   */
  notificationDelivery: "notification-delivery",
  /** One escalation-policy step: page its target unless the incident is acked. */
  escalationStep: "escalation-step",
  /** Nightly pruning of old check results. */
  retention: "retention",
  /**
   * Aggregates high-frequency samples into minute/hour/day buckets and
   * drops the raw ones. Every minute, not nightly: the raw table is a
   * two-hour buffer taking two thousand rows a second, and a job that
   * ran once a day would be aggregating a hundred and seventy million
   * rows that had already been deleted.
   */
  highFrequencyRollup: "high-frequency-rollup",
  /**
   * Expands maintenance rules into occurrences, moves those through
   * their states, and lets go of the incidents a finished window was
   * holding.
   *
   * Every minute rather than nightly, and a queue of its own rather than
   * a step inside the delivery tick, because the third of those three
   * jobs pages people: an incident held through a window is released the
   * minute the window ends, and putting that behind the notification
   * drain would make one tenant's slow provider delay another tenant's
   * page.
   */
} as const;

export interface MonitorCheckJob {
  monitorId: string;
}


/**
 * The incident generation a recovery job observed when it was
 * scheduled, compared against `incidents.status_revision` before the job
 * writes anything that matters.
 *
 * A recovery chain reads an incident, probes a target for up to that
 * check's full timeout, and then acts. An operator who resolves the
 * incident inside that window used to change nothing about what
 * happened next: the trigger still fired against a target that was fine,
 * the timeline of a closed incident still grew, channels were still told
 * about the recovery of an outage that had ended, and the next attempt
 * was still scheduled. Re-reading is not sufficient on its own either -
 * "still not resolved" becomes true again if the monitor flaps down a
 * second time, and that is a different outage than the one this job was
 * scheduled for.
 *
 * Optional, because a job enqueued by 1.18.1 and still in the queue
 * during the upgrade has no fence to carry. Those run unfenced, exactly
 * as they did before, and drain within one recovery chain.
 */
export interface RecoveryFence {
  incidentRevision?: number;
}

export interface RecoveryExecuteJob extends RecoveryFence {
  incidentId: string;
  monitorId: string;
  attemptNumber: number;
}

export interface RecoveryVerifyJob extends RecoveryExecuteJob {
  attemptId: string;
}

export interface RecoveryEscalateJob extends RecoveryFence {
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

/**
 * How long a finished job row stays in `pgboss.job` before maintenance
 * deletes it, for the queues that produce one per check or per minute.
 *
 * pg-boss's own default is seven DAYS, and its maintenance sweep runs
 * once a DAY — tuned for queues where a job is a business event worth
 * keeping. Here a completed job is pure transport: the observation it
 * carried is already in `monitor_checks`, the run in `synthetic_runs`,
 * the delivery in `notification_outbox`. Measured on a development
 * database, a `monitor-check` job row costs ~437 bytes with its indexes,
 * so a 1,000-monitor installation on a 60-second cadence accumulates
 * ~10 million rows — about 4 GB of Postgres — before the default window
 * even starts deleting. An hour keeps enough to debug a dispatch problem
 * that just happened and bounds the table at tens of thousands of rows.
 *
 * Failed jobs share the window. That is a judgement: failures worth
 * keeping longer than an hour are visible as incidents and ledger rows,
 * not as queue archaeology.
 */
export const HIGH_CHURN_DELETE_AFTER_SECONDS = 3_600;

/**
 * How often pg-boss runs its maintenance sweep — the DELETION of
 * finished jobs. (Expiring stuck active jobs is the supervisor's, on
 * its own sixty-second cadence; this knob does not touch it.)
 *
 * The retention above is enforced BY this sweep, so leaving the sweep at
 * its one-day default would make the one-hour window above a fiction:
 * the table would still grow for a day between deletions. Ten minutes
 * keeps the high-churn queues within ~17% of their nominal bound.
 */
export const QUEUE_MAINTENANCE_INTERVAL_SECONDS = 600;

/**
 * The queues whose completed jobs are transport rather than record —
 * one row per check, or one per minute per cron. `recovery-*`,
 * `escalation-step` and `retention` are NOT here on purpose: they are
 * rare, and their job rows are evidence an operator may want when asking
 * why somebody was or was not paged.
 *
 * Exported so the retention test asserts against the same list the boot
 * path applies — a list that drifts from the loop it feeds is how a
 * queue silently returns to seven-day retention.
 */
export const HIGH_CHURN_QUEUES: readonly string[] = [
  QUEUES.monitorTick,
  QUEUES.monitorCheck,
  QUEUES.notificationDelivery,
  QUEUES.highFrequencyRollup,
];
