import { z } from "zod";

import { mqttDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

export interface MqttConfig {
  /**
   * Credentials for a broker that wants them. Optional because plenty of
   * brokers accept anonymous connects, and because a refusal is a useful
   * observation either way — see {@link CONNACK_RETURN_MESSAGES}.
   */
  username: string | null;
  password: string | null;
  degradedThresholdMs: number;
}

export const mqttStoredSchema = z
  .object({
    username: z
      .string()
      .trim()
      .max(255)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null)),
    // Not trimmed, unlike the user name: trailing whitespace inside a
    // password is part of the secret, and quietly rewriting it turns a
    // working credential into a refusal nobody can account for.
    password: z
      .string()
      .max(255)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null)),
  })
  // MQTT 3.1.1 §3.1.2.9 forbids a password without a user name. Refused
  // here, where the operator is standing, rather than dropped at connect
  // time — a silently unsent password comes back as "bad username or
  // password" from the broker, which sends the search in the wrong
  // direction entirely.
  .refine((config) => config.username !== null || config.password === null, {
    message: "A password needs a username.",
    path: ["password"],
  });

export const mqttConfigSchema: z.ZodType<MqttConfig> = z.object({
  username: z.string().max(255).nullable(),
  password: z.string().max(255).nullable(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/**
 * The CONNACK return codes (§3.2.2.3).
 *
 * Every one of these, zero included, is the broker *answering*: the
 * process is alive, listening, and speaking MQTT. So a refusal is
 * recorded as a fact and judged by an assertion, never returned as a
 * transport error — an operator who cannot authenticate to a broker
 * still needs to know the broker is up, and "bad password" must never
 * be indistinguishable from "unreachable".
 */
export const CONNACK_RETURN_MESSAGES: Readonly<Record<number, string>> = {
  0: "Connection accepted",
  1: "Unacceptable protocol version",
  2: "Client identifier rejected",
  3: "Server unavailable",
  4: "Bad username or password",
  5: "Not authorised",
};

export function connackMessage(code: number): string {
  return CONNACK_RETURN_MESSAGES[code] ?? `Unrecognised return code ${code}`;
}

const answered: Assertion<MqttConfig> = {
  id: "connack",
  fact: "connack",
  severity: "down",
  evaluate(value) {
    // The socket opened, so something is listening — it just never
    // identified itself as a broker. That is a statement about what is
    // on the port, not about the network, which is why it is judged
    // here instead of being reported as a transport failure.
    return value === true ? null : "The broker sent no CONNACK";
  },
};

const accepted: Assertion<MqttConfig> = {
  id: "connection-accepted",
  fact: "returnCode",
  severity: "down",
  evaluate(value) {
    // Absent when no CONNACK arrived, which `connack` above already
    // reports — there is no return code here to have an opinion about.
    if (typeof value !== "number") return null;
    return value === 0
      ? null
      : `The broker refused the connection: ${connackMessage(value)}`;
  },
};

export const mqttSpec: CheckTypeSpec<MqttConfig> = {
  descriptor: mqttDescriptor,
  configSchema: mqttConfigSchema,
  storedSchema: mqttStoredSchema,
  secretFields: ["password"],
  targetSchema: monitorHostnameSchema,
  assertions: [answered, accepted, latencyAssertion<MqttConfig>("Answered")],
  fromRow(row: MonitorRowView): MqttConfig {
    const stored = mqttStoredSchema.safeParse(row.config ?? {});
    return {
      username: stored.success ? stored.data.username : null,
      password: stored.success ? stored.data.password : null,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, port) {
    // Host and port only. This string is embedded in incident emails,
    // webhook payloads and the public status page, and the config it is
    // handed carries a broker password.
    return port === null ? target : `${target}:${port}`;
  },
};
