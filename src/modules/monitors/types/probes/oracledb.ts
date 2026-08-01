import net from "node:net";

import type { ProbeContext, ProbeResult } from "../contract";
import {
  parseOracleConnection,
  type OracleConfig,
  type OracleConnection,
} from "../specs/oracledb";
import { connectionErrorMessage, elapsedSince, refusesPrivate } from "./guard";

/**
 * One TNS connect request, put to an Oracle listener.
 *
 * **What this check does not do, and why.** It does not sign in and it
 * runs no query. Oracle's login is O5LOGON: a session-key exchange, an
 * AES-encrypted verifier and a data-type negotiation phase that runs to
 * thousands of lines in every client that implements it. The only
 * shortcut is `node-oracledb`, which is a native addon — the thick mode
 * wants Oracle Instant Client installed on the host, and neither mode is
 * a dependency Vigil can add to a container whose pitch is two processes
 * and a Postgres. So the honest check is the one that fits on the wire:
 * ask the listener to accept a connection for a named service.
 *
 * **That question is worth asking.** A TCP check on 1521 proves the
 * listener process is alive, which is the least interesting thing about
 * an Oracle deployment. The listener answers `ACCEPT` only when an
 * instance has registered the service and has a handler free for it; the
 * everyday failures — an instance that never came up (ORA-12514), one
 * that is blocking new connections (ORA-12528), a handler pool that is
 * full (ORA-12516) — all answer `REFUSE` on a port that a TCP check
 * finds perfectly healthy.
 *
 * **What it costs the database.** On Linux a listener hands a dedicated
 * connection to a freshly spawned server process, so an accepted request
 * creates a process that this probe then abandons. That is one
 * short-lived process per check and a line in `listener.log` — the same
 * cost as any connection attempt, and the reason the check identifies
 * itself as `vigil` in the connect descriptor rather than arriving
 * anonymously.
 */

/** Length (2), packet checksum (2), type, flags, header checksum (2). */
const HEADER_BYTES = 8;

/** Where the connect descriptor starts, and the header size we declare. */
const CONNECT_DATA_OFFSET = 58;

const PACKET_CONNECT = 1;
const PACKET_ACCEPT = 2;
const PACKET_REFUSE = 4;
const PACKET_REDIRECT = 5;
const PACKET_RESEND = 11;

/**
 * The TNS protocol version this probe claims to speak.
 *
 * 313 is a 19c client, and staying below 315 is load-bearing rather than
 * conservative: from 315 onwards a negotiated session may frame packets
 * with a 32-bit length instead of the 16-bit one every version has used,
 * and the probe would then have to know which framing it had agreed to
 * before it could read the answer. Nothing here needs a packet larger
 * than a listener's refusal.
 */
const PROTOCOL_VERSION = 313;

/** The oldest protocol version this probe will settle for. */
const PROTOCOL_VERSION_MINIMUM = 300;

/**
 * A listener's answer is a few hundred bytes. The cap is protection
 * against a peer that declares a length it never fills — without it the
 * far end decides how much memory the worker spends.
 */
const MAX_PACKET_BYTES = 8 * 1024;

/** Peer-supplied text lands in the ledger, one row per check. */
const MAX_TEXT_CHARS = 200;

/**
 * The everyday listener refusals, in the words Oracle documents for
 * them.
 *
 * The wire carries a number and nothing else. An operator reading
 * "ORA-12514" in an incident email at 3am has to go and look it up, and
 * the difference between "the service is not registered" and "the
 * listener is full" is the difference between two entirely different
 * repairs. Only the codes a listener actually answers a connect request
 * with are here; anything else is reported as its bare code rather than
 * guessed at.
 */
const REFUSAL_REASONS: Readonly<Record<number, string>> = {
  12500: "listener failed to start a dedicated server process",
  12505: "listener does not currently know of SID given in connect descriptor",
  12514:
    "listener does not currently know of service requested in connect descriptor",
  12516:
    "listener could not find available handler with matching protocol stack",
  12518: "listener could not hand off client connection",
  12520:
    "listener could not find available handler for requested type of server",
  12528: "listener: all appropriate instances are blocking new connections",
  12564: "TNS:connection refused",
};

export async function oracledbProbe(
  ctx: ProbeContext<OracleConfig>,
): Promise<ProbeResult> {
  // The target schema rejects this already, but a row can predate the
  // schema or survive a downgrade, and `new URL` throwing on the
  // worker's hot path would escape the probe entirely.
  const connection = parseOracleConnection(ctx.target);
  if (connection === null) {
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: "Not an Oracle connection string",
    };
  }

  const guard = await refusesPrivate(
    connection.hostname,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const request = buildConnectPacket(connection);
  const startedAt = performance.now();

  return new Promise<ProbeResult>((resolve) => {
    const socket = net.connect({
      host: connection.hostname,
      port: connection.port,
    });
    let buffered: Buffer = Buffer.alloc(0);
    let resent = false;
    let settled = false;

    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(result);
    };
    const failed = (error: string) => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error,
      });
    };

    // `socket.setTimeout` is an idle timer that every chunk resets, so a
    // peer trickling bytes could hold the worker open long past the check
    // window without ever going idle. A listener answers in one packet;
    // a deadline over the whole exchange is what the runner allotted.
    const deadline = setTimeout(
      () => failed(`Timed out after ${ctx.timeoutMs}ms`),
      ctx.timeoutMs,
    );

    socket.setNoDelay(true);
    socket.once("connect", () => {
      socket.write(request);
    });

    socket.on("data", (chunk: Buffer) => {
      buffered =
        buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      const take = takePacket(buffered);
      if (take.state === "incomplete") return;
      if (take.state === "invalid") {
        settle(notSpeakingTns(elapsedSince(startedAt)));
        return;
      }

      // A listener asks for the request again when it wants it on a
      // fresh connection state; sqlplus obliges once. Twice is a loop,
      // and a listener stuck in one is not accepting anything — which
      // `readAnswer` will duly report.
      if (take.type === PACKET_RESEND && !resent) {
        resent = true;
        buffered = take.rest;
        socket.write(request);
        return;
      }

      settle(readAnswer(take.type, take.packet, elapsedSince(startedAt)));
    });

    socket.once("error", (error: Error) =>
      failed(connectionErrorMessage(error, "Connection failed")),
    );
    // Without this, a listener that accepts the connection and then hangs
    // up says nothing until the deadline expires, and the operator reads
    // "the network ate it" instead of "the listener dropped me".
    socket.once("close", () =>
      failed("The listener closed the connection without answering"),
    );
  });
}

/**
 * Turns the listener's answer into facts.
 *
 * `accepted` is a boolean for every TNS packet type, never null, and
 * that is deliberate. Only ACCEPT and REDIRECT are the listener saying
 * yes; anything else — a refusal, a marker, a packet type this probe has
 * never seen — is a connect request that did not succeed. Recording an
 * unrecognised answer as "no opinion" would leave a monitor whose
 * assertions all skip, and a check with no opinion reads as up.
 *
 * A REDIRECT counts as yes and is never followed. It names another
 * address to connect to, and that address comes from the far end, so
 * dialling it would reach a host the egress guard never resolved — an
 * SSRF hole opened by whatever answered on 1521. The redirect is enough
 * evidence on its own: the listener knew the service well enough to hand
 * the connection on.
 *
 * Pure, and exported, because the answer is the whole check — the socket
 * around it is plumbing.
 */
export function readAnswer(
  type: number,
  packet: Buffer,
  responseTimeMs: number,
): ProbeResult {
  const refusal = type === PACKET_REFUSE ? readRefusal(packet) : null;
  return {
    facts: {
      listenerAnswered: true,
      accepted: type === PACKET_ACCEPT || type === PACKET_REDIRECT,
      listenerResponse: describePacketType(type),
      serviceError: refusal?.error ?? null,
      serverVersion: refusal?.version ?? null,
      responseTimeMs,
    },
    responseTimeMs,
    statusCode: null,
    error: null,
  };
}

/**
 * The listener's answer in the words the protocol uses for it, so an
 * operator reading the fact can search Oracle's own documentation.
 */
function describePacketType(type: number): string {
  if (type === PACKET_ACCEPT) return "accept";
  if (type === PACKET_REDIRECT) return "redirect";
  if (type === PACKET_REFUSE) return "refuse";
  if (type === PACKET_RESEND) return "resend";
  return `TNS packet type ${type}`;
}

/**
 * Something is listening on this port and it is not framing TNS. Still
 * not a transport error — the connection worked, and what came back over
 * it is the finding.
 */
function notSpeakingTns(responseTimeMs: number): ProbeResult {
  return {
    facts: {
      listenerAnswered: false,
      accepted: false,
      listenerResponse: null,
      serviceError: null,
      serverVersion: null,
      responseTimeMs,
    },
    responseTimeMs,
    statusCode: null,
    error: null,
  };
}

type PacketTake =
  | { state: "incomplete" }
  | { state: "invalid" }
  | { state: "packet"; type: number; packet: Buffer; rest: Buffer };

/**
 * Takes one whole TNS packet off the front of a buffer.
 *
 * Pure, and exported, because the framing is where a hostile peer gets
 * to choose numbers: the declared length is the only thing standing
 * between a stranger on port 1521 and an unbounded read.
 */
export function takePacket(buffer: Buffer): PacketTake {
  if (buffer.length < HEADER_BYTES) return { state: "incomplete" };
  const length = buffer.readUInt16BE(0);
  const type = buffer.readUInt8(4);
  if (length < HEADER_BYTES || length > MAX_PACKET_BYTES) {
    return { state: "invalid" };
  }
  if (buffer.length < length) return { state: "incomplete" };
  return {
    state: "packet",
    type,
    packet: buffer.subarray(0, length),
    rest: buffer.subarray(length),
  };
}

/**
 * The connect request: a fixed 58-byte header of negotiation values,
 * then the connect descriptor the listener parses.
 *
 * The descriptor names the service, the address it was reached at, and
 * the client — `CID` is what puts "vigil" in `listener.log` next to
 * every connection this check makes, which is the difference between a
 * DBA finding a monitor and a DBA finding an intruder.
 */
export function buildConnectPacket(connection: OracleConnection): Buffer {
  const descriptor =
    `(DESCRIPTION=` +
    `(CONNECT_DATA=(SERVICE_NAME=${connection.serviceName})` +
    `(CID=(PROGRAM=vigil)(HOST=vigil)(USER=vigil)))` +
    `(ADDRESS=(PROTOCOL=TCP)(HOST=${connection.hostname})(PORT=${connection.port})))`;
  // latin1 rather than utf8: the schema restricts a service name to
  // ASCII, and a length computed over anything else would disagree with
  // the bytes actually written.
  const data = Buffer.from(descriptor, "latin1");
  const packet = Buffer.alloc(CONNECT_DATA_OFFSET + data.length);

  packet.writeUInt16BE(packet.length, 0);
  packet.writeUInt16BE(0, 2); // Packet checksum: unused for decades.
  packet.writeUInt8(PACKET_CONNECT, 4);
  packet.writeUInt8(0, 5); // Reserved.
  packet.writeUInt16BE(0, 6); // Header checksum, likewise unused.
  packet.writeUInt16BE(PROTOCOL_VERSION, 8);
  packet.writeUInt16BE(PROTOCOL_VERSION_MINIMUM, 10);
  packet.writeUInt16BE(0, 12); // Global service options: none wanted.
  packet.writeUInt16BE(8192, 14); // Session data unit.
  packet.writeUInt16BE(32767, 16); // Transport data unit.
  // What the far end may assume about our socket: the value every TCP
  // client sends. It describes the transport, not the request.
  packet.writeUInt16BE(0x7f08, 18);
  packet.writeUInt16BE(0, 20); // Line turnaround, unused over TCP.
  // The number 1 in this machine's byte order, which is how TNS tells a
  // big-endian peer from a little-endian one.
  packet.writeUInt16BE(1, 22);
  packet.writeUInt16BE(data.length, 24);
  packet.writeUInt16BE(CONNECT_DATA_OFFSET, 26);
  packet.writeUInt32BE(0, 28); // Maximum receivable connect data.
  packet.writeUInt8(0x41, 32); // Connect flags, as a 19c client sends them.
  packet.writeUInt8(0x41, 33);
  data.copy(packet, CONNECT_DATA_OFFSET);
  return packet;
}

/**
 * The reason out of a REFUSE packet.
 *
 * Read by looking for the keys rather than by offset. A refusal carries
 * a TNS descriptor whose fields differ between listener releases —
 * `TMP`, `VSNNUM`, `ERR` and an `ERROR_STACK` appear in different orders
 * and not all of them always appear — and a parser that counted bytes
 * would break on the version it was not written against.
 */
export function readRefusal(packet: Buffer): {
  error: string;
  version: string | null;
} {
  const text = packet.toString("latin1", HEADER_BYTES);
  const code = /\(ERR=(\d+)\)/.exec(text)?.[1];
  const versionNumber = /\(VSNNUM=(\d+)\)/.exec(text)?.[1];
  const number = code === undefined ? null : Number(code);

  const reason = number === null ? null : REFUSAL_REASONS[number];
  const error =
    number === null
      ? capped(`The listener refused the connection: ${printable(text)}`)
      : `ORA-${String(number).padStart(5, "0")}${reason ? `: ${reason}` : ""}`;

  return {
    error,
    version:
      versionNumber === undefined ? null : decodeVersion(Number(versionNumber)),
  };
}

/**
 * Oracle's VSNNUM, which packs a five-part release into 32 bits: 19.3.0.0.0
 * arrives as 0x13300000. Reported because the listener volunteers it in
 * a refusal, and knowing an outage came from an 11.2 listener rather
 * than a 19c one is the first question anyone asks.
 */
export function decodeVersion(vsnnum: number): string | null {
  if (!Number.isFinite(vsnnum) || vsnnum <= 0) return null;
  const parts = [
    (vsnnum >> 24) & 0xff,
    (vsnnum >> 20) & 0x0f,
    (vsnnum >> 12) & 0xff,
    (vsnnum >> 8) & 0x0f,
    vsnnum & 0xff,
  ];
  return parts.join(".");
}

/** The far end chose every byte of this, and it lands in an email. */
function printable(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, " ").trim();
}

function capped(value: string): string {
  return value.length > MAX_TEXT_CHARS
    ? `${value.slice(0, MAX_TEXT_CHARS)}…`
    : value;
}
