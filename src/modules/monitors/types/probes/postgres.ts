import { Client } from "pg";

import type { ProbeContext, ProbeResult } from "../contract";
import { connectionHostname, type PostgresConfig } from "../specs/postgres";
import { elapsedSince, refusesPrivate } from "./guard";

/**
 * One connection and one `SELECT 1`.
 *
 * A TCP check on 5432 only proves something is listening. A server that
 * has exhausted its connection slots, is still replaying WAL, or has
 * lost the role the application logs in as accepts the socket and fails
 * here — which is the outage an operator wants paged. Answering a
 * trivial query is the smallest observation that separates the two, and
 * deliberately the largest: this runs against production every interval,
 * so it must cost the monitored database nothing.
 *
 * `pg` rather than the wire protocol by hand, unlike the other probes:
 * the startup packet is followed by SCRAM-SHA-256 and usually a TLS
 * negotiation, so speaking it means implementing a cryptographic
 * handshake rather than parsing a greeting. The driver is already a
 * dependency — Vigil's own database goes through it — so it costs
 * nothing in image size, and it parses `sslmode` out of the connection
 * string for free.
 */
export async function postgresProbe(
  ctx: ProbeContext<PostgresConfig>,
): Promise<ProbeResult> {
  // The target schema rejects this already, but a row can predate the
  // schema or survive a downgrade, and `new URL` throwing on the
  // worker's hot path would escape the probe entirely.
  const hostname = connectionHostname(ctx.target);
  if (hostname === null) {
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: "Not a PostgreSQL connection string",
    };
  }

  const guard = await refusesPrivate(hostname, ctx.allowPrivateTargets);
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const client = new Client({
    connectionString: ctx.target,
    // pg has no single deadline for "connect, then query", so the two
    // phases are bounded separately and a pathological server can take
    // up to twice the timeout. Bounded is what matters — neither phase
    // can hang the worker.
    connectionTimeoutMillis: ctx.timeoutMs,
    query_timeout: ctx.timeoutMs,
    // Server-side as well, so a query this probe has given up waiting
    // for stops costing the monitored database anything.
    statement_timeout: ctx.timeoutMs,
  });
  const startedAt = performance.now();

  try {
    await client.connect();
    await client.query("SELECT 1");
    const responseTimeMs = elapsedSince(startedAt);
    return {
      facts: { responseTimeMs, queryOk: true },
      responseTimeMs,
      statusCode: null,
      error: null,
    };
  } catch (error) {
    const responseTimeMs = elapsedSince(startedAt);
    const message = connectionErrorMessage(error);
    return {
      facts: { responseTimeMs, queryOk: false },
      responseTimeMs,
      statusCode: null,
      // Never the empty string. The condition engine reads a falsy
      // `error` as "no transport failure" and would go on to judge a
      // refused connection by its latency alone — i.e. `up`.
      error: message.length > 0 ? message : "The connection failed",
    };
  } finally {
    // Cleanup, so a failure to close must not replace the observation
    // this probe already has — or escape as an unhandled rejection.
    await client.end().catch(() => undefined);
  }
}

/**
 * The first message worth showing an operator, or "" when there is none.
 *
 * A refused connection does not arrive as a plain `Error`: Node tries
 * every address the host resolved to and reports an `AggregateError`
 * whose own `message` is empty and whose `errors` hold the real
 * `ECONNREFUSED`. Exported because this unwrapping is the whole decision
 * — the socket around it is plumbing.
 */
export function connectionErrorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    for (const cause of error.errors) {
      const message = connectionErrorMessage(cause);
      if (message.length > 0) return message;
    }
    return "";
  }
  return error instanceof Error ? error.message : "";
}
