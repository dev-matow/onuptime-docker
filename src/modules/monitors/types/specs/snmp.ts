import { z } from "zod";

import {
  DEFAULT_SNMP_OID,
  DEFAULT_SNMP_PORT,
  SNMP_VERSIONS,
  snmpDescriptor,
  type SnmpVersion,
} from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * One SNMP GET, for one OID.
 *
 * A GET rather than a walk, and one OID rather than a subtree, because
 * a monitor's question is "is this value still what it should be" and a
 * walk's is "what is in here". A walk against a switch with a thousand
 * interfaces is thousands of round trips per check against a device
 * whose CPU is the thing being watched; there is no interval at which
 * that is a responsible thing to do every minute, for ever.
 *
 * The community string is a credential in the plainest sense — it is
 * the whole of v1 and v2c authentication — so it is declared in
 * `secretFields` and never reaches a browser. The v3 pass phrases are
 * the same. The v3 *user name* deliberately is not: USM sends it in the
 * clear in every message, at every security level, so masking it would
 * hide an identifier the operator needs in order to recognise their own
 * monitor while protecting a value the protocol publishes anyway.
 */

/** The community every agent ships with, and the one every tool defaults to. */
export const DEFAULT_SNMP_COMMUNITY = "public";

export type SnmpAuthProtocol = "MD5" | "SHA";
export type SnmpPrivProtocol = "AES";

export const SNMP_AUTH_PROTOCOLS = ["MD5", "SHA"] as const;

/**
 * Privacy protocols Vigil offers. AES-128 and nothing else.
 *
 * USM also defines CBC-DES, and it is not here because it cannot run:
 * OpenSSL 3 moved single DES to the legacy provider, so
 * `createCipheriv("des-cbc")` throws on a default Node build. An agent
 * that offers only DES privacy has to be polled at authNoPriv — which
 * still authenticates and still integrity-checks every message, and
 * only leaves the *value* readable to anyone on the path.
 */
export const SNMP_PRIV_PROTOCOLS = ["AES"] as const;

export interface SnmpConfig {
  /** The one object this check asks for, dotted. */
  oid: string;
  version: SnmpVersion;
  /** v1/v2c only. Null when an operator has cleared it. */
  community: string | null;
  /** USM user name. Required by the schema when the version is 3. */
  v3Username: string | null;
  v3AuthProtocol: SnmpAuthProtocol | null;
  v3AuthPassword: string | null;
  v3PrivProtocol: SnmpPrivProtocol | null;
  v3PrivPassword: string | null;
  /** When set, the value must equal this string exactly. */
  expectedValue: string | null;
  degradedThresholdMs: number;
}

/**
 * A dotted OID with at least two arcs.
 *
 * The prefix is checked as well as the shape, because BER packs the
 * first two arcs into one byte and can only do so for `0.x`, `1.x` with
 * x < 40, or `2.x`. `3.1.1` is a plausible typo that no encoder can
 * represent, and finding that out in the probe means a monitor that
 * reports `misconfigured` for ever instead of a form that says so while
 * the operator is still looking at it.
 */
export function isEncodableOid(value: string): boolean {
  if (!/^\d+(\.\d+)+$/.test(value)) return false;
  const arcs = value.split(".").map(Number);
  if (arcs.some((arc) => !Number.isSafeInteger(arc))) return false;
  const [first, second] = arcs as [number, number];
  return first <= 2 && (first === 2 || second < 40);
}

const trimmedOrNull = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null));

/**
 * Not trimmed, unlike the identifiers beside it: whitespace inside a
 * pass phrase is part of the secret, and quietly rewriting it turns a
 * working credential into an authentication failure with no visible
 * cause. The same rule the Redis and MQTT passwords follow.
 */
const secretOrNull = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null));

export const snmpStoredSchema = z
  .object({
    oid: z
      .string()
      .trim()
      .max(255)
      .refine(isEncodableOid, {
        message:
          "Enter a numeric OID like 1.3.6.1.2.1.1.3.0, names from a MIB are not resolved.",
      })
      .default(DEFAULT_SNMP_OID),
    version: z.enum(SNMP_VERSIONS).default("2c"),
    /**
     * Absent means "never said", and a monitor that has never said
     * anything about its community is a monitor an operator created by
     * typing a hostname. `public` is what their device answers to
     * unless somebody changed it, so it is the default — while an
     * explicit `null` still clears the field, which is what the config
     * contract says a null must do for a secret.
     */
    community: z
      .string()
      .max(255)
      .nullish()
      .transform((value) => {
        if (value === undefined) return DEFAULT_SNMP_COMMUNITY;
        return value !== null && value.length > 0 ? value : null;
      }),
    v3Username: trimmedOrNull(64),
    v3AuthProtocol: z.enum(SNMP_AUTH_PROTOCOLS).nullish().default(null),
    v3AuthPassword: secretOrNull(255),
    v3PrivProtocol: z.enum(SNMP_PRIV_PROTOCOLS).nullish().default(null),
    v3PrivPassword: secretOrNull(255),
    expectedValue: trimmedOrNull(255),
  })
  .superRefine((config, ctx) => {
    if (config.version === "3" && config.v3Username === null) {
      ctx.addIssue({
        code: "custom",
        path: ["v3Username"],
        message: "SNMP v3 identifies the caller by user name, so it needs one.",
      });
    }
    if (config.version !== "3" && config.community === null) {
      ctx.addIssue({
        code: "custom",
        path: ["community"],
        message: `SNMP ${config.version} has no other credential, so it needs a community string.`,
      });
    }
    // USM has no noAuthPriv level (RFC 3414 §1.4.1): encryption without
    // authentication would leave anyone able to substitute a message
    // Vigil could not tell from the agent's. Refused where the operator
    // is standing rather than silently downgraded at send time.
    if (config.v3PrivProtocol !== null && config.v3AuthProtocol === null) {
      ctx.addIssue({
        code: "custom",
        path: ["v3PrivProtocol"],
        message: "SNMP v3 cannot encrypt without authenticating as well.",
      });
    }
    for (const [protocol, password, path] of [
      [config.v3AuthProtocol, config.v3AuthPassword, "v3AuthPassword"],
      [config.v3PrivProtocol, config.v3PrivPassword, "v3PrivPassword"],
    ] as const) {
      if (protocol !== null && password === null) {
        ctx.addIssue({
          code: "custom",
          path: [path],
          message: `Enter the ${protocol} pass phrase for this user.`,
        });
      }
      if (protocol === null && password !== null) {
        ctx.addIssue({
          code: "custom",
          path: [path],
          message: "Choose the protocol this pass phrase is for.",
        });
      }
    }
  });

export const snmpConfigSchema: z.ZodType<SnmpConfig> = z.object({
  oid: z.string().min(1).max(255),
  version: z.enum(SNMP_VERSIONS),
  community: z.string().max(255).nullable(),
  v3Username: z.string().max(64).nullable(),
  v3AuthProtocol: z.enum(SNMP_AUTH_PROTOCOLS).nullable(),
  v3AuthPassword: z.string().max(255).nullable(),
  v3PrivProtocol: z.enum(SNMP_PRIV_PROTOCOLS).nullable(),
  v3PrivPassword: z.string().max(255).nullable(),
  expectedValue: z.string().max(255).nullable(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/** What a row holds before anyone has configured anything. */
const DEFAULTS: Omit<SnmpConfig, "degradedThresholdMs"> = {
  oid: DEFAULT_SNMP_OID,
  version: "2c",
  community: DEFAULT_SNMP_COMMUNITY,
  v3Username: null,
  v3AuthProtocol: null,
  v3AuthPassword: null,
  v3PrivProtocol: null,
  v3PrivPassword: null,
  expectedValue: null,
};

const agentAccepted: Assertion<SnmpConfig> = {
  id: "agent-error",
  fact: "errorStatus",
  severity: "down",
  evaluate(value) {
    // Every one of these is the agent *answering*: it parsed the
    // request and declined it. A v1 agent says `noSuchName` for an OID
    // it does not implement; a v3 engine reports `unknownUserName` or
    // `wrongDigest` for credentials it does not accept. Reporting any
    // of them as a transport failure would tell an operator their
    // device is unreachable at the moment it is talking to them.
    if (typeof value !== "string") return null;
    return `The agent refused the request: ${value}`;
  },
};

const oidAnswered: Assertion<SnmpConfig> = {
  id: "oid-answered",
  fact: "oidFound",
  severity: "down",
  evaluate(value) {
    // Null when the agent returned an error-status instead of a
    // varbind, because then it said nothing about this OID at all and
    // the assertion above has already named the cause. Not knowing the
    // answer is not the same as getting the wrong one.
    if (typeof value !== "boolean") return null;
    return value ? null : "The agent has no value for this OID on this device";
  },
};

const valueMatches: Assertion<SnmpConfig> = {
  id: "value",
  fact: "value",
  severity: "down",
  applies: (config) => config.expectedValue !== null,
  evaluate(value, config) {
    if (value === config.expectedValue) return null;
    return value === null || value === undefined
      ? `The agent returned no value, expected ${config.expectedValue}`
      : `The value is ${String(value)}, expected ${config.expectedValue}`;
  },
};

export const snmpSpec: CheckTypeSpec<SnmpConfig> = {
  descriptor: snmpDescriptor,
  configSchema: snmpConfigSchema,
  storedSchema: snmpStoredSchema,
  secretFields: ["community", "v3AuthPassword", "v3PrivPassword"],
  targetSchema: monitorHostnameSchema,
  assertions: [
    agentAccepted,
    oidAnswered,
    valueMatches,
    latencyAssertion<SnmpConfig>("The agent answered"),
  ],
  fromRow(row: MonitorRowView): SnmpConfig {
    const stored = snmpStoredSchema.safeParse(row.config ?? {});
    return {
      ...(stored.success ? stored.data : DEFAULTS),
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, port, config) {
    // The OID is the other half of what this monitor watches, and it is
    // not a credential — printing it is what makes an incident email
    // say which value stopped answering rather than only which box.
    // The community string is a credential and is never printed here.
    return `${target}:${port ?? DEFAULT_SNMP_PORT} ${config.oid}`;
  },
};
