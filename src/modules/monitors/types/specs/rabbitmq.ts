import { z } from "zod";

import { rabbitmqDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorUrlSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * Is this RabbitMQ node healthy, asked of its management API.
 *
 * The target is the management plugin's base URL rather than the AMQP
 * host, because the management API is the only thing on a RabbitMQ node
 * that will answer the question. AMQP 0-9-1 would prove a connection can
 * be opened, which is exactly what a node with a memory alarm in effect
 * still lets you do — it accepts the connection and then blocks every
 * publisher on it. A monitor that reported that as up would be green for
 * the entire outage.
 *
 * The path Vigil asks for is fixed. Making it a setting would turn a
 * check with one meaning into a small HTTP client whose meaning depends
 * on what the operator typed, and `json-query` already exists for that.
 */

/**
 * The health check this type reads, appended to the operator's base URL.
 *
 * `checks/alarms` is the node-local question: has *this* node a resource
 * alarm — memory, disk, file descriptors — in effect. The cluster-wide
 * checks (`virtual-hosts`, `port-listener`) answer for peers as well, so
 * three monitors on three nodes would all go red for one node's alarm and
 * nobody could tell which one to look at.
 */
export const RABBITMQ_HEALTH_PATH = "/api/health/checks/alarms";

export interface RabbitmqConfig {
  /**
   * The management user Vigil authenticates as. Null when the monitor
   * has none — `storedSchema` must accept an empty submission, so an
   * unconfigured monitor has to be representable. The API answers 401
   * to an anonymous request, and the probe reports that as
   * `misconfigured` rather than as an outage.
   */
  username: string | null;
  password: string | null;
  degradedThresholdMs: number;
}

export const rabbitmqStoredSchema = z
  .object({
    username: z
      .string()
      .trim()
      .max(255)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null)),
    // Not trimmed, unlike the user name: leading and trailing space is
    // legal in a RabbitMQ password, and eating it turns a working
    // credential into a 401 with no visible cause.
    password: z
      .string()
      .max(255)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null)),
  })
  // HTTP Basic carries one field, `user:password`, so a password with no
  // user name cannot be sent at all. Refused here, where the operator is
  // standing, rather than dropped at request time — a silently unsent
  // password comes back as a 401, which sends the search for the cause in
  // entirely the wrong direction.
  .refine((config) => config.username !== null || config.password === null, {
    message: "A password needs a username.",
    path: ["password"],
  });

export const rabbitmqConfigSchema: z.ZodType<RabbitmqConfig> = z.object({
  username: z.string().max(255).nullable(),
  password: z.string().max(255).nullable(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/**
 * The two codes the health-check endpoints are documented to answer
 * with: 200 when the check passes, 503 when it does not. Anything else
 * is the management API — or something in front of it — talking about
 * itself rather than about the broker.
 */
export const RABBITMQ_HEALTHY = 200;
export const RABBITMQ_UNHEALTHY = 503;

const answeredAsManagementApi: Assertion<RabbitmqConfig> = {
  id: "management-api",
  fact: "statusCode",
  severity: "down",
  evaluate(value) {
    // Absent when the probe never got a response at all, which it
    // reports as a transport error; there is no code here to judge.
    if (typeof value !== "number") return null;
    // 401, 403 and 404 never reach this assertion — the probe reports
    // them as `unavailable`, because a wrong credential and a disabled
    // plugin are operator errors and an operator error that reads as an
    // outage is indistinguishable from the broker being gone. What is
    // left is a 500 from the management plugin itself, or a 502 from a
    // proxy that could not reach it: both are outages of the thing this
    // monitor exists to watch.
    if (value === RABBITMQ_HEALTHY || value === RABBITMQ_UNHEALTHY) return null;
    return `The management API answered ${value}`;
  },
};

/**
 * Reads the reason rather than the `alarmsClear` boolean beside it,
 * because the reason is the whole value of this check: "resource alarm(s)
 * in effect: [memory]" is a fix, and "the health check failed" is a
 * second question. The probe leaves this fact null when — and only when —
 * the check passed, so a null here is never a silent skip.
 */
const healthChecksPass: Assertion<RabbitmqConfig> = {
  id: "health-checks",
  fact: "alarmReason",
  severity: "down",
  evaluate(value) {
    if (typeof value !== "string" || value.length === 0) return null;
    return `The node reports a failed health check: ${value}`;
  },
};

export const rabbitmqSpec: CheckTypeSpec<RabbitmqConfig> = {
  descriptor: rabbitmqDescriptor,
  configSchema: rabbitmqConfigSchema,
  storedSchema: rabbitmqStoredSchema,
  secretFields: ["password"],
  targetSchema: monitorUrlSchema,
  assertions: [
    answeredAsManagementApi,
    healthChecksPass,
    latencyAssertion<RabbitmqConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): RabbitmqConfig {
    const stored = rabbitmqStoredSchema.safeParse(row.config ?? {});
    return {
      username: stored.success ? stored.data.username : null,
      password: stored.success ? stored.data.password : null,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  /**
   * Origin and path, never the userinfo in front of them.
   *
   * `https://guest:guest@rabbit.example.com:15672` is a URL an operator
   * will paste, because it is the one their browser gave them, and this
   * string is embedded verbatim in incident emails, webhook payloads and
   * public status pages.
   */
  describeTarget(target) {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      // Unparseable, so the credential cannot be located precisely.
      // Everything up to the last "@" is where one would be.
      return target.slice(target.lastIndexOf("@") + 1);
    }
    return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  },
};
