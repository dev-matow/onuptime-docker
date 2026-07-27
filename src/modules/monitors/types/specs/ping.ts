import { z } from "zod";

import { pingDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

export interface PingConfig {
  degradedThresholdMs: number;
  /** Echo requests per check. One is enough to answer "is it there". */
  packets: number;
}

/** Stored config for a ping monitor — the shared columns supply the rest. */
export const pingStoredSchema = z.object({
  packets: z.number().int().min(1).max(5).default(1),
});

export const pingConfigSchema: z.ZodType<PingConfig> = z.object({
  degradedThresholdMs: z.number().int().min(100).max(30_000),
  packets: z.number().int().min(1).max(5),
});

const reachable: Assertion<PingConfig> = {
  id: "reachable",
  fact: "packetsReceived",
  severity: "down",
  evaluate(value) {
    // Zero replies is a measurement, not a transport failure — the
    // probe ran fine and observed silence. Keeping the distinction is
    // what lets "ping cannot run here" stay a separate, non-down state.
    if (typeof value !== "number") return "Ping produced no result";
    return value > 0 ? null : "No ICMP reply";
  },
};

export const pingSpec: CheckTypeSpec<PingConfig> = {
  descriptor: pingDescriptor,
  configSchema: pingConfigSchema,
  storedSchema: pingStoredSchema,
  targetSchema: monitorHostnameSchema,
  assertions: [reachable, latencyAssertion<PingConfig>("Replied")],
  fromRow(row: MonitorRowView): PingConfig {
    const stored = pingStoredSchema.safeParse(row.config ?? {});
    return {
      degradedThresholdMs: row.degradedThresholdMs,
      packets: stored.success ? stored.data.packets : 1,
    };
  },
  describeTarget(target) {
    return target;
  },
};
