export const QUEUES = {
  /** Cron fan-out: finds due monitors and enqueues individual checks. */
  monitorTick: "monitor-tick",
  /** One HTTP probe of one monitor. */
  monitorCheck: "monitor-check",
  /** Nightly pruning of old check results. */
  retention: "retention",
} as const;

export interface MonitorCheckJob {
  monitorId: string;
}

export const CHECK_RETENTION_DAYS = 90;
