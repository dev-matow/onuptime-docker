import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ProbeContext, ProbeResult } from "../contract";
import { HOSTNAME_PATTERN } from "../targets";
import type { PingConfig } from "../specs/ping";
import { refusesPrivate } from "./guard";

const execFileAsync = promisify(execFile);

/**
 * ICMP without a dependency.
 *
 * Node has no raw-socket API, and every npm ping library is a wrapper
 * around either a native addon or this same binary. So we shell out —
 * via `execFile`, never a shell, so there is nothing to inject into.
 *
 * `LC_ALL=C` is not cosmetic: the summary line we parse is localised,
 * and this project has already been bitten by a Russian-locale
 * Postgres. Forcing the C locale makes the parse deterministic on any
 * host.
 */
const ICMP_HINT =
  "ICMP is not permitted for this process. Grant CAP_NET_RAW to the worker, or widen net.ipv4.ping_group_range to include its group.";

export interface PingRun {
  stdout: string;
  stderr: string;
  code: number;
}

export function buildArgs(
  host: string,
  packets: number,
  timeoutMs: number,
): string[] {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  if (process.platform === "darwin") {
    // BSD ping: -t is the overall deadline, -W a per-reply wait in ms.
    return ["-n", "-c", String(packets), "-t", String(seconds), host];
  }
  // iputils: -w overall deadline, -W per-reply wait, both in seconds.
  return [
    "-n",
    "-c",
    String(packets),
    "-W",
    String(seconds),
    "-w",
    String(seconds),
    host,
  ];
}

async function runPing(args: string[], timeoutMs: number): Promise<PingRun> {
  try {
    const { stdout, stderr } = await execFileAsync("ping", args, {
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      // A hard ceiling above ping's own deadline: if the binary itself
      // wedges, the probe must still return within the check window.
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
    if (failure.code === "ENOENT") throw new MissingBinaryError();
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: typeof failure.code === "number" ? failure.code : 2,
    };
  }
}

export class MissingBinaryError extends Error {}

/** Replies observed, from the summary line. */
export function parseReceived(stdout: string): number | null {
  const match = /(\d+)\s+(?:packets\s+)?received/i.exec(stdout);
  return match ? Number(match[1]) : null;
}

/** Average round trip in ms, from the rtt summary or a reply line. */
export function parseRtt(stdout: string): number | null {
  const summary =
    /(?:rtt|round-trip)\s+min\/avg\/max[^=]*=\s*[\d.]+\/([\d.]+)\//i.exec(
      stdout,
    );
  if (summary) return Math.round(Number(summary[1]));
  const reply = /time[=<]\s*([\d.]+)\s*ms/i.exec(stdout);
  return reply ? Math.round(Number(reply[1])) : null;
}

export function looksLikePermissionProblem(text: string): boolean {
  return /operation not permitted|permission denied|socket.*not permitted|must be root/i.test(
    text,
  );
}

/**
 * Runs `ping` and returns its raw output. Injectable so the probe's
 * decisions — which exit codes are outages, which are operator errors,
 * how the summary is parsed — can be tested without an ICMP-capable
 * host or a mocked `node:child_process`.
 */
export type PingRunner = (
  args: string[],
  timeoutMs: number,
) => Promise<PingRun>;

export async function pingProbe(
  ctx: ProbeContext<PingConfig>,
  run: PingRunner = runPing,
): Promise<ProbeResult> {
  // The schema already guarantees this, but the value reaches an argv
  // and a leading dash would be read as a flag. Cheap, and the cost of
  // being wrong is argument confusion in a subprocess.
  if (!HOSTNAME_PATTERN.test(ctx.target)) {
    return {
      facts: {},
      responseTimeMs: null,
      error: null,
      unavailable: "Not a valid hostname for an ICMP check.",
    };
  }

  const guard = await refusesPrivate(ctx.target, ctx.allowPrivateTargets);
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  let result: PingRun;
  try {
    result = await run(
      buildArgs(ctx.target, ctx.config.packets, ctx.timeoutMs),
      ctx.timeoutMs,
    );
  } catch (error) {
    if (error instanceof MissingBinaryError) {
      return unavailable(
        "The `ping` command is not available on this host, so ICMP checks cannot run.",
      );
    }
    throw error;
  }

  if (looksLikePermissionProblem(`${result.stderr}\n${result.stdout}`)) {
    return unavailable(ICMP_HINT);
  }

  const received = parseReceived(result.stdout);
  const rtt = parseRtt(result.stdout);

  // ping exits 0 on a reply, 1 on total loss and 2 on any other error
  // (unknown host, bad argument). Only the last is a transport failure;
  // total loss is a measurement the `reachable` assertion judges.
  if (result.code >= 2 && received === null) {
    const message =
      result.stderr.split("\n").find((line) => line.trim().length > 0) ??
      "Ping failed";
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: message.replace(/^ping:\s*/i, "").trim(),
    };
  }

  return {
    facts: {
      packetsReceived: received ?? 0,
      ...(rtt === null ? {} : { responseTimeMs: rtt }),
    },
    responseTimeMs: rtt,
    statusCode: null,
    error: null,
  };
}

function unavailable(message: string): ProbeResult {
  return {
    facts: {},
    responseTimeMs: null,
    statusCode: null,
    error: null,
    unavailable: message,
  };
}
