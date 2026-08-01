import { z } from "zod";

import { DEFAULT_MEMCACHED_PORT, memcachedDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * What a memcached monitor is allowed to hold.
 *
 * The credentials are for memcached's *ASCII* authentication — the
 * `-Y/--auth-file` mode added in 1.5.16, where a client authenticates by
 * sending a `set <user>` carrying the password as its data block. SASL
 * over the binary protocol is deliberately not supported: it is a
 * different framing, a different handshake and a different build flag,
 * and a server compiled for it does not speak the text protocol this
 * type is built on at all. A monitor that quietly failed against such a
 * server would be worse than one that says so, which is what the
 * documented limitation is for.
 */
export interface MemcachedConfig {
  /**
   * Null when the server accepts unauthenticated commands — the common
   * case for a cache on a private network, and the reason both of these
   * are optional rather than required fields.
   */
  username: string | null;
  password: string | null;
  /**
   * Share of the server's connection limit that counts as too much, or
   * null to make no claim about it.
   *
   * Connection exhaustion is the memcached failure a TCP check cannot
   * see: `maxconns` is reached, the server stops accepting, and the
   * monitor that only opened a socket already had one. The ratio is the
   * only saturation signal `stats` exposes that means something on a
   * single reading — every other counter there is cumulative since the
   * process started, and a cumulative counter needs a previous
   * observation to be worth anything, which a probe does not have.
   */
  maxConnectionUsagePercent: number | null;
  degradedThresholdMs: number;
}

/**
 * 90%, not off.
 *
 * A default of null would make the field dead weight for everyone who
 * never opens the API, and this assertion is only degraded — it colours
 * the monitor amber and never opens an incident, so the cost of it
 * firing early is a warning nobody had to be woken for. memcached's own
 * default limit is 1024 connections and a healthy fleet sits far below
 * it, so the threshold is quiet until something is genuinely wrong.
 */
export const DEFAULT_MAX_CONNECTION_USAGE_PERCENT = 90;

/**
 * A user name with no whitespace, no colon and no control character.
 *
 * Two separate reasons, both worth refusing at the form rather than at
 * connect time. A space or a newline in the user name would be *parsed*
 * — the ASCII protocol is line- and space-delimited, so `set alice 0 0`
 * with a space inside `alice` is a different command with different
 * arguments, which is command injection wearing a credential's clothes.
 * A colon cannot exist in a real user name either: the auth file is
 * `user:password` per line, so a colon there names a user the server
 * does not have, and the failure arrives as a bare authentication error
 * with nothing pointing at the cause.
 */
const MEMCACHED_USERNAME = /^[^\s:\p{Cc}]+$/u;

/**
 * Anything that could not survive the auth file's one line per user.
 *
 * The password itself is sent length-prefixed, so a newline inside it
 * would reach the server intact — but it could never have got into the
 * auth file to be compared against, so a credential containing one is a
 * typo every time, and one that authenticates nowhere.
 */
const CONTROL_CHARACTERS = /\p{Cc}/u;

export const memcachedStoredSchema = z
  .object({
    username: z
      .string()
      .trim()
      .max(255)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null))
      .refine((value) => value === null || MEMCACHED_USERNAME.test(value), {
        message:
          "A memcached user name cannot contain a space, a colon or a control character.",
      }),
    // Not trimmed, unlike the user name: leading and trailing space are
    // part of a secret, and eating them turns a working credential into
    // an authentication failure with no visible cause.
    password: z
      .string()
      .max(255)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null))
      .refine((value) => value === null || !CONTROL_CHARACTERS.test(value), {
        message: "A memcached password cannot contain a control character.",
      }),
    maxConnectionUsagePercent: z
      .number()
      .int()
      .min(1)
      .max(100)
      .nullish()
      // Absent means "never said", which is the create case and takes
      // the default; an explicit null means "do not judge this", which
      // is how the assertion is turned off.
      .transform((value) =>
        value === undefined ? DEFAULT_MAX_CONNECTION_USAGE_PERCENT : value,
      ),
  })
  // The auth file pairs the two, so a password alone authenticates
  // nobody. Refused here, where the operator is standing, rather than
  // dropped at connect time — a silently unsent password comes back as
  // an authentication failure, which sends the search in the wrong
  // direction entirely.
  .refine((config) => config.username !== null || config.password === null, {
    message: "A password needs a username.",
    path: ["password"],
  });

export const memcachedConfigSchema: z.ZodType<MemcachedConfig> = z.object({
  username: z.string().max(255).nullable(),
  password: z.string().max(255).nullable(),
  maxConnectionUsagePercent: z.number().int().min(1).max(100).nullable(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

const answersVersion: Assertion<MemcachedConfig> = {
  id: "version",
  fact: "version",
  severity: "down",
  evaluate(value) {
    // A missing version is a failure here rather than a skipped
    // assertion, and that is safe precisely because the probe only ever
    // omits it when the connection worked: a refused connection is a
    // transport error and a rejected credential is `unavailable`, and
    // `judge` answers both of those before it reads a single fact. What
    // is left is a socket that opened and answered something other than
    // `VERSION` — a proxy, a TLS terminator, the wrong service after a
    // compose file was edited — which is the whole reason to run this
    // instead of a `tcp` monitor on 11211.
    if (typeof value === "string" && value.length > 0) return null;
    return "The server did not answer VERSION";
  },
};

const connectionHeadroom: Assertion<MemcachedConfig> = {
  id: "connection-headroom",
  fact: "connectionUsagePercent",
  severity: "degraded",
  applies: (config) => config.maxConnectionUsagePercent !== null,
  evaluate(value, config) {
    // Absent when the server would not answer `stats settings` — some
    // hosted memcacheds restrict it. The ratio cannot be computed, so
    // this assertion has nothing to say; saying it anyway would report
    // a missing counter as saturation.
    if (typeof value !== "number") return null;
    const threshold =
      config.maxConnectionUsagePercent ?? DEFAULT_MAX_CONNECTION_USAGE_PERCENT;
    return value > threshold
      ? `${value}% of the connection limit is in use, over the ${threshold}% threshold`
      : null;
  },
};

export const memcachedSpec: CheckTypeSpec<MemcachedConfig> = {
  descriptor: memcachedDescriptor,
  configSchema: memcachedConfigSchema,
  storedSchema: memcachedStoredSchema,
  secretFields: ["password"],
  targetSchema: monitorHostnameSchema,
  assertions: [
    answersVersion,
    connectionHeadroom,
    latencyAssertion<MemcachedConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): MemcachedConfig {
    const stored = memcachedStoredSchema.safeParse(row.config ?? {});
    return {
      username: stored.success ? stored.data.username : null,
      password: stored.success ? stored.data.password : null,
      maxConnectionUsagePercent: stored.success
        ? stored.data.maxConnectionUsagePercent
        : DEFAULT_MAX_CONNECTION_USAGE_PERCENT,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  // The credential lives in the config, never in the target, so there is
  // nothing to redact here. This string is what an incident email and a
  // public status page print, so it has to stay that way. The port is
  // shown even when it is the default, because two memcached instances
  // on one host are told apart by nothing else.
  describeTarget(target, port) {
    return `${target}:${port ?? DEFAULT_MEMCACHED_PORT}`;
  },
};
