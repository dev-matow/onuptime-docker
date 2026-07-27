import net from "node:net";

import type { ProbeContext, ProbeResult } from "../contract";
import { DEFAULT_MYSQL_PORT } from "../catalog";
import { type MysqlConfig } from "../specs/mysql";
import { elapsedSince, refusesPrivate, connectionErrorMessage } from "./guard";

/**
 * One MySQL/MariaDB handshake, read and thrown away.
 *
 * A server that is up and accepting connections sends its
 * Protocol::Handshake packet the moment the socket opens, before any
 * authentication. Reading it proves reachability and yields the server
 * version, which is the whole check — no driver, no credential, no login
 * attempt. Nothing is ever written to the socket, which is what makes
 * this safe to point at a production database: the server records an
 * aborted connection, not a failed authentication.
 */

/** 3-byte little-endian payload length, then a sequence id. */
const HEADER_BYTES = 4;

/**
 * A first packet — handshake or ERR — runs to a couple of hundred bytes.
 * A larger declared length means whatever is listening is not framing
 * MySQL packets, and honouring it would let a stranger on port 3306
 * decide how much memory the worker spends.
 */
const MAX_PAYLOAD_BYTES = 2048;

/** Where a protocol version would be, this marks an ERR packet instead. */
const ERR_PACKET = 0xff;

/** ERR packets carry `#HY000` after the code once a session knows the
 * client's capabilities. This one cannot, but tolerate it if it appears. */
const SQL_STATE_MARKER = 0x23;

/** Version strings run to about thirty characters. The cap exists only
 * so a peer cannot write a kilobyte into every check row of the ledger. */
const MAX_TEXT_CHARS = 128;

export async function mysqlProbe(
  ctx: ProbeContext<MysqlConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(ctx.target, ctx.allowPrivateTargets);
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_MYSQL_PORT;
  const startedAt = performance.now();

  return new Promise<ProbeResult>((resolve) => {
    const socket = net.connect({ host: ctx.target, port });
    let received = Buffer.alloc(0);
    let settled = false;
    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const fail = (error: string) =>
      settle({
        facts: {},
        responseTimeMs: elapsedSince(startedAt),
        statusCode: null,
        error,
      });

    socket.setTimeout(ctx.timeoutMs);
    socket.once("timeout", () => fail(`Timed out after ${ctx.timeoutMs}ms`));
    socket.once("error", (error: Error) =>
      fail(connectionErrorMessage(error, "Connection failed")),
    );
    socket.once("close", () =>
      fail("The server closed the connection before sending a packet"),
    );
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const result = readHandshake(received, elapsedSince(startedAt));
      if (result) {
        settle(result);
        return;
      }
      // A socket timeout is an idle timer that every chunk resets, so on
      // the one probe that reads a stream a peer trickling bytes could
      // push it back indefinitely. Re-arming it with what is left of the
      // budget turns it into the deadline the worker needs. Never zero:
      // that would switch the timeout off altogether.
      socket.setTimeout(Math.max(1, ctx.timeoutMs - elapsedSince(startedAt)));
    });
  });
}

/**
 * Reads the server's first packet, or returns null while it is still
 * arriving — a single `data` event is not guaranteed to carry all of it.
 *
 * Pure, and exported, because this is where every decision lives; the
 * socket around it is plumbing.
 */
export function readHandshake(
  received: Buffer,
  responseTimeMs: number,
): ProbeResult | null {
  if (received.length < HEADER_BYTES) return null;

  const payloadLength = received.readUIntLE(0, 3);
  if (payloadLength > MAX_PAYLOAD_BYTES) return notAHandshake(responseTimeMs);
  if (received.length < HEADER_BYTES + payloadLength) return null;

  const payload = received.subarray(HEADER_BYTES, HEADER_BYTES + payloadLength);
  const protocolVersion = payload[0];
  if (protocolVersion === undefined) return notAHandshake(responseTimeMs);

  // An ERR packet means the server is up, answering, and has decided not
  // to talk to this client — "Host '...' is not allowed to connect" is
  // the everyday one. That is an observation and not a transport
  // failure: the probe measured perfectly well, and the type's own
  // assertion is what turns it into a verdict.
  if (protocolVersion === ERR_PACKET) {
    return {
      facts: {
        handshakeOk: false,
        serverVersion: null,
        protocolVersion: null,
        serverError: serverErrorFrom(payload),
        responseTimeMs,
      },
      responseTimeMs,
      statusCode: null,
      error: null,
    };
  }

  const versionEnd = payload.indexOf(0, 1);
  if (versionEnd === -1) return notAHandshake(responseTimeMs, protocolVersion);
  // latin1 rather than utf8: the version string is ASCII, and latin1
  // cannot fail on a stray byte from something that is not a MySQL
  // server the way decoding as UTF-8 would.
  const serverVersion = capped(payload.toString("latin1", 1, versionEnd));

  return {
    facts: {
      handshakeOk: true,
      serverVersion,
      // Recorded rather than asserted on. 10 has been the protocol
      // version since MySQL 3.21, but a server speaking something else
      // is still a server, and naming it is more use than refusing to
      // look at what came back.
      protocolVersion,
      serverError: null,
      responseTimeMs,
    },
    responseTimeMs,
    statusCode: null,
    error: null,
  };
}

/**
 * Something is listening and it is not framing a MySQL handshake. Still
 * not a transport error — the connection worked, and what came back over
 * it is the finding.
 */
function notAHandshake(
  responseTimeMs: number,
  protocolVersion: number | null = null,
): ProbeResult {
  return {
    facts: {
      handshakeOk: false,
      serverVersion: null,
      protocolVersion,
      serverError: null,
      responseTimeMs,
    },
    responseTimeMs,
    statusCode: null,
    error: null,
  };
}

/** The message out of an ERR packet: a 2-byte error code, then text. */
function serverErrorFrom(payload: Buffer): string {
  const code = payload.length >= 3 ? payload.readUInt16LE(1) : 0;
  const start = payload[3] === SQL_STATE_MARKER ? 9 : 3;
  const message = capped(payload.toString("latin1", start).trim());
  return message.length > 0 ? message : `MySQL error ${code}`;
}

/** Caps peer-supplied text — facts land in the ledger, one row per check. */
function capped(value: string): string {
  return value.slice(0, MAX_TEXT_CHARS);
}
