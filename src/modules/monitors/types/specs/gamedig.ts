import { z } from "zod";

import {
  gamedigDescriptor,
  GAME_QUERY_PROTOCOLS,
  GAME_QUERY_PROTOCOL_IDS,
  type GameQueryProtocol,
} from "../catalog";
import type { CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";
import { answersQuery } from "./steam";

export { GAME_QUERY_PROTOCOLS, type GameQueryProtocol };

/**
 * A game server, queried over UDP in one of three dialects.
 *
 * The id is `gamedig` because that is what Uptime Kuma calls this
 * monitor and what an import carries across. It is **not** the GameDig
 * library, and the difference is the whole reason this file has a long
 * comment on it. GameDig ships a table of roughly three hundred game
 * ids; almost all of them resolve to one of three wire protocols, and
 * what the table really holds is which port and which quirk each title
 * uses. Vigil speaks the three protocols and does not have the table.
 *
 * That trade was taken deliberately rather than by default:
 *
 *  - The library dials its own sockets. Every probe here goes through
 *    the egress guard first, and a dependency that resolves and
 *    connects on its own is an SSRF hole with a nice API — the one
 *    class of bug this codebase spends the most effort refusing.
 *  - It would be the first monitor dependency in a product whose pitch
 *    is two processes, a Postgres and no broker. Fourteen types already
 *    speak their protocols by hand.
 *  - The three queries below are ninety lines of wire format between
 *    them. A dependency that large buys a lookup table.
 *
 * What it costs is written down in `docs/GAME-SERVERS.md` and repeated
 * in the type's own description: a game whose server speaks something
 * else — Minecraft Bedrock's RakNet, Ventrilo, Nadeo, the GameSpy
 * variants — cannot be watched with this type, and Vigil says so rather
 * than offering a game id it cannot honour.
 */

export interface GamedigConfig {
  protocol: GameQueryProtocol;
  degradedThresholdMs: number;
}

/**
 * The protocol names, listed in the message, because the operator who
 * sees this error is looking at a value that came out of an import or
 * an API call and needs to know what to put there instead.
 */
const PROTOCOL_ERROR = `Choose a query protocol Vigil speaks: ${GAME_QUERY_PROTOCOL_IDS.join(", ")}.`;

export const gamedigStoredSchema = z.object({
  // Defaulted rather than required, because `{}` has to parse: a row
  // written before this field existed, or by a build that spelled it
  // differently, must still produce a check that runs. Source is the
  // right default — it is the family most of GameDig's list belongs to.
  protocol: z
    .enum(GAME_QUERY_PROTOCOL_IDS, { error: PROTOCOL_ERROR })
    .default("source"),
});

export const gamedigConfigSchema: z.ZodType<GamedigConfig> = z.object({
  protocol: z.enum(GAME_QUERY_PROTOCOL_IDS),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/** What the protocol is called in an error message and on the page. */
export function protocolLabel(protocol: GameQueryProtocol): string {
  return (
    GAME_QUERY_PROTOCOLS.find((entry) => entry.id === protocol)?.label ??
    protocol
  );
}

/**
 * The port the protocol conventionally answers on.
 *
 * A fallback, not a default: `port` is required on this type, so the
 * form and the schema both insist on one. This exists for the row that
 * predates the requirement or arrives from an importer that had nothing
 * to put there, where guessing the convention beats dialling port 0.
 */
export function conventionalPort(protocol: GameQueryProtocol): number {
  return (
    GAME_QUERY_PROTOCOLS.find((entry) => entry.id === protocol)?.defaultPort ??
    27015
  );
}

export const gamedigSpec: CheckTypeSpec<GamedigConfig> = {
  descriptor: gamedigDescriptor,
  configSchema: gamedigConfigSchema,
  storedSchema: gamedigStoredSchema,
  // No `secretFields`: none of the three queries authenticates. A game
  // server answers these to anybody — that is what makes them usable as
  // a server browser — so this type holds no credential to leak.
  targetSchema: monitorHostnameSchema,
  assertions: [
    answersQuery<GamedigConfig>("a reply this protocol could read"),
    latencyAssertion<GamedigConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): GamedigConfig {
    const stored = gamedigStoredSchema.safeParse(row.config ?? {});
    return {
      // A blob this build cannot read falls back to the protocol most
      // servers speak rather than to no check at all. The alternative —
      // refusing to run — turns a config the operator can no longer see
      // into a monitor that has silently stopped monitoring.
      protocol: stored.success ? stored.data.protocol : "source",
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, port, config) {
    // The protocol is part of the identity of what is being watched:
    // the same host and port answer differently depending on which
    // query is sent, and two monitors on one server differ by nothing
    // else. This lands in incident emails, so it names the protocol in
    // the words the form used rather than in its id.
    const address = `${target}:${port ?? conventionalPort(config.protocol)}`;
    return `${address} (${protocolLabel(config.protocol)})`;
  },
};
