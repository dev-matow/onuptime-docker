import { z } from "zod";

import {
  DEFAULT_SIP_PORT,
  SIP_TRANSPORTS,
  sipDescriptor,
  type SipTransport,
} from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * SIP, checked the way a neighbouring proxy checks one: an OPTIONS
 * request, and whatever status line comes back.
 *
 * OPTIONS is the right request because it is the one a SIP element is
 * obliged to answer without doing anything (RFC 3261 §11) — no call is
 * set up, no registration is touched, no B-leg is dialled. A TCP connect
 * to 5060 proves only that something is bound; a registrar that has lost
 * its database, a proxy with no route left, and an SBC that is shedding
 * load all accept the socket and then say 503 here, which is the outage
 * an operator wants paged.
 */

export interface SipConfig {
  transport: SipTransport;
  /**
   * The user part of the Request-URI, or null for a bare host URI.
   *
   * Null is the default because `sip:host` is what a neighbouring proxy
   * sends and what every proxy answers. A user is worth setting when the
   * thing being watched is a specific AOR — a gateway that answers for
   * `sip:pstn@host` but 404s for the host itself is a real
   * configuration, and without this field it would be unmonitorable.
   */
  requestUser: string | null;
  /**
   * The status the operator expects, from the shared column, or null for
   * "any 2xx". SIP's 6xx class cannot be expressed here: the column is
   * bounded at 599 by `monitorFields`, which is a limitation of the
   * shared field and not of this type — a 6xx answer is still recorded
   * as a fact and still judged unexpected.
   */
  expectedStatusCode: number | null;
  degradedThresholdMs: number;
}

/**
 * The characters a Request-URI user part may hold here.
 *
 * Far narrower than RFC 3261's `user` production, and deliberately so:
 * this value is interpolated into a request line that is terminated by
 * CRLF, so a user containing one would append headers of the attacker's
 * choosing to the message Vigil sends. Escaping would be the general
 * answer; refusing is the one that cannot be got wrong, and no real AOR
 * needs anything outside this set.
 */
const SIP_USER_PATTERN = /^[A-Za-z0-9._%+-]+$/;

export const sipStoredSchema = z.object({
  transport: z.enum(SIP_TRANSPORTS).default("udp"),
  requestUser: z
    .string()
    .trim()
    .max(64)
    .regex(SIP_USER_PATTERN, "Use only letters, digits and . _ % + -")
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

export const sipConfigSchema: z.ZodType<SipConfig> = z.object({
  transport: z.enum(SIP_TRANSPORTS),
  requestUser: z.string().max(64).nullable(),
  expectedStatusCode: z.number().int().min(100).max(699).nullable(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/**
 * Declared before the status assertion so the first line an operator
 * reads is the cause: something that answers on 5060 without speaking
 * SIP has no status code, and a "no status code" message would send
 * them looking at the wrong thing.
 */
const answeredSip: Assertion<SipConfig> = {
  id: "answered",
  fact: "answered",
  severity: "down",
  evaluate(value) {
    // Absent when nothing came back at all — that is a timeout, which
    // the probe already reports as a transport failure.
    if (typeof value !== "boolean") return null;
    return value
      ? null
      : "Something answered on this port, but not with a SIP response";
  },
};

const expectedStatus: Assertion<SipConfig> = {
  id: "status",
  fact: "statusCode",
  severity: "down",
  evaluate(value, config) {
    if (typeof value !== "number") return null;
    if (config.expectedStatusCode !== null) {
      return value === config.expectedStatusCode
        ? null
        : `Answered ${value}, expected ${config.expectedStatusCode}`;
    }
    // Any 2xx, and nothing else. A 3xx redirect, a 4xx refusal and a 5xx
    // failure are all a request this element declined to serve — which
    // is exactly what a neighbouring proxy would conclude before routing
    // its traffic somewhere else. An operator whose gateway answers 405
    // to OPTIONS says so in the expected-status field.
    return value >= 200 && value < 300 ? null : `Answered ${value}`;
  },
};

export const sipSpec: CheckTypeSpec<SipConfig> = {
  descriptor: sipDescriptor,
  configSchema: sipConfigSchema,
  storedSchema: sipStoredSchema,
  targetSchema: monitorHostnameSchema,
  assertions: [
    answeredSip,
    expectedStatus,
    latencyAssertion<SipConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): SipConfig {
    const stored = sipStoredSchema.safeParse(row.config ?? {});
    return {
      transport: stored.success ? stored.data.transport : "udp",
      requestUser: stored.success ? stored.data.requestUser : null,
      expectedStatusCode: row.expectedStatusCode,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, port, config) {
    // The transport belongs in the line an incident email prints: UDP
    // 5060 and TCP 5060 are different listeners on most SBCs, and an
    // alert that says only the host sends someone to check the wrong one.
    return `${sipRequestUri(target, port ?? DEFAULT_SIP_PORT, config)} over ${config.transport.toUpperCase()}`;
  },
};

/**
 * The Request-URI this check addresses. Exported because the probe puts
 * the same string on the wire that `describeTarget` prints, and the two
 * disagreeing is how an alert names something nobody dialled.
 *
 * The `transport` parameter is part of the URI rather than a header
 * (RFC 3261 §19.1.1): it is how the receiving element knows which
 * listener the request arrived on when it decides where to send the
 * response.
 */
export function sipRequestUri(
  host: string,
  port: number,
  config: Pick<SipConfig, "requestUser" | "transport">,
): string {
  const user = config.requestUser === null ? "" : `${config.requestUser}@`;
  const transport = config.transport === "tcp" ? ";transport=tcp" : "";
  return `sip:${user}${host}:${port}${transport}`;
}
