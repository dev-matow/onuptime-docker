import type { CheckTypeDescriptor } from "./contract";

/**
 * Isomorphic metadata for every check type.
 *
 * This module is imported by the monitor form (a client component), so
 * it must stay free of zod and of every `node:` import. That constraint
 * is the whole reason descriptors are separated from definitions: the
 * probe implementations pull in `node:dns`, `node:net`, `node:tls` and
 * `node:child_process`, none of which may reach the browser bundle.
 *
 * Adding a type means a descriptor here, a spec in `specs/<id>.ts`, a
 * probe in `probes/<id>.ts`, an entry in `specs/index.ts` and one in
 * `registry.ts` — five files. The conformance suite fails if any of them
 * disagree; forgetting `specs/index.ts` in particular produces a type
 * that renders in the form selector and then fails validation with
 * "Unknown check type".
 */

const RESPONSE_TIME = {
  key: "responseTimeMs",
  label: "Response time",
  kind: "number",
  unit: "ms",
} as const;

export const httpDescriptor: CheckTypeDescriptor = {
  id: "http",
  label: "HTTP(S) request",
  description: "Fetch a URL and assert on the status code, body and TLS.",
  target: {
    kind: "url",
    label: "URL",
    placeholder: "https://example.com/health",
    help: "The full URL to request, including the scheme.",
  },
  port: null,
  facts: [
    { key: "statusCode", label: "Status code", kind: "number" },
    RESPONSE_TIME,
    { key: "keywordPresent", label: "Keyword found", kind: "boolean" },
    {
      key: "tlsDaysRemaining",
      label: "Certificate expires in",
      kind: "number",
      unit: "days",
    },
  ],
  form: ["method", "expectedStatusCode", "keyword", "tlsWarning"],
  supportsRecovery: true,
};

export const tcpDescriptor: CheckTypeDescriptor = {
  id: "tcp",
  label: "TCP port",
  description: "Open a TCP connection to a host and port.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "db.example.com",
    help: "A bare hostname — no scheme, no port.",
  },
  port: { required: true, default: null },
  facts: [RESPONSE_TIME],
  form: ["port"],
  supportsRecovery: true,
};

export const pingDescriptor: CheckTypeDescriptor = {
  id: "ping",
  label: "Ping (ICMP)",
  description: "Send an ICMP echo and measure the round trip.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "gateway.example.com",
    help: "A bare hostname. ICMP has no ports.",
  },
  port: null,
  facts: [
    { key: "responseTimeMs", label: "Round trip", kind: "number", unit: "ms" },
    { key: "packetsReceived", label: "Replies", kind: "number" },
  ],
  form: [],
  // ICMP needs a raw socket. On Linux that is CAP_NET_RAW, or a
  // `net.ipv4.ping_group_range` that includes the worker's gid. When it
  // is absent the monitor reads `misconfigured`, never `down`.
  requiresCapability: "icmp",
  supportsRecovery: false,
};

/** Record types a `dns` monitor can ask for. Lives in the catalog so the
 * form can render the selector without importing zod. */
export const DNS_RECORD_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "NS",
  "TXT",
] as const;

export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export const dnsDescriptor: CheckTypeDescriptor = {
  id: "dns",
  label: "DNS record",
  description: "Resolve a name and assert on the records that come back.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "example.com",
    help: "The name to resolve.",
  },
  port: null,
  facts: [
    { key: "records", label: "Records", kind: "list" },
    { key: "recordCount", label: "Record count", kind: "number" },
    {
      key: "responseTimeMs",
      label: "Resolve time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["dnsRecord"],
  supportsRecovery: false,
};

export const tlsExpiryDescriptor: CheckTypeDescriptor = {
  id: "tls-expiry",
  label: "TLS certificate expiry",
  description: "Watch how long a certificate has left before it expires.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "example.com",
    help: "The host to handshake with. Defaults to port 443.",
  },
  port: { required: false, default: 443 },
  facts: [
    {
      key: "daysRemaining",
      label: "Expires in",
      kind: "number",
      unit: "days",
    },
    { key: "issuer", label: "Issuer", kind: "string" },
    { key: "validTo", label: "Valid until", kind: "string" },
    RESPONSE_TIME,
  ],
  form: ["port", "expiryWarning"],
  supportsRecovery: false,
};

export const domainExpiryDescriptor: CheckTypeDescriptor = {
  id: "domain-expiry",
  label: "Domain expiry",
  description: "Watch a domain registration's expiry date over RDAP.",
  target: {
    kind: "domain",
    label: "Domain",
    placeholder: "example.com",
    help: "The registrable domain — no scheme, no subdomain.",
  },
  port: null,
  facts: [
    {
      key: "daysRemaining",
      label: "Expires in",
      kind: "number",
      unit: "days",
    },
    { key: "expiresAt", label: "Registered until", kind: "string" },
    { key: "registrar", label: "Registrar", kind: "string" },
    RESPONSE_TIME,
  ],
  form: ["expiryWarning"],
  supportsRecovery: false,
};

/** Every descriptor, in the order the type selector shows them. */
export const CHECK_TYPE_DESCRIPTORS: readonly CheckTypeDescriptor[] = [
  httpDescriptor,
  tcpDescriptor,
  pingDescriptor,
  dnsDescriptor,
  tlsExpiryDescriptor,
  domainExpiryDescriptor,
];

export const CHECK_TYPE_IDS = CHECK_TYPE_DESCRIPTORS.map(
  (descriptor) => descriptor.id,
) as readonly string[];

export function findDescriptor(id: string): CheckTypeDescriptor | undefined {
  return CHECK_TYPE_DESCRIPTORS.find((descriptor) => descriptor.id === id);
}

/**
 * The descriptor for a stored monitor, tolerating a type this build does
 * not know about. `check_type` is `text` since 1.10.0 precisely so an
 * unknown value is data rather than a failed enum cast — a monitor
 * created by a build with an extra type must still list and still be
 * deletable after a downgrade.
 */
export function describeCheckType(id: string): CheckTypeDescriptor {
  return findDescriptor(id) ?? unknownDescriptor(id);
}

function unknownDescriptor(id: string): CheckTypeDescriptor {
  return {
    id,
    label: id,
    description: "This check type is not available in this build.",
    target: { kind: "hostname", label: "Target", placeholder: "", help: "" },
    port: null,
    facts: [],
    form: [],
    supportsRecovery: false,
  };
}
