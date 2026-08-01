import { z } from "zod";

import { udpDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * How the operator writes the payload, and how the expected reply is
 * read back.
 *
 * One setting for both directions rather than two, because the two
 * cases are whole: somebody probing a text protocol writes text on both
 * sides, and somebody probing a binary one writes hex on both sides. A
 * separate encoding for the expectation would be a third combination
 * nobody has, offered at the cost of a field everybody has to read.
 */
export const UDP_PAYLOAD_ENCODINGS = ["text", "hex"] as const;

export type UdpPayloadEncoding = (typeof UDP_PAYLOAD_ENCODINGS)[number];

/**
 * The ceiling on what one check sends.
 *
 * Well under the 1500-byte Ethernet MTU on purpose. A datagram larger
 * than the path MTU is fragmented, and a fragmented probe measures the
 * network's willingness to reassemble it — many firewalls drop
 * non-initial fragments outright — rather than whether the service
 * answers. An operator who needs to send more than this is testing the
 * network, and this check would tell them the wrong thing about it.
 */
export const MAX_UDP_PAYLOAD_BYTES = 1024;

export interface UdpConfig {
  /** Sent verbatim, decoded according to {@link payloadEncoding}. */
  payload: string;
  payloadEncoding: UdpPayloadEncoding;
  /**
   * A substring the reply must contain, or null when any reply will do.
   * Read with the same encoding as the payload — hex against the
   * reply's hex, text against its text.
   */
  expectedResponse: string | null;
  degradedThresholdMs: number;
}

/** Whitespace is how a person writes hex; the wire has no room for it. */
export function normalizeHex(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

const HEX_ONLY = /^[0-9a-f]*$/;

function payloadByteLength(
  payload: string,
  encoding: UdpPayloadEncoding,
): number {
  return encoding === "hex"
    ? normalizeHex(payload).length / 2
    : // TextEncoder rather than Buffer: this file is imported by the
      // monitor form, and Buffer does not exist in a browser.
      new TextEncoder().encode(payload).length;
}

export const udpStoredSchema = z
  .object({
    // Not trimmed: a trailing newline is what half the text protocols on
    // this planet use as a terminator, and eating it turns a working
    // probe into one the server waits forever to finish.
    payload: z
      .string()
      .max(4096)
      .nullish()
      .transform((value) => value ?? ""),
    payloadEncoding: z
      .enum(UDP_PAYLOAD_ENCODINGS)
      .nullish()
      .transform((value) => value ?? "text"),
    expectedResponse: z
      .string()
      .max(200)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null)),
  })
  .refine(
    (config) =>
      config.payloadEncoding !== "hex" ||
      (HEX_ONLY.test(normalizeHex(config.payload)) &&
        normalizeHex(config.payload).length % 2 === 0),
    {
      // Refused here rather than at send time, where `Buffer.from(…,
      // "hex")` silently truncates at the first byte it cannot read: the
      // operator would get a shorter datagram than they wrote and no
      // sign of it anywhere.
      message: "Enter the payload as pairs of hex digits, like 00ff2a.",
      path: ["payload"],
    },
  )
  .refine(
    (config) =>
      payloadByteLength(config.payload, config.payloadEncoding) <=
      MAX_UDP_PAYLOAD_BYTES,
    {
      message: `The payload cannot exceed ${MAX_UDP_PAYLOAD_BYTES} bytes.`,
      path: ["payload"],
    },
  );

export const udpConfigSchema: z.ZodType<UdpConfig> = z.object({
  payload: z.string().max(4096),
  payloadEncoding: z.enum(UDP_PAYLOAD_ENCODINGS),
  expectedResponse: z.string().max(200).nullable(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

const matchedExpectedResponse: Assertion<UdpConfig> = {
  id: "expected-response",
  fact: "responseMatches",
  severity: "down",
  applies: (config) => config.expectedResponse !== null,
  evaluate(value, config) {
    // Absent when nothing replied at all, which the probe has already
    // reported as a transport failure. Repeating it as an assertion
    // failure would put two lines in the timeline for one event.
    if (typeof value !== "boolean") return null;
    return value
      ? null
      : `The reply did not contain "${config.expectedResponse}"`;
  },
};

export const udpSpec: CheckTypeSpec<UdpConfig> = {
  descriptor: udpDescriptor,
  configSchema: udpConfigSchema,
  storedSchema: udpStoredSchema,
  targetSchema: monitorHostnameSchema,
  assertions: [
    matchedExpectedResponse,
    latencyAssertion<UdpConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): UdpConfig {
    const stored = udpStoredSchema.safeParse(row.config ?? {});
    return {
      payload: stored.success ? stored.data.payload : "",
      payloadEncoding: stored.success ? stored.data.payloadEncoding : "text",
      expectedResponse: stored.success ? stored.data.expectedResponse : null,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, port) {
    // The transport is part of the address here. "dns.example.com:53"
    // reads as TCP to anyone who has ever written a firewall rule, and
    // this string is what an incident email and a status page print.
    return port === null ? target : `${target}:${port}/udp`;
  },
};
