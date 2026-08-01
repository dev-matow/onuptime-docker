import { afterEach, describe, expect, it, vi } from "vitest";

import { SchedulerClock } from "@/modules/monitors/highfreq/clock";

afterEach(() => {
  vi.useRealTimers();
});

describe("the high-frequency scheduler's clock", () => {
  it("keeps counting forward when the system clock jumps backwards", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));

    let mono = 1_000;
    const clock = new SchedulerClock(() => mono);

    const before = clock.now();
    // The machine's NTP client corrects a clock that was five minutes
    // fast. This is the event that, on a wall-clock scheduler, makes
    // every monitor simultaneously overdue by five minutes.
    vi.setSystemTime(new Date("2026-08-01T11:55:00.000Z"));
    mono += 500;

    expect(clock.now() - before).toBe(500);
  });

  it("reconstructs wall-clock stamps from the monotonic reading", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));

    let mono = 5_000;
    const clock = new SchedulerClock(() => mono);

    mono += 500;
    expect(clock.wallAt(mono).toISOString()).toBe("2026-08-01T12:00:00.500Z");
    mono += 500;
    expect(clock.wallAt(mono).toISOString()).toBe("2026-08-01T12:00:01.000Z");
  });

  it("follows a corrected system clock instead of drifting away from it forever", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));

    let mono = 0;
    const clock = new SchedulerClock(() => mono);

    mono += 500;
    vi.setSystemTime(new Date("2026-08-01T12:01:00.000Z"));

    // A minute of wall time appeared inside half a second of monotonic
    // time, so the reconstruction is a minute behind: the anchor is
    // re-taken and the stamp says what the corrected clock says. Ignoring
    // the correction would leave the samples permanently misdated
    // relative to every other table in the product.
    expect(clock.wallAt(mono).toISOString()).toBe("2026-08-01T12:01:00.000Z");
    expect(clock.clockSteps()).toBe(1);

    mono += 500;
    expect(clock.wallAt(mono).toISOString()).toBe("2026-08-01T12:01:00.500Z");
    expect(clock.clockSteps()).toBe(1);
  });

  it("does not re-anchor for ordinary sub-second scheduling jitter", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));

    let mono = 0;
    const clock = new SchedulerClock(() => mono);

    for (let slot = 1; slot <= 20; slot += 1) {
      mono += 500;
      vi.advanceTimersByTime(500);
      clock.wallAt(mono);
    }
    expect(clock.clockSteps()).toBe(0);
  });
});
