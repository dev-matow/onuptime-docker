import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ProbeContext, ProbeResult } from "../contract";
import {
  UNIT_NAME_PATTERN,
  type SystemServiceConfig,
} from "../specs/system-service";
import { elapsedSince } from "./guard";

const execFileAsync = promisify(execFile);

/**
 * One `systemctl show`, on the machine the worker runs on.
 *
 * Shelled out rather than spoken over D-Bus, and the trade is worth
 * naming. systemd's API is a D-Bus interface, and reaching it properly
 * means SASL EXTERNAL over `/run/dbus/system_bus_socket` and a
 * marshalling layer — several hundred lines of wire format to ask one
 * question that `systemctl show` answers in a line of `KEY=value` text.
 * The binary is present on every machine that has systemd at all, by
 * construction: it ships in the same package as the init system.
 *
 * `execFile`, never a shell, so there is nothing to inject into, and
 * `LC_ALL=C` for the same reason the ping probe forces it — a localised
 * error message would make the "systemd is not here" check locale
 * dependent, and this project has been bitten by that before.
 *
 * The property values themselves are not localised: `active`, `failed`
 * and `not-found` are systemd's own identifiers and are the same on
 * every host.
 */

/** Everything one check reads, in one call. */
const PROPERTIES = [
  "LoadState",
  "ActiveState",
  "SubState",
  "UnitFileState",
  "NRestarts",
] as const;

/**
 * What `systemctl` said. Modelled on the ping probe's `PingRun` for the
 * same reason: the decisions this check makes — which exit is an
 * outage, which is an operator problem, how the output is parsed — are
 * worth testing without a systemd on the other side.
 */
export interface SystemctlRun {
  stdout: string;
  stderr: string;
  code: number;
  /** The deadline killed it. Distinct from any exit code it might have. */
  timedOut: boolean;
}

export type SystemctlRunner = (
  args: string[],
  timeoutMs: number,
) => Promise<SystemctlRun>;

/** `systemctl` is not installed, so this host has no systemd to ask. */
export class MissingSystemctlError extends Error {}

/** The binary is there but this process may not execute it. */
export class SystemctlPermissionError extends Error {}

export function systemctlArgs(unit: string): string[] {
  // `--no-pager` because a pager on a non-tty is a process that never
  // exits; `--property` because the full property set of a unit is tens
  // of kilobytes and this reads five of them.
  return ["show", unit, "--no-pager", `--property=${PROPERTIES.join(",")}`];
}

export async function runSystemctl(
  args: string[],
  timeoutMs: number,
  binary = "systemctl",
): Promise<SystemctlRun> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
    });
    return { stdout, stderr, code: 0, timedOut: false };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: number | string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    if (failure.code === "ENOENT") throw new MissingSystemctlError();
    if (failure.code === "EACCES" || failure.code === "EPERM") {
      throw new SystemctlPermissionError();
    }
    // A process killed by the deadline carries a signal rather than an
    // exit code, so the timeout has to be read from `killed` — by the
    // time this returns, `code` is null and indistinguishable from any
    // other abnormal end.
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: typeof failure.code === "number" ? failure.code : 1,
      timedOut: failure.killed === true,
    };
  }
}

/**
 * `KEY=value` lines into a map. Exported because it is where the wire
 * format ends and the facts begin.
 *
 * A value may itself contain `=` (a unit's `Description` routinely
 * does), so the split is on the first one only. Absent properties are
 * absent from the map rather than empty: systemd omits `NRestarts`
 * entirely for a unit type that has no such notion, and reporting that
 * as zero restarts would be inventing a measurement.
 */
export function parseShowOutput(stdout: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    // systemd prints an empty value for a property that does not apply
    // — `UnitFileState` on a transient unit, say. Empty is not a state,
    // and storing "" would put a blank string on the timeline.
    if (value.length > 0) properties[key] = value;
  }
  return properties;
}

/**
 * Does this output mean "there is no systemd here" rather than "the
 * unit is unhappy"?
 *
 * The first two are what a container, a BSD or a distribution running
 * something other than systemd says. The third is a systemd that is
 * present but whose bus this process cannot reach — a worker in a
 * namespace without `/run/systemd`, most often. All three are the
 * operator having wired the worker somewhere it cannot answer the
 * question, and none of them is evidence about the service.
 */
export function looksLikeNoSystemd(text: string): boolean {
  return /has not been booted with systemd|failed to (?:connect to|get) (?:the )?(?:d-?bus|bus|system bus)|no such file or directory.*systemd/i.test(
    text,
  );
}

export async function systemServiceProbe(
  ctx: ProbeContext<SystemServiceConfig>,
  run: SystemctlRunner = runSystemctl,
): Promise<ProbeResult> {
  // The target schema guarantees this, but a row can predate the schema
  // or survive a downgrade, and the value reaches an argv: a name
  // starting with `-` would be read by `systemctl` as a flag. Refused
  // as an operator problem rather than as an outage, because that is
  // what it is.
  if (!UNIT_NAME_PATTERN.test(ctx.target)) {
    return unavailable(
      "This is not a systemd unit name, so there is nothing to ask about.",
    );
  }

  // No egress guard, and the omission is deliberate: nothing here opens
  // a socket or resolves a name. `refusesPrivate` exists to stop a
  // probe dialling an address the operator should not reach, and this
  // probe dials nothing at all — the target is a unit name, and the
  // machine being asked is the one the code is already running on.

  const startedAt = performance.now();
  let result: SystemctlRun;
  try {
    result = await run(systemctlArgs(ctx.target), ctx.timeoutMs);
  } catch (error) {
    if (error instanceof MissingSystemctlError) {
      return unavailable(
        "There is no `systemctl` on this host, so it has no systemd to ask. Run the worker on a systemd machine, or watch this service over the network with a tcp or http check.",
      );
    }
    if (error instanceof SystemctlPermissionError) {
      return unavailable(
        "The worker may not execute `systemctl`. Grant its user execute permission on the binary.",
      );
    }
    throw error;
  }

  const responseTimeMs = elapsedSince(startedAt);

  // A systemd that does not answer inside the check window is a
  // transport failure, not a missing capability: something IS there and
  // it is not responding, which is news about the machine rather than
  // about how the worker was deployed. The distinction matters because
  // `unavailable` takes the monitor out of the outage count entirely.
  if (result.timedOut) {
    return {
      facts: { responseTimeMs },
      responseTimeMs,
      statusCode: null,
      error: `systemctl did not answer within ${ctx.timeoutMs}ms`,
    };
  }

  const combined = `${result.stderr}\n${result.stdout}`;
  if (looksLikeNoSystemd(combined)) {
    return unavailable(
      "systemd did not answer on this host: it is either not the init system here, or its bus is not reachable from this worker.",
      responseTimeMs,
    );
  }

  const properties = parseShowOutput(result.stdout);
  const activeState = properties.ActiveState;

  // No ActiveState means the question was never answered, whatever the
  // exit code said. Reporting facts from here would let a monitor read
  // `up` because every assertion skipped a fact that is not there —
  // silence judged as health is the failure mode this check exists to
  // avoid, so it is named instead.
  if (activeState === undefined) {
    const line = firstLine(result.stderr);
    return unavailable(
      line === null
        ? `\`systemctl show\` exited ${result.code} without reporting a state for this unit.`
        : `\`systemctl show\` could not report on this unit: ${line}`,
      responseTimeMs,
    );
  }

  return {
    facts: {
      activeState,
      subState: properties.SubState ?? null,
      loadState: properties.LoadState ?? null,
      unitFileState: properties.UnitFileState ?? null,
      // Absent for every unit type that is not a service, so null
      // rather than zero — see `parseShowOutput`.
      restarts: readCount(properties.NRestarts),
      responseTimeMs,
    },
    responseTimeMs,
    statusCode: null,
    error: null,
  };
}

function readCount(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function firstLine(text: string): string | null {
  const line = text
    .split("\n")
    .find((candidate) => candidate.trim().length > 0);
  return line === undefined ? null : line.trim();
}

/** Vigil could not find out — never `down`, always the operator's cue. */
function unavailable(
  reason: string,
  responseTimeMs: number | null = null,
): ProbeResult {
  return {
    facts: responseTimeMs === null ? {} : { responseTimeMs },
    responseTimeMs,
    statusCode: null,
    error: null,
    unavailable: reason,
  };
}
