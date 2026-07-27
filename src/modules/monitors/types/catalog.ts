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

export const DEFAULT_MYSQL_PORT = 3306;
export const DEFAULT_REDIS_PORT = 6379;
export const DEFAULT_SMTP_PORT = 25;
export const DEFAULT_MQTT_PORT = 1883;
export const DEFAULT_MONGODB_PORT = 27017;
export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";

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

export const postgresDescriptor: CheckTypeDescriptor = {
  id: "postgres",
  label: "PostgreSQL",
  description: "Connect to a PostgreSQL server and run a query.",
  target: {
    kind: "url",
    label: "Connection string",
    placeholder: "postgres://user:pass@db.example.com:5432/app",
    help: "The full connection string, credentials included. They are stored like any other monitor setting, so point it at a role that can connect and nothing more.",
  },
  // The port is already in the connection string. A separate field for
  // it would be a second answer to the same question.
  port: { required: false, default: null },
  facts: [
    { key: "responseTimeMs", label: "Query time", kind: "number", unit: "ms" },
    { key: "queryOk", label: "Query answered", kind: "boolean" },
  ],
  form: [],
  supportsRecovery: true,
};

export const mysqlDescriptor: CheckTypeDescriptor = {
  id: "mysql",
  label: "MySQL / MariaDB",
  description: "Read the handshake a MySQL or MariaDB server sends on connect.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "db.example.com",
    help: "A bare hostname — no scheme, no port.",
  },
  port: { required: true, default: DEFAULT_MYSQL_PORT },
  facts: [
    { key: "serverVersion", label: "Server version", kind: "string" },
    { key: "handshakeOk", label: "Handshake read", kind: "boolean" },
    { key: "protocolVersion", label: "Protocol version", kind: "number" },
    { key: "serverError", label: "Server error", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["port"],
  supportsRecovery: true,
};

export const mongodbDescriptor: CheckTypeDescriptor = {
  id: "mongodb",
  label: "MongoDB",
  description:
    "Run the hello handshake a MongoDB server answers unauthenticated.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "mongo.example.com",
    help: "A bare hostname — no scheme, no connection string.",
  },
  port: { required: true, default: DEFAULT_MONGODB_PORT },
  facts: [
    {
      key: "responseTimeMs",
      label: "Handshake time",
      kind: "number",
      unit: "ms",
    },
    { key: "helloOk", label: "Answered hello", kind: "boolean" },
    { key: "maxWireVersion", label: "Wire version", kind: "number" },
    { key: "isPrimary", label: "Writable primary", kind: "boolean" },
    { key: "replicaSet", label: "Replica set", kind: "string" },
  ],
  form: ["port"],
  supportsRecovery: true,
};

export const redisDescriptor: CheckTypeDescriptor = {
  id: "redis",
  label: "Redis",
  description: "Send a PING to a Redis server and read what comes back.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "cache.example.com",
    help: "A bare hostname — no scheme, no port.",
  },
  port: { required: true, default: DEFAULT_REDIS_PORT },
  facts: [
    { key: "pong", label: "Answered PONG", kind: "boolean" },
    { key: "authRequired", label: "Requires authentication", kind: "boolean" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["port"],
  supportsRecovery: true,
};

export const dockerDescriptor: CheckTypeDescriptor = {
  id: "docker",
  label: "Docker container",
  description: "Ask a Docker daemon whether a named container is running.",
  target: {
    kind: "hostname",
    label: "Docker host",
    placeholder: "docker-1.example.com",
    help: "The machine whose daemon is asked. With the default local socket this is a label.",
  },
  port: null,
  facts: [
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
    { key: "running", label: "Running", kind: "boolean" },
    { key: "state", label: "State", kind: "string" },
    { key: "health", label: "Health", kind: "string" },
    { key: "restartCount", label: "Restarts", kind: "number" },
  ],
  form: [],
  supportsRecovery: true,
};

export const mqttDescriptor: CheckTypeDescriptor = {
  id: "mqtt",
  label: "MQTT broker",
  description:
    "Connect to an MQTT broker and read the CONNACK it answers with.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "broker.example.com",
    help: "A bare hostname — no scheme, no port.",
  },
  port: { required: true, default: 1883 },
  facts: [
    { key: "connack", label: "CONNACK received", kind: "boolean" },
    { key: "returnCode", label: "Return code", kind: "number" },
    { key: "returnMessage", label: "Broker response", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["port"],
  supportsRecovery: true,
};

export const smtpDescriptor: CheckTypeDescriptor = {
  id: "smtp",
  label: "SMTP",
  description: "Greet a mail server and check that it accepts EHLO.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "mail.example.com",
    help: "A bare hostname — no scheme, no port. The conversation is plaintext, so port 465 (implicit TLS) will never answer; use 25, 587 or 2525.",
  },
  port: { required: true, default: DEFAULT_SMTP_PORT },
  facts: [
    { key: "greetingCode", label: "Greeting code", kind: "number" },
    { key: "ehloAccepted", label: "EHLO accepted", kind: "boolean" },
    { key: "banner", label: "Banner", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["port"],
  supportsRecovery: true,
};

export const jsonQueryDescriptor: CheckTypeDescriptor = {
  id: "json-query",
  label: "JSON query",
  description: "Fetch a JSON endpoint and assert on one value inside the body.",
  target: {
    kind: "url",
    label: "URL",
    placeholder: "https://example.com/health",
    help: "The full URL of an endpoint that answers with JSON.",
  },
  port: { required: false, default: null },
  facts: [
    { key: "statusCode", label: "Status code", kind: "number" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
    { key: "jsonValid", label: "Body parsed as JSON", kind: "boolean" },
    { key: "pathFound", label: "Path found", kind: "boolean" },
    { key: "actualValue", label: "Value at path", kind: "string" },
    { key: "matches", label: "Value matches", kind: "boolean" },
  ],
  // No shared form section: the path and the expected value are this
  // type's own config, not something another type renders too.
  form: [],
  supportsRecovery: true,
};

/** Every descriptor, in the order the type selector shows them. */
export const CHECK_TYPE_DESCRIPTORS: readonly CheckTypeDescriptor[] = [
  httpDescriptor,
  tcpDescriptor,
  pingDescriptor,
  dnsDescriptor,
  tlsExpiryDescriptor,
  domainExpiryDescriptor,
  postgresDescriptor,
  mysqlDescriptor,
  mongodbDescriptor,
  redisDescriptor,
  dockerDescriptor,
  mqttDescriptor,
  smtpDescriptor,
  jsonQueryDescriptor,
];

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

export const CHECK_TYPE_IDS = CHECK_TYPE_DESCRIPTORS.map(
  (descriptor) => descriptor.id,
) as readonly string[];
