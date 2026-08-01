import { z } from "zod";

import { DEFAULT_SQLSERVER_PORT, sqlserverDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { flatColumnsOnly, latencyAssertion } from "./shared";

export interface SqlServerConfig {
  degradedThresholdMs: number;
}

export const sqlserverConfigSchema: z.ZodType<SqlServerConfig> = z.object({
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/**
 * Both spellings an operator is likely to reach for: `sqlserver://` is
 * the JDBC subprotocol, `mssql://` is what the Node ecosystem uses.
 * Accepting one and refusing the other would be a coin toss the form
 * cannot help them win.
 */
const CONNECTION_SCHEMES = new Set(["sqlserver:", "mssql:"]);

/** Everything the probe needs from the target string. */
export interface SqlServerConnection {
  hostname: string;
  port: number;
  username: string;
  password: string;
  /** The database the login switches to, or null to take the default. */
  database: string | null;
}

/**
 * The connection string, taken apart — or null when the string is not
 * one this type can use.
 *
 * Exported because the probe needs the same answer as the schema and
 * `describeTarget`: two parsers would be two chances to disagree about
 * which host is being reached, and the one the SSRF guard resolves has
 * to be the one the socket dials.
 */
export function parseSqlServerConnection(
  target: string,
): SqlServerConnection | null {
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

  // `URL` hands back userinfo and the path percent-encoded, and a SQL
  // Server password is exactly the kind of string that contains an `@`
  // or a `/`. Sending the encoded form would fail authentication with a
  // message that says "wrong password" and mean "wrong parser".
  const username = decode(url.username);
  const password = decode(url.password);
  const database = decode(url.pathname.replace(/^\//, ""));
  if (username === null || password === null || database === null) return null;

  const port = url.port === "" ? DEFAULT_SQLSERVER_PORT : Number(url.port);
  return {
    hostname,
    port,
    username,
    password,
    database: database.length > 0 ? database : null,
  };
}

/** Percent-decoded, or null when the escape sequence is malformed. */
function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Not `monitorUrlSchema`: that one demands http or https, which is the
 * right rule for every type that speaks HTTP and the wrong one here.
 *
 * A login name is required, unlike postgres, because this check has no
 * useful unauthenticated form: SQL Server sends its greeting to anyone,
 * and everything past it — the database being mounted, the login still
 * existing, the server able to run a query — needs a credential. A
 * connection string without one would create a monitor that silently
 * watches less than the operator thinks it does.
 */
export const sqlserverConnectionSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) => {
      const connection = parseSqlServerConnection(value);
      return connection !== null && connection.username.length > 0;
    },
    {
      message:
        "Enter a SQL Server connection string with a login, like sqlserver://user:password@db.example.com:1433/app.",
    },
  );

const answersTds: Assertion<SqlServerConfig> = {
  id: "prelogin",
  fact: "preloginOk",
  severity: "down",
  evaluate(value) {
    return value === true
      ? null
      : "Whatever answered on this port is not speaking TDS";
  },
};

const signsIn: Assertion<SqlServerConfig> = {
  id: "login",
  fact: "loginOk",
  severity: "down",
  evaluate(value) {
    // Null when the login was never attempted — the server demanded an
    // encrypted one, and this probe speaks plaintext TDS. Not knowing
    // the answer is not the same as getting the wrong one, and a monitor
    // that read "down" for every Azure SQL database would be reporting
    // on Vigil rather than on the server.
    if (typeof value !== "boolean") return null;
    return value ? null : "The server refused the login";
  },
};

const answersQuery: Assertion<SqlServerConfig> = {
  id: "query",
  fact: "queryOk",
  severity: "down",
  evaluate(value) {
    // Absent whenever the login did not happen, so this stays quiet and
    // lets the login assertion name the failure once. Two lines for one
    // cause is how an incident stops being readable.
    if (typeof value !== "boolean") return null;
    return value ? null : "The server signed the check in but ran no query";
  },
};

export const sqlserverSpec: CheckTypeSpec<SqlServerConfig> = {
  descriptor: sqlserverDescriptor,
  configSchema: sqlserverConfigSchema,
  storedSchema: flatColumnsOnly,
  targetSchema: sqlserverConnectionSchema,
  assertions: [
    answersTds,
    signsIn,
    answersQuery,
    latencyAssertion<SqlServerConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): SqlServerConfig {
    return { degradedThresholdMs: row.degradedThresholdMs };
  },
  /**
   * Host, port and database — never the login in front of them.
   * This is the redaction the contract asks for: the target carries a
   * password, and this type is the only thing that knows it does.
   */
  describeTarget(target) {
    const connection = parseSqlServerConnection(target);
    if (!connection) {
      // Unparseable, so the credential cannot be located precisely.
      // Everything up to the last "@" is where one would be.
      return target.slice(target.lastIndexOf("@") + 1);
    }
    const host = `${connection.hostname}:${connection.port}`;
    return connection.database === null
      ? host
      : `${host}/${connection.database}`;
  },
};
