import net from "node:net";

import type { ProbeContext, ProbeResult } from "../contract";
import { DEFAULT_REDIS_PORT } from "../catalog";
import { type RedisConfig } from "../specs/redis";
import { elapsedSince, refusesPrivate, connectionErrorMessage } from "./guard";

/**
 * A Redis PING, spoken by hand.
 *
 * RESP is a length-prefixed text protocol and the whole check is one
 * command, so a client library would buy nothing these few lines do not
 * — and would cost megabytes in an image whose pitch is two processes
 * and a Postgres.
 *
 * What counts as an answer is the subtle part, and it is not "PONG". A
 * server that replies `-NOAUTH Authentication required.` parsed a RESP
 * command and wrote RESP back; it is up, and a monitor that called that
 * an outage would page on a healthy cache. Only silence, a refused
 * connection or bytes that are not RESP at all are transport failures.
 */

const CRLF = "\r\n";

/**
 * A reply with no terminator in this much data is not a Redis server
 * answering PING. The idle timeout bounds how long the probe waits; this
 * bounds how much of a firehose it holds while waiting.
 */
const MAX_REPLY_BYTES = 8 * 1024;

/**
 * A command as RESP: an array of bulk strings, each prefixed with its
 * length in bytes. Redis also accepts inline commands, but not with
 * arbitrary bytes in them — a password containing a space would arrive
 * as two arguments and be rejected as a wrong one.
 */
export function encodeCommand(...args: string[]): Buffer {
  const bulk = args
    .map((arg) => `$${Buffer.byteLength(arg)}${CRLF}${arg}${CRLF}`)
    .join("");
  return Buffer.from(`*${args.length}${CRLF}${bulk}`, "utf8");
}

/**
 * Whether a RESP error is Redis saying "not without credentials".
 * Redis 6 introduced the prefixed codes; 5 and older answer an
 * unauthenticated command with a bare `-ERR operation not permitted`.
 */
export function isAuthError(message: string): boolean {
  return /^(NOAUTH|WRONGPASS|NOPERM)\b|operation not permitted/i.test(message);
}

/**
 * Turns the reply to PING into facts. Pure, and exported, because
 * reading the reply is the whole check — the socket around it is
 * plumbing.
 */
export function pingResult(
  line: string,
  responseTimeMs: number,
  authenticated: boolean,
): ProbeResult {
  if (line.startsWith("+")) {
    return {
      facts: {
        pong: line.slice(1).toUpperCase() === "PONG",
        authRequired: authenticated,
        responseTimeMs,
      },
      responseTimeMs,
      statusCode: null,
      error: null,
    };
  }

  if (line.startsWith("-")) {
    const message = line.slice(1);
    return {
      facts: {
        // Null, not false: the server declined to answer PING rather
        // than answering it wrongly, and the `pong` assertion is written
        // to have no opinion when it has no boolean.
        pong: null,
        authRequired: authenticated || isAuthError(message),
        responseTimeMs,
      },
      responseTimeMs,
      statusCode: null,
      error: null,
    };
  }

  return {
    facts: { responseTimeMs },
    responseTimeMs,
    statusCode: null,
    error: `Not a RESP reply: ${summarise(line)}`,
  };
}

export async function redisProbe(
  ctx: ProbeContext<RedisConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(
    ctx.target,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_REDIS_PORT;
  const password = ctx.config.password;
  const startedAt = performance.now();
  const deadline = startedAt + ctx.timeoutMs;

  return new Promise<ProbeResult>((resolve) => {
    const socket = net.connect({ host: ctx.target, port });
    let settled = false;
    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    // `setTimeout` is an idle timeout, and an authenticated check makes
    // two round trips: left alone it would grant the full budget to each
    // one. Re-arming with what is left of the budget keeps the probe
    // inside the window the runner allotted it.
    const armTimeout = () =>
      socket.setTimeout(Math.max(1, Math.round(deadline - performance.now())));

    let pending = Buffer.alloc(0);
    let awaitingAuth = password !== null;

    armTimeout();
    socket.once("connect", () => {
      socket.write(
        password === null
          ? encodeCommand("PING")
          : encodeCommand("AUTH", password),
      );
      armTimeout();
    });

    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf(CRLF);
      if (end === -1) {
        if (pending.length > MAX_REPLY_BYTES) {
          settle(
            transportFailure("The server never sent a RESP reply", startedAt),
          );
        }
        return;
      }

      const line = pending.subarray(0, end).toString("utf8");
      pending = pending.subarray(end + CRLF.length);

      if (!awaitingAuth) {
        settle(pingResult(line, elapsedSince(startedAt), password !== null));
        return;
      }

      // PING is only sent once AUTH has been answered, so this runs at
      // most once and the next line to arrive belongs to PING.
      awaitingAuth = false;
      if (line === "+OK") {
        socket.write(encodeCommand("PING"));
        armTimeout();
        return;
      }
      settle(authRefused(line, elapsedSince(startedAt)));
    });

    socket.once("timeout", () =>
      settle(transportFailure(`Timed out after ${ctx.timeoutMs}ms`, startedAt)),
    );
    socket.once("error", (error: Error) =>
      settle(
        transportFailure(
          connectionErrorMessage(error, "Connection failed"),
          startedAt,
        ),
      ),
    );
    // Without this a server that accepts the connection and then hangs
    // up says nothing until the timeout expires, and the operator reads
    // "the network ate it" instead of "the server dropped me".
    socket.once("close", () =>
      settle(
        transportFailure(
          "The server closed the connection without replying",
          startedAt,
        ),
      ),
    );
  });
}

/**
 * A rejected AUTH is neither an outage nor a measurement: the server is
 * up and talking, and the stored credential is wrong. That is an
 * operator error, and an operator error that reads as `down` is
 * indistinguishable from the cache actually being gone.
 */
function authRefused(line: string, responseTimeMs: number): ProbeResult {
  if (!line.startsWith("-")) {
    return {
      facts: { responseTimeMs },
      responseTimeMs,
      statusCode: null,
      error: `Not a RESP reply to AUTH: ${summarise(line)}`,
    };
  }

  const message = line.slice(1);
  return {
    facts: { authRequired: isAuthError(message), responseTimeMs },
    responseTimeMs,
    statusCode: null,
    error: null,
    unavailable: `The server refused the stored password: ${summarise(message)}`,
  };
}

function transportFailure(error: string, startedAt: number): ProbeResult {
  const responseTimeMs = elapsedSince(startedAt);
  return { facts: { responseTimeMs }, responseTimeMs, statusCode: null, error };
}

/**
 * The server's own words, kept short and printable. This lands in the
 * ledger and in an incident email, and the far end chose every byte of
 * it.
 */
function summarise(line: string): string {
  const printable = line.replace(/[^\x20-\x7e]/g, " ").trim();
  return printable.length > 80 ? `${printable.slice(0, 80)}…` : printable;
}
