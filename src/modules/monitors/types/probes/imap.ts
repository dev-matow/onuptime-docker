import net from "node:net";

import { DEFAULT_IMAP_PORT } from "../catalog";
import type { FactBag, ProbeContext, ProbeResult } from "../contract";
import {
  IMAP_GREETINGS,
  type ImapConfig,
  type ImapGreeting,
} from "../specs/imap";
import { connectionErrorMessage, elapsedSince, refusesPrivate } from "./guard";

/**
 * One IMAP conversation: read the greeting, ask for CAPABILITY, read the
 * answer, log out.
 *
 * Spoken by hand rather than through a mail library, for the reason the
 * SMTP probe gives: "did the store greet us and answer a command" is a
 * banner and one command, and an IMAP client would bring a folder
 * synchroniser along for it.
 *
 * **Nothing is authenticated, and that is not an omission.** The
 * conversation is plaintext throughout — STARTTLS is never issued — so
 * sending LOGIN would put a mailbox password on the wire in the clear on
 * every check, every interval, forever. RFC 3501 §7.2.1 has the other
 * half of the argument: a server that refuses cleartext logins is
 * *required* to advertise LOGINDISABLED and reject LOGIN, so an
 * authenticating check would report every correctly configured mail
 * server as down. What this observes is that the store is listening,
 * talking, and still offering the capabilities its clients need; a
 * `tls-expiry` monitor on the same host answers the question about TLS.
 *
 * The consequence an operator meets is port 993, which expects a TLS
 * handshake before a single byte of IMAP and so will never greet this
 * probe. 143 will.
 */

/**
 * The tags for the two commands this probe sends. A tag identifies which
 * command a response completes (RFC 3501 §2.2.1), so they must differ:
 * with one tag reused, the answer to LOGOUT would be indistinguishable
 * from a late answer to CAPABILITY.
 */
const CAPABILITY_TAG = "v1";
const LOGOUT_TAG = "v2";

/**
 * The banner is stored on every check, so it is truncated. Its job is
 * letting an operator recognise that they are talking to the wrong host,
 * and that is legible in the first few words.
 */
const MAX_BANNER = 200;

/**
 * A ceiling on the capability list. Dovecot advertises about twenty
 * entries and Exchange rather more; a peer that keeps naming
 * capabilities is not a mail store, and this list is written to the
 * check history on every single check.
 */
const MAX_CAPABILITIES = 64;

/**
 * A ceiling on the whole conversation. A greeting and a CAPABILITY
 * response are a few hundred bytes; a peer that keeps talking past this
 * is filling a string that lives in the worker's heap.
 */
const MAX_RESPONSE_LENGTH = 64 * 1024;

type Phase = "greeting" | "capability";

export async function imapProbe(
  ctx: ProbeContext<ImapConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(
    ctx.target,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_IMAP_PORT;
  const startedAt = performance.now();

  return new Promise<ProbeResult>((resolve) => {
    // No `connect` handler: in IMAP the server speaks first, so the
    // observation begins with the bytes it sends unprompted.
    const socket = net.connect({ host: ctx.target, port });
    let settled = false;
    let buffer = "";
    let phase: Phase = "greeting";
    let greeting: FactBag = {};
    let capabilities: string[] | null = null;

    const measured = (facts: FactBag) => {
      if (settled) return;
      settled = true;
      const responseTimeMs = elapsedSince(startedAt);
      // LOGOUT rather than a reset. The measurement is already made, so
      // the answer is not waited for, but a connection dropped without
      // one is what a mail store logs as an aborted session — and on the
      // servers that count them, what earns the next check a delay.
      socket.end(`${LOGOUT_TAG} LOGOUT\r\n`);
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
    // idle timeout: this probe reads two responses, and a server
    // dribbling a byte at a time would reset an idle timer forever.
    const deadline = setTimeout(() => {
      socket.destroy();
      failed(`Timed out after ${ctx.timeoutMs}ms`);
    }, ctx.timeoutMs);

    const pump = () => {
      // Loops because a TCP read boundary is not a line boundary: one
      // read can carry the greeting and the whole capability response,
      // or half of one line.
      for (;;) {
        const taken = readLine(buffer);
        if (taken === null) return;
        buffer = taken.rest;

        if (phase === "greeting") {
          const status = parseGreeting(taken.line);
          greeting = {
            greetingStatus: status,
            banner: taken.line.slice(0, MAX_BANNER),
          };
          if (status === null || status === "BYE") {
            // Nothing to send CAPABILITY to. `capabilityAccepted` stays
            // absent rather than false: the probe never asked, and a
            // fact it did not observe is not one it may report.
            measured(greeting);
            return;
          }
          socket.write(`${CAPABILITY_TAG} CAPABILITY\r\n`);
          phase = "capability";
          continue;
        }

        const advertised = parseCapabilities(taken.line);
        if (advertised !== null) {
          capabilities = advertised.slice(0, MAX_CAPABILITIES);
          continue;
        }

        const completion = parseTagged(taken.line, CAPABILITY_TAG);
        // Anything else is another untagged response — an ALERT, a
        // pre-auth notice — which the server is entitled to send at any
        // time and which says nothing about our command.
        if (completion === null) continue;

        measured({
          ...greeting,
          capabilityAccepted: completion === "OK",
          // Recorded only on a tagged OK, and empty rather than absent
          // when the server advertised nothing: "the command failed" and
          // "the command succeeded and named no capabilities" are
          // different faults, and `specs/imap.ts` judges them
          // differently.
          ...(completion === "OK" ? { capabilities: capabilities ?? [] } : {}),
        });
        return;
      }
    };

    socket.on("data", (chunk: Buffer) => {
      // Decoded per read: IMAP keywords and CRLF are ASCII, so a
      // boundary that splits a multi-byte character can garble a
      // character of the banner text and never the parse.
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_RESPONSE_LENGTH) {
        failed(`The response exceeded ${MAX_RESPONSE_LENGTH} bytes`);
        return;
      }
      pump();
    });

    socket.on("close", () => {
      // Disarmed here rather than in `measured`, so a timer does not sit
      // pending for the rest of the timeout after a successful check.
      // The deadline still owns the case this handler cannot see: a
      // server that answers LOGOUT with silence and never closes.
      clearTimeout(deadline);
      // Hung up mid-conversation, so nothing was measured: a transport
      // failure rather than a fact about the server. After a completed
      // exchange this is the server answering our LOGOUT, and `measured`
      // has already settled.
      failed(
        phase === "greeting"
          ? "The server closed the connection without greeting"
          : "The server closed the connection without answering CAPABILITY",
      );
    });

    // `on`, not `once`: this probe writes to the socket, so a peer that
    // resets can produce a second error event, and an unhandled error on
    // a stream takes the worker down with it.
    socket.on("error", (error: Error) =>
      failed(connectionErrorMessage(error, "The connection failed")),
    );
  });
}

/**
 * Reads one complete line out of `buffer`, or null when the rest of it
 * has not arrived yet.
 *
 * Lines, not IMAP's full grammar, and the boundary is worth stating: a
 * response containing a literal (`{42}\r\n` followed by 42 raw bytes)
 * cannot be split this way. Neither the greeting nor a CAPABILITY
 * response may contain one — both are atoms and text — so the grammar
 * this probe needs is exactly a line, and implementing the rest would be
 * writing an IMAP parser to answer a question that never asks for it.
 */
export function readLine(
  buffer: string,
): { line: string; rest: string } | null {
  const eol = buffer.indexOf("\n");
  if (eol === -1) return null;
  return {
    line: buffer.slice(0, eol).replace(/\r$/, ""),
    rest: buffer.slice(eol + 1),
  };
}

/**
 * The status of an untagged greeting, or null when the line is not one.
 *
 * Pure, and exported, because this is where every decision about the
 * protocol lives; the socket around it is plumbing.
 */
export function parseGreeting(line: string): ImapGreeting | null {
  const match = /^\*\s+([A-Z]+)\b/i.exec(line);
  const word = match?.[1]?.toUpperCase();
  return IMAP_GREETINGS.find((greeting) => greeting === word) ?? null;
}

/**
 * The capabilities in an untagged CAPABILITY response, or null when the
 * line is not one.
 *
 * The greeting may carry the same list in a `[CAPABILITY ...]` response
 * code, and this deliberately does not read it: a banner proves a
 * process is writing bytes, whereas a CAPABILITY response proves it
 * accepted a command, parsed it and answered. That difference is the
 * whole check.
 */
export function parseCapabilities(line: string): string[] | null {
  const match = /^\*\s+CAPABILITY\b\s*(.*)$/i.exec(line);
  if (!match) return null;
  return (match[1] ?? "").split(/\s+/).filter((entry) => entry.length > 0);
}

/** What a tagged completion can say (RFC 3501 §7.1). */
const COMPLETIONS = ["OK", "NO", "BAD"] as const;
export type ImapCompletion = (typeof COMPLETIONS)[number];

/**
 * The completion status of the tagged command, or null for any other
 * line. Matched by comparison rather than by building a regular
 * expression around `tag` — a tag interpolated into a pattern is a
 * pattern the caller can rewrite.
 */
export function parseTagged(line: string, tag: string): ImapCompletion | null {
  const [head, status] = line.split(/\s+/);
  if (head?.toLowerCase() !== tag.toLowerCase()) return null;
  const word = status?.toUpperCase();
  return COMPLETIONS.find((completion) => completion === word) ?? null;
}
