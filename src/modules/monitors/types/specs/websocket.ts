import { z } from "zod";

import { isForbiddenEgressHost } from "../../net";
import { websocketDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { latencyAssertion } from "./shared";

/**
 * The only status that means the endpoint agreed to speak WebSocket.
 *
 * Exported because the probe reports it as a fact, the assertion below
 * judges it and the fixture in the unit test answers with it. Three
 * literals would be three chances to disagree about what a completed
 * handshake is.
 */
export const SWITCHING_PROTOCOLS = 101;

export interface WebsocketConfig {
  /**
   * Sent as `Sec-WebSocket-Protocol` and asserted against what comes
   * back. One field rather than "request this, expect that": the server
   * may only echo a protocol the client offered, so an operator able to
   * ask for one and assert another would be writing a check that can
   * never pass.
   */
  subprotocol: string | null;
  /**
   * Sent verbatim as the `Authorization` header. Null when the endpoint
   * is open — the common case for a public status socket, and why this
   * is optional rather than required.
   */
  authorization: string | null;
  degradedThresholdMs: number;
}

/** A single RFC 9110 token — what a subprotocol name is allowed to be. */
const SUBPROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Visible characters, tab and obs-text: a header field value with no CR,
 * LF or NUL in it.
 *
 * This is the one validation here that is a security control rather than
 * a nicety. The value is written into the handshake request as-is, so a
 * newline would let whoever can edit a monitor append headers of their
 * own to a request Vigil makes, the classic response-splitting shape,
 * pointed outward. Node's client would refuse it too, but by then the
 * failure reads as an unexplained probe error rather than as a rejected
 * field with a message.
 */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/;

export const websocketStoredSchema = z.object({
  subprotocol: z
    .string()
    .trim()
    .max(64)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null))
    .refine((value) => value === null || SUBPROTOCOL_TOKEN.test(value), {
      message: "A subprotocol is a single token, like graphql-ws.",
    }),
  // Trimmed, unlike the Redis password next door: the whitespace around
  // an HTTP field value is not part of the value — every parser on the
  // receiving end strips it — so trimming here cannot change what the
  // server sees, and a credential pasted with a trailing newline stops
  // being a rejected request nobody can explain.
  authorization: z
    .string()
    .trim()
    .max(2048)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null))
    .refine((value) => value === null || HEADER_VALUE.test(value), {
      message:
        "An Authorization value cannot contain line breaks or control characters.",
    }),
});

export const websocketConfigSchema: z.ZodType<WebsocketConfig> = z.object({
  subprotocol: z.string().max(64).nullable(),
  authorization: z.string().max(2048).nullable(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/**
 * Not `monitorUrlSchema`: that one demands http or https, which is the
 * right rule for everything that fetches and the wrong one here. The
 * scheme is also what decides whether the handshake runs over TLS, so
 * refusing to guess it is the point.
 */
export const websocketTargetSchema = z
  .url({
    protocol: /^wss?$/,
    hostname: z.regexes.domain,
    error: "Enter a ws:// or wss:// URL, like wss://example.com/socket.",
  })
  .max(2048)
  .refine(
    (value) => {
      let hostname: string;
      try {
        hostname = new URL(value).hostname;
      } catch {
        return true; // not a URL at all — the check above already said so
      }
      return !isForbiddenEgressHost(hostname);
    },
    { message: "This host cannot be monitored." },
  );

const switchedProtocols: Assertion<WebsocketConfig> = {
  id: "switching-protocols",
  fact: "statusCode",
  severity: "down",
  evaluate(value) {
    // Absent when nothing answered at all, which the probe has already
    // reported as a transport error. Judging it again here would put a
    // second sentence on an incident that has one cause.
    if (typeof value !== "number") return null;
    return value === SWITCHING_PROTOCOLS
      ? null
      : `Expected ${SWITCHING_PROTOCOLS} Switching Protocols, got ${value}`;
  },
};

const acceptedTheKey: Assertion<WebsocketConfig> = {
  id: "accept-key",
  fact: "acceptValid",
  severity: "down",
  evaluate(value) {
    // Only present when a 101 arrived; the assertion above owns every
    // other answer.
    if (typeof value !== "boolean") return null;
    // RFC 6455's whole point: the digest proves the peer read the key
    // this handshake sent and is a WebSocket endpoint, not a proxy or a
    // cache that will happily say 101 to anything. Without it a monitor
    // can be green against something no client could ever talk to.
    return value
      ? null
      : "The server answered 101, but its Sec-WebSocket-Accept does not match the key sent";
  },
};

const negotiatedSubprotocol: Assertion<WebsocketConfig> = {
  id: "subprotocol",
  fact: "subprotocol",
  severity: "down",
  applies: (config) => config.subprotocol !== null,
  evaluate(value, config) {
    // `undefined` means no handshake completed — nothing was negotiated
    // because nothing was upgraded. `null` means the handshake completed
    // and the server chose no protocol at all, which for a client that
    // asked for one is a refusal it has to treat as fatal.
    if (value === undefined) return null;
    if (value === null) {
      return `The server accepted the upgrade without the "${config.subprotocol}" subprotocol`;
    }
    if (typeof value !== "string") return null;
    return value === config.subprotocol
      ? null
      : `Expected the "${config.subprotocol}" subprotocol, got "${value}"`;
  },
};

export const websocketSpec: CheckTypeSpec<WebsocketConfig> = {
  descriptor: websocketDescriptor,
  configSchema: websocketConfigSchema,
  storedSchema: websocketStoredSchema,
  secretFields: ["authorization"],
  targetSchema: websocketTargetSchema,
  assertions: [
    switchedProtocols,
    acceptedTheKey,
    negotiatedSubprotocol,
    latencyAssertion<WebsocketConfig>("Handshook"),
  ],
  fromRow(row: MonitorRowView): WebsocketConfig {
    const stored = websocketStoredSchema.safeParse(row.config ?? {});
    return {
      subprotocol: stored.success ? stored.data.subprotocol : null,
      authorization: stored.success ? stored.data.authorization : null,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  /**
   * Origin and path — never the userinfo or the query string.
   *
   * Both can carry a credential here, and the second one usually does: a
   * browser cannot set an `Authorization` header on a WebSocket, so
   * `wss://host/socket?token=…` is the ordinary way these endpoints
   * authenticate. This string is what an incident email, a webhook body
   * and a public status page print, so the token has to come off before
   * it gets there.
   */
  describeTarget(target) {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      // Unparseable, so a credential cannot be located precisely.
      // Everything up to the last "@" is where one would be.
      return target.slice(target.lastIndexOf("@") + 1);
    }
    return `${url.protocol}//${url.host}${url.pathname}`;
  },
};
