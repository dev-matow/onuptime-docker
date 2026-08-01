import net from "node:net";

import { DEFAULT_SSH_PORT } from "../catalog";
import type { FactBag, ProbeContext, ProbeResult } from "../contract";
import type { SshConfig } from "../specs/ssh";
import { connectionErrorMessage, elapsedSince, refusesPrivate } from "./guard";

/**
 * One connection, and the identification string the daemon sends first.
 *
 * RFC 4253 §4.2: the server sends `SSH-protoversion-softwareversion SP
 * comments CR LF` as soon as it accepts, before any key exchange. That
 * line is the observation and the time it took to arrive is the
 * measurement.
 *
 * Nothing is written to the socket. Sending our own identification
 * string would start a key exchange — the server would answer with a
 * KEXINIT and begin Diffie-Hellman — which costs the monitored host real
 * CPU every interval and proves nothing the banner has not already
 * proved. No authentication is attempted either, and that is the type's
 * design rather than an omission: an SSH check that logged in would need
 * a key on the monitoring host, and the monitoring host would become a
 * credentialed foothold on every machine it watches.
 *
 * What this cannot see is anything past the banner. `sshd` prints it
 * after forking, so a daemon that is wedged in `MaxStartups`, refusing
 * every key, or serving a broken host key still greets this probe
 * cheerfully. It answers "is the daemon accepting and talking", which is
 * the question a TCP check on 22 cannot answer at all — a systemd socket
 * unit accepts the connection whether or not `sshd` is behind it.
 */

/**
 * The identification string is at most 255 bytes including CRLF (§4.2),
 * but the server may send other lines before it — legal notices, load
 * balancer preambles — and the RFC puts no limit on those. This is the
 * limit: past it, whatever is on the port is not going to identify
 * itself, and the string being accumulated lives in the worker's heap.
 */
const MAX_PREAMBLE = 8 * 1024;

/** The banner is stored on every check, so it is bounded by §4.2's own. */
const MAX_BANNER = 255;

export async function sshProbe(
  ctx: ProbeContext<SshConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(
    ctx.target,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_SSH_PORT;
  const startedAt = performance.now();

  return new Promise<ProbeResult>((resolve) => {
    // No `connect` handler: the server speaks first, so the observation
    // begins with the bytes it sends unprompted.
    const socket = net.connect({ host: ctx.target, port });
    let settled = false;
    let buffer = "";

    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const measured = (facts: FactBag, responseTimeMs: number) => {
      if (settled) return;
      settled = true;
      // A clean FIN rather than the reset `settle` would send. By the
      // time the banner has been read, `sshd` has usually already queued
      // its KEXINIT behind it, and a socket destroyed with unread bytes
      // waiting sends RST — which the daemon logs as "Connection reset
      // by", every interval, next to the resets an actual attack makes.
      socket.end();
      resolve({ facts, responseTimeMs, statusCode: null, error: null });
    };

    socket.setTimeout(ctx.timeoutMs);

    socket.on("data", (chunk: Buffer) => {
      // Decoded per read: the identification string is printable US-ASCII
      // by §4.2, so a read boundary that splits a multi-byte sequence can
      // garble a character of a non-conforming banner and never the
      // parse.
      buffer += chunk.toString("utf8");
      const read = readIdentification(buffer);
      if (read.state === "partial") return;
      const responseTimeMs = elapsedSince(startedAt);
      measured(
        read.state === "identified"
          ? {
              identified: true,
              protocolVersion: read.protocolVersion,
              softwareVersion: read.softwareVersion,
              banner: read.banner,
              responseTimeMs,
            }
          : notSsh(read.banner, responseTimeMs),
        responseTimeMs,
      );
    });

    // A daemon that accepts and then hangs up without greeting has still
    // told us something — it is what a host over `MaxStartups` does, and
    // what a TCP proxy in front of a dead backend does. Handled rather
    // than left to the timeout because the inactivity timer stops with
    // the socket: without this the promise never settles and the worker
    // slot leaks.
    socket.once("close", () => {
      // Anything already identified settled in the data handler above,
      // so reaching here means the daemon never got round to greeting.
      const responseTimeMs = elapsedSince(startedAt);
      measured(notSsh(firstLine(buffer), responseTimeMs), responseTimeMs);
    });

    socket.once("timeout", () => {
      // Destroyed unconditionally: this also fires after a successful
      // measurement, and it is what closes a socket whose half-close the
      // daemon never answered. `settle` is a no-op by then.
      socket.destroy();
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: `Timed out after ${ctx.timeoutMs}ms`,
      });
    });

    socket.once("error", (error: Error) => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: connectionErrorMessage(error, "Connection failed"),
      });
    });
  });
}

/**
 * Something answered on the port and it was not an SSH daemon. Facts
 * rather than an error: the connection worked, so this is an observation
 * about what is listening, and the `identification` assertion is what
 * turns it into a verdict. The line it did send is carried so an
 * operator can recognise the HTTP server they pointed this at.
 */
function notSsh(banner: string, responseTimeMs: number): FactBag {
  return {
    identified: false,
    protocolVersion: null,
    softwareVersion: null,
    banner: banner.length > 0 ? banner.slice(0, MAX_BANNER) : null,
    responseTimeMs,
  };
}

/** The first non-empty line of whatever arrived, complete or not. */
function firstLine(buffer: string): string {
  for (const line of buffer.split("\n")) {
    const trimmed = line.replace(/\r$/, "").trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

export type IdentificationRead =
  | { state: "partial" }
  | { state: "not-ssh"; banner: string }
  | {
      state: "identified";
      banner: string;
      protocolVersion: string;
      softwareVersion: string;
    };

/**
 * Reads the identification string out of whatever has arrived so far.
 * Pure and exported, because every decision this check makes about the
 * protocol lives here; the socket around it is plumbing.
 *
 * Lines that are not the identification string are skipped rather than
 * rejected — §4.2 lets a server send a legal notice first, and stopping
 * at the first line would report every bastion with a banner file as
 * down. They are skipped only up to {@link MAX_PREAMBLE}, because a peer
 * that is not an SSH server also fails to start with `SSH-`, and waiting
 * out the whole timeout to say so wastes a worker slot and reports
 * "timed out" for a port that answered instantly.
 */
export function readIdentification(buffer: string): IdentificationRead {
  let offset = 0;

  for (;;) {
    const eol = buffer.indexOf("\n", offset);
    if (eol === -1) break;
    // The RFC requires CRLF and then tells implementations to tolerate a
    // bare LF, which some embedded daemons send.
    const line = buffer.slice(offset, eol).replace(/\r$/, "");
    offset = eol + 1;

    if (!line.startsWith("SSH-")) continue;

    // `SSH-2.0-OpenSSH_9.6p1 Debian-3`: the protocol version runs to the
    // second hyphen and the software version to the first space, after
    // which §4.2 allows free-text comments.
    const rest = line.slice("SSH-".length);
    const separator = rest.indexOf("-");
    if (separator === -1) {
      // `SSH-2.0` with nothing after it is not an identification string.
      // Reported as the banner rather than skipped, because it is the
      // most useful thing an operator could be shown about a peer that
      // is imitating one badly.
      return { state: "not-ssh", banner: line.slice(0, MAX_BANNER) };
    }
    const remainder = rest.slice(separator + 1);
    const space = remainder.indexOf(" ");

    return {
      state: "identified",
      banner: line.slice(0, MAX_BANNER),
      protocolVersion: rest.slice(0, separator),
      softwareVersion: space === -1 ? remainder : remainder.slice(0, space),
    };
  }

  if (buffer.length > MAX_PREAMBLE) {
    return { state: "not-ssh", banner: firstLine(buffer) };
  }
  return { state: "partial" };
}
