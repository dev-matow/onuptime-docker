import { z } from "zod";

import { DEFAULT_ORACLE_PORT, oracledbDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { flatColumnsOnly, latencyAssertion } from "./shared";

export interface OracleConfig {
  degradedThresholdMs: number;
}

export const oracledbConfigSchema: z.ZodType<OracleConfig> = z.object({
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/**
 * `oracle://` is what Uptime Kuma and most ORMs spell it; `oracledb://`
 * is the driver's own name and the first thing an operator who has read
 * the Node documentation will type.
 */
const CONNECTION_SCHEMES = new Set(["oracle:", "oracledb:"]);

/**
 * Characters a service name may contain.
 *
 * Narrow on purpose. The name is interpolated into a TNS descriptor —
 * `(CONNECT_DATA=(SERVICE_NAME=...))` — so a parenthesis or an equals
 * sign in it would not be a bad service name, it would be a different
 * request. Oracle's own service names are a database name and an
 * optional domain, which is exactly this set.
 */
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Everything the probe needs from the target string. */
export interface OracleConnection {
  hostname: string;
  port: number;
  serviceName: string;
}

/**
 * The connection string, taken apart — or null when the string is not
 * one this type can use.
 *
 * Exported because the probe needs the same answer as the schema and
 * `describeTarget`: the host the SSRF guard resolves has to be the host
 * the socket dials, and the service name the guard never looks at is the
 * one that ends up inside a TNS descriptor.
 */
export function parseOracleConnection(target: string): OracleConnection | null {
  let url: URL;
  try {
    url = new URL(target.trim());
  } catch {
    return null;
  }
  if (!CONNECTION_SCHEMES.has(url.protocol)) return null;

  // An IPv6 literal keeps its brackets in `hostname`, and every consumer
  // of this wants an address it can resolve or compare.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname.length === 0) return null;

  let serviceName: string;
  try {
    serviceName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
  if (!SERVICE_NAME_PATTERN.test(serviceName)) return null;

  const port = url.port === "" ? DEFAULT_ORACLE_PORT : Number(url.port);
  return { hostname, port, serviceName };
}

/** Whether the operator pasted a credential into the target. */
function carriesCredentials(target: string): boolean {
  try {
    const url = new URL(target.trim());
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    return false;
  }
}

/**
 * Not `monitorUrlSchema`: that one demands http or https, which is the
 * right rule for every type that speaks HTTP and the wrong one here.
 *
 * Credentials are refused rather than ignored. This check never signs
 * in — see the probe for why — so a password in the string would be a
 * secret stored in the database, carried into every export, and never
 * sent anywhere. Refusing it costs an operator one edit and is the only
 * answer that does not quietly keep a credential Vigil has no use for.
 */
export const oracleConnectionSchema = z
  .string()
  .trim()
  .max(2048)
  .superRefine((value, ctx) => {
    if (carriesCredentials(value)) {
      ctx.addIssue({
        code: "custom",
        message:
          "Remove the credentials: this check asks the listener for the service and never signs in, so a password would be stored and never sent. Use oracle://db.example.com:1521/ORCLPDB1.",
      });
      return;
    }
    if (parseOracleConnection(value) === null) {
      ctx.addIssue({
        code: "custom",
        message:
          "Enter an Oracle connection string with a service name, like oracle://db.example.com:1521/ORCLPDB1.",
      });
    }
  });

const answersTns: Assertion<OracleConfig> = {
  id: "listener",
  fact: "listenerAnswered",
  severity: "down",
  evaluate(value) {
    return value === true
      ? null
      : "Whatever answered on this port is not an Oracle listener";
  },
};

const acceptsService: Assertion<OracleConfig> = {
  id: "accepted",
  fact: "accepted",
  severity: "down",
  evaluate(value) {
    // Only a boolean is evidence. A listener that answered something
    // this probe does not recognise said nothing about the service, and
    // the probe records that as null rather than as false: not knowing
    // the answer is not the same as getting the wrong one.
    if (typeof value !== "boolean") return null;
    // The everyday failure is ORA-12514 — the listener is running, the
    // instance behind it is not registered — and that is precisely the
    // outage a TCP check on 1521 cannot see. What the listener actually
    // said is in `serviceError`, which an assertion cannot reach, so the
    // message here stays general.
    return value ? null : "The listener would not accept a connection";
  },
};

export const oracledbSpec: CheckTypeSpec<OracleConfig> = {
  descriptor: oracledbDescriptor,
  configSchema: oracledbConfigSchema,
  storedSchema: flatColumnsOnly,
  targetSchema: oracleConnectionSchema,
  assertions: [
    answersTns,
    acceptsService,
    latencyAssertion<OracleConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): OracleConfig {
    return { degradedThresholdMs: row.degradedThresholdMs };
  },
  /**
   * Host, port and service — and still redacted, even though the schema
   * refuses a target that carries a credential.
   *
   * `describeTarget` is the last thing between a target and an incident
   * email, and it must not depend on a validation rule that lives in
   * another function and could be relaxed by someone who never reads
   * this one. A row can also predate the rule, or arrive from a build
   * that did not have it.
   */
  describeTarget(target) {
    const connection = parseOracleConnection(target);
    if (!connection) {
      return target.slice(target.lastIndexOf("@") + 1);
    }
    return `${connection.hostname}:${connection.port}/${connection.serviceName}`;
  },
};
