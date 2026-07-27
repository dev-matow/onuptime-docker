import { z } from "zod";

import { mysqlDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { flatColumnsOnly, latencyAssertion } from "./shared";

/** Belongs beside the other descriptors in `catalog.ts`. */

export interface MysqlConfig {
  degradedThresholdMs: number;
}

export const mysqlConfigSchema: z.ZodType<MysqlConfig> = z.object({
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/**
 * The server answered, but not with a handshake.
 *
 * The case worth naming is the ERR packet: a server that replies "Host
 * '...' is not allowed to connect to this MySQL server" is running and
 * healthy and still refusing this check, and a monitor that stayed green
 * would be reporting on the wrong thing. What the server actually said
 * is in `serverError`, which the assertion cannot reach — an assertion
 * reads one fact — so the message here stays general.
 */
const handshakes: Assertion<MysqlConfig> = {
  id: "handshake",
  fact: "handshakeOk",
  severity: "down",
  evaluate(value) {
    return value === true ? null : "The server sent no MySQL handshake";
  },
};

export const mysqlSpec: CheckTypeSpec<MysqlConfig> = {
  descriptor: mysqlDescriptor,
  configSchema: mysqlConfigSchema,
  storedSchema: flatColumnsOnly,
  targetSchema: monitorHostnameSchema,
  assertions: [handshakes, latencyAssertion<MysqlConfig>("Handshook")],
  fromRow(row: MonitorRowView): MysqlConfig {
    return { degradedThresholdMs: row.degradedThresholdMs };
  },
  describeTarget(target, port) {
    return port === null ? target : `${target}:${port}`;
  },
};
