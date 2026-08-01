import { z } from "zod";

import { DEFAULT_NTP_PORT, ntpDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * The leap indicator value that means "I have no idea what time it is"
 * (RFC 5905 §7.3). A server saying this is answering honestly, and
 * anything that sets its clock from it will step to the wrong time.
 */
export const NTP_ALARM_LEAP = 3;

/**
 * Stratum 16 is "unsynchronised": the server is running, its clock is
 * free-wheeling, and it is telling every client so. 15 is the last
 * usable hop below a reference clock.
 */
export const NTP_UNSYNCHRONISED_STRATUM = 16;

/**
 * Stratum 0 carries a kiss-o'-death instead of a time. The probe turns
 * that into `misconfigured` rather than a fact, because the server is
 * declining to serve *us* — see `probes/ntp.ts`.
 */
export const NTP_KISS_STRATUM = 0;

/**
 * How far apart the two clocks may be before the check says so.
 *
 * A second is the point at which the things that depend on time start
 * breaking: Kerberos allows five minutes, TOTP thirty seconds, and a
 * TLS certificate's notBefore is judged to the second. Under a second
 * is a healthy server that is merely not perfect.
 */
export const DEFAULT_MAX_OFFSET_MS = 1000;

export interface NtpConfig {
  /** Tolerance on the offset between the server's clock and Vigil's. */
  maxOffsetMs: number;
  degradedThresholdMs: number;
}

export const ntpStoredSchema = z.object({
  maxOffsetMs: z
    .number()
    .int()
    .min(1)
    .max(3_600_000)
    .nullish()
    .transform((value) => value ?? DEFAULT_MAX_OFFSET_MS),
});

export const ntpConfigSchema: z.ZodType<NtpConfig> = z.object({
  maxOffsetMs: z.number().int().min(1).max(3_600_000),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

const synchronised: Assertion<NtpConfig> = {
  id: "synchronised",
  fact: "leapIndicator",
  severity: "down",
  evaluate(value) {
    if (typeof value !== "number") return null;
    return value === NTP_ALARM_LEAP
      ? "The server reports its own clock as unsynchronised"
      : null;
  },
};

const usableStratum: Assertion<NtpConfig> = {
  id: "stratum",
  fact: "stratum",
  severity: "down",
  evaluate(value) {
    if (typeof value !== "number") return null;
    // Not a duplicate of the leap indicator: a server can be stratum 16
    // with a leap indicator of 0 while it is still stepping towards its
    // upstream, and it will happily hand out its free-running clock the
    // whole time.
    return value >= NTP_UNSYNCHRONISED_STRATUM
      ? `The server is not synchronised to a reference clock (stratum ${value})`
      : null;
  },
};

const closeEnough: Assertion<NtpConfig> = {
  id: "clock-offset",
  fact: "offsetMs",
  severity: "degraded",
  evaluate(value, config) {
    if (typeof value !== "number") return null;
    if (Math.abs(value) <= config.maxOffsetMs) return null;
    // Degraded and never down, and the reason is whose clock is the
    // reference: this offset is measured against the machine Vigil runs
    // on. A monitoring host whose own clock has drifted would otherwise
    // page for every time server in the world simultaneously — the one
    // failure that looks exactly like a global outage and is not.
    const direction = value > 0 ? "ahead of" : "behind";
    return `The server's clock is ${Math.abs(value)}ms ${direction} Vigil's, over the ${config.maxOffsetMs}ms tolerance`;
  },
};

export const ntpSpec: CheckTypeSpec<NtpConfig> = {
  descriptor: ntpDescriptor,
  configSchema: ntpConfigSchema,
  storedSchema: ntpStoredSchema,
  targetSchema: monitorHostnameSchema,
  assertions: [
    synchronised,
    usableStratum,
    closeEnough,
    latencyAssertion<NtpConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): NtpConfig {
    const stored = ntpStoredSchema.safeParse(row.config ?? {});
    return {
      maxOffsetMs: stored.success
        ? stored.data.maxOffsetMs
        : DEFAULT_MAX_OFFSET_MS,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, port) {
    // Always with the port, default included: an estate that runs a
    // second time service on 1123 for testing is common enough, and an
    // incident email that omits which one was watched gets replied to.
    return `${target}:${port ?? DEFAULT_NTP_PORT}`;
  },
};
