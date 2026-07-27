import { z } from "zod";

import { redisDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

export interface RedisConfig {
  /**
   * Sent as AUTH before PING. Null when the server answers unauthenticated
   * — the common case for a cache on a private network, and the reason
   * this is optional rather than a required field.
   */
  password: string | null;
  degradedThresholdMs: number;
}

export const redisStoredSchema = z.object({
  // Not trimmed, unlike every other string in a config blob: leading and
  // trailing space are legal in a Redis password, and eating them turns a
  // working credential into a WRONGPASS with no visible cause.
  password: z
    .string()
    .max(512)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

export const redisConfigSchema: z.ZodType<RedisConfig> = z.object({
  password: z.string().max(512).nullable(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

const answersPong: Assertion<RedisConfig> = {
  id: "pong",
  fact: "pong",
  severity: "down",
  evaluate(value) {
    // Only a boolean is evidence. A server that answered with a RESP
    // error — `-NOAUTH` above all — said nothing at all about PING, and
    // the probe records that as null rather than as false: not knowing
    // the answer is not the same as getting the wrong one.
    if (typeof value !== "boolean") return null;
    return value ? null : "The server answered, but not with PONG";
  },
};

export const redisSpec: CheckTypeSpec<RedisConfig> = {
  descriptor: redisDescriptor,
  configSchema: redisConfigSchema,
  storedSchema: redisStoredSchema,
  targetSchema: monitorHostnameSchema,
  assertions: [answersPong, latencyAssertion<RedisConfig>("Answered")],
  fromRow(row: MonitorRowView): RedisConfig {
    const stored = redisStoredSchema.safeParse(row.config ?? {});
    return {
      password: stored.success ? stored.data.password : null,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  // The credential lives in the config, never in the target, so there is
  // nothing to redact here. This string is what an incident email and a
  // public status page print, so it has to stay that way.
  describeTarget(target, port) {
    return port === null ? target : `${target}:${port}`;
  },
};
