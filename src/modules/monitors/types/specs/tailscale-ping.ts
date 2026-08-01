import { z } from "zod";

import { tailscalePingDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { latencyAssertion } from "./shared";

/**
 * A ping across a tailnet, asked of the local `tailscale` CLI.
 *
 * The thing being watched is a peer that, by design, is reachable from
 * nowhere else: a database on a private VPC, a NAS behind a domestic
 * router, a laptop. No other check type in Vigil can see it, because
 * every other check type dials from this machine's own network and that
 * network has no route. Tailscale does, and the CLI is how a process on
 * the host borrows it.
 *
 * This costs a prerequisite Vigil cannot ship: the `tailscale` binary,
 * plus a tailscaled that is logged in. Neither exists in a default
 * install, so the probe reports `misconfigured` and says exactly what is
 * missing — never `down`. A monitoring product that cannot tell an
 * operator's setup gap from an outage has no business waking anyone up.
 */

export interface TailscalePingConfig {
  /**
   * Attempts before giving up. More than one because a tailnet path can
   * be being renegotiated — a peer that has just changed networks drops
   * the first packet and answers the second — and a monitor that opens
   * an incident for that is a monitor nobody trusts.
   */
  packets: number;
  /**
   * Report a peer that is only reachable through a DERP relay as
   * degraded.
   *
   * Off by default: a relayed connection carries traffic perfectly well
   * and plenty of estates never get a direct path at all, so amber by
   * default would be amber forever. On, it is genuinely useful — a link
   * that silently fell back to a relay in Frankfurt is the reason the
   * application got slow, and nothing else in the stack reports it.
   */
  requireDirect: boolean;
  degradedThresholdMs: number;
}

/**
 * A peer name, as tailscaled resolves them.
 *
 * Not `monitorHostnameSchema`, and the reason is that a tailnet name is
 * not a DNS name: `db-1` is the form MagicDNS actually uses, and a
 * hostname schema that insists on a dot and a public-looking TLD would
 * refuse the common case outright. `100.101.102.103` is refused by that
 * schema too, and it is the address every `tailscale status` prints.
 *
 * What is enforced instead is the shape that keeps the value safe to
 * hand to `execFile`: no leading dash (which argv would read as a flag),
 * no whitespace, no shell metacharacters, nothing that is not a label.
 * There is no shell involved — `execFile`, never `exec` — so this is the
 * second line of that defence rather than the first.
 */
const PEER_NAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** Tailscale's IPv4 range: 100.64.0.0/10, the CGNAT block (RFC 6598). */
function isTailnetIPv4(value: string): boolean {
  const octets = value.split(".");
  if (octets.length !== 4) return false;
  const numbers = octets.map((octet) =>
    /^\d{1,3}$/.test(octet) ? Number(octet) : NaN,
  );
  if (numbers.some((n) => Number.isNaN(n) || n > 255)) return false;
  return numbers[0] === 100 && numbers[1]! >= 64 && numbers[1]! <= 127;
}

/**
 * Tailscale's IPv6 range: fd7a:115c:a1e0::/48. Matched by prefix rather
 * than parsed, because the only question here is "is this plausibly a
 * tailnet address" — tailscaled is what actually resolves it, and an
 * address it does not recognise comes back as `no matching peer`, which
 * is a perfectly readable answer.
 */
function isTailnetIPv6(value: string): boolean {
  return /^fd7a:115c:a1e0:/i.test(value);
}

export const tailscalePeerSchema = z
  .string()
  .trim()
  .max(253)
  .refine(
    (value) =>
      isTailnetIPv4(value) || isTailnetIPv6(value) || PEER_NAME.test(value),
    {
      message:
        "Enter a tailnet peer: a MagicDNS name like db-1 or db-1.tailnet-name.ts.net, or a 100.x address.",
    },
  );

export const tailscalePingStoredSchema = z.object({
  packets: z.number().int().min(1).max(10).default(2),
  requireDirect: z.boolean().default(false),
});

export const tailscalePingConfigSchema: z.ZodType<TailscalePingConfig> =
  z.object({
    packets: z.number().int().min(1).max(10),
    requireDirect: z.boolean(),
    degradedThresholdMs: z.number().int().min(100).max(30_000),
  });

/**
 * What the CLI reported, normalised to the handful of answers that mean
 * different things to an operator.
 *
 * Normalised in the probe rather than judged there, and mapped to a
 * message here, for the same reason `connackMessage` lives in the MQTT
 * spec: the probe reports what happened, the spec decides what it means,
 * and a stored observation can be re-judged later against a spec that
 * words it differently.
 */
export const TAILSCALE_OUTCOMES = [
  "pong",
  "no-peer",
  "no-reply",
  "unknown",
] as const;

export type TailscaleOutcome = (typeof TAILSCALE_OUTCOMES)[number];

export function tailscaleOutcomeMessage(outcome: string): string | null {
  switch (outcome) {
    case "pong":
      return null;
    case "no-peer":
      // A peer that has been removed from the tailnet, and a peer whose
      // name was mistyped, produce the same sentence from tailscaled.
      // The wording has to cover both without implying the other.
      return "No peer with that name is in this tailnet";
    case "no-reply":
      return "The peer is in the tailnet but did not answer";
    default:
      return "The tailnet ping did not succeed";
  }
}

const reachable: Assertion<TailscalePingConfig> = {
  id: "reachable",
  fact: "outcome",
  severity: "down",
  evaluate(value) {
    // Absent when the probe could not run at all, which surfaces as
    // `misconfigured` before any assertion is consulted.
    if (typeof value !== "string") return null;
    return tailscaleOutcomeMessage(value);
  },
};

const directPath: Assertion<TailscalePingConfig> = {
  id: "direct-path",
  fact: "direct",
  severity: "degraded",
  applies: (config) => config.requireDirect,
  evaluate(value) {
    // Only a definite `false` is evidence. A peer that never answered
    // has no path at all, and the `reachable` assertion has already said
    // so — a second line about relaying would bury the cause.
    if (value !== false) return null;
    return "Reachable only through a DERP relay, not directly";
  },
};

export const tailscalePingSpec: CheckTypeSpec<TailscalePingConfig> = {
  descriptor: tailscalePingDescriptor,
  configSchema: tailscalePingConfigSchema,
  storedSchema: tailscalePingStoredSchema,
  targetSchema: tailscalePeerSchema,
  assertions: [
    reachable,
    directPath,
    latencyAssertion<TailscalePingConfig>("Replied"),
  ],
  fromRow(row: MonitorRowView): TailscalePingConfig {
    const stored = tailscalePingStoredSchema.safeParse(row.config ?? {});
    return {
      packets: stored.success ? stored.data.packets : 2,
      requireDirect: stored.success ? stored.data.requireDirect : false,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target) {
    // "on the tailnet" earns its place in an incident email: the same
    // name usually also exists in the operator's ordinary DNS, and the
    // two are different machines often enough to matter.
    return `${target} on the tailnet`;
  },
};
