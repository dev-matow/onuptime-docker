import http2 from "node:http2";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";

import {
  authorizeEgress,
  EgressBlockedError,
  type ResolvedAddress,
} from "../../egress";
import { normalizeHost } from "../../net";
import { DEFAULT_GRPC_PORT } from "../catalog";
import type { FactBag, ProbeContext, ProbeResult } from "../contract";
import { GRPC_OK, HEALTH_METHOD, type GrpcConfig } from "../specs/grpc";
import { connectionErrorMessage, elapsedSince, monitorEgress } from "./guard";

/**
 * One `grpc.health.v1.Health/Check` call.
 *
 * A TCP connect on 50051 proves a socket opens. It does not separate a
 * server that is serving from one that is still loading its model, has
 * lost its database, or is draining before a rollout — all of which the
 * health protocol exists to report and all of which answer a TCP connect
 * perfectly. Asking the health service is the smallest observation that
 * tells those apart, and deliberately the largest: it runs against
 * production every interval, so it must cost the monitored server one
 * cheap RPC and nothing else.
 *
 * ## No gRPC dependency, and why that was the right call
 *
 * `@grpc/grpc-js` is ~2MB of runtime, a code generator and a `.proto`
 * loader, and every one of those exists to make *arbitrary* RPCs
 * callable. This check makes exactly one, whose message types are two
 * fields long: a request carrying one string, a response carrying one
 * enum. Written by hand that is the forty lines at the bottom of this
 * file — the length-prefixed framing, one protobuf varint, and the
 * status trailer — against a wire format that has been stable since
 * 2016 and is versioned in the path. The dependency would have bought
 * nothing this check uses and would have added a transport that dials on
 * its own, which is the one thing the egress guard cannot allow.
 *
 * `node:http2` is HTTP/2 itself, which is all gRPC is underneath.
 */
export async function grpcProbe(
  ctx: ProbeContext<GrpcConfig>,
): Promise<ProbeResult> {
  const host = normalizeHost(ctx.target);
  const port = ctx.port ?? DEFAULT_GRPC_PORT;
  const scheme = ctx.config.tls ? "https:" : "http:";
  // Built as a URL rather than concatenated: it is what `http2.connect`
  // takes, it is what the egress guard classifies, and one of them
  // parsing a string the other did not is how a guard gets walked
  // around. `net.isIPv6` rather than a bracket test — an operator can
  // only type a hostname here today, but the target column is text and
  // has outlived stricter validation before.
  let authority: URL;
  try {
    authority = new URL(
      `${scheme}//${net.isIPv6(host) ? `[${host}]` : host}:${port}`,
    );
  } catch {
    return blank("Not a hostname");
  }

  let pin: ResolvedAddress | null;
  try {
    ({ pin } = await authorizeEgress(authority, monitorEgress(ctx)));
  } catch (error) {
    // Refused by policy: nothing was sent, so there is no response time
    // to report and no fact to store.
    return blank(
      error instanceof EgressBlockedError
        ? error.message
        : connectionErrorMessage(error, "The target could not be reached"),
    );
  }

  const startedAt = performance.now();

  return new Promise<ProbeResult>((resolve) => {
    let session: http2.ClientHttp2Session;
    try {
      session = http2.connect(authority, {
        // The only hook `http2` gives for the address a session dials,
        // and the reason it is used rather than `refusesPrivate` alone:
        // the socket connects to the address the guard classified
        // instead of resolving a second time, which is the window a
        // rebinding resolver aims at. The hostname stays in the
        // authority, so SNI and the certificate check are still done
        // against the name the operator typed.
        createConnection: () => connect(host, port, ctx.config.tls, pin),
      });
    } catch (error) {
      // `createConnection` runs synchronously inside `connect`, and a
      // transport that cannot even be constructed would otherwise leave
      // this promise rejected — an exception on the worker's hot path
      // rather than a monitor that reports why it failed.
      resolve({
        facts: {},
        responseTimeMs: null,
        statusCode: null,
        error: connectionErrorMessage(error, "The connection failed"),
      });
      return;
    }

    let settled = false;
    // One deadline over connect, request and response together. `http2`
    // times out each phase separately at best, and a server that stalls
    // between them would otherwise hold a worker for the sum of them.
    const deadline = setTimeout(() => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: `Timed out after ${ctx.timeoutMs}ms`,
      });
    }, ctx.timeoutMs);

    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // `destroy`, not `close`: a graceful close waits for a GOAWAY the
      // far end may never send, and this promise has already resolved.
      session.destroy();
      resolve(result);
    };
    const failed = (error: unknown, fallback: string) => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: connectionErrorMessage(error, fallback),
      });
    };

    session.once("error", (error) => failed(error, "The connection failed"));

    const request = session.request(requestHeaders(ctx, authority));

    let httpStatus: number | null = null;
    // Null rather than undefined until something says otherwise: the
    // absence of a `grpc-status` anywhere in the answer is itself the
    // observation that this port is not serving gRPC, and the assertion
    // reads it as one.
    let grpcStatus: number | null = null;
    let grpcMessage: string | null = null;
    const body: Buffer[] = [];

    const readStatus = (headers: http2.IncomingHttpHeaders): void => {
      const status = headerNumber(headers["grpc-status"]);
      if (status !== null) grpcStatus = status;
      const message = headers["grpc-message"];
      if (typeof message === "string" && message.length > 0) {
        // Attacker-supplied and printed in incidents. Decoded because
        // gRPC percent-encodes anything outside ASCII, and truncated
        // because a server is free to send kilobytes.
        grpcMessage = decodeGrpcMessage(message).slice(0, 200);
      }
    };

    request.once("response", (headers) => {
      httpStatus = headerNumber(headers[":status"]);
      // A "trailers-only" answer: the server puts the status in the
      // HEADERS frame and ends the stream, which is exactly what it does
      // for UNIMPLEMENTED — the most important failure this check
      // reports. A client that only listened for trailers would see that
      // as a successful call with an empty body.
      readStatus(headers);
    });
    request.on("trailers", (headers) => readStatus(headers));
    request.on("data", (chunk: Buffer) => body.push(chunk));

    request.once("end", () => {
      const responseTimeMs = elapsedSince(startedAt);
      const facts: FactBag = {
        responseTimeMs,
        httpStatus,
        grpcStatus,
        grpcMessage,
      };
      // Only reported when the call itself succeeded. A failed RPC owes
      // no message, so emitting `servingStatus: null` for one would fire
      // a second assertion about a consequence of the failure the first
      // one has already named.
      if (grpcStatus === GRPC_OK) {
        facts.servingStatus = servingStatusOf(Buffer.concat(body));
      }
      settle({
        facts,
        responseTimeMs,
        statusCode: httpStatus,
        error: null,
      });
    });

    request.once("error", (error) => failed(error, "The health check failed"));

    request.end(healthCheckRequest(ctx.config.service));
  });
}

/**
 * A header as a number, or null when it is absent or not one. Never
 * `NaN`: facts are stored as JSON, where `NaN` serialises to `null`
 * anyway, and an assertion that read one would compare false against
 * everything including itself.
 */
function headerNumber(
  value: number | string | string[] | undefined,
): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The socket the session runs on, pinned to the address the guard
 * approved. `pin` is null only when the hostname did not resolve, in
 * which case the platform resolver is about to fail on it exactly as
 * ours did — with the real error, rather than a synthetic one.
 */
function connect(
  host: string,
  port: number,
  secure: boolean,
  pin: ResolvedAddress | null,
): Duplex {
  const lookup: net.LookupFunction | undefined =
    pin === null
      ? undefined
      : (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [{ address: pin.address, family: pin.family }]);
          } else {
            callback(null, pin.address, pin.family);
          }
        };
  return secure
    ? tls.connect({
        host,
        port,
        lookup,
        // Without this the server has no way to know HTTP/2 was wanted
        // and answers HTTP/1.1, which `http2` then cannot parse — the
        // failure reads as a protocol error rather than as a missing
        // negotiation.
        ALPNProtocols: ["h2"],
        // The certificate is checked against the name the operator
        // typed, not against the pinned address — but only when there is
        // a name: RFC 6066 forbids an IP literal in SNI, and `tls`
        // enforces that by throwing.
        ...(net.isIP(host) === 0 ? { servername: host } : {}),
      })
    : net.connect({ host, port, lookup });
}

function requestHeaders(
  ctx: ProbeContext<GrpcConfig>,
  authority: URL,
): http2.OutgoingHttpHeaders {
  const headers: http2.OutgoingHttpHeaders = {
    ":method": "POST",
    ":path": HEALTH_METHOD,
    // `URL.host` already drops a port that is the scheme's default, so
    // an endpoint behind 443 is addressed as the bare name a server
    // matches its virtual hosts on.
    ":authority": authority.host,
    "content-type": "application/grpc+proto",
    // Required by the gRPC specification, and load-bearing rather than
    // ceremonial: it is how a server is told this client can read the
    // trailer the call's result arrives in.
    te: "trailers",
    // The server's own deadline, so a call this probe has given up
    // waiting for stops costing the monitored server anything. "m" is
    // the protocol's unit suffix for milliseconds.
    "grpc-timeout": `${ctx.timeoutMs}m`,
    "user-agent": "vigil-monitor/1.0 grpc-node-none",
  };
  if (ctx.config.authorization !== null) {
    headers.authorization = ctx.config.authorization;
  }
  return headers;
}

/* ------------------------------------------------------------------ */
/* The two messages, encoded by hand                                   */
/* ------------------------------------------------------------------ */

/** `SERVING` and friends, as the health protocol numbers them. */
const SERVING_STATUS_NAMES: Readonly<Record<number, string>> = {
  0: "UNKNOWN",
  1: "SERVING",
  2: "NOT_SERVING",
  3: "SERVICE_UNKNOWN",
};

/**
 * `HealthCheckRequest { string service = 1; }`, in a gRPC length-prefixed
 * frame.
 *
 * An empty service name is the empty message — protobuf does not encode
 * a field holding its type's default — which is why the health protocol
 * can define "" to mean the server as a whole without a second field to
 * say so.
 */
export function healthCheckRequest(service: string): Buffer {
  const name = Buffer.from(service, "utf8");
  const message =
    name.length === 0
      ? Buffer.alloc(0)
      : // Tag 0x0a: field 1, wire type 2 (length-delimited).
        Buffer.concat([Buffer.from([0x0a]), varint(name.length), name]);
  const frame = Buffer.alloc(5 + message.length);
  // Byte 0 is the compression flag. Nothing is compressed here and
  // nothing may be: this client advertises no `grpc-encoding`, so a
  // compliant server must answer uncompressed too.
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(message.length, 1);
  message.copy(frame, 5);
  return frame;
}

/**
 * The serving status inside a `HealthCheckResponse`, or null when the
 * body does not hold one this client can read.
 *
 * Null rather than a guess of `SERVING`: the whole point of the type is
 * that an answer which does not say it is serving is not evidence that
 * it is.
 */
export function servingStatusOf(body: Buffer): string | null {
  // 5-byte frame header: a compression flag and a big-endian length.
  if (body.length < 5) return null;
  if (body.readUInt8(0) !== 0) return null; // compressed; see above
  const length = body.readUInt32BE(1);
  if (body.length < 5 + length) return null;
  const message = body.subarray(5, 5 + length);

  let offset = 0;
  while (offset < message.length) {
    const tag = readVarint(message, offset);
    if (tag === null) return null;
    offset = tag.offset;
    const field = tag.value >>> 3;
    const wireType = tag.value & 0b111;
    if (field === 1 && wireType === 0) {
      const status = readVarint(message, offset);
      if (status === null) return null;
      return SERVING_STATUS_NAMES[status.value] ?? `status ${status.value}`;
    }
    // Every other field is skipped rather than refused: a later version
    // of the message may add one, and a monitor that stopped reading
    // because a field it does not care about appeared would be a
    // self-inflicted outage.
    const next = skipField(message, offset, wireType);
    if (next === null) return null;
    offset = next;
  }
  return null;
}

/** Base-128, low group first — protobuf's only integer encoding. */
function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    const group = rest & 0x7f;
    rest >>>= 7;
    bytes.push(rest > 0 ? group | 0x80 : group);
  } while (rest > 0);
  return Buffer.from(bytes);
}

function readVarint(
  buffer: Buffer,
  start: number,
): { value: number; offset: number } | null {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < buffer.length) {
    const byte = buffer.readUInt8(offset);
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
    // Bounded: a varint longer than ten groups cannot be a 64-bit
    // number, so the input is malformed and reading on would loop over
    // whatever follows it.
    if (shift > 63) return null;
  }
  return null;
}

/** Skips a field this decoder does not read. Null when it cannot. */
function skipField(
  buffer: Buffer,
  start: number,
  wireType: number,
): number | null {
  switch (wireType) {
    case 0: {
      const skipped = readVarint(buffer, start);
      return skipped === null ? null : skipped.offset;
    }
    case 1:
      return start + 8 <= buffer.length ? start + 8 : null;
    case 2: {
      const length = readVarint(buffer, start);
      if (length === null) return null;
      const end = length.offset + length.value;
      return end <= buffer.length ? end : null;
    }
    case 5:
      return start + 4 <= buffer.length ? start + 4 : null;
    default:
      // Groups (3 and 4) were removed from protobuf before gRPC existed,
      // and 6/7 are not assigned. Anything here means the bytes are not
      // what they claim to be.
      return null;
  }
}

/**
 * gRPC percent-encodes everything outside printable ASCII in
 * `grpc-message`, because a header value cannot carry it otherwise.
 * Decoding failures keep the raw text: a server that encoded badly still
 * said something worth showing.
 */
function decodeGrpcMessage(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function blank(error: string): ProbeResult {
  return { facts: {}, responseTimeMs: null, statusCode: null, error };
}
