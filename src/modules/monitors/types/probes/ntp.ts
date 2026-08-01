import { DEFAULT_NTP_PORT } from "../catalog";
import type { ProbeContext, ProbeResult } from "../contract";
import { NTP_KISS_STRATUM, type NtpConfig } from "../specs/ntp";
import { refusesPrivate } from "./guard";
import { datagramFailure, exchangeDatagram, resolveDatagramHost } from "./udp";

/**
 * One SNTP client request (RFC 5905 §8), and the four timestamps that
 * come out of it.
 *
 * Forty-eight bytes out, forty-eight back, so there is nothing here a
 * client library would do for us — and a real NTP client is not a
 * client library. It is a discipline loop: it polls a set of servers,
 * filters and clusters their answers, and steers the local clock. A
 * monitor must do none of that. It asks one server what time it thinks
 * it is, and reports the answer.
 *
 * What that answer means is the part worth being exact about. The
 * offset is computed against *this machine's* clock, so it says how far
 * apart the two are and not which of them is wrong. That is why the
 * offset assertion is degraded and never down — see `specs/ntp.ts`.
 */

const NTP_PACKET_BYTES = 48;

/**
 * Seconds between 1900-01-01 (the NTP epoch) and 1970-01-01 (Unix).
 * Era 0 runs out in 2036, when the 32-bit second count wraps; this
 * reads it as unsigned and is therefore correct until then.
 */
const NTP_EPOCH_OFFSET_SECONDS = 2_208_988_800;

/** The fraction field is 32 bits of a second. */
const FRACTION_SCALE = 4_294_967_296;

const CLIENT_MODE = 3;
const SERVER_MODE = 4;
/** NTPv4. A v3 server answers a v4 request; the packet is unchanged. */
const NTP_VERSION = 4;

const REFERENCE_ID_OFFSET = 12;
const ORIGIN_OFFSET = 24;
const RECEIVE_OFFSET = 32;
const TRANSMIT_OFFSET = 40;
const TIMESTAMP_BYTES = 8;

export interface NtpReply {
  leapIndicator: number;
  version: number;
  mode: number;
  stratum: number;
  /** The upstream source, decoded per RFC 5905 §7.3 — see below. */
  referenceId: string;
  /** When the server says it received our request, in Unix ms. */
  receiveAt: number;
  /** When the server says it sent its reply, in Unix ms. */
  transmitAt: number;
}

export async function ntpProbe(
  ctx: ProbeContext<NtpConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(
    ctx.target,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_NTP_PORT;
  const endpoint = await resolveDatagramHost(ctx.target);
  if (endpoint === null) {
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: `Could not resolve ${ctx.target}`,
    };
  }

  // Built at send time, so the transmit timestamp it carries is the
  // moment it was actually sent. Kept here because it is also the only
  // thing that identifies the reply.
  let request: Buffer = Buffer.alloc(0);
  const exchange = await exchangeDatagram({
    endpoint,
    port,
    timeoutMs: ctx.timeoutMs,
    payload: (sentAt) => {
      request = encodeClientPacket(sentAt);
      return request;
    },
    // The server copies our transmit timestamp into the origin field
    // verbatim (§8), and on a protocol with no sequence numbers that
    // echo is the only thing tying a datagram to this request. Without
    // the test, a late reply to the *previous* check is measured as this
    // one's — and reads as a clock offset the size of the interval.
    accepts: (data) => echoesOurRequest(data, request),
  });

  if (exchange.outcome !== "reply") {
    return datagramFailure(exchange, port, ctx.timeoutMs);
  }

  const reply = decodeServerPacket(exchange.data);
  if (reply === null) {
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: `The reply was not an NTP server packet (${exchange.data.length} bytes)`,
    };
  }

  if (reply.stratum === NTP_KISS_STRATUM) {
    // A kiss-o'-death is the server declining to serve *this client*:
    // `RATE` means we are polling faster than it allows, `DENY` and
    // `RSTR` that we are not welcome at all. None of them is an outage,
    // and reporting one as `down` would page an operator for a check
    // interval — so it surfaces as misconfigured, with the code the
    // server sent, which is the thing they have to act on.
    const code = reply.referenceId.length > 0 ? reply.referenceId : "no code";
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: null,
      unavailable: `The server sent a kiss-o'-death (${code}): it is refusing to answer this client`,
    };
  }

  const originateAt = readTimestamp(request, TRANSMIT_OFFSET);
  // Derived from the monotonic round trip rather than read off the wall
  // clock a second time: an NTP step landing on this machine mid-check
  // would otherwise turn up as an offset the server does not have.
  const receivedAt = originateAt + exchange.responseTimeMs;

  const offsetMs = Math.round(
    (reply.receiveAt - originateAt + (reply.transmitAt - receivedAt)) / 2,
  );
  const delayMs = Math.round(
    receivedAt - originateAt - (reply.transmitAt - reply.receiveAt),
  );

  return {
    facts: {
      stratum: reply.stratum,
      leapIndicator: reply.leapIndicator,
      offsetMs,
      // Never negative: a server whose timestamps are coarser than the
      // round trip can report spending longer on the request than the
      // whole exchange took, and a negative delay is not a number an
      // operator can do anything with.
      delayMs: Math.max(0, delayMs),
      referenceId: reply.referenceId,
      responseTimeMs: exchange.responseTimeMs,
    },
    responseTimeMs: exchange.responseTimeMs,
    statusCode: null,
    error: null,
  };
}

/**
 * A client packet: mode 3, version 4, and our clock in the transmit
 * field. Everything else is zero, which is exactly what a client is
 * supposed to send.
 */
export function encodeClientPacket(sentAt: number): Buffer {
  const packet = Buffer.alloc(NTP_PACKET_BYTES);
  // Leap indicator 0, version, mode — two bits, three bits, three bits.
  packet.writeUInt8((NTP_VERSION << 3) | CLIENT_MODE, 0);
  writeTimestamp(packet, TRANSMIT_OFFSET, sentAt);
  return packet;
}

/** Whether this datagram echoes the transmit timestamp we sent. */
export function echoesOurRequest(reply: Buffer, request: Buffer): boolean {
  if (reply.length < NTP_PACKET_BYTES || request.length < NTP_PACKET_BYTES) {
    return false;
  }
  return reply
    .subarray(ORIGIN_OFFSET, ORIGIN_OFFSET + TIMESTAMP_BYTES)
    .equals(
      request.subarray(TRANSMIT_OFFSET, TRANSMIT_OFFSET + TIMESTAMP_BYTES),
    );
}

/**
 * Reads a server reply, or null when the bytes are not one.
 *
 * Pure and exported, because every decision this check makes about the
 * wire is here; the socket around it is plumbing.
 */
export function decodeServerPacket(data: Buffer): NtpReply | null {
  if (data.length < NTP_PACKET_BYTES) return null;
  const header = data.readUInt8(0);
  const mode = header & 0b111;
  // Mode 4 is a server answering a client. Anything else on this port
  // is another NTP association's traffic — a peer, a broadcast — and
  // reading its timestamps as an answer to our request would be
  // measuring a conversation we are not in.
  if (mode !== SERVER_MODE) return null;

  const stratum = data.readUInt8(1);
  return {
    leapIndicator: (header >> 6) & 0b11,
    version: (header >> 3) & 0b111,
    mode,
    stratum,
    referenceId: decodeReferenceId(data, stratum),
    receiveAt: readTimestamp(data, RECEIVE_OFFSET),
    transmitAt: readTimestamp(data, TRANSMIT_OFFSET),
  };
}

/**
 * The reference identifier (RFC 5905 §7.3), which means three different
 * things depending on the stratum:
 *
 *  - stratum 0: a four-character kiss code — `RATE`, `DENY`, `RSTR`.
 *  - stratum 1: the reference clock — `GPS`, `PPS`, `DCFa`.
 *  - stratum 2+: the IPv4 address of the upstream server, or, when that
 *    server is reached over IPv6, the first four bytes of an MD5 hash
 *    of its address. The dotted quad is then a fingerprint rather than
 *    an address — it is still the right thing to show, because it is
 *    what identifies the upstream this server is following.
 */
function decodeReferenceId(data: Buffer, stratum: number): string {
  const raw = data.subarray(REFERENCE_ID_OFFSET, REFERENCE_ID_OFFSET + 4);
  if (stratum <= 1) {
    return raw
      .toString("latin1")
      .replace(/[^\x20-\x7e]/g, "")
      .trim();
  }
  return Array.from(raw).join(".");
}

/** An NTP timestamp as Unix milliseconds. */
function readTimestamp(packet: Buffer, offset: number): number {
  const seconds = packet.readUInt32BE(offset);
  const fraction = packet.readUInt32BE(offset + 4);
  return (
    (seconds - NTP_EPOCH_OFFSET_SECONDS) * 1000 +
    (fraction / FRACTION_SCALE) * 1000
  );
}

function writeTimestamp(packet: Buffer, offset: number, unixMs: number): void {
  const seconds = Math.floor(unixMs / 1000);
  packet.writeUInt32BE(seconds + NTP_EPOCH_OFFSET_SECONDS, offset);
  // Clamped because `writeUInt32BE` throws above 2^32-1, and a caller
  // handing this a sub-millisecond fraction close enough to 1 would
  // round up to exactly 2^32. An exception on the worker's hot path is
  // a worse answer to that than a fraction one part in 4 billion short.
  packet.writeUInt32BE(
    Math.min(
      FRACTION_SCALE - 1,
      Math.round(((unixMs - seconds * 1000) / 1000) * FRACTION_SCALE),
    ),
    offset + 4,
  );
}
