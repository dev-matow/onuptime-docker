import { z } from "zod";

import { GLOBALPING_API_URL, globalpingDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * The target, pinged from somewhere that is not here.
 *
 * Every other check type in Vigil answers "can this machine reach it".
 * That is the question an operator asks second. The first one — "can my
 * users reach it" — cannot be answered from one host at all: a route
 * that is broken in São Paulo and fine in Frankfurt looks perfect from a
 * worker in Frankfurt, and the monitor stays green through an outage
 * half a continent wide. Globalping is a public probe network that will
 * run the measurement from wherever you ask, and this type asks it.
 *
 * The prerequisite is outbound access to the API, and a quota: anonymous
 * callers get a few hundred measurements an hour per IP, a free API
 * token raises it. When either is missing the monitor reports
 * `misconfigured` with the reason — a spent quota is an operator problem
 * and must never look like the target being unreachable.
 */

/** The public API. Overridable so an install can point at a mirror. */

/** Where the measurement runs from, in Globalping's "magic" syntax. */
export const DEFAULT_GLOBALPING_LOCATION = "world";

export interface GlobalpingConfig {
  /**
   * Probe selection: `world`, `europe`, `US`, `US+NY`, `Germany`,
   * `AS13335`, or a comma-separated list of them.
   *
   * Passed through as the API's `magic` filter rather than parsed here.
   * Globalping owns the vocabulary — it grows continents, countries,
   * networks and cloud regions without asking anyone — and a client-side
   * allowlist would reject valid values the day the network gains a
   * region. A location no probe matches comes back as a clear API error,
   * which is a better failure than a regex nobody can update.
   */
  location: string;
  /** How many probes to ask for. */
  probeLimit: number;
  /** ICMP echoes per probe. */
  packets: number;
  /**
   * Mean packet loss, across all probes, that counts as degraded.
   *
   * Not zero. Internet ICMP loses the odd packet everywhere, and a
   * threshold of zero would make every monitor of this type permanently
   * amber — which is the same as having no amber at all.
   */
  maxPacketLossPct: number;
  apiToken: string | null;
  apiBaseUrl: string;
  degradedThresholdMs: number;
}

/**
 * Anything Globalping's location grammar can hold, minus anything that
 * would corrupt the JSON body or a log line. Deliberately a shape check
 * and not a vocabulary check — see `location` above.
 */
const LOCATION_PATTERN = /^[A-Za-z0-9 ,.+_-]+$/;

const apiBaseUrlSchema = z
  .string()
  .trim()
  .max(512)
  .refine(
    (value) => {
      if (!URL.canParse(value)) return false;
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    },
    { message: "Enter the Globalping API base URL." },
  );

export const globalpingStoredSchema = z.object({
  location: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(LOCATION_PATTERN, "Use letters, digits, spaces, + and commas.")
    .default(DEFAULT_GLOBALPING_LOCATION),
  probeLimit: z.number().int().min(1).max(10).default(3),
  packets: z.number().int().min(1).max(16).default(3),
  maxPacketLossPct: z.number().int().min(0).max(100).default(5),
  // Not trimmed, for the reason no credential in this codebase is.
  apiToken: z
    .string()
    .max(512)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null)),
  apiBaseUrl: apiBaseUrlSchema.default(GLOBALPING_API_URL),
});

/**
 * What an absent or unreadable config blob falls back to. Resolved once
 * at load rather than per check: `fromRow` runs on the worker's hot path
 * for every monitor of this type, every interval.
 */
const GLOBALPING_DEFAULTS = globalpingStoredSchema.parse({});

export const globalpingConfigSchema: z.ZodType<GlobalpingConfig> = z.object({
  location: z.string().min(1).max(100),
  probeLimit: z.number().int().min(1).max(10),
  packets: z.number().int().min(1).max(16),
  maxPacketLossPct: z.number().int().min(0).max(100),
  apiToken: z.string().max(512).nullable(),
  apiBaseUrl: z.string().min(1).max(512),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/**
 * Declared first: "nowhere in the world can reach this" is the cause,
 * and the loss and latency lines below it are consequences of the same
 * measurement.
 */
const reachableFromSomewhere: Assertion<GlobalpingConfig> = {
  id: "reachable",
  fact: "probesReachable",
  severity: "down",
  evaluate(value, config) {
    // Absent when the measurement never produced results — the probe
    // reports that as `misconfigured`, because a Globalping failure is
    // not evidence about the target.
    if (typeof value !== "number") return null;
    return value > 0
      ? null
      : `No probe in ${config.location} got a reply from the target`;
  },
};

/**
 * Partial loss as amber rather than red, and it is the reason this type
 * exists. A target that answers ten probes and drops one is not down —
 * but something on the path between a quarter of the internet and the
 * service is broken, and no single-vantage-point monitor will ever see
 * it.
 */
const packetLossWithinBudget: Assertion<GlobalpingConfig> = {
  id: "packet-loss",
  fact: "packetLossPct",
  severity: "degraded",
  evaluate(value, config) {
    if (typeof value !== "number") return null;
    return value > config.maxPacketLossPct
      ? `${value}% packet loss across the probes, over the ${config.maxPacketLossPct}% threshold`
      : null;
  },
};

export const globalpingSpec: CheckTypeSpec<GlobalpingConfig> = {
  descriptor: globalpingDescriptor,
  configSchema: globalpingConfigSchema,
  storedSchema: globalpingStoredSchema,
  secretFields: ["apiToken"],
  targetSchema: monitorHostnameSchema,
  assertions: [
    reachableFromSomewhere,
    packetLossWithinBudget,
    // The threshold is compared against the mean round trip the probes
    // measured, not against Vigil's own wall clock — see the probe.
    latencyAssertion<GlobalpingConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): GlobalpingConfig {
    const stored = globalpingStoredSchema.safeParse(row.config ?? {});
    const data = stored.success ? stored.data : GLOBALPING_DEFAULTS;
    return {
      location: data.location,
      probeLimit: data.probeLimit,
      packets: data.packets,
      maxPacketLossPct: data.maxPacketLossPct,
      apiToken: data.apiToken,
      apiBaseUrl: data.apiBaseUrl,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, _port, config) {
    // Where it was measured from is half the identity of this monitor:
    // two monitors of the same host from `europe` and from `US+CA` are
    // different checks, and an incident email that omits the location
    // is one that gets replied to.
    return `${target} from ${config.location}`;
  },
};
