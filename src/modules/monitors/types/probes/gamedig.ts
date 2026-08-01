import { randomBytes } from "node:crypto";

import type { ProbeContext, ProbeResult } from "../contract";
import {
  conventionalPort,
  type GamedigConfig,
  type GameQueryProtocol,
} from "../specs/gamedig";
import { elapsedSince, refusesPrivate } from "./guard";
import {
  printableText,
  queryA2sInfo,
  queryFailed,
  udpQuery,
  type UdpFailure,
} from "./steam";

/**
 * Three game-server query protocols, spoken by hand over UDP.
 *
 * Which three, and why not three hundred, is argued in
 * `specs/gamedig.ts` and written down for operators in
 * `docs/GAME-SERVERS.md`. The short version: GameDig's game list is a
 * table mapping titles onto a handful of wire protocols, and this speaks
 * the protocols.
 *
 * All three answer the same question — is the server there, and what is
 * it running — so they produce the same five facts, and the type has one
 * pair of assertions rather than one pair per protocol. Everything below
 * is the difference between three ways of asking.
 *
 * The UDP exchange itself, its retransmit and its deadline live in
 * `probes/steam.ts`, next to the A2S codec they were written for. The
 * `source` protocol here *is* that query: it is imported rather than
 * reimplemented, so the `steam` type and this one can never disagree
 * about what a Source server said.
 */

/** What every protocol has to produce, whatever it had to ask. */
export interface GameServerState {
  name: string | null;
  map: string | null;
  players: number | null;
  maxPlayers: number | null;
}

/**
 * The reply, or the reason there is not one. `unreadable` is a datagram
 * that arrived and made no sense — a real observation about the port,
 * and quite different from the silence a `UdpFailure` carries.
 */
type QueryOutcome =
  | { state: "answered"; server: GameServerState }
  | { state: "unreadable" }
  | UdpFailure;

export async function gamedigProbe(
  ctx: ProbeContext<GamedigConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(
    ctx.target,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const protocol = ctx.config.protocol;
  const port = ctx.port ?? conventionalPort(protocol);
  const startedAt = performance.now();
  const deadline = startedAt + ctx.timeoutMs;
  const outcome = await query(protocol, ctx.target, port, deadline);

  if (outcome.state === "silent" || outcome.state === "failed") {
    return queryFailed(outcome, ctx.timeoutMs, startedAt);
  }

  const responseTimeMs = elapsedSince(startedAt);

  if (outcome.state === "unreadable") {
    // Something is listening and it is not the game server this monitor
    // was pointed at — the wrong port, or the wrong protocol for the
    // right port. Facts rather than a transport error: the datagram
    // arrived, so this is an observation, and the `answered` assertion
    // is what turns it into a verdict.
    return {
      facts: {
        answered: false,
        serverName: null,
        map: null,
        players: null,
        maxPlayers: null,
        responseTimeMs,
      },
      responseTimeMs,
      statusCode: null,
      error: null,
    };
  }

  const server = outcome.server;
  return {
    facts: {
      answered: true,
      serverName: server.name,
      map: server.map,
      players: server.players,
      maxPlayers: server.maxPlayers,
      responseTimeMs,
    },
    responseTimeMs,
    statusCode: null,
    error: null,
  };
}

function query(
  protocol: GameQueryProtocol,
  host: string,
  port: number,
  deadline: number,
): Promise<QueryOutcome> {
  switch (protocol) {
    case "source":
      return sourceQuery(host, port, deadline);
    case "minecraft":
      return minecraftQuery(host, port, deadline);
    case "quake3":
      return quake3Query(host, port, deadline);
  }
}

/* ------------------------------------------------------------------ */
/* Source / GoldSrc — A2S_INFO                                         */
/* ------------------------------------------------------------------ */

/**
 * The `steam` type's query, reported through this type's smaller fact
 * set. A split reply is `unreadable` here rather than the
 * `indeterminate` the steam probe reports, and that is the one place the
 * two deliberately differ: this type promises "the server answered a
 * query", and a reply we cannot read is a failed promise either way.
 */
async function sourceQuery(
  host: string,
  port: number,
  deadline: number,
): Promise<QueryOutcome> {
  const outcome = await queryA2sInfo(host, port, deadline);
  switch (outcome.state) {
    case "info":
      return {
        state: "answered",
        server: {
          name: outcome.info.name,
          map: outcome.info.map,
          players: outcome.info.players,
          maxPlayers: outcome.info.maxPlayers,
        },
      };
    case "challenge":
    case "split":
    case "unreadable":
      return { state: "unreadable" };
    case "silent":
    case "failed":
      return outcome;
  }
}

/* ------------------------------------------------------------------ */
/* Minecraft — the GameSpy4 query protocol                             */
/* ------------------------------------------------------------------ */

/**
 * Minecraft's UDP query, which the server only answers when
 * `enable-query=true` is set in `server.properties`. A server without it
 * is perfectly healthy and completely silent, which is why the type's
 * help text says so: a monitor that reports a permanent outage because
 * of a config line nobody knew about is worse than no monitor.
 *
 * Two exchanges, and the first is not optional: the server hands out a
 * token and refuses to answer a stat request that does not carry it.
 * Both are inside one absolute deadline, so a slow server cannot spend
 * the operator's timeout twice.
 */
const QUERY_MAGIC = [0xfe, 0xfd];
const HANDSHAKE = 0x09;
const BASIC_STAT = 0x00;

async function minecraftQuery(
  host: string,
  port: number,
  deadline: number,
): Promise<QueryOutcome> {
  const session = sessionId();

  const handshake = await udpQuery({
    host,
    port,
    request: Buffer.from([...QUERY_MAGIC, HANDSHAKE, ...session]),
    deadline,
  });
  if (handshake.state !== "reply") return handshake;

  const token = readChallenge(handshake.datagram, session);
  if (token === null) return { state: "unreadable" };

  const request = Buffer.alloc(11);
  request.set([...QUERY_MAGIC, BASIC_STAT, ...session], 0);
  // The token is handed to us as decimal text and goes back as a signed
  // 32-bit integer, big-endian. It genuinely can be negative, which is
  // why this is not `writeUInt32BE`.
  request.writeInt32BE(token, 7);

  const stat = await udpQuery({ host, port, request, deadline });
  if (stat.state !== "reply") return stat;

  const state = readBasicStat(stat.datagram, session);
  return state === null
    ? { state: "unreadable" }
    : { state: "answered", server: state };
}

/**
 * A session id the server echoes back on every reply.
 *
 * Masked with `0x0f0f0f0f` because the reference implementation only
 * reads the low nibble of each byte and silently mangles anything else —
 * a session that does not survive the round trip looks exactly like a
 * server answering somebody else's query.
 */
function sessionId(): number[] {
  return [...randomBytes(4)].map((byte) => byte & 0x0f);
}

/** The handshake reply: `09`, the session id, then the token as text. */
export function readChallenge(
  datagram: Buffer,
  session: readonly number[],
): number | null {
  if (!isReplyFor(datagram, HANDSHAKE, session)) return null;
  const end = datagram.indexOf(0, 5);
  const text = datagram.toString("ascii", 5, end === -1 ? undefined : end);
  return /^-?\d+$/.test(text) ? Number(text) : null;
}

/**
 * The basic stat reply: five null-terminated strings, then the port and
 * address the server thinks it has. The last two are read past rather
 * than parsed — the operator already told us where the server is, and a
 * server behind NAT reports the address it cannot be reached on.
 */
export function readBasicStat(
  datagram: Buffer,
  session: readonly number[],
): GameServerState | null {
  if (!isReplyFor(datagram, BASIC_STAT, session)) return null;

  const fields: string[] = [];
  let offset = 5;
  while (fields.length < 5) {
    const end = datagram.indexOf(0, offset);
    if (end === -1) return null;
    fields.push(datagram.toString("utf8", offset, end));
    offset = end + 1;
  }

  const [motd, , map, players, maxPlayers] = fields;
  return {
    name: printableText(motd ?? ""),
    map: printableText(map ?? ""),
    players: wholeNumber(players),
    maxPlayers: wholeNumber(maxPlayers),
  };
}

/** Whether this datagram is the reply we asked for, in this session. */
function isReplyFor(
  datagram: Buffer,
  type: number,
  session: readonly number[],
): boolean {
  if (datagram.length < 6 || datagram.readUInt8(0) !== type) return false;
  return session.every((byte, index) => datagram.readUInt8(1 + index) === byte);
}

/** A count as the wire spells it: decimal digits and nothing else. */
function wholeNumber(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

/* ------------------------------------------------------------------ */
/* id Tech 3 — getstatus                                               */
/* ------------------------------------------------------------------ */

/**
 * Quake III's `getstatus`, which every id Tech 3 descendant inherited —
 * Call of Duty through 4, Wolfenstein: Enemy Territory, OpenArena,
 * Xonotic, Soldier of Fortune II.
 *
 * One datagram each way. The reply is `statusResponse`, an info string of
 * backslash-delimited key/value pairs, and then one line per connected
 * player, which is how the player count is obtained: the info string
 * carries the *limit*, not the occupancy.
 */
const GETSTATUS = Buffer.concat([
  Buffer.from([0xff, 0xff, 0xff, 0xff]),
  Buffer.from("getstatus\n", "ascii"),
]);

async function quake3Query(
  host: string,
  port: number,
  deadline: number,
): Promise<QueryOutcome> {
  const reply = await udpQuery({ host, port, request: GETSTATUS, deadline });
  if (reply.state !== "reply") return reply;

  const state = readStatusResponse(reply.datagram);
  return state === null
    ? { state: "unreadable" }
    : { state: "answered", server: state };
}

export function readStatusResponse(datagram: Buffer): GameServerState | null {
  if (datagram.length < 5 || datagram.readInt32LE(0) !== -1) return null;

  // Decoded as UTF-8, which the modern engines emit. The older ones put
  // raw high bytes in server names; those decode to replacement
  // characters rather than throwing, and `printableText` is what makes
  // whatever survives safe to print.
  const lines = datagram.toString("utf8", 4).split("\n");
  if (lines[0]?.trim() !== "statusResponse") return null;

  const info = readInfoString(lines[1] ?? "");
  return {
    // `sv_hostname` is the id Tech 3 key; `hostname` is what the
    // Quake II-era engines and a few forks answer with instead.
    name: printableText(info.get("sv_hostname") ?? info.get("hostname") ?? ""),
    map: printableText(info.get("mapname") ?? ""),
    // Every line after the info string is a connected player. Blank ones
    // are the trailing newline the servers disagree about sending.
    players: lines.slice(2).filter((line) => line.trim() !== "").length,
    maxPlayers:
      wholeNumber(info.get("sv_maxclients")) ??
      wholeNumber(info.get("maxclients")),
  };
}

/** `\key\value\key\value` — the id Tech 3 info string. */
function readInfoString(line: string): Map<string, string> {
  // The leading backslash makes the first token empty; a stray trailing
  // key with no value is dropped rather than stored as undefined.
  const tokens = line.split("\\").slice(1);
  const info = new Map<string, string>();
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (key !== undefined && value !== undefined) info.set(key, value);
  }
  return info;
}
