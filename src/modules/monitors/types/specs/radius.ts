import { z } from "zod";

import { DEFAULT_RADIUS_PORT, radiusDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

/** Packet codes, RFC 2865 §3. */
export const RADIUS_ACCESS_REQUEST = 1;
export const RADIUS_ACCESS_ACCEPT = 2;
export const RADIUS_ACCESS_REJECT = 3;
export const RADIUS_ACCESS_CHALLENGE = 11;

/**
 * The three codes a server may answer an Access-Request with. Every one
 * of them is the server *working*: a rejection means it read our packet,
 * verified the shared secret, consulted its user store and made a
 * decision. Which of them counts as healthy is the operator's call —
 * see {@link RadiusConfig.expectAccept}.
 */
export const RADIUS_RESPONSE_CODES: Readonly<Record<number, string>> = {
  [RADIUS_ACCESS_ACCEPT]: "Access-Accept",
  [RADIUS_ACCESS_REJECT]: "Access-Reject",
  [RADIUS_ACCESS_CHALLENGE]: "Access-Challenge",
};

export function radiusCodeName(code: number): string {
  return RADIUS_RESPONSE_CODES[code] ?? `Unrecognised code ${code}`;
}

/** RFC 2865 §5.2: the plaintext password is at most 128 octets. */
export const MAX_RADIUS_PASSWORD_BYTES = 128;

/** An attribute carries its length in one byte, minus the 2-byte header. */
export const MAX_RADIUS_ATTRIBUTE_BYTES = 253;

/** What the request calls itself when the operator has not said. */
export const DEFAULT_RADIUS_USERNAME = "vigil-monitor";
export const DEFAULT_NAS_IDENTIFIER = "vigil";

export interface RadiusConfig {
  /**
   * The shared secret. Null until an operator supplies one, and the
   * probe then reports `misconfigured` rather than dialling: an
   * Access-Request cannot be built without it, and a monitor that
   * reads `down` because nobody filled in a field is the one failure a
   * monitoring product may not have.
   */
  secret: string | null;
  /** The account the check authenticates as. */
  username: string;
  password: string;
  /** What the request calls itself — some servers key policy on it. */
  nasIdentifier: string;
  /**
   * Whether only an Access-Accept counts as healthy.
   *
   * Off by default, because the usual way to monitor a RADIUS server is
   * with credentials that are meant to fail: any signed answer proves
   * the server, its secret and its user store are all alive. Turn it on
   * when the account is a real test account, where a rejection means the
   * directory behind the server has stopped answering.
   */
  expectAccept: boolean;
  degradedThresholdMs: number;
}

function byteLength(value: string): number {
  // TextEncoder rather than Buffer: this file is reachable from the
  // monitor form, and Buffer does not exist in a browser.
  return new TextEncoder().encode(value).length;
}

const attributeValue = (label: string) =>
  z
    .string()
    .trim()
    .max(MAX_RADIUS_ATTRIBUTE_BYTES)
    .refine((value) => byteLength(value) <= MAX_RADIUS_ATTRIBUTE_BYTES, {
      // Length is a single byte on the wire, so a name that fits as
      // characters and not as UTF-8 bytes would produce a packet the
      // server discards without a word. Refused where the operator is
      // standing instead.
      message: `The ${label} cannot exceed ${MAX_RADIUS_ATTRIBUTE_BYTES} bytes.`,
    });

export const radiusStoredSchema = z.object({
  // Not trimmed, like every other credential in this codebase: a shared
  // secret is compared byte for byte at the far end, and quietly eating
  // a trailing space turns a working secret into replies that never
  // verify — with nothing anywhere saying why.
  secret: z
    .string()
    .max(255)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null)),
  username: attributeValue("user name")
    .nullish()
    .transform((value) =>
      value && value.length > 0 ? value : DEFAULT_RADIUS_USERNAME,
    ),
  password: z
    .string()
    .max(MAX_RADIUS_PASSWORD_BYTES)
    .nullish()
    .transform((value) => value ?? ""),
  nasIdentifier: attributeValue("NAS identifier")
    .nullish()
    .transform((value) =>
      value && value.length > 0 ? value : DEFAULT_NAS_IDENTIFIER,
    ),
  expectAccept: z
    .boolean()
    .nullish()
    .transform((value) => value ?? false),
});

export const radiusConfigSchema: z.ZodType<RadiusConfig> = z.object({
  secret: z.string().max(255).nullable(),
  username: z.string().max(MAX_RADIUS_ATTRIBUTE_BYTES),
  password: z.string().max(MAX_RADIUS_PASSWORD_BYTES),
  nasIdentifier: z.string().max(MAX_RADIUS_ATTRIBUTE_BYTES),
  expectAccept: z.boolean(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

const answeredAsRadius: Assertion<RadiusConfig> = {
  id: "radius-response",
  fact: "replyCode",
  severity: "down",
  evaluate(value) {
    // Absent when nothing came back, which the probe reports as a
    // transport failure; the reply that did come back has already been
    // verified against the shared secret, so an unrecognised code here
    // is a server answering an Access-Request with something that is
    // not an answer to one.
    if (typeof value !== "number") return null;
    return value in RADIUS_RESPONSE_CODES
      ? null
      : `The server answered with an unrecognised RADIUS code (${value})`;
  },
};

const accepted: Assertion<RadiusConfig> = {
  id: "access-accepted",
  fact: "replyCode",
  severity: "down",
  applies: (config) => config.expectAccept,
  evaluate(value) {
    if (typeof value !== "number") return null;
    return value === RADIUS_ACCESS_ACCEPT
      ? null
      : `The server answered ${radiusCodeName(value)}`;
  },
};

export const radiusSpec: CheckTypeSpec<RadiusConfig> = {
  descriptor: radiusDescriptor,
  configSchema: radiusConfigSchema,
  storedSchema: radiusStoredSchema,
  // The account's password is as much a credential as the shared secret
  // — it is a working login on whatever the server authenticates
  // against — so both are masked on the way out and both mean "keep the
  // stored one" when the mask comes back.
  secretFields: ["secret", "password"],
  targetSchema: monitorHostnameSchema,
  assertions: [
    answeredAsRadius,
    accepted,
    latencyAssertion<RadiusConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): RadiusConfig {
    const stored = radiusStoredSchema.safeParse(row.config ?? {});
    return {
      secret: stored.success ? stored.data.secret : null,
      username: stored.success ? stored.data.username : DEFAULT_RADIUS_USERNAME,
      password: stored.success ? stored.data.password : "",
      nasIdentifier: stored.success
        ? stored.data.nasIdentifier
        : DEFAULT_NAS_IDENTIFIER,
      expectAccept: stored.success ? stored.data.expectAccept : false,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, port) {
    // Host and port only. This lands in incident emails, webhook bodies
    // and on public status pages, and the config beside it holds both a
    // shared secret and a working account password.
    return `${target}:${port ?? DEFAULT_RADIUS_PORT}`;
  },
};
