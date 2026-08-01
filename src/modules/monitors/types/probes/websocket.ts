import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";

import {
  authorizeEgress,
  EgressBlockedError,
  type ResolvedAddress,
} from "../../egress";
import { normalizeHost } from "../../net";
import type { ProbeContext, ProbeResult } from "../contract";
import type { WebsocketConfig } from "../specs/websocket";
import { connectionErrorMessage, elapsedSince, monitorEgress } from "./guard";

/**
 * One WebSocket opening handshake.
 *
 * A TCP connect on 443 proves a socket opens; an HTTP request proves the
 * server answers. Neither says the thing a WebSocket client needs, which
 * is that this path will *upgrade*. A load balancer that has lost its
 * websocket route answers 200 or 404 on it and everything else about the
 * host looks perfect — that is the outage this type exists to catch.
 *
 * The observation is the handshake and nothing after it. No frames are
 * exchanged beyond a Close, because the state a WebSocket monitor can
 * honestly report is "the endpoint agreed to speak"; anything past that
 * is the application's protocol, which Vigil does not know and must not
 * invent.
 *
 * ## Why this issues its own request instead of calling `egressFetch`
 *
 * `fetch` cannot express a 101. The WHATWG interface has no way to
 * surface an informational response or hand back the socket underneath
 * it, so the answer this check exists to read is precisely the one the
 * shared HTTP path throws away. What matters about `egressFetch` is not
 * the transport, though — it is the decision: `authorizeEgress` is the
 * same function it calls, so this probe refuses the same hosts and pins
 * the connection to the same classified address. A redirect chain cannot
 * open a second window either, because a handshake does not follow
 * redirects at all (see below).
 */
export async function websocketProbe(
  ctx: ProbeContext<WebsocketConfig>,
): Promise<ProbeResult> {
  const url = handshakeUrl(ctx.target);
  if (url === null) {
    return blank("Not a WebSocket URL — expected ws:// or wss://");
  }

  let pin: ResolvedAddress | null;
  try {
    ({ pin } = await authorizeEgress(url, monitorEgress(ctx)));
  } catch (error) {
    // A policy refusal is not a measurement: nothing was sent, so there
    // is no handshake time to report and no fact to store.
    return blank(
      error instanceof EgressBlockedError
        ? error.message
        : connectionErrorMessage(error, "The target could not be reached"),
    );
  }

  const key = randomBytes(16).toString("base64");
  const secure = url.protocol === "https:";
  const options: https.RequestOptions = {
    protocol: url.protocol,
    // Unbracketed: `URL.hostname` keeps the brackets on an IPv6 literal
    // and `node:http` re-adds them when it builds `Host`.
    hostname: normalizeHost(url.hostname),
    port: url.port || (secure ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: handshakeHeaders(key, ctx.config),
    // Pooling would let this ride a socket opened for an earlier check,
    // and a reused socket never calls `lookup` — the pin would be
    // decoration. It would also be a socket that has already been
    // upgraded, which is not an HTTP connection any more.
    agent: false,
  };
  // Assigned rather than spread in so the callback picks up its
  // parameter types from `RequestOptions`; only set when the guard
  // actually resolved something, because no pin means the hostname did
  // not resolve and the system resolver is about to fail identically
  // with the real error rather than a synthetic one.
  if (pin !== null) {
    const resolved = pin;
    options.lookup = (_hostname, lookupOptions, callback) => {
      // Node asks with `all: true` from `net.connect` and with the
      // single-address shape elsewhere. Both mean the same one address.
      if (lookupOptions.all) {
        callback(null, [
          { address: resolved.address, family: resolved.family },
        ]);
      } else {
        callback(null, resolved.address, resolved.family);
      }
    };
  }

  const startedAt = performance.now();

  return new Promise<ProbeResult>((resolve) => {
    const request = (secure ? https : http).request(options);
    let settled = false;

    /** Resolve and tear the request down — every path but the upgrade. */
    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      request.destroy();
      resolve(result);
    };
    /**
     * Resolve without touching the request. After an upgrade the socket
     * belongs to the caller, and destroying the request would cut the
     * Close frame off mid-write — the server would log a reset from
     * every check, every interval, for ever.
     */
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    request.setTimeout(ctx.timeoutMs, () => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: `Timed out after ${ctx.timeoutMs}ms`,
      });
    });

    request.once("upgrade", (response, socket) => {
      const responseTimeMs = elapsedSince(startedAt);
      const statusCode = response.statusCode;
      const accept = header(response.headers["sec-websocket-accept"]);
      // `null`, not absent: the handshake completed, and "no protocol
      // was negotiated" is a different answer from "no handshake
      // happened". The assertion reads the difference.
      const subprotocol = header(response.headers["sec-websocket-protocol"]);
      closePolitely(socket);
      if (statusCode === undefined) {
        finish(unreadable(responseTimeMs));
        return;
      }
      finish({
        facts: {
          responseTimeMs,
          statusCode,
          acceptValid: accept === acceptFor(key),
          subprotocol,
        },
        responseTimeMs,
        statusCode,
        error: null,
      });
    });

    request.once("response", (response) => {
      const responseTimeMs = elapsedSince(startedAt);
      // Nothing reads the body of a refused handshake, and an unconsumed
      // stream holds its buffers and its socket open.
      response.resume();
      const statusCode = response.statusCode;
      if (statusCode === undefined) {
        settle(unreadable(responseTimeMs));
        return;
      }
      // A 3xx is reported as itself rather than followed. No WebSocket
      // client is required to follow one, so a monitor that did would
      // pass while every real client failed — and it would be a second
      // request to a host chosen by the answer rather than by the
      // operator, which is the shape the egress guard exists to refuse.
      settle({
        facts: { responseTimeMs, statusCode },
        responseTimeMs,
        statusCode,
        error: null,
      });
    });

    request.once("error", (error: Error) => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: connectionErrorMessage(error, "The handshake failed"),
      });
    });

    request.end();
  });
}

/**
 * The URL the handshake is actually made to.
 *
 * `ws` and `wss` are HTTP on the wire — the scheme exists to tell a
 * client what to do after the upgrade, not to name a different protocol
 * — so the mapping is exact rather than an approximation. It also has to
 * happen before the egress guard sees the URL: that module refuses
 * anything that is not http or https, and rightly, because it is the
 * module that decides what may be dialled.
 */
export function handshakeUrl(target: string): URL | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else return null;
  return url;
}

/**
 * The digest RFC 6455 requires the server to answer with: the key, the
 * protocol's fixed GUID, SHA-1, base64. Exported so the fixture in the
 * unit test computes it the same way a real server does, rather than
 * being handed the answer.
 */
export function acceptFor(key: string): string {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function handshakeHeaders(
  key: string,
  config: WebsocketConfig,
): Record<string, string> {
  const headers: Record<string, string> = {
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-key": key,
    // 13 is the only version RFC 6455 defines. Sending anything else
    // asks servers to answer 426 with a list of what they support, which
    // is a negotiation no monitor needs to have.
    "sec-websocket-version": "13",
  };
  if (config.subprotocol !== null) {
    headers["sec-websocket-protocol"] = config.subprotocol;
  }
  if (config.authorization !== null) {
    headers.authorization = config.authorization;
  }
  return headers;
}

/**
 * An empty, masked Close frame, then a FIN.
 *
 * Six bytes of politeness with a real purpose: a monitor that resets an
 * upgraded connection instead of closing it writes an error into the
 * monitored server's log on every interval, and a server whose logs are
 * full of Vigil's own noise is one an operator stops reading. Masking is
 * not optional — RFC 6455 requires every client frame to be masked, and
 * a compliant server closes on an unmasked one, which would put the
 * error back.
 */
function closePolitely(socket: Socket): void {
  // Attached first: the peer may reset while this is being written, and
  // an unhandled `error` on a bare socket takes the worker down.
  socket.once("error", () => undefined);
  const mask = randomBytes(4);
  socket.end(Buffer.concat([Buffer.from([0x88, 0x80]), mask]));
  // A peer that never answers the Close must not hold a file descriptor
  // for as long as the process lives.
  socket.setTimeout(1_000, () => socket.destroy());
}

/**
 * An answer with no status line.
 *
 * `statusCode` is optional on `IncomingMessage` because the same class
 * carries server-side requests, which have none; a client response
 * always has one. Reporting the impossible case as a failure to measure
 * is the only honest alternative to inventing a status — and a fact
 * invented here would be judged exactly like one that was observed.
 */
function unreadable(responseTimeMs: number): ProbeResult {
  return {
    facts: { responseTimeMs },
    responseTimeMs,
    statusCode: null,
    error: "The server's answer carried no status",
  };
}

/** One header value, or null. Node gives an array for repeated names. */
function header(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function blank(error: string): ProbeResult {
  return { facts: {}, responseTimeMs: null, statusCode: null, error };
}
