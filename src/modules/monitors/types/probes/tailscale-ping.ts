import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ProbeContext, ProbeResult } from "../contract";
import {
  tailscalePeerSchema,
  type TailscaleOutcome,
  type TailscalePingConfig,
} from "../specs/tailscale-ping";

const execFileAsync = promisify(execFile);

/**
 * `tailscale ping`, run as a subprocess.
 *
 * There is no other way in. A tailnet is a WireGuard mesh whose keys and
 * routes live inside tailscaled; reaching a peer means going through
 * that daemon, and the supported interfaces to it are the CLI and a
 * local API socket whose shape is explicitly not stable. The CLI is the
 * contract Tailscale actually keeps, so the CLI is what this uses —
 * through `execFile`, never a shell, so there is nothing to inject into.
 *
 * The private-address guard is deliberately NOT applied here, and this
 * is the exception that will read like a bug later, so:
 *
 *  - Every tailnet address is in 100.64.0.0/10, which the classifier
 *    calls `private`. Running the guard would refuse every real target
 *    this type has, and the only way to use the type at all would be to
 *    set `ALLOW_PRIVATE_MONITOR_TARGETS` — which widens the policy for
 *    every *other* monitor on the install, including the HTTP ones an
 *    untrusted user can create. Turning off a defence globally to use
 *    one feature is worse than not having the feature.
 *  - The guard defends against Vigil being used to reach something it
 *    should not. Nothing here opens a socket: tailscaled decides what
 *    the name resolves to, and it will only ever send packets to a peer
 *    of this tailnet. A target that is not one comes back as
 *    `no matching peer`. The blast radius is a network the operator
 *    deliberately joined this host to.
 *  - What the target *can* reach is argv, so the peer name is validated
 *    against `tailscalePeerSchema` here as well as at write time.
 *
 * `LC_ALL=C` for the same reason `ping` sets it: the lines parsed below
 * are the CLI's human output, and a localised host would make the parse
 * non-deterministic.
 */

/** What `tailscale ping` printed, and how it exited. */
export interface TailscaleRun {
  stdout: string;
  stderr: string;
  code: number;
}

/** The binary is not on this host at all. */
export class MissingTailscaleError extends Error {}

/**
 * Runs the CLI. Injectable so the probe's decisions — which failures are
 * operator problems, how a pong line is read — can be exercised against
 * a stand-in binary instead of a real tailnet.
 */
export type TailscaleRunner = (
  args: string[],
  timeoutMs: number,
) => Promise<TailscaleRun>;

async function runTailscale(
  args: string[],
  timeoutMs: number,
): Promise<TailscaleRun> {
  try {
    const { stdout, stderr } = await execFileAsync("tailscale", args, {
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      // A hard ceiling above the CLI's own deadline: if the binary
      // wedges — a tailscaled that accepts the connection and never
      // answers does exactly that — the probe must still return inside
      // the check window.
      timeout: timeoutMs + 2_000,
      maxBuffer: 64 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    if (failure.code === "ENOENT") throw new MissingTailscaleError();
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      // A non-zero exit is the ordinary way this CLI reports an
      // unreachable peer, so it is data rather than a throw. Anything
      // that is not a numeric exit status (a signal, a spawn failure) is
      // reported as 2, matching what the shell would show.
      code: typeof failure.code === "number" ? failure.code : 2,
    };
  }
}

export function buildArgs(
  peer: string,
  packets: number,
  timeoutMs: number,
): string[] {
  // Divided by the attempt count so the whole run fits the monitor's
  // timeout: the CLI's `--timeout` is per attempt, and `--c=3` with the
  // full budget on each would take three times as long as the operator
  // asked for.
  const seconds = Math.max(1, Math.ceil(timeoutMs / packets / 1000));
  return [
    "ping",
    `--c=${packets}`,
    `--timeout=${seconds}s`,
    // The default is to keep pinging until a direct path is negotiated,
    // which turns a relayed-but-working peer into a slow check that
    // reports the last attempt rather than the first answer. A monitor
    // wants the first answer; whether it came directly is a fact it
    // reports, not something it should wait for.
    "--until-direct=false",
    peer,
  ];
}

/**
 * `pong from db-1 (100.101.102.103) via 203.0.113.5:41641 in 12ms`, or
 * the same line with `via DERP(fra)` when the path is relayed.
 */
const PONG_LINE = /^pong from (\S+) \(([^)]+)\) via (\S+) in ([\d.]+)\s*ms/im;

export interface TailscalePong {
  peer: string;
  peerAddress: string;
  via: string;
  direct: boolean;
  responseTimeMs: number;
}

/**
 * The first pong in the output, or null when there is none.
 *
 * The *first* deliberately: with more than one attempt the CLI prints a
 * line per packet, and the question this check asks is "did it answer",
 * not "did every packet answer". A peer that dropped the first packet
 * while its path was being renegotiated is not an outage.
 */
export function parsePong(stdout: string): TailscalePong | null {
  const match = PONG_LINE.exec(stdout);
  if (!match) return null;
  const via = match[3] ?? "";
  return {
    peer: match[1] ?? "",
    peerAddress: match[2] ?? "",
    via,
    // A relayed path is printed as `DERP(region)`; a direct one is an
    // ip:port. Anything else is new syntax, and calling that "not
    // direct" would raise a degraded alert on a working link, so only
    // the shape we recognise as a relay counts as one.
    direct: !/^DERP\b/i.test(via),
    responseTimeMs: Math.round(Number(match[4])),
  };
}

/**
 * Whether the CLI failed for a reason that is about this host rather
 * than about the peer, and the sentence to show an operator if so.
 *
 * Every one of these is a setup gap: nothing has been measured, so
 * reporting `down` would be a lie about the peer. Pure and exported —
 * this classification is the whole difference between "your database is
 * unreachable" and "this worker is not on your tailnet".
 */
export function unavailableReason(text: string): string | null {
  if (/failed to connect to local tailscale|is tailscale running/i.test(text)) {
    return "The local tailscaled is not answering. Start Tailscale on the machine running this worker.";
  }
  if (/logged out|needslogin|tailscale up/i.test(text)) {
    return "This machine is not signed in to a tailnet. Run `tailscale up` on the worker's host.";
  }
  if (/tailscale is stopped|state=stopped/i.test(text)) {
    return "Tailscale is installed but stopped on this machine. Run `tailscale up` to rejoin the tailnet.";
  }
  if (
    /permission denied|operation not permitted|access is denied/i.test(text)
  ) {
    return "The worker may not talk to tailscaled. Add its user to the group that owns the tailscaled socket.";
  }
  return null;
}

/** What the run says happened to the ping itself. */
export function classifyOutcome(text: string): TailscaleOutcome {
  if (/no matching peer|is not a known peer|unknown peer/i.test(text)) {
    return "no-peer";
  }
  if (/no reply|timeout|timed out/i.test(text)) return "no-reply";
  return "unknown";
}

export async function tailscalePingProbe(
  ctx: ProbeContext<TailscalePingConfig>,
  run: TailscaleRunner = runTailscale,
): Promise<ProbeResult> {
  // The schema guarantees this at write time, but a row can predate the
  // schema or survive a downgrade, and this value reaches an argv where
  // a leading dash would be read as a flag.
  if (!tailscalePeerSchema.safeParse(ctx.target).success) {
    return unavailable(
      `"${ctx.target}" is not a tailnet peer name or address.`,
    );
  }

  let result: TailscaleRun;
  try {
    result = await run(
      buildArgs(ctx.target, ctx.config.packets, ctx.timeoutMs),
      ctx.timeoutMs,
    );
  } catch (error) {
    if (error instanceof MissingTailscaleError) {
      return unavailable(
        "The `tailscale` command is not on this host, so tailnet checks cannot run. Install Tailscale on the machine running this worker.",
      );
    }
    throw error;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  const blocked = unavailableReason(output);
  if (blocked !== null) return unavailable(blocked);

  const pong = parsePong(result.stdout);
  if (pong === null) {
    return {
      facts: {
        outcome: classifyOutcome(output),
        peer: null,
        peerAddress: null,
        via: null,
        direct: null,
        responseTimeMs: null,
      },
      responseTimeMs: null,
      statusCode: null,
      // Not an error: the CLI ran and observed silence, exactly as
      // `ping` does. Filing it as a transport failure would make it
      // indistinguishable from tailscaled being unreachable, which is
      // the one distinction this type exists to keep.
      error: null,
    };
  }

  return {
    facts: {
      outcome: "pong" satisfies TailscaleOutcome,
      peer: pong.peer,
      peerAddress: pong.peerAddress,
      via: pong.via,
      direct: pong.direct,
      responseTimeMs: pong.responseTimeMs,
    },
    responseTimeMs: pong.responseTimeMs,
    statusCode: null,
    error: null,
  };
}

/** Vigil could not find out — never `down`, always the operator's cue. */
function unavailable(reason: string): ProbeResult {
  return {
    facts: {},
    responseTimeMs: null,
    statusCode: null,
    error: null,
    unavailable: reason,
  };
}
