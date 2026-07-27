import { z } from "zod";

import { tlsExpiryDescriptor } from "../catalog";
import type { CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { expiryAssertions, latencyAssertion } from "./shared";

export const DEFAULT_TLS_PORT = 443;

export interface TlsExpiryConfig {
  warnDays: number;
  degradedThresholdMs: number;
}

export const tlsExpiryStoredSchema = z.object({
  warnDays: z.number().int().min(1).max(365).default(14),
});

export const tlsExpiryConfigSchema: z.ZodType<TlsExpiryConfig> = z.object({
  warnDays: z.number().int().min(1).max(365),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

export const tlsExpirySpec: CheckTypeSpec<TlsExpiryConfig> = {
  descriptor: tlsExpiryDescriptor,
  configSchema: tlsExpiryConfigSchema,
  storedSchema: tlsExpiryStoredSchema,
  targetSchema: monitorHostnameSchema,
  assertions: [
    ...expiryAssertions<TlsExpiryConfig>("certificate"),
    latencyAssertion<TlsExpiryConfig>("Handshook"),
  ],
  fromRow(row: MonitorRowView): TlsExpiryConfig {
    const stored = tlsExpiryStoredSchema.safeParse(row.config ?? {});
    return {
      // Falls back to the shared tlsWarnDays column so an operator who
      // converts an https monitor's TLS option into a standalone
      // monitor keeps the threshold they already chose.
      warnDays: stored.success ? stored.data.warnDays : row.tlsWarnDays,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, port) {
    const effective = port ?? DEFAULT_TLS_PORT;
    return effective === DEFAULT_TLS_PORT ? target : `${target}:${effective}`;
  },
};
