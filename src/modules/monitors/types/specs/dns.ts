import { z } from "zod";

import {
  dnsDescriptor,
  DNS_RECORD_TYPES,
  type DnsRecordType,
} from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

export { DNS_RECORD_TYPES, type DnsRecordType };

export interface DnsConfig {
  recordType: DnsRecordType;
  /**
   * Substring at least one record must contain. Null asserts only that
   * the name resolves at all — which is the common case: a name that
   * stops resolving is the outage, whatever it used to point at.
   */
  expectedValue: string | null;
  degradedThresholdMs: number;
}

export const dnsStoredSchema = z.object({
  recordType: z.enum(DNS_RECORD_TYPES).default("A"),
  expectedValue: z
    .string()
    .trim()
    .max(255)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

export const dnsConfigSchema: z.ZodType<DnsConfig> = z.object({
  recordType: z.enum(DNS_RECORD_TYPES),
  expectedValue: z.string().max(255).nullable(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

const resolves: Assertion<DnsConfig> = {
  id: "resolves",
  fact: "recordCount",
  severity: "down",
  evaluate(value, config) {
    if (typeof value !== "number") return "The lookup returned no result";
    return value > 0 ? null : `No ${config.recordType} records`;
  },
};

const matchesExpected: Assertion<DnsConfig> = {
  id: "expected-value",
  fact: "records",
  severity: "down",
  applies: (config) => config.expectedValue !== null,
  evaluate(value, config) {
    const expected = config.expectedValue ?? "";
    const records = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
    return records.some((record) => record.includes(expected))
      ? null
      : `No ${config.recordType} record contains "${expected}"`;
  },
};

export const dnsSpec: CheckTypeSpec<DnsConfig> = {
  descriptor: dnsDescriptor,
  configSchema: dnsConfigSchema,
  storedSchema: dnsStoredSchema,
  targetSchema: monitorHostnameSchema,
  assertions: [
    resolves,
    matchesExpected,
    latencyAssertion<DnsConfig>("Resolved"),
  ],
  fromRow(row: MonitorRowView): DnsConfig {
    const stored = dnsStoredSchema.safeParse(row.config ?? {});
    return {
      recordType: stored.success ? stored.data.recordType : "A",
      expectedValue: stored.success ? stored.data.expectedValue : null,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, _port, config) {
    return `${config.recordType} ${target}`;
  },
};
