import { z } from "zod";

import { tcpDescriptor } from "../catalog";
import type { CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { flatColumnsOnly, latencyAssertion } from "./shared";

export interface TcpConfig {
  degradedThresholdMs: number;
}

export const tcpConfigSchema: z.ZodType<TcpConfig> = z.object({
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

export const tcpSpec: CheckTypeSpec<TcpConfig> = {
  descriptor: tcpDescriptor,
  configSchema: tcpConfigSchema,
  storedSchema: flatColumnsOnly,
  targetSchema: monitorHostnameSchema,
  // A completed handshake is the whole assertion; there is nothing to
  // read afterwards. Everything else a TCP check can say is timing.
  assertions: [latencyAssertion<TcpConfig>("Connected")],
  fromRow(row: MonitorRowView): TcpConfig {
    return { degradedThresholdMs: row.degradedThresholdMs };
  },
  describeTarget(target, port) {
    return port === null ? target : `${target}:${port}`;
  },
};
