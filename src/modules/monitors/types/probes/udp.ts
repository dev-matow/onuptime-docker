import dgram from "node:dgram";
import dns from "node:dns/promises";

import type { ProbeContext, ProbeResult } from "../contract";
import {
  MAX_UDP_PAYLOAD_BYTES,
  normalizeHex,
  type UdpConfig,
} from "../specs/udp";
import { connectionErrorMessage, elapsedSince, refusesPrivate } from "./guard";

/**
 * One datagram out, one datagram back — and the transport every UDP
 * check in this codebase is built on.
 *
 * The exchange lives here, in the generic type's file, rather than in a
 * shared `datagram.ts`, because `udp` *is* the generic case: `ntp` and
 * `radius` are the same send-and-wait with a packet format on top. One
 * copy also means one place where the things UDP gets wrong are handled
 * — source filtering, ICMP, and the fact that silence is an answer.
 *
 * What TCP gives for free and this does not:
 *
 *  - **Proof of life.** A completed handshake says something is there.
 *    A sent datagram says only that the kernel accepted it, so every
 *    check here has to send something the far end is obliged to answer.
 *  - **A conversation.** Nothing pairs a reply with a request, so the
 *    socket is `connect`ed (which makes the kernel drop datagrams from
 *    any other source) and each caller may add its own `accepts` test
 *    for the payload. Without both, a late reply to the *previous*
 *    check is measured as this one's answer.
 *  - **A closed-port signal.** There is one — ICMP port unreachable —
 *    but it is advisory, routinely filtered, and only delivered to a
 *    connected socket, where Node reports it as `ECONNREFUSED`.
 */

/** Where a datagram is actually sent, once the name has been resolved. */
export interface DatagramEndpoint {
  address: string;
  /** 4 or 6, as `dns.lookup` reports it — it decides the socket type. */
  family: number;
}

export interface DatagramRequest {
  endpoint: DatagramEndpoint;
  port: number;
  /**
   * The bytes to send, or a function given the wall-clock millisecond
   * they are sent at.
   *
   * The function form exists for NTP, whose payload *is* a timestamp: a
   * packet built before the socket is created carries a transmit time
   * earlier than the transmit, and every millisecond of that gap lands
   * in the offset the check reports.
   */
  payload: Buffer | ((sentAt: number) => Buffer);
  timeoutMs: number;
  /**
   * Whether an arriving datagram is the answer to this request. A
   * rejected one is ignored and the probe keeps waiting, because a
   * stale or forged datagram must not be able to end a measurement
   * early. Default: the first datagram from the peer.
   */
  accepts?: (data: Buffer) => boolean;
}

export type DatagramExchange =
  | { outcome: "reply"; data: Buffer; responseTimeMs: number }
  /** Nothing arrived before the deadline. */
  | { outcome: "silence" }
  /** ICMP port unreachable: the host is up, nothing is bound there. */
  | { outcome: "unreachable" }
  | { outcome: "error"; message: string };

/**
 * The address a datagram will be sent to, or null when the name does
 * not resolve.
 *
 * Separate from the exchange, and deliberately outside its measurement,
 * for two reasons. A datagram socket picks its address family from its
 * *type*, before it resolves anything, so a `udp4` socket cannot reach a
 * server that only publishes AAAA records — the family has to be known
 * first. And the round trip a check reports has to be the service's,
 * not the resolver's: a cold DNS lookup is tens of milliseconds, and
 * folding it into an NTP measurement moves the clock offset by half of
 * it.
 */
export async function resolveDatagramHost(
  host: string,
): Promise<DatagramEndpoint | null> {
  try {
    const { address, family } = await dns.lookup(host);
    return { address, family };
  } catch {
    return null;
  }
}

export async function exchangeDatagram(
  request: DatagramRequest,
): Promise<DatagramExchange> {
  return new Promise<DatagramExchange>((resolve) => {
    const socket = dgram.createSocket(
      request.endpoint.family === 6 ? "udp6" : "udp4",
    );
    let settled = false;
    let sentAtMonotonic = 0;

    const settle = (exchange: DatagramExchange) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        socket.close();
      } catch {
        // Already closing — Node throws ERR_SOCKET_DGRAM_NOT_RUNNING for
        // it. The measurement is made either way, and letting a cleanup
        // failure escape would replace an answer with a crash.
      }
      resolve(exchange);
    };

    const deadline = setTimeout(
      () => settle({ outcome: "silence" }),
      request.timeoutMs,
    );

    socket.on("message", (data: Buffer) => {
      // The kernel has already dropped everything from another source:
      // the socket is connected. This is the caller's own test for
      // whether the *payload* answers the request it made.
      if (request.accepts && !request.accepts(data)) return;
      settle({
        outcome: "reply",
        data,
        responseTimeMs: elapsedSince(sentAtMonotonic),
      });
    });

    socket.on("error", (error: NodeJS.ErrnoException) => {
      settle(
        error.code === "ECONNREFUSED"
          ? { outcome: "unreachable" }
          : {
              outcome: "error",
              message: connectionErrorMessage(error, "The datagram failed"),
            },
      );
    });

    // Connected rather than fire-and-forget. An unconnected UDP socket
    // accepts a datagram from anybody, so anything on the network could
    // answer for the server being watched; connecting makes the kernel
    // filter by source address and port, and is also the only way Node
    // is told about an ICMP port unreachable at all.
    socket.connect(request.port, request.endpoint.address, () => {
      sentAtMonotonic = performance.now();
      const payload =
        typeof request.payload === "function"
          ? request.payload(Date.now())
          : request.payload;
      socket.send(payload, (error) => {
        if (!error) return;
        settle({
          outcome: "error",
          message: connectionErrorMessage(error, "The datagram was not sent"),
        });
      });
    });
  });
}

/**
 * The three ways an exchange ends without an answer, as a probe result.
 *
 * Shared by all three datagram checks so they report the same event in
 * the same words: an operator who has an NTP monitor and a RADIUS
 * monitor on one host should not have to learn that "No reply within
 * 5000ms" and "timed out" are the same sentence.
 *
 * All three are transport failures rather than facts. Nothing was
 * measured — there is no reply to have an opinion about — and the
 * distinction matters downstream, where `transport` and `assertion`
 * failures are counted and explained differently.
 */
export function datagramFailure(
  exchange: Exclude<DatagramExchange, { outcome: "reply" }>,
  port: number,
  timeoutMs: number,
): ProbeResult {
  const error =
    exchange.outcome === "silence"
      ? // Deliberately says what was waited for and not why nothing
        // came. UDP silence is ambiguous by construction: a dropped
        // packet, a firewall that discards rather than rejects, and a
        // service that will not answer this payload are indistinguishable
        // from here, and naming one of them would be a guess in an
        // incident email.
        `No reply within ${timeoutMs}ms`
      : exchange.outcome === "unreachable"
        ? `Nothing is listening on ${port}/udp (ICMP port unreachable)`
        : exchange.message;
  return { facts: {}, responseTimeMs: null, statusCode: null, error };
}

/** How much of a reply is kept as a fact. */
const MAX_PREVIEW_BYTES = 120;

export async function udpProbe(
  ctx: ProbeContext<UdpConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(
    ctx.target,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  // The schema demands a port for this type, so this only fires for a
  // row written before it did or by hand. Misconfigured rather than
  // down: there is no port to be unreachable on.
  if (ctx.port === null) {
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: null,
      unavailable: "This monitor has no UDP port configured",
    };
  }

  const payload = encodePayload(ctx.config);
  if (payload.length > MAX_UDP_PAYLOAD_BYTES) {
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: null,
      unavailable: `The stored payload is ${payload.length} bytes, over the ${MAX_UDP_PAYLOAD_BYTES}-byte limit`,
    };
  }

  const endpoint = await resolveDatagramHost(ctx.target);
  if (endpoint === null) {
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: `Could not resolve ${ctx.target}`,
    };
  }

  const exchange = await exchangeDatagram({
    endpoint,
    port: ctx.port,
    payload,
    timeoutMs: ctx.timeoutMs,
  });

  if (exchange.outcome !== "reply") {
    return datagramFailure(exchange, ctx.port, ctx.timeoutMs);
  }

  const { data, responseTimeMs } = exchange;
  return {
    facts: {
      replyBytes: data.length,
      replyPreview: previewOf(data),
      // Absent, not false, when the operator asked for no content: the
      // assertion that reads this is switched off with them, and a fact
      // nobody declared an opinion about is noise in the timeline.
      ...(ctx.config.expectedResponse === null
        ? {}
        : { responseMatches: replyMatches(data, ctx.config) }),
      responseTimeMs,
    },
    responseTimeMs,
    statusCode: null,
    error: null,
  };
}

/**
 * The configured payload as bytes.
 *
 * `Buffer.from(value, "hex")` stops at the first thing that is not a hex
 * pair and returns what it had, so a malformed payload would go out
 * silently truncated. The stored schema refuses that shape, and this
 * normalises the whitespace an operator writes hex with, which the
 * schema also allows.
 */
export function encodePayload(config: UdpConfig): Buffer {
  return config.payloadEncoding === "hex"
    ? Buffer.from(normalizeHex(config.payload), "hex")
    : Buffer.from(config.payload, "utf8");
}

/**
 * Whether the reply carries what the operator said it would.
 *
 * Matched with the same encoding the payload was written in: hex
 * against the reply's hex, text against its text. Somebody probing a
 * binary protocol writes hex on both sides and somebody probing a text
 * one writes text on both sides; the mixed case is not a case.
 */
export function replyMatches(data: Buffer, config: UdpConfig): boolean {
  const expected = config.expectedResponse;
  if (expected === null) return true;
  return config.payloadEncoding === "hex"
    ? data.toString("hex").includes(normalizeHex(expected))
    : data.toString("utf8").includes(expected);
}

/**
 * The reply, made safe to print.
 *
 * `latin1` rather than `utf8`: every byte becomes exactly one character,
 * so a binary reply reads as its printable bytes instead of a run of
 * replacement characters that hides how long it was. The far end chose
 * these bytes and this string lands in the ledger and in an incident
 * email, so control characters are replaced rather than escaped.
 */
export function previewOf(data: Buffer): string {
  const visible = data
    .subarray(0, MAX_PREVIEW_BYTES)
    .toString("latin1")
    .replace(/[^\x20-\x7e]/g, ".");
  return data.length > MAX_PREVIEW_BYTES ? `${visible}…` : visible;
}
