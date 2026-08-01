import { z } from "zod";

import { SYSTEMD_UNIT_SUFFIXES, systemServiceDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { flatColumnsOnly, latencyAssertion } from "./shared";

/**
 * Is a systemd unit active, asked of the init system on the worker's
 * own machine.
 *
 * The target is the **unit name**, and that is the whole design
 * decision. Docker faced the same question and answered it the other
 * way round — its target is the host and the container is a config
 * field — because a Docker daemon can be remote and one daemon holds
 * many containers. Neither is true here. There is exactly one init
 * system this check can ask, it is the one on the machine the worker
 * happens to be running on, and a hostname field would therefore be a
 * field whose only correct answer is a value nothing ever reads.
 *
 * That also leaves this type with no settings at all, so it keeps its
 * two flat columns and stores no config blob. A monitor is a unit name
 * and a cadence, which is the whole of what there is to say.
 *
 * The honest limitation, stated here because it decides whether this
 * type is the right one: the answer is about ONE machine. A service
 * behind three workers needs three monitors, one per worker, and a
 * Vigil that is moved to another host is a Vigil whose system-service
 * monitors are now watching a different machine's units. Anything that
 * should be true of a *service* rather than of a host belongs in a
 * `tcp` or `http` check against it.
 */

export interface SystemServiceConfig {
  degradedThresholdMs: number;
}

export const systemServiceConfigSchema: z.ZodType<SystemServiceConfig> =
  z.object({
    degradedThresholdMs: z.number().int().min(100).max(30_000),
  });

/**
 * A systemd unit name: the character set systemd itself allows, and a
 * suffix from {@link SYSTEMD_UNIT_SUFFIXES}.
 *
 * The leading character is deliberately narrower than the rest. This
 * value reaches an `execFile` argv, and a name beginning with `-` would
 * be read as a flag by `systemctl` rather than as a unit — the same
 * argument-confusion the ping probe guards against, made impossible at
 * the point where the operator can still see the message.
 */
export const UNIT_NAME_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9:_.@\\\\-]*\\.(?:${SYSTEMD_UNIT_SUFFIXES.join("|")})$`,
);

export const systemServiceTargetSchema = z
  .string()
  .trim()
  // systemd's own ceiling (UNIT_NAME_MAX). A longer name cannot name a
  // unit that exists, so refusing it here is refusing a typo.
  .max(255)
  .refine((value) => UNIT_NAME_PATTERN.test(value), {
    message:
      "Enter a full systemd unit name with its suffix, like nginx.service or docker.socket.",
  });

/**
 * States in which a unit is doing its job.
 *
 * `reloading` is one of them and that is not an oversight: systemd
 * reports it for a unit that is active and re-reading its configuration,
 * so an nginx that reloads on every certificate renewal would otherwise
 * page whoever is on call for doing exactly what it was told to.
 */
const RUNNING_STATES = new Set(["active", "reloading"]);

const loaded: Assertion<SystemServiceConfig> = {
  id: "loaded",
  fact: "loadState",
  severity: "down",
  evaluate(value) {
    if (typeof value !== "string") return null;
    switch (value) {
      // The unit file is gone: uninstalled, or renamed, or never
      // installed on this machine. Judged rather than reported as an
      // environment problem, on the same reasoning as a Docker
      // container that no longer exists — a service that was removed is
      // an outage of that service, not a failure to look.
      case "not-found":
        return "systemd has no unit by this name on this machine";
      // Masked is a deliberate act — `systemctl mask` — and it means the
      // unit cannot be started even by a dependency. Worth its own
      // wording, because "inactive" would send the reader to the logs
      // of a unit that never ran.
      case "masked":
        return "The unit is masked, so nothing can start it";
      case "error":
      case "bad-setting":
        return `systemd could not load the unit file (${value})`;
      default:
        return null;
    }
  },
};

const running: Assertion<SystemServiceConfig> = {
  id: "active",
  fact: "activeState",
  severity: "down",
  evaluate(value) {
    if (typeof value !== "string") return null;
    // `activating` is excluded here and judged as degraded below: a unit
    // in the middle of starting has not failed, and a restart that takes
    // longer than one check interval must not open an incident.
    if (RUNNING_STATES.has(value) || value === "activating") return null;
    // A unit that is not loaded is also inactive, so this fires
    // alongside `loaded` above. The engine reports the first failing
    // assertion, which is why `loaded` is declared first — "no unit by
    // this name" sends the reader somewhere useful and "the unit is
    // inactive" does not. Both ids still land in `failedAssertions`.
    return `The unit is ${value} rather than active`;
  },
};

const settling: Assertion<SystemServiceConfig> = {
  id: "activating",
  fact: "activeState",
  severity: "degraded",
  evaluate(value) {
    return value === "activating"
      ? "The unit is still starting up"
      : // `deactivating` is deliberately absent: a unit on its way down
        // is going down, and calling that amber would hide a stop
        // behind a warning for as long as the shutdown takes.
        null;
  },
};

export const systemServiceSpec: CheckTypeSpec<SystemServiceConfig> = {
  descriptor: systemServiceDescriptor,
  configSchema: systemServiceConfigSchema,
  // No settings, so no blob — the same choice `smtp` makes. A type that
  // stored `{}` would create a second place its configuration could
  // live and nothing to put there.
  storedSchema: flatColumnsOnly,
  targetSchema: systemServiceTargetSchema,
  assertions: [
    loaded,
    running,
    settling,
    latencyAssertion<SystemServiceConfig>("systemd answered"),
  ],
  fromRow(row: MonitorRowView): SystemServiceConfig {
    return { degradedThresholdMs: row.degradedThresholdMs };
  },
  describeTarget(target) {
    // "local" is the part a reader needs and the part a unit name does
    // not carry. This string goes into incident emails and onto public
    // status pages, where `nginx.service` alone would read as a claim
    // about the service rather than about one machine's copy of it.
    return `${target} (local systemd)`;
  },
};
