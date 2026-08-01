import net from "node:net";

import { DEFAULT_FTP_PORT } from "../catalog";
import type { FactBag, ProbeContext, ProbeResult } from "../contract";
import { NEED_PASSWORD, SERVICE_READY, type FtpConfig } from "../specs/ftp";
import { connectionErrorMessage, elapsedSince, refusesPrivate } from "./guard";

/**
 * One FTP control conversation: read the greeting, ask for FEAT, log in
 * if an account is configured, and quit.
 *
 * Only the control connection. No data connection is ever opened — no
 * PASV, no PORT, no LIST — because a monitor that opens a data channel
 * every interval is a monitor that needs a firewall exception on both
 * sides and that will one day be blamed for exhausting a server's
 * passive port range. What this observes is that the control channel is
 * up, answering commands, and accepting the account, which is the part
 * that breaks.
 *
 * Plaintext throughout, deliberately: AUTH TLS is never issued, so what
 * this reports is that the server is listening and talking, not that its
 * TLS is healthy — a `tls-expiry` monitor on the same host answers that.
 * The consequence an operator meets is port 990, which expects a TLS
 * handshake before a single byte of FTP and so will never greet this
 * probe; 21 will.
 *
 * **A configured password travels in the clear.** FTP has no other way,
 * which is why `specs/ftp.ts` says out loud what kind of account belongs
 * here. The one thing a stored credential cannot do is become a command:
 * `ftpStoredSchema` refuses a CR or LF in either field, and `fromRow`
 * falls back to no credentials at all when the blob does not parse — so
 * a value that could inject a line never reaches this file.
 */

/**
 * The FEAT success code (RFC 2389 §3). A server that predates the
 * extension answers 500 or 502 instead, which is not a failure — see
 * the `answers-commands` assertion.
 */
const FEATURES_LISTED = 211;

/**
 * The banner is stored on every check, so it is truncated. Its job is
 * letting an operator recognise that they are talking to the wrong host,
 * and that is legible in the first few words.
 */
const MAX_BANNER = 200;

/**
 * A ceiling on the feature list, which is written to the check history
 * on every check. No FTP server has thirty-two features; a peer that
 * claims more is not the thing being monitored.
 */
const MAX_FEATURES = 32;

/**
 * A ceiling on the whole conversation. A greeting, a feature list and
 * two login replies are a few hundred bytes; a peer that keeps talking
 * past this is filling a string that lives in the worker's heap.
 */
const MAX_RESPONSE_LENGTH = 64 * 1024;

/** Where the conversation is. Each phase reads exactly one reply. */
type Phase = "greeting" | "feat" | "user" | "pass";

const CLOSED_EARLY: Readonly<Record<Phase, string>> = {
  greeting: "The server closed the connection without greeting",
  feat: "The server closed the connection without answering FEAT",
  user: "The server closed the connection without answering USER",
  pass: "The server closed the connection without answering PASS",
};

export async function ftpProbe(
  ctx: ProbeContext<FtpConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(
    ctx.target,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_FTP_PORT;
  const { username, password } = ctx.config;
  const startedAt = performance.now();

  return new Promise<ProbeResult>((resolve) => {
    // No `connect` handler: in FTP the server speaks first, so the
    // observation begins with the bytes it sends unprompted.
    const socket = net.connect({ host: ctx.target, port });
    let settled = false;
    let buffer = "";
    let phase: Phase = "greeting";
    let facts: FactBag = {};

    const measured = (last: FactBag) => {
      if (settled) return;
      settled = true;
      const responseTimeMs = elapsedSince(startedAt);
      // QUIT rather than a reset. The measurement is already made, so
      // the reply is not waited for, but a control connection dropped
      // without one is what an FTP server holds open until its idle
      // timer expires — and those timers are what its connection limit
      // is spent on.
      socket.end("QUIT\r\n");
      resolve({
        facts: { ...facts, ...last, responseTimeMs },
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
    // idle timeout: this probe reads up to four replies, and a server
    // dribbling a byte at a time would reset an idle timer forever.
    const deadline = setTimeout(() => {
      socket.destroy();
      failed(`Timed out after ${ctx.timeoutMs}ms`);
    }, ctx.timeoutMs);

    const pump = () => {
      // Loops because a TCP read boundary is not a reply boundary: one
      // read can carry two replies, or half of one line of one.
      while (!settled) {
        const taken = readReply(buffer);
        if (taken === null) return;
        buffer = taken.rest;
        const reply = taken.reply;

        if (phase === "greeting") {
          facts = {
            greetingCode: reply.code,
            banner: reply.text.slice(0, MAX_BANNER),
          };
          if (reply.code !== SERVICE_READY) {
            // Nothing to send a command to. Every later fact stays
            // absent rather than null: the probe never asked, and a fact
            // it did not observe is not one it may report.
            measured({});
            return;
          }
          socket.write("FEAT\r\n");
          phase = "feat";
          continue;
        }

        if (phase === "feat") {
          facts = {
            ...facts,
            featCode: reply.code,
            // Only when the server actually listed features. A 500 means
            // it does not implement FEAT, and recording an empty list
            // for that would read as "advertises nothing" — which is a
            // different and alarming thing to tell an operator.
            ...(reply.code === FEATURES_LISTED
              ? { features: reply.lines.slice(0, MAX_FEATURES) }
              : {}),
          };
          if (username === null) {
            measured({});
            return;
          }
          socket.write(`USER ${username}\r\n`);
          phase = "user";
          continue;
        }

        if (phase === "user") {
          // 331 is "user name okay, need password". Without one stored
          // there is nothing to send, so the 331 is recorded as the
          // login's outcome and the spec explains it to the operator —
          // sending an empty PASS instead would turn a configuration
          // gap into a 530 that reads like a wrong password.
          if (reply.code === NEED_PASSWORD && password !== null) {
            socket.write(`PASS ${password}\r\n`);
            phase = "pass";
            continue;
          }
          measured({ loginCode: reply.code });
          return;
        }

        measured({ loginCode: reply.code });
        return;
      }
    };

    socket.on("data", (chunk: Buffer) => {
      // Decoded per read: reply codes and CRLF are ASCII, so a boundary
      // that splits a multi-byte character can garble a character of the
      // banner text and never the parse.
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
      // server that answers QUIT with silence and never closes.
      clearTimeout(deadline);
      // Hung up mid-conversation, so nothing was measured: a transport
      // failure rather than a fact about the server. After a completed
      // exchange this is the server answering our QUIT, and `measured`
      // has already settled.
      failed(CLOSED_EARLY[phase]);
    });

    // `on`, not `once`: this probe writes to the socket, so a peer that
    // resets can produce a second error event, and an unhandled error on
    // a stream takes the worker down with it.
    socket.on("error", (error: Error) =>
      failed(connectionErrorMessage(error, "The connection failed")),
    );
  });
}

export interface FtpReply {
  /** The reply code, or null when the line was not an FTP reply. */
  code: number | null;
  /** The first line's text, minus the code — the part an operator reads. */
  text: string;
  /** The lines between the first and the terminator, trimmed. */
  lines: string[];
}

/**
 * Reads one complete reply out of `buffer`, or null when the rest of it
 * has not arrived yet. Pure, and exported, because this is where every
 * decision about the protocol lives; the socket around it is plumbing.
 *
 * FTP is where SMTP's reply format came from, and it is not the same
 * format. RFC 959 §4.2 terminates a multi-line reply on **the same code
 * followed by a space** and allows every line in between to be anything
 * at all — including a line with no code on it, which is what a
 * multi-line FTP banner usually is:
 *
 * ```
 * 220-Welcome to files.example.com
 *  unauthorised access is logged
 * 220 Server ready
 * ```
 *
 * SMTP forbids that shape, so `probes/smtp.ts` stops at the first line
 * whose fourth column is not a hyphen. Reusing that reader here would
 * end the greeting on the middle line, leave the terminator in the
 * buffer, and read it back as the answer to FEAT.
 */
export function readReply(
  buffer: string,
): { reply: FtpReply; rest: string } | null {
  const first = takeLine(buffer, 0);
  if (first === null) return null;

  // Not an FTP reply at all: a web server, an SSH banner, the wrong
  // port. Returned as the reply so the banner fact carries the evidence,
  // instead of waiting out the deadline for a terminator that is never
  // coming.
  if (!/^\d{3}([ -]|$)/.test(first.line)) {
    return {
      reply: { code: null, text: first.line, lines: [] },
      rest: buffer.slice(first.offset),
    };
  }

  const digits = first.line.slice(0, 3);
  const code = Number(digits);
  const text = first.line.slice(4).trim();
  if (first.line[3] !== "-") {
    return {
      reply: { code, text, lines: [] },
      rest: buffer.slice(first.offset),
    };
  }

  const lines: string[] = [];
  let offset = first.offset;
  for (;;) {
    const next = takeLine(buffer, offset);
    if (next === null) return null;
    offset = next.offset;
    // The terminator repeats the opening code with a space — or, on a
    // server that pads nothing, is the bare code. A *different* code
    // inside the block terminates nothing, which is why this compares
    // the digits rather than looking for any code-shaped line.
    if (
      next.line === digits ||
      next.line.startsWith(`${digits} `) ||
      next.line.startsWith(`${digits}\t`)
    ) {
      return { reply: { code, text, lines }, rest: buffer.slice(offset) };
    }
    lines.push(next.line.trim());
  }
}

/** One CRLF-terminated line and where the next one starts. */
function takeLine(
  buffer: string,
  from: number,
): { line: string; offset: number } | null {
  const eol = buffer.indexOf("\n", from);
  if (eol === -1) return null;
  return {
    line: buffer.slice(from, eol).replace(/\r$/, ""),
    offset: eol + 1,
  };
}
