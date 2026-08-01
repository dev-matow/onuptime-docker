import { randomBytes } from "node:crypto";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import net from "node:net";

import { DEFAULT_SIP_PORT } from "../catalog";
import type { ProbeContext, ProbeResult } from "../contract";
import { sipRequestUri, type SipConfig } from "../specs/sip";
import { connectionErrorMessage, elapsedSince, refusesPrivate } from "./guard";

/**
 * One SIP OPTIONS request, and the status line that answers it.
 *
 * Spoken by hand rather than through a SIP stack. A stack is a state
 * machine for dialogs, registrations, media negotiation and NAT
 * traversal; this check sends one request outside any dialog and reads
 * one response, which is a few hundred bytes each way. Every SIP library
 * in npm is an order of magnitude more machinery than that, and most of
 * them want to own a listening socket for the lifetime of the process —
 * which is the opposite of what a probe that runs every 60 seconds and
 * then goes away should do.
 *
 * The status code is a fact, not an error. A proxy that answers 403 is a
 * proxy that is running and reachable, and reporting that as a transport
 * failure would tell an operator their SBC is unreachable at the moment
 * it is answering them.
 */

/**
 * RFC 3261 §17.1.2.2. A non-INVITE client transaction on an unreliable
 * transport retransmits at T1, doubling to a T2 ceiling, because a lost
 * datagram is otherwise indistinguishable from a dead server. Vigil
 * cares about that distinction more than most callers do: without the
 * retransmissions one dropped packet on an otherwise healthy link opens
 * an incident and wakes somebody up.
 */
const T1_MS = 500;
const T2_MS = 4_000;

/**
 * Ceiling on what will be read from a TCP peer before giving up on it.
 * A SIP response with a full SDP body is a couple of kilobytes; anything
 * approaching this is a peer streaming at us, and an unbounded read
 * would let one of them exhaust the worker.
 */
const MAX_MESSAGE_BYTES = 64 * 1024;

/** The branch magic cookie every RFC 3261 transaction begins with (§8.1.1.7). */
const BRANCH_MAGIC = "z9hG4bK";

export async function sipProbe(
  ctx: ProbeContext<SipConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(
    ctx.target,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_SIP_PORT;

  // Resolved here rather than left to the transport because a datagram
  // socket has to be created as udp4 or udp6 *before* it has anywhere to
  // send, so the address family is a decision this probe cannot avoid
  // making. The residual rebinding window between this lookup and the
  // one `refusesPrivate` did is the same one `guard.ts` documents for
  // every probe that opens its own socket.
  let resolved: { address: string; family: number };
  try {
    resolved = await dns.lookup(ctx.target);
  } catch (error) {
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: connectionErrorMessage(error, "The hostname did not resolve"),
    };
  }

  return ctx.config.transport === "tcp"
    ? overTcp(ctx, resolved.address, port)
    : overUdp(ctx, resolved, port);
}

/* ------------------------------------------------------------------ */
/* UDP — the default transport, and the one that has to retransmit     */
/* ------------------------------------------------------------------ */

function overUdp(
  ctx: ProbeContext<SipConfig>,
  resolved: { address: string; family: number },
  port: number,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const socket = dgram.createSocket(resolved.family === 6 ? "udp6" : "udp4");
    const timers: NodeJS.Timeout[] = [];
    let settled = false;
    let requestsSent = 0;
    let startedAt = performance.now();

    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      // A socket that never bound — the failure path below — throws
      // ERR_SOCKET_DGRAM_NOT_RUNNING on close, and that would escape the
      // probe as an unhandled rejection.
      try {
        socket.close();
      } catch {
        // Already closed; the result is what matters.
      }
      resolve(result);
    };

    socket.once("error", (error: Error) =>
      settle({
        facts: requestsSent > 0 ? { requestsSent } : {},
        responseTimeMs: null,
        statusCode: null,
        error: connectionErrorMessage(error, "The datagram could not be sent"),
      }),
    );

    socket.on("message", (datagram: Buffer) => {
      // One datagram is one message (RFC 3261 §18.3), so there is no
      // framing to do and a Content-Length that lies about the body
      // cannot stall the read the way it could over TCP.
      const read = readSipResponse(datagram, false);
      if (read.state === "partial") return;
      if (read.state === "not-sip") {
        settle(notSip(elapsedSince(startedAt), requestsSent));
        return;
      }
      // A provisional response means the request arrived and the far end
      // is still working on it. Answering with the 100 would report a
      // proxy that is thinking as a proxy that is fine, so the retransmit
      // schedule keeps running until the final response or the deadline.
      if (read.statusCode < 200) return;
      settle(answered(read, elapsedSince(startedAt), requestsSent));
    });

    socket.connect(port, resolved.address, () => {
      // The local address is only knowable once the socket has a peer,
      // and it has to go in the Via header: a UAS that does not honour
      // `rport` sends its response to the sent-by address, and one that
      // does still logs it. Getting it wrong is how a probe times out
      // against a server that answered.
      const local = socket.address();
      const request = Buffer.from(
        buildOptionsRequest({
          host: ctx.target,
          port,
          config: ctx.config,
          localHost: local.address,
          localPort: local.port,
        }),
        "utf8",
      );

      // Every retransmission is byte-identical, which is what makes it a
      // retransmission rather than a second transaction: same branch,
      // same Call-ID, same CSeq. A server that already answered the
      // first one simply answers again.
      const send = () => {
        if (settled) return;
        requestsSent += 1;
        socket.send(request, (error) => {
          if (error) {
            settle({
              facts: { requestsSent },
              responseTimeMs: null,
              statusCode: null,
              error: connectionErrorMessage(
                error,
                "The datagram could not be sent",
              ),
            });
          }
        });
      };

      startedAt = performance.now();
      send();

      let interval = T1_MS;
      const retransmit = () => {
        send();
        interval = Math.min(interval * 2, T2_MS);
        timers.push(setTimeout(retransmit, interval));
      };
      timers.push(setTimeout(retransmit, interval));
      timers.push(
        setTimeout(() => {
          const responseTimeMs = elapsedSince(startedAt);
          settle({
            facts: { requestsSent, responseTimeMs },
            responseTimeMs,
            statusCode: null,
            error: `Timed out after ${ctx.timeoutMs}ms (${requestsSent} ${requestsSent === 1 ? "request" : "requests"} sent)`,
          });
        }, ctx.timeoutMs),
      );
    });
  });
}

/* ------------------------------------------------------------------ */
/* TCP — one connection, framed by Content-Length                      */
/* ------------------------------------------------------------------ */

function overTcp(
  ctx: ProbeContext<SipConfig>,
  address: string,
  port: number,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const socket = net.connect({ host: address, port });
    let settled = false;
    let buffered = Buffer.alloc(0);
    const startedAt = performance.now();

    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(ctx.timeoutMs);
    socket.once("connect", () => {
      socket.write(
        buildOptionsRequest({
          host: ctx.target,
          port,
          config: ctx.config,
          localHost: socket.localAddress ?? address,
          localPort: socket.localPort ?? 0,
        }),
      );
    });

    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_MESSAGE_BYTES) {
        const responseTimeMs = elapsedSince(startedAt);
        settle({
          facts: { requestsSent: 1, responseTimeMs },
          responseTimeMs,
          statusCode: null,
          error: "The server sent an oversized SIP message",
        });
        return;
      }
      // A loop rather than a single read: TCP is a stream, so a
      // provisional response and the final one that follows it are
      // entitled to arrive in the same segment, and stopping after the
      // first message would leave the 200 unread until the next chunk
      // that never comes.
      for (;;) {
        const read = readSipResponse(buffered, true);
        if (read.state === "partial") return;
        if (read.state === "not-sip") {
          settle(notSip(elapsedSince(startedAt), 1));
          return;
        }
        if (read.statusCode >= 200) {
          settle(answered(read, elapsedSince(startedAt), 1));
          return;
        }
        buffered = buffered.subarray(read.length);
      }
    });

    // A server that takes the connection and hangs up without answering
    // has still told us something, and the inactivity timer stops with
    // the socket — without this the promise never settles and the worker
    // slot leaks.
    socket.once("close", () => settle(notSip(elapsedSince(startedAt), 1)));
    socket.once("timeout", () => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { requestsSent: 1, responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: `Timed out after ${ctx.timeoutMs}ms`,
      });
    });
    socket.once("error", (error: Error) => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { requestsSent: 1, responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: connectionErrorMessage(error, "Connection failed"),
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* The wire                                                            */
/* ------------------------------------------------------------------ */

export interface SipRequestParams {
  host: string;
  port: number;
  config: Pick<SipConfig, "requestUser" | "transport">;
  localHost: string;
  localPort: number;
}

/**
 * The OPTIONS request, exactly as it goes on the wire.
 *
 * Pure and exported: every decision this check makes about the protocol
 * is in this string, and the sockets around it are plumbing. The header
 * set is the minimum RFC 3261 §8.1.1 makes mandatory — anything less and
 * a strict UAS answers 400 Bad Request, which would read as an outage of
 * a server that is working perfectly.
 *
 * Neither interpolated value can carry a CRLF: the host has been through
 * `monitorHostnameSchema` and the user through `SIP_USER_PATTERN`. That
 * is what stops a monitor target from appending headers of its own.
 */
export function buildOptionsRequest(params: SipRequestParams): string {
  const { host, port, config, localHost, localPort } = params;
  const uri = sipRequestUri(host, port, config);
  const branch = `${BRANCH_MAGIC}${randomBytes(8).toString("hex")}`;
  const tag = randomBytes(6).toString("hex");
  const callId = `${randomBytes(10).toString("hex")}@vigil.invalid`;
  const transport = config.transport.toUpperCase();
  // A Via sent-by that is an IPv6 literal is bracketed (RFC 3261 §7.3.1
  // via the SIP-URI host production); an unbracketed one is ambiguous
  // with the port separator and some stacks answer 400 to it.
  const sentBy = localHost.includes(":")
    ? `[${localHost}]:${localPort}`
    : `${localHost}:${localPort}`;

  return [
    `OPTIONS ${uri} SIP/2.0`,
    // `rport` (RFC 3581) asks the far end to answer to the source
    // address of the datagram rather than to the sent-by above. Without
    // it a probe behind NAT — which every containerised worker is —
    // never sees the response.
    `Via: SIP/2.0/${transport} ${sentBy};branch=${branch};rport`,
    "Max-Forwards: 70",
    `To: <${uri}>`,
    `From: <sip:vigil@vigil.invalid>;tag=${tag}`,
    `Call-ID: ${callId}`,
    "CSeq: 1 OPTIONS",
    `Contact: <sip:vigil@${sentBy}>`,
    "Accept: application/sdp",
    "User-Agent: vigil-monitor/1.0",
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n");
}

export type SipRead =
  | { state: "partial" }
  | { state: "not-sip" }
  | {
      state: "response";
      statusCode: number;
      statusText: string;
      server: string | null;
      /** Bytes this message occupies, so a stream reader can advance. */
      length: number;
    };

/** `SIP/2.0 200 OK`, tolerating the extra whitespace real stacks emit. */
const STATUS_LINE = /^SIP\/2\.0[ \t]+(\d{3})[ \t]*(.*)$/;

/**
 * Reads one response out of whatever has arrived so far.
 *
 * Pure and exported for the same reason `readConnack` is in the MQTT
 * probe: this is where every judgment about the bytes lives, and it is
 * the part worth testing without a socket.
 *
 * `framed` says whether the caller is reading a stream. Over TCP the
 * message ends where Content-Length says it does, and a truncated one
 * has to come back `partial` so the reader waits for the rest. Over UDP
 * the datagram boundary *is* the message boundary, so a body shorter
 * than its declared length is a malformed message rather than a promise
 * of more to come — and waiting for more would mean waiting forever.
 */
export function readSipResponse(buffer: Buffer, framed: boolean): SipRead {
  const boundary = findHeaderEnd(buffer);
  if (boundary === null) return framed ? { state: "partial" } : notSipRead();

  const head = buffer.subarray(0, boundary.index).toString("utf8");
  // Split liberally: RFC 3261 §7.5 mandates CRLF, and enough stacks in
  // the field send bare LF that refusing them would report working
  // servers as not speaking SIP.
  const lines = head.split(/\r?\n/);
  const status = STATUS_LINE.exec(lines[0] ?? "");
  if (!status) return notSipRead();

  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    // First wins. A malicious or broken peer that sends two
    // Content-Length headers must not be able to pick which one frames
    // the message after we have already parsed it.
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }

  const declared = Number(headers.get("content-length") ?? "0");
  const bodyBytes = Number.isInteger(declared) && declared > 0 ? declared : 0;
  const length = boundary.index + boundary.width + bodyBytes;
  if (framed && buffer.length < length) return { state: "partial" };

  return {
    state: "response",
    statusCode: Number(status[1]),
    statusText: (status[2] ?? "").trim(),
    // `Server` is what a UAS sends; `User-Agent` is what a UAC sends,
    // and plenty of gateways answer OPTIONS with the latter. Reading
    // only one of them would leave the fact empty for half the estate.
    server: headers.get("server") ?? headers.get("user-agent") ?? null,
    length,
  };
}

/** The blank line that ends the headers, and how many bytes it takes. */
function findHeaderEnd(
  buffer: Buffer,
): { index: number; width: number } | null {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { index: crlf, width: 4 };
  if (lf >= 0) return { index: lf, width: 2 };
  return null;
}

function notSipRead(): SipRead {
  return { state: "not-sip" };
}

/**
 * Something answered, but not as a SIP element — or it closed before it
 * got round to it. Facts rather than an error: the packet or the
 * connection arrived, so this is an observation about what is listening,
 * and the `answered` assertion is what turns it into a verdict.
 */
function notSip(responseTimeMs: number, requestsSent: number): ProbeResult {
  return {
    facts: {
      answered: false,
      statusCode: null,
      statusText: null,
      server: null,
      requestsSent,
      responseTimeMs,
    },
    responseTimeMs,
    statusCode: null,
    error: null,
  };
}

function answered(
  read: Extract<SipRead, { state: "response" }>,
  responseTimeMs: number,
  requestsSent: number,
): ProbeResult {
  return {
    facts: {
      answered: true,
      statusCode: read.statusCode,
      statusText: read.statusText.length > 0 ? read.statusText : null,
      server: read.server,
      requestsSent,
      responseTimeMs,
    },
    responseTimeMs,
    // Mirrored onto the outcome column as well as into the facts: the
    // monitor list has shown a status code since 1.0 and a SIP code is
    // the same three digits with the same classes.
    statusCode: read.statusCode,
    error: null,
  };
}
