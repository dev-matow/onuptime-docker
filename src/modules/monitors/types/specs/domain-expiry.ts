import { z } from "zod";

import { domainExpiryDescriptor } from "../catalog";
import type { CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorDomainSchema } from "../targets";
import { expiryAssertions } from "./shared";

export interface DomainExpiryConfig {
  warnDays: number;
  degradedThresholdMs: number;
}

export const domainExpiryStoredSchema = z.object({
  // Registrations renew in years, not weeks. Thirty days is the point
  // at which a human still has time to act without a support ticket.
  warnDays: z.number().int().min(1).max(365).default(30),
});

export const domainExpiryConfigSchema: z.ZodType<DomainExpiryConfig> = z.object(
  {
    warnDays: z.number().int().min(1).max(365),
    degradedThresholdMs: z.number().int().min(100).max(30_000),
  },
);

export const domainExpirySpec: CheckTypeSpec<DomainExpiryConfig> = {
  descriptor: domainExpiryDescriptor,
  configSchema: domainExpiryConfigSchema,
  storedSchema: domainExpiryStoredSchema,
  targetSchema: monitorDomainSchema,
  // Deliberately no latency assertion: RDAP response time says
  // something about the registry's web server, not about the domain.
  assertions: expiryAssertions<DomainExpiryConfig>("domain registration"),
  fromRow(row: MonitorRowView): DomainExpiryConfig {
    const stored = domainExpiryStoredSchema.safeParse(row.config ?? {});
    return {
      warnDays: stored.success ? stored.data.warnDays : 30,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target) {
    return target;
  },
};
