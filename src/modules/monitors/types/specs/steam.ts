import { z } from "zod";

import { DEFAULT_STEAM_PORT, steamDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { flatColumnsOnly, latencyAssertion } from "./shared";

/**
 * A Steam (Source / GoldSrc) game server, watched the way a player's
 * client watches it: one A2S_INFO query, and whatever comes back.
 *
 * There is no config blob, and that is a decision rather than an
 * omission. The two settings a game-server check could plausibly carry
 * were both rejected:
 *
 *  - **"down when the map is not X".** Maps rotate. An assertion on the
 *    current map pages an operator every time the server does the one
 *    thing it is supposed to do.
 *  - **"degraded when the server is full".** A popular server is full
 *    every evening. Filing that as degraded spends the monitor's amber
 *    state on the server's best hours and drags its uptime figure down
 *    for succeeding. The player counts are still recorded as facts, so
 *    the number is on the monitor's page — it just does not get to
 *    decide anything.
 *
 * What is left is what a monitor is for: the server answers, and it
 * answers quickly enough. Everything else it tells us is a fact.
 */

export interface SteamConfig {
  degradedThresholdMs: number;
}

export const steamConfigSchema: z.ZodType<SteamConfig> = z.object({
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/**
 * The only verdict a UDP game query can honestly reach on its own.
 *
 * Shared with `gamedig`, which asks three different servers the same
 * question in three different dialects and needs the same sentence for
 * all of them. Written as a factory rather than a constant so the
 * message can name the protocol that was spoken: "did not answer" is
 * useless to an operator who has to work out whether they picked the
 * wrong port, the wrong protocol, or has a dead server.
 *
 * `false` here never means silence. A server that says nothing at all
 * produces a transport error and never reaches an assertion; `false`
 * means something on that port replied with bytes we could not read as
 * a reply — which is usually a port that belongs to something else.
 */
export function answersQuery<Config>(protocolName: string): Assertion<Config> {
  return {
    id: "answered",
    fact: "answered",
    severity: "down",
    evaluate(value) {
      if (value === true) return null;
      return `Something answered on that port, but not with ${protocolName}`;
    },
  };
}

export const steamSpec: CheckTypeSpec<SteamConfig> = {
  descriptor: steamDescriptor,
  configSchema: steamConfigSchema,
  storedSchema: flatColumnsOnly,
  // No `secretFields`: A2S is unauthenticated. There is no credential
  // anywhere in this type — not in the target, not in a config blob —
  // so there is nothing to mask, and declaring an empty list would
  // imply someone had looked for one and found it empty this release.
  targetSchema: monitorHostnameSchema,
  assertions: [
    answersQuery<SteamConfig>("an A2S_INFO reply"),
    latencyAssertion<SteamConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): SteamConfig {
    return { degradedThresholdMs: row.degradedThresholdMs };
  },
  describeTarget(target, port) {
    // The port is worth printing even when it is the default: a box
    // running four servers answers for four different communities on
    // four ports, and an incident email that omits which one was
    // watched is an email that gets replied to.
    return `${target}:${port ?? DEFAULT_STEAM_PORT}`;
  },
};
