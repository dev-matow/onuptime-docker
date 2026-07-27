import { z } from "zod";

import type { Assertion } from "../contract";

/**
 * The `storedSchema` for the types that predate the `config` jsonb
 * column and keep their settings in flat columns. Whatever arrives is
 * discarded: an `http` monitor has no config blob, and quietly storing
 * one would create a second place its settings could live.
 */
export const flatColumnsOnly: z.ZodType<unknown> = z
  .unknown()
  .transform(() => null);

/**
 * Assertions every type would otherwise re-declare. They exist here
 * rather than being folded into the engine on purpose: the engine must
 * not know that latency is special, or the next type that measures
 * something other than time inherits a rule it never asked for.
 */

/** Slower than the monitor's degraded threshold. */
export function latencyAssertion<
  Config extends { degradedThresholdMs: number },
>(label = "Responded"): Assertion<Config> {
  return {
    id: "latency",
    fact: "responseTimeMs",
    severity: "degraded",
    evaluate(value, config) {
      if (typeof value !== "number") return null;
      return value > config.degradedThresholdMs
        ? `${label} in ${value}ms, over the ${config.degradedThresholdMs}ms threshold`
        : null;
    },
  };
}

/**
 * The pair of assertions that make an expiry date useful: already
 * expired is an outage, nearly expired is a warning. Shared by TLS
 * certificates and domain registrations, which differ only in wording.
 */
export function expiryAssertions<Config extends { warnDays: number }>(
  subject: string,
): readonly Assertion<Config>[] {
  return [
    {
      id: "not-expired",
      fact: "daysRemaining",
      severity: "down",
      evaluate(value) {
        if (typeof value !== "number") return null;
        if (value > 0) return null;
        return value === 0
          ? `The ${subject} expires today`
          : `The ${subject} expired ${Math.abs(value)} ${Math.abs(value) === 1 ? "day" : "days"} ago`;
      },
    },
    {
      id: "expiring-soon",
      fact: "daysRemaining",
      severity: "degraded",
      evaluate(value, config) {
        if (typeof value !== "number" || value <= 0) return null;
        return value < config.warnDays
          ? `The ${subject} expires in ${value} ${value === 1 ? "day" : "days"}`
          : null;
      },
    },
  ];
}

export const warnDaysSchemaBounds = { min: 1, max: 365 } as const;
