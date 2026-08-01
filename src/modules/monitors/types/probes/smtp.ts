import net from "node:net";

import type { FactBag, ProbeContext, ProbeResult } from "../contract";
import { DEFAULT_SMTP_PORT } from "../catalog";
import { EHLO_OK, SERVICE_READY, type SmtpConfig } from "../specs/smtp";
import { elapsedSince, refusesPrivate } from "./guard";

/**
 * One SMTP conversation: read the greeting, send EHLO, read the reply.
 *
 * Spoken by hand rather than through a mail library, because "did a mail
 * server greet us and accept EHLO" is a banner and one command — a
 * client would bring an entire submission pipeline along for it.
 *
 * Plaintext throughout, deliberately: STARTTLS is never issued, so what
 * this reports is that the MTA is listening and talking, not that its
 * TLS is healthy — a `tls-expiry` monitor on the same host answers that.
 * The consequence an operator meets is port 465, which expects a TLS
 * handshake before a single byte of SMTP and so will never greet this
 * probe; 25, 587 and 2525 all will.
 */

/**
 * The name given to EHLO. RFC 5321 wants a resolvable FQDN here, so a
 * server strict enough to reject a name it cannot resolve will fail this
 * check — that is the server's policy, honestly reported.
 */
const EHLO_NAME = "vigil.monitor";

/**
 * The banner is stored on every check, so it is truncated. Its job is
 * letting an operator recognise that they are talking to the wrong host,
 * and that is legible in the first few words.
 */
const MAX_BANNER = 200;

/**
 * A ceiling on one reply. An EHLO answer is a dozen short lines; a peer
 * that keeps talking past this is not a mail server, and the string it
 * is filling lives in the worker's heap.
 */
const MAX_REPLY_LENGTH = 64 * 1024;

export async function smtpProbe(
  ctx: ProbeContext<SmtpConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(
    ctx.target,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_SMTP_PORT;
  const startedAt = performance.now();

  return new Promise<ProbeResult>((resolve) => {
    // No `connect` handler: in SMTP the server speaks first, so the
    // observation begins with the bytes it sends unprompted.
    const socket = net.connect({ host: ctx.target, port });
    let settled = false;
    let buffer = "";
    let greeting: SmtpReply | null = null;

    const measured = (facts: FactBag) => {
      if (settled) return;
      settled = true;
      const responseTimeMs = elapsedSince(startedAt);
      // QUIT rather than a reset. The measurement is already made, so
      // the reply is not waited for, but a connection dropped without
      // one is what a mail server logs and — on the ones that count
      // them — what earns the next check a tarpit.
      socket.end("QUIT\r\n");
      resolve({
        facts: { ...facts, responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: null,
      });
    };

    const failed = (error: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve({
        facts: {},
        responseTimeMs: elapsedSince(startedAt),
        statusCode: null,
        error,
      });
    };

    // One deadline for the whole conversation rather than a per-read
    // idle timeout: this probe reads two replies, and a server dribbling
    // a byte at a time would reset an idle timer forever. It stays armed
    // past a successful measurement on purpose — that is what closes the
    // socket if the QUIT is never answered.
    const deadline = setTimeout(() => {
      socket.destroy();
      failed(`Timed out after ${ctx.timeoutMs}ms`);
    }, ctx.timeoutMs);

    const pump = () => {
      // Loops because a TCP read boundary is not a reply boundary: one
      // read can carry both replies, or half of one.
      while (!settled) {
        const taken = readReply(buffer);
        if (!taken) return;
        buffer = taken.rest;

        if (greeting === null) {
          greeting = taken.reply;
          if (greeting.code !== SERVICE_READY) {
            // Nothing to say EHLO to. `ehloAccepted` stays absent rather
            // than false: the probe never asked, and a fact it did not
            // observe is not one it may report.
            measured(greetingFacts(greeting));
            return;
          }
          socket.write(`EHLO ${EHLO_NAME}\r\n`);
          continue;
        }

        measured({
          ...greetingFacts(greeting),
          ehloAccepted: taken.reply.code === EHLO_OK,
        });
        return;
      }
    };

    socket.on("data", (chunk: Buffer) => {
      // Decoded per read: reply codes and CRLF are ASCII, so a boundary
      // that splits a multi-byte character can garble a character of the
      // banner text and never the parse.
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_REPLY_LENGTH) {
        failed(`The reply exceeded ${MAX_REPLY_LENGTH} bytes`);
        return;
      }
      pump();
    });

    socket.on("close", () => {
      // Hung up mid-conversation, so nothing was measured: a transport
      // failure rather than a fact about the server. After a completed
      // exchange this is the server answering our QUIT, and `measured`
      // has already settled.
      failed(
        greeting === null
          ? "The server closed the connection without greeting"
          : "The server closed the connection without answering EHLO",
      );
    });

    // `on`, not `once`: this probe writes to the socket, so a peer that
    // resets can produce a second error event, and an unhandled error on
    // a stream takes the worker down with it.
    socket.on("error", (error: Error) => failed(describeSocketError(error)));
  });
}

/**
 * A socket error, as a message that is never empty.
 *
 * Node reports a host whose addresses all failed as an `AggregateError`
 * with an empty message and the real reasons in `errors`. That is the
 * ordinary case here rather than an exotic one — a mail host worth
 * monitoring has several A records, and an unreachable one fails this
 * way every time. An empty string would be worse than a bad message:
 * the runner reads `error` for truthiness, so the outage would be filed
 * as a failed assertion about a reply that was never received.
 */
export function describeSocketError(error: Error): string {
  if (error.message) return error.message;
  if (error instanceof AggregateError) {
    for (const inner of error.errors as unknown[]) {
      if (inner instanceof Error && inner.message) return inner.message;
    }
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code ? `connect ${code}` : "The connection failed";
}

function greetingFacts(greeting: SmtpReply): FactBag {
  return {
    greetingCode: greeting.code,
    banner: greeting.text.slice(0, MAX_BANNER),
  };
}

export interface SmtpReply {
  /** The reply code, or null when the line was not an SMTP reply. */
  code: number | null;
  /** The first line's text, minus the code — the part an operator reads. */
  text: string;
}

/**
 * Reads one complete reply out of `buffer`, or null when the rest of it
 * has not arrived yet. Pure, and exported, because this is where every
 * decision about the protocol lives; the socket around it is plumbing.
 *
 * A reply is one or more lines. Continuations carry a hyphen in the
 * fourth column (`250-PIPELINING`) and the final line a space
 * (`250 SIZE`) — RFC 5321 §4.2.1. Stopping at the first line is the
 * classic bug here: EHLO answers with one line per extension, and the
 * unread remainder would be read back as the answer to the next command.
 */
export function readReply(
  buffer: string,
): { reply: SmtpReply; rest: string } | null {
  let offset = 0;
  let text: string | null = null;

  for (;;) {
    const eol = buffer.indexOf("\n", offset);
    if (eol === -1) return null;
    const line = buffer.slice(offset, eol).replace(/\r$/, "");
    offset = eol + 1;

    // Not an SMTP reply line at all: a web server, an SSH banner, the
    // wrong port. Returned as the reply so the banner fact carries the
    // evidence, instead of waiting out the deadline for a terminator
    // that is never coming.
    if (!/^\d{3}([ -]|$)/.test(line)) {
      return { reply: { code: null, text: line }, rest: buffer.slice(offset) };
    }

    if (text === null) text = line.slice(4).trim();

    if (line[3] !== "-") {
      return {
        reply: { code: Number(line.slice(0, 3)), text },
        rest: buffer.slice(offset),
      };
    }
  }
}
