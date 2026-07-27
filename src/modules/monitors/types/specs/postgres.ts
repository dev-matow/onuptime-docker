import { z } from "zod";

import { postgresDescriptor } from "../catalog";
import type { CheckTypeSpec, MonitorRowView } from "../contract";
import { flatColumnsOnly, latencyAssertion } from "./shared";

export interface PostgresConfig {
  degradedThresholdMs: number;
}

export const postgresConfigSchema: z.ZodType<PostgresConfig> = z.object({
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

const CONNECTION_SCHEMES = new Set(["postgres:", "postgresql:"]);

function parseConnection(target: string): URL | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  return CONNECTION_SCHEMES.has(url.protocol) ? url : null;
}

/**
 * The host a connection string points at, or null when the string is not
 * one this type can use.
 *
 * Exported because the probe needs the same answer for its SSRF guard,
 * and two parsers would be two chances to disagree about which host is
 * actually being reached.
 */
export function connectionHostname(target: string): string | null {
  const url = parseConnection(target);
  if (!url) return null;
  // An IPv6 literal keeps its brackets in `hostname`, and every consumer
  // of this wants an address it can resolve or compare.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return hostname.length > 0 ? hostname : null;
}

/**
 * Not `monitorUrlSchema`: that one demands http or https, which is the
 * right rule for every type that speaks HTTP and the wrong one here.
 */
export const postgresConnectionSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => connectionHostname(value) !== null, {
    message:
      "Enter a PostgreSQL connection string, like postgres://user:password@db.example.com:5432/app.",
  });

export const postgresSpec: CheckTypeSpec<PostgresConfig> = {
  descriptor: postgresDescriptor,
  configSchema: postgresConfigSchema,
  storedSchema: flatColumnsOnly,
  targetSchema: postgresConnectionSchema,
  // Connecting, authenticating and getting an answer back is the whole
  // observation; there is nothing in `SELECT 1` to read afterwards.
  // Everything else this check can say is timing.
  assertions: [latencyAssertion<PostgresConfig>("Answered")],
  fromRow(row: MonitorRowView): PostgresConfig {
    return { degradedThresholdMs: row.degradedThresholdMs };
  },
  /**
   * Host, port and database — never the credentials in front of them.
   * This is the redaction the contract asks for: the target carries a
   * password, and this type is the only thing that knows it does.
   */
  describeTarget(target) {
    const url = parseConnection(target);
    if (!url) {
      // Unparseable, so the credential cannot be located precisely.
      // Everything up to the last "@" is where one would be.
      return target.slice(target.lastIndexOf("@") + 1);
    }
    const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    const database = url.pathname.replace(/^\//, "");
    return database.length > 0 ? `${host}/${database}` : host;
  },
};
