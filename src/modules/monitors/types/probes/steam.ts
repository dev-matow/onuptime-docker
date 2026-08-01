import dgram from "node:dgram";

import { DEFAULT_STEAM_PORT } from "../catalog";
import type { ProbeContext, ProbeResult } from "../contract";
import type { SteamConfig } from "../specs/steam";
import { connectionErrorMessage, elapsedSince, refusesPrivate } from "./guard";

/**
 * A2S_INFO — the query a Steam client makes of a game server, spoken by
 * hand over UDP.
 *
 * The whole exchange is twenty-five bytes out and a few hundred back,
 * and this is the only thing Vigil ever asks a game server, so a client
 * library would buy nothing these lines do not.
 *
 * Two things about UDP shape everything below, and neither has an
 * equivalent in the TCP probes next door:
 *
 *  1. **Nothing is connected, so nothing fails fast.** A dead host and a
 *     dropped datagram look identical until the deadline passes. The
 *     socket is therefore `connect`ed anyway — not for the handshake it
 *     does not have, but because a connected UDP socket is told about
 *     the ICMP port-unreachable a closed port answers with, and drops
 *     datagrams from anyone but the server we asked.
 *  2. **A single lost packet must not be an outage.** One retransmit,
 *     half way through the budget, is the difference between a monitor
 *     that reports the internet's ordinary 0.1% loss as downtime and
 *     one that does not. Two round trips still fit inside the operator's
 *     timeout because the deadline is absolute, not per attempt.
 *
 * The UDP exchange lives here, beside the A2S codec it was written for,
 * and `probes/gamedig.ts` imports both: that type's `source` protocol
 * *is* this query, and a second copy of it is a second chance for the
 * two to disagree about the wire.
 */

/* ------------------------------------------------------------------ */
/* The UDP exchange                                                    */
/* ------------------------------------------------------------------ */

export type UdpReply =
  /** The first datagram the server sent back. */
  | { state: "reply"; datagram: Buffer }
  /** Nothing arrived before the deadline. */
  | { state: "silent" }
  /** The datagram could not be sent, or the port answered ICMP. */
  | { state: "failed"; error: string };

/** An exchange that produced no datagram — the two transport failures. */
export type UdpFailure = Exclude<UdpReply, { state: "reply" }>;

export interface UdpQuery {
  host: string;
  port: number;
  request: Buffer;
  /** A `performance.now()` reading: when the whole probe must be over. */
  deadline: number;
}

/**
 * One datagram out, the first datagram back.
 *
 * The retransmit is deliberately not a second *exchange*: it is the same
 * request sent twice into a medium that is allowed to lose things, and
 * either copy of the reply settles it. A server that answers both gets
 * its first answer read and its second discarded with the socket.
 */
export function udpQuery(query: UdpQuery): Promise<UdpReply> {
  const budgetMs = query.deadline - performance.now();
  // The caller has already spent the operator's timeout — on the
  // challenge round trip, usually. Reporting silence is honest and
  // instant; opening a socket to wait zero milliseconds is not.
  if (budgetMs <= 0) return Promise.resolve({ state: "silent" });

  return new Promise<UdpReply>((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timers: NodeJS.Timeout[] = [];
    let settled = false;

    const settle = (reply: UdpReply) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Closing a socket that never finished binding throws. The
        // exchange is over either way, and a failure to clean up must
        // not replace the observation this probe already has.
      }
      resolve(reply);
    };

    const send = () =>
      socket.send(query.request, (error) => {
        if (error) {
          settle({
            state: "failed",
            error: connectionErrorMessage(error, "The query could not be sent"),
          });
        }
      });

    socket.on("message", (datagram: Buffer) =>
      settle({ state: "reply", datagram }),
    );
    // ICMP port-unreachable arrives here on a connected socket, as does
    // a name that does not resolve. Both are the transport saying no,
    // which is a different thing from a server that stayed quiet.
    socket.on("error", (error: Error) =>
      settle({
        state: "failed",
        error: connectionErrorMessage(error, "The query failed"),
      }),
    );

    timers.push(setTimeout(() => settle({ state: "silent" }), budgetMs));
    timers.push(
      setTimeout(() => {
        if (!settled) send();
      }, budgetMs / 2),
    );

    // `connect` resolves the name itself, which is the residual the
    // egress guard documents: the caller has already refused a target
    // that resolves into private space, and this lookup is a second one.
    socket.connect(query.port, query.host, send);
  });
}

/** The transport half of a probe result, phrased for the operator. */
export function queryFailed(
  failure: UdpFailure,
  timeoutMs: number,
  startedAt: number,
): ProbeResult {
  const responseTimeMs = elapsedSince(startedAt);
  return {
    facts: { responseTimeMs },
    responseTimeMs,
    statusCode: null,
    error:
      failure.state === "silent"
        ? `No reply within ${timeoutMs}ms`
        : failure.error,
  };
}

/* ------------------------------------------------------------------ */
/* The A2S codec                                                       */
/* ------------------------------------------------------------------ */

/**
 * The four header bytes are the int32 `-1` written little-endian, and a
 * multi-packet response is `-2`. Read as an integer rather than compared
 * byte by byte because that is what the protocol says they are.
 */
const SIMPLE_RESPONSE = -1;
const SPLIT_RESPONSE = -2;

/** A2S_INFO request (`T`) and the two replies it can draw. */
const A2S_INFO = 0x54;
const S2A_INFO = 0x49;
const S2C_CHALLENGE = 0x41;

/** The payload every A2S_INFO request carries, terminator included. */
const INFO_PAYLOAD = "Source Engine Query\0";

export interface SteamServerInfo {
  name: string;
  map: string;
  game: string;
  players: number;
  maxPlayers: number;
  bots: number;
  vacSecured: boolean;
}

export type A2sReply =
  | { state: "info"; info: SteamServerInfo }
  | { state: "challenge"; challenge: Buffer }
  /** A multi-packet reply. Answered, but not in one piece — see below. */
  | { state: "split" }
  | { state: "unreadable" };

/**
 * The request, with the challenge the server asked for when it asked for
 * one. Exported because the two-step exchange is the part of this
 * protocol worth testing directly.
 */
export function infoRequest(challenge: Buffer | null): Buffer {
  const query = Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, A2S_INFO]),
    Buffer.from(INFO_PAYLOAD, "ascii"),
  ]);
  return challenge === null ? query : Buffer.concat([query, challenge]);
}

/**
 * Reads whatever came back. Pure and exported: every decision this check
 * makes about the wire is here, and the socket around it is plumbing.
 */
export function readA2sReply(datagram: Buffer): A2sReply {
  if (datagram.length < 5) return { state: "unreadable" };

  const header = datagram.readInt32LE(0);
  if (header === SPLIT_RESPONSE) return { state: "split" };
  if (header !== SIMPLE_RESPONSE) return { state: "unreadable" };

  const kind = datagram.readUInt8(4);

  if (kind === S2C_CHALLENGE) {
    // Four bytes of opaque token. Never parsed — it is echoed back
    // exactly as it arrived, so byte order is the server's business.
    if (datagram.length < 9) return { state: "unreadable" };
    return { state: "challenge", challenge: datagram.subarray(5, 9) };
  }

  if (kind !== S2A_INFO) return { state: "unreadable" };

  try {
    return { state: "info", info: readInfoPayload(datagram.subarray(5)) };
  } catch {
    // A truncated or malformed payload is one outcome, not eight.
    // Threading a null through every field would give the caller eight
    // ways to express the same "this is not an A2S_INFO reply".
    return { state: "unreadable" };
  }
}

/**
 * A cursor over the payload. Every read is bounds-checked by Buffer
 * itself and throws past the end, which is exactly the behaviour
 * `readA2sReply` catches: no partial info object is ever built.
 */
class PayloadReader {
  private offset = 0;

  constructor(private readonly bytes: Buffer) {}

  byte(): number {
    const value = this.bytes.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  uint16(): number {
    const value = this.bytes.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  /** A null-terminated UTF-8 string — how A2S carries all of them. */
  text(): string {
    const end = this.bytes.indexOf(0, this.offset);
    if (end === -1) throw new RangeError("unterminated string");
    const value = this.bytes.toString("utf8", this.offset, end);
    this.offset = end + 1;
    return value;
  }
}

/**
 * The A2S_INFO payload, up to the VAC flag.
 *
 * The fields nothing asserts on are still *read* rather than skipped by
 * arithmetic, because four of the first six are variable-length strings:
 * an offset-based version would have to walk them anyway.
 *
 * Reading stops at VAC on purpose. What follows is the version string,
 * and its position depends on the app id — The Ship (2400) inserts three
 * bytes of its own before it — and then an optional extra-data block
 * whose layout is a bitfield. None of it is asserted on, and a parser
 * that walks it is a parser that can be broken by a game nobody here has.
 */
function readInfoPayload(payload: Buffer): SteamServerInfo {
  const reader = new PayloadReader(payload);

  reader.byte(); // protocol version
  const name = reader.text();
  const map = reader.text();
  reader.text(); // the mod's directory; `game` below is its readable name
  const game = reader.text();
  reader.uint16(); // Steam application id
  const players = reader.byte();
  const maxPlayers = reader.byte();
  const bots = reader.byte();
  reader.byte(); // dedicated, listen or SourceTV
  reader.byte(); // operating system
  reader.byte(); // password-protected or not
  const vac = reader.byte();

  return {
    name: printableText(name),
    map: printableText(map),
    game: printableText(game),
    players,
    maxPlayers,
    bots,
    vacSecured: vac === 1,
  };
}

/**
 * A server-chosen string, made safe to print.
 *
 * Server names are decorated with colour codes, control characters and
 * whatever else the operator typed, and this lands in the ledger, in
 * incident emails and on a public status page. Every byte of it was
 * chosen by the far end.
 */
export function printableText(value: string, limit = 80): string {
  const clean = value
    // C0 and C1 controls, which break a log line, a CSV cell and a
    // webhook body alike. Unicode is otherwise left alone: a server
    // called "Кафе" should read as itself.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/* ------------------------------------------------------------------ */
/* The probe                                                           */
/* ------------------------------------------------------------------ */

/**
 * A reply Vigil cannot read is not an outage, and must not be reported
 * as one. `unavailable` says "I could not measure this", which the
 * runner turns into `indeterminate` — the same answer a ping probe gives
 * without CAP_NET_RAW.
 *
 * Reassembling a multi-packet reply means handling packet ids, ordering,
 * and bzip2 payloads on the older engines. A2S_INFO fits in one datagram
 * on every server anyone runs; A2S_RULES, which Vigil does not send, is
 * the query that splits.
 */
const SPLIT_UNSUPPORTED =
  "The server answered with a multi-packet reply, which Vigil does not reassemble.";

export type A2sOutcome = A2sReply | UdpFailure;

/**
 * The full A2S_INFO exchange: one query, one challenge round trip if the
 * server demands one, and the reply.
 *
 * Since December 2020 a Source server answers an unchallenged A2S_INFO
 * with a four-byte token and expects it echoed back — the fix for an
 * amplification attack that used game servers as reflectors. Older
 * GoldSrc servers answer the first query outright, so both paths have to
 * work, and which one happened is not worth reporting: it is a property
 * of the server's build date, not of its health.
 */
export async function queryA2sInfo(
  host: string,
  port: number,
  deadline: number,
): Promise<A2sOutcome> {
  const first = await udpQuery({
    host,
    port,
    request: infoRequest(null),
    deadline,
  });
  if (first.state !== "reply") return first;

  const reply = readA2sReply(first.datagram);
  if (reply.state !== "challenge") return reply;

  const second = await udpQuery({
    host,
    port,
    request: infoRequest(reply.challenge),
    deadline,
  });
  if (second.state !== "reply") return second;

  // A server that challenges the challenged request is not going to
  // stop. One round trip is the protocol; a loop is a server we cannot
  // read, and `readA2sReply` returning `challenge` again lands in
  // `unreadable` at the call site rather than being retried for ever.
  return readA2sReply(second.datagram);
}

export async function steamProbe(
  ctx: ProbeContext<SteamConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(
    ctx.target,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_STEAM_PORT;
  const startedAt = performance.now();
  const outcome = await queryA2sInfo(
    ctx.target,
    port,
    startedAt + ctx.timeoutMs,
  );

  if (outcome.state === "silent" || outcome.state === "failed") {
    return queryFailed(outcome, ctx.timeoutMs, startedAt);
  }

  const responseTimeMs = elapsedSince(startedAt);

  if (outcome.state === "split") {
    return {
      facts: { answered: null, responseTimeMs },
      responseTimeMs,
      statusCode: null,
      error: null,
      unavailable: SPLIT_UNSUPPORTED,
    };
  }

  if (outcome.state !== "info") {
    // Something is listening on that port and it is not a game server —
    // or it is one speaking a protocol this does not read. Facts rather
    // than an error: the datagram arrived, so this is an observation
    // about what is on the port, and the `answered` assertion is what
    // turns it into a verdict.
    return {
      facts: {
        answered: false,
        serverName: null,
        map: null,
        game: null,
        players: null,
        maxPlayers: null,
        bots: null,
        vacSecured: null,
        responseTimeMs,
      },
      responseTimeMs,
      statusCode: null,
      error: null,
    };
  }

  const info = outcome.info;
  return {
    facts: {
      answered: true,
      serverName: info.name,
      map: info.map,
      game: info.game,
      players: info.players,
      maxPlayers: info.maxPlayers,
      bots: info.bots,
      vacSecured: info.vacSecured,
      responseTimeMs,
    },
    responseTimeMs,
    statusCode: null,
    error: null,
  };
}
