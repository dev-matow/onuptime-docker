/**
 * The scheduler's clock, and why it is not `Date.now()`.
 *
 * A slot at 500ms is `previous + 500`, and if "previous" is a wall-clock
 * reading then an NTP step — or a VM resuming from a snapshot, or a
 * leap-second smear finishing — moves every deadline with it. Stepping
 * backwards by a second makes two thousand monitors instantly overdue by
 * two slots each and the plane issues four thousand probes at once;
 * stepping forwards by a second makes every monitor sleep through two
 * slots and report a gap that never happened. Neither is theoretical on
 * a machine that has just booted, which is when the monitoring worker
 * starts.
 *
 * `process.hrtime.bigint()` is monotonic and unaffected by both. So
 * scheduling is done entirely in monotonic milliseconds, and wall-clock
 * time is reconstructed for the stored timestamp from a single anchor
 * pair captured at start-up.
 */

/**
 * How far the reconstructed wall clock may drift from the real one
 * before the anchor is re-taken.
 *
 * The reconstruction is exact except for the difference in rate between
 * the monotonic source and the system clock, which under NTP slew is
 * parts per million — a day of running is tens of milliseconds. So this
 * threshold is almost never crossed by drift; what crosses it is a step,
 * and re-anchoring is precisely how a step is absorbed without letting
 * the sample stream wander away from wall time forever.
 */
const REANCHOR_THRESHOLD_MS = 1_000;

export interface ClockAnchor {
  wallMs: number;
  monoMs: number;
}

/**
 * A monotonic clock paired with the wall clock, for a scheduler that
 * needs both: slots are placed on the monotonic one and observations are
 * stamped on the wall one.
 */
export class SchedulerClock {
  private anchor: ClockAnchor;
  private steps = 0;

  constructor(private readonly monotonic: () => number = defaultMonotonic) {
    this.anchor = { wallMs: Date.now(), monoMs: this.monotonic() };
  }

  /** Milliseconds since an arbitrary fixed point. Never goes backwards. */
  now(): number {
    return this.monotonic();
  }

  /**
   * The wall-clock instant corresponding to a monotonic reading.
   *
   * Re-anchors when the reconstruction has diverged from the system
   * clock by more than a second, so a corrected clock is followed rather
   * than ignored. The count of how often that happened is reported, not
   * swallowed: a worker whose clock steps every few minutes is a broken
   * host, and the sample stream is the only place that would show it.
   */
  wallAt(monoMs: number): Date {
    const reconstructed = this.anchor.wallMs + (monoMs - this.anchor.monoMs);
    if (Math.abs(Date.now() - reconstructed) > REANCHOR_THRESHOLD_MS) {
      this.steps += 1;
      this.anchor = { wallMs: Date.now(), monoMs };
      return new Date(this.anchor.wallMs);
    }
    return new Date(Math.round(reconstructed));
  }

  /** How many times the system clock moved out from under the anchor. */
  clockSteps(): number {
    return this.steps;
  }
}

/**
 * Milliseconds, to microsecond resolution.
 *
 * Divided in bigint down to microseconds before converting, rather than
 * converting the nanosecond value directly: nanoseconds since boot
 * exceeds `Number.MAX_SAFE_INTEGER` after 104 days of uptime, and a
 * scheduler that starts quantising its deadlines after three months of
 * uptime is a bug nobody would find. Microseconds hold for centuries.
 */
function defaultMonotonic(): number {
  return Number(process.hrtime.bigint() / 1_000n) / 1_000;
}
