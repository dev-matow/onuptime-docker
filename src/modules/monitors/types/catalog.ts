import { isScheduledKind } from "./contract";
import type { CheckTypeDescriptor, CheckTypeKind } from "./contract";

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

export const httpDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
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

export const tcpDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
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

export const pingDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
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

export const dnsDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
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

export const tlsExpiryDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
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

export const domainExpiryDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
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
    // `active` is the honest guess and the safe one. The scheduler keeps
    // enqueuing a monitor whose type this build lost, `performCheck`
    // answers `indeterminate`, and the row reads "not available in this
    // build" every interval. Guessing `manual` would instead take it off
    // the schedule entirely and leave it sitting on its last known
    // status, which is a monitor that has quietly stopped monitoring.
    kind: "active",
    label: id,
    description: "This check type is not available in this build.",
    target: { kind: "hostname", label: "Target", placeholder: "", help: "" },
    port: null,
    facts: [],
    form: [],
    supportsRecovery: false,
  };
}

export const postgresDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
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

export const mysqlDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
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

export const mongodbDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
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

export const redisDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
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

export const dockerDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
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

export const mqttDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
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

export const smtpDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
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

export const jsonQueryDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
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

/**
 * The default tolerance on a heartbeat's deadline, in seconds.
 *
 * Not zero, and the reason is arithmetic rather than kindness: a cron
 * that fires every 60 seconds does not deliver every 60.000 seconds,
 * and the evaluation that judges it is itself aligned to a tick. With
 * no tolerance, the two clocks eventually land the wrong way round and
 * a job that never missed a beat records a failed observation. Thirty
 * seconds is half a tick period — long enough to absorb that, short
 * enough that a job which genuinely stopped is still caught inside the
 * operator's failure window.
 */
export const DEFAULT_HEARTBEAT_GRACE_SECONDS = 30;

export const pushDescriptor: CheckTypeDescriptor<"passive"> = {
  kind: "passive",
  id: "push",
  label: "Push heartbeat",
  description:
    "Wait for a job to check in, and go down when it stops checking in.",
  target: {
    kind: "label",
    label: "Job name",
    placeholder: "nightly-backup",
    help: "What reports in. Nothing is dialled — this names the job in incidents, emails and on status pages.",
  },
  port: null,
  facts: [
    { key: "heartbeatReceived", label: "Ever checked in", kind: "boolean" },
    {
      key: "secondsSinceHeartbeat",
      label: "Silent for",
      kind: "number",
      unit: "s",
    },
    { key: "reportedStatus", label: "Last report", kind: "string" },
    { key: "reportedMessage", label: "Message", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Job duration",
      kind: "number",
      unit: "ms",
    },
  ],
  form: ["heartbeatGrace"],
  // Recovery verifies a fix by re-probing, and there is nothing here to
  // re-probe: the only thing that can prove a push monitor healthy is
  // the job itself checking in, on its own schedule.
  supportsRecovery: false,
};

export const groupDescriptor: CheckTypeDescriptor<"aggregate"> = {
  kind: "aggregate",
  id: "group",
  label: "Group",
  description: "Roll several monitors up into one state, derived from theirs.",
  target: {
    kind: "label",
    label: "What this group covers",
    placeholder: "EU region",
    help: "A one-line description of the thing the members add up to. Shown wherever a target would be.",
  },
  port: null,
  facts: [
    { key: "memberCount", label: "Members", kind: "number" },
    { key: "downMembers", label: "Down", kind: "number" },
    { key: "degradedMembers", label: "Degraded", kind: "number" },
    { key: "unmeasuredMembers", label: "Not measured", kind: "number" },
    { key: "worstMember", label: "Worst member", kind: "string" },
    {
      key: "memberIntervalSeconds",
      label: "Slowest member reports every",
      kind: "number",
      unit: "s",
    },
  ],
  // Membership is the only setting a group has, and it is stored on the
  // members — a child names its group, not the other way round, so that
  // deleting a group cannot take its members with it.
  form: [],
  supportsRecovery: false,
};

export const manualDescriptor: CheckTypeDescriptor<"manual"> = {
  kind: "manual",
  id: "manual",
  label: "Manual",
  description:
    "A status an operator sets by hand — for what Vigil cannot reach.",
  target: {
    kind: "label",
    label: "What this tracks",
    placeholder: "Stripe payments",
    help: "The thing you are vouching for. A vendor, a physical site, anything with no endpoint to dial.",
  },
  port: null,
  facts: [
    { key: "declaredStatus", label: "Set to", kind: "string" },
    { key: "declaredNote", label: "Note", kind: "string" },
  ],
  form: ["manualStatus"],
  supportsRecovery: false,
};

/**
 * The management plugin's own port. Not a `port` field on the
 * descriptor: the target is a URL, so the port is already in it, and a
 * second field for it would be a second answer to the same question.
 * Kept as a constant because the placeholder and the docs both quote it.
 */
export const DEFAULT_RABBITMQ_MANAGEMENT_PORT = 15672;

export const rabbitmqDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "rabbitmq",
  label: "RabbitMQ",
  description:
    "Ask a RabbitMQ node's management API whether its health checks pass.",
  target: {
    kind: "url",
    label: "Management API URL",
    placeholder: `https://rabbit.example.com:${DEFAULT_RABBITMQ_MANAGEMENT_PORT}`,
    help: `The base URL of the management plugin, including its port (${DEFAULT_RABBITMQ_MANAGEMENT_PORT} unless it sits behind a proxy). Vigil appends the health-check path itself.`,
  },
  port: null,
  facts: [
    { key: "statusCode", label: "Status code", kind: "number" },
    { key: "alarmsClear", label: "Health check passed", kind: "boolean" },
    { key: "alarmReason", label: "Node's reason", kind: "string" },
    RESPONSE_TIME,
  ],
  // Credentials are this type's only setting and the form has no section
  // for them yet; they arrive by import or by API. See the spec.
  form: [],
  supportsRecovery: true,
};

export const DEFAULT_KAFKA_PORT = 9092;

export const kafkaProducerDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "kafka-producer",
  label: "Kafka producer",
  description:
    "Publish one message to a Kafka topic and read the broker's acknowledgement.",
  target: {
    kind: "hostname",
    label: "Bootstrap broker",
    placeholder: "kafka-1.example.com",
    help: "A bare hostname — no scheme, no port. Vigil asks this broker which node leads the topic and produces to that one.",
  },
  port: { required: true, default: DEFAULT_KAFKA_PORT },
  facts: [
    { key: "brokerCount", label: "Brokers in cluster", kind: "number" },
    { key: "topicFound", label: "Topic exists", kind: "boolean" },
    { key: "partitionCount", label: "Partitions", kind: "number" },
    { key: "produced", label: "Message accepted", kind: "boolean" },
    { key: "baseOffset", label: "Written at offset", kind: "number" },
    { key: "brokerError", label: "Broker error", kind: "string" },
    RESPONSE_TIME,
  ],
  form: ["port"],
  supportsRecovery: true,
};

export const DEFAULT_MEMCACHED_PORT = 11211;

export const memcachedDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "memcached",
  label: "Memcached",
  description:
    "Ask a memcached server for its version and read the counters behind it.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "cache.example.com",
    help: "A bare hostname — no scheme, no port.",
  },
  port: { required: true, default: DEFAULT_MEMCACHED_PORT },
  facts: [
    { key: "version", label: "Server version", kind: "string" },
    { key: "uptimeSeconds", label: "Uptime", kind: "number", unit: "s" },
    { key: "currentConnections", label: "Open connections", kind: "number" },
    { key: "maxConnections", label: "Connection limit", kind: "number" },
    {
      key: "connectionUsagePercent",
      label: "Connection limit in use",
      kind: "number",
      unit: "%",
    },
    // The server's own words when it refuses. A memcached that answers
    // `ERROR` and one that never answered at all are different
    // incidents, and only one of them is a network problem.
    { key: "serverError", label: "Server error", kind: "string" },
    RESPONSE_TIME,
  ],
  form: ["port"],
  supportsRecovery: true,
};

/**
 * Elasticsearch's REST port. Not a `port` field on the descriptor: the
 * target is a URL, so the port is already in it, and a second field for
 * it would be a second answer to the same question. Kept as a constant
 * because the placeholder and the docs both quote it.
 */
export const DEFAULT_ELASTICSEARCH_PORT = 9200;

export const elasticsearchDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "elasticsearch",
  label: "Elasticsearch",
  description:
    "Read a cluster's health endpoint and judge it by the status colour.",
  target: {
    kind: "url",
    label: "Cluster URL",
    placeholder: `https://search.example.com:${DEFAULT_ELASTICSEARCH_PORT}`,
    help: `The base URL of any node in the cluster, including its port (${DEFAULT_ELASTICSEARCH_PORT} unless it sits behind a proxy). Vigil appends the cluster-health path itself.`,
  },
  port: null,
  facts: [
    { key: "statusCode", label: "Status code", kind: "number" },
    { key: "clusterStatus", label: "Cluster status", kind: "string" },
    { key: "clusterName", label: "Cluster name", kind: "string" },
    { key: "nodeCount", label: "Nodes", kind: "number" },
    { key: "unassignedShards", label: "Unassigned shards", kind: "number" },
    {
      key: "activeShardsPercent",
      label: "Active shards",
      kind: "number",
      unit: "%",
    },
    RESPONSE_TIME,
  ],
  // Credentials are this type's only setting and the form has no section
  // for them yet; they arrive by import or by API. See the spec.
  form: [],
  supportsRecovery: true,
};

export const websocketDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "websocket",
  label: "WebSocket",
  description:
    "Complete the upgrade handshake and check the server answers as a WebSocket.",
  target: {
    kind: "url",
    label: "URL",
    placeholder: "wss://example.com/socket",
    help: "The full ws:// or wss:// URL, path included. Put the port in the URL.",
  },
  // The URL already carries the port, exactly as it does for `http`. A
  // separate field would be a second answer to the same question, and
  // the two would disagree the first time someone edited one of them.
  port: null,
  facts: [
    { key: "statusCode", label: "Status code", kind: "number" },
    { key: "acceptValid", label: "Handshake key accepted", kind: "boolean" },
    { key: "subprotocol", label: "Subprotocol", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Handshake time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: [],
  supportsRecovery: true,
};

/**
 * What a plaintext gRPC server listens on by convention — there is no
 * IANA assignment, and the whole ecosystem's examples use this. A TLS
 * endpoint is normally behind 443, which the operator types.
 */
export const DEFAULT_GRPC_PORT = 50051;

export const grpcDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "grpc",
  label: "gRPC health check",
  description:
    "Call the standard gRPC health service and read the status it reports.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "api.example.com",
    help: "A bare hostname — no scheme, no port. Plaintext HTTP/2 unless the monitor is set to use TLS.",
  },
  port: { required: true, default: DEFAULT_GRPC_PORT },
  facts: [
    { key: "httpStatus", label: "HTTP status", kind: "number" },
    { key: "grpcStatus", label: "gRPC status", kind: "number" },
    { key: "grpcMessage", label: "gRPC message", kind: "string" },
    { key: "servingStatus", label: "Reported status", kind: "string" },
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

export const DEFAULT_LDAP_PORT = 389;

export const ldapDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "ldap",
  label: "LDAP directory",
  description:
    "Bind to a directory server and read the result it answers with.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "ldap.example.com",
    help: "A bare hostname — no scheme, no port. The bind is plaintext, so port 636 (LDAPS) will never answer; use 389, or 3268 for an Active Directory global catalog.",
  },
  port: { required: true, default: DEFAULT_LDAP_PORT },
  facts: [
    { key: "bindResponse", label: "Bind answered", kind: "boolean" },
    { key: "resultCode", label: "Result code", kind: "number" },
    { key: "resultMessage", label: "Result", kind: "string" },
    { key: "diagnosticMessage", label: "Server message", kind: "string" },
    { key: "responseTimeMs", label: "Bind time", kind: "number", unit: "ms" },
  ],
  form: ["port"],
  supportsRecovery: true,
};

export const DEFAULT_SSH_PORT = 22;

export const sshDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "ssh",
  label: "SSH",
  description: "Read the version banner an SSH daemon sends when it answers.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "bastion.example.com",
    help: "A bare hostname — no scheme, no port. Nothing is authenticated: Vigil reads the banner the daemon sends first and hangs up.",
  },
  port: { required: true, default: DEFAULT_SSH_PORT },
  facts: [
    { key: "identified", label: "Sent an SSH banner", kind: "boolean" },
    { key: "protocolVersion", label: "Protocol version", kind: "string" },
    { key: "softwareVersion", label: "Software version", kind: "string" },
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

export const DEFAULT_SQLSERVER_PORT = 1433;
export const DEFAULT_ORACLE_PORT = 1521;

export const sqlserverDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "sqlserver",
  label: "Microsoft SQL Server",
  description: "Sign in to a SQL Server over TDS and run a query.",
  target: {
    kind: "url",
    label: "Connection string",
    placeholder: "sqlserver://user:pass@db.example.com:1433/app",
    help: "The full connection string, credentials included. The login is spoken in plaintext TDS, so a server with Force Encryption on — and Azure SQL, which always requires it — is watched as far as its TDS greeting and no further.",
  },
  // The port is already in the connection string, exactly as for
  // postgres. A separate field would be a second answer to the same
  // question, and the two would disagree the first time one was edited.
  port: { required: false, default: null },
  facts: [
    { key: "preloginOk", label: "Answered TDS", kind: "boolean" },
    { key: "serverVersion", label: "Server version", kind: "string" },
    {
      key: "encryptionRequired",
      label: "Requires encryption",
      kind: "boolean",
    },
    { key: "loginOk", label: "Signed in", kind: "boolean" },
    { key: "queryOk", label: "Query answered", kind: "boolean" },
    { key: "serverError", label: "Server error", kind: "string" },
    { key: "responseTimeMs", label: "Query time", kind: "number", unit: "ms" },
  ],
  form: [],
  supportsRecovery: true,
};

export const oracledbDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "oracledb",
  label: "Oracle Database",
  description: "Ask an Oracle listener to accept a connection for one service.",
  target: {
    kind: "url",
    label: "Connection string",
    placeholder: "oracle://db.example.com:1521/ORCLPDB1",
    help: "Host, port and service name. No credentials: this check speaks TNS to the listener and never signs in, so a password here would be stored and never sent.",
  },
  port: { required: false, default: null },
  facts: [
    { key: "listenerAnswered", label: "Answered TNS", kind: "boolean" },
    { key: "accepted", label: "Connection accepted", kind: "boolean" },
    { key: "listenerResponse", label: "Listener said", kind: "string" },
    { key: "serviceError", label: "Listener error", kind: "string" },
    { key: "serverVersion", label: "Server version", kind: "string" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: [],
  supportsRecovery: true,
};

export const DEFAULT_IMAP_PORT = 143;

export const imapDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "imap",
  label: "IMAP",
  description:
    "Greet a mail store and check the capabilities it still advertises.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "imap.example.com",
    help: "A bare hostname — no scheme, no port. The conversation is plaintext, so port 993 (implicit TLS) will never answer; use 143.",
  },
  port: { required: true, default: DEFAULT_IMAP_PORT },
  facts: [
    { key: "greetingStatus", label: "Greeting", kind: "string" },
    {
      key: "capabilityAccepted",
      label: "CAPABILITY accepted",
      kind: "boolean",
    },
    { key: "capabilities", label: "Capabilities", kind: "list" },
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

export const DEFAULT_FTP_PORT = 21;

export const ftpDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "ftp",
  label: "FTP",
  description:
    "Greet an FTP server, read its feature list, and optionally log in.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "files.example.com",
    help: "A bare hostname — no scheme, no port. The conversation is plaintext, so port 990 (implicit FTPS) will never answer; use 21. Credentials, if you set any, travel in the clear — point them at an account that can do nothing.",
  },
  port: { required: true, default: DEFAULT_FTP_PORT },
  facts: [
    { key: "greetingCode", label: "Greeting code", kind: "number" },
    { key: "banner", label: "Banner", kind: "string" },
    { key: "featCode", label: "FEAT reply", kind: "number" },
    { key: "features", label: "Features", kind: "list" },
    { key: "loginCode", label: "Login reply", kind: "number" },
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

/** The IANA-assigned SNMP agent port. */
export const DEFAULT_SNMP_PORT = 161;

/**
 * `sysUpTime.0` — the OID every agent answers, from RFC 1213's
 * `system` group. It is the default so that a monitor created with
 * nothing but a hostname is a working monitor: an agent that answers
 * this is an agent that is running, which is what an operator who has
 * not yet decided what to poll actually wants to know.
 */
export const DEFAULT_SNMP_OID = "1.3.6.1.2.1.1.3.0";

/**
 * The SNMP versions Vigil speaks, as they are written on the wire and
 * in every agent's configuration file — "2c" rather than "2", because
 * SNMPv2c (community-based) and SNMPv2u are different protocols and an
 * operator copying a value out of `snmpd.conf` must not have to
 * translate it.
 */
export const SNMP_VERSIONS = ["1", "2c", "3"] as const;

export type SnmpVersion = (typeof SNMP_VERSIONS)[number];

export const snmpDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "snmp",
  label: "SNMP",
  description: "Ask an SNMP agent for one OID and judge what it answers.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "switch.example.com",
    help: "A bare hostname — no scheme, no port. SNMP is UDP, so nothing is connected: one request goes out and Vigil waits for one answer. Without further settings it asks for sysUpTime.0 as v2c with the community `public`.",
  },
  port: { required: true, default: DEFAULT_SNMP_PORT },
  facts: [
    { key: "oidFound", label: "OID answered", kind: "boolean" },
    { key: "value", label: "Value", kind: "string" },
    { key: "valueType", label: "Value type", kind: "string" },
    { key: "numericValue", label: "Numeric value", kind: "number" },
    { key: "errorStatus", label: "Agent error", kind: "string" },
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

/**
 * The systemd unit suffixes a monitor may name.
 *
 * Enumerated rather than accepting any suffix, and required rather than
 * defaulting to `.service` the way `systemctl start nginx` does: a
 * monitor is read by whoever is woken at 3am, and "nginx" leaves them
 * guessing whether the socket, the timer or the service is the one
 * being watched. The suffix is one keystroke and removes the question.
 */
export const SYSTEMD_UNIT_SUFFIXES = [
  "service",
  "socket",
  "target",
  "timer",
  "mount",
  "automount",
  "path",
  "slice",
  "scope",
  "device",
  "swap",
] as const;

export const systemServiceDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "system-service",
  label: "System service",
  description: "Ask the local systemd whether one of its units is active.",
  target: {
    kind: "label",
    // Not a hostname, and the help text has to say so: this is the one
    // check type whose subject is the machine Vigil itself runs on.
    // Naming a host here would be a promise that some other machine is
    // being asked, and nothing would ever dial it.
    label: "Unit name",
    placeholder: "nginx.service",
    help: "A systemd unit on the machine this worker runs on, suffix included. Nothing is dialled — the local init system is asked — so this monitor speaks for that one machine and no other.",
  },
  port: null,
  facts: [
    { key: "activeState", label: "Active state", kind: "string" },
    { key: "subState", label: "Sub state", kind: "string" },
    { key: "loadState", label: "Load state", kind: "string" },
    { key: "unitFileState", label: "Unit file state", kind: "string" },
    { key: "restarts", label: "Restarts", kind: "number" },
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
  form: [],
  // systemd, on this machine, reachable by this process. Where it is
  // absent — a container, a BSD, a distribution that runs something
  // else — the monitor reads `misconfigured` and says why, because an
  // operator error that looks like an outage is the one failure a
  // monitoring product may not have.
  requiresCapability: "systemd",
  supportsRecovery: true,
};

/**
 * The query port a Source server listens on. Usually the game port, and
 * usually 27015 — but a box running four servers gives three of them
 * something else, which is why the port is required rather than assumed.
 */
export const DEFAULT_STEAM_PORT = 27015;

export const steamDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "steam",
  label: "Steam game server",
  description:
    "Ask a Source or GoldSrc server for the A2S_INFO reply a player's client reads.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "cs.example.com",
    help: "A bare hostname — no scheme. The port is the server's query port, which is the game port on all but the most crowded boxes.",
  },
  port: { required: true, default: DEFAULT_STEAM_PORT },
  facts: [
    { key: "answered", label: "Answered A2S_INFO", kind: "boolean" },
    { key: "serverName", label: "Server name", kind: "string" },
    { key: "map", label: "Map", kind: "string" },
    { key: "game", label: "Game", kind: "string" },
    { key: "players", label: "Players", kind: "number" },
    { key: "maxPlayers", label: "Player slots", kind: "number" },
    { key: "bots", label: "Bots", kind: "number" },
    { key: "vacSecured", label: "VAC secured", kind: "boolean" },
    RESPONSE_TIME,
  ],
  form: ["port"],
  supportsRecovery: true,
};

/**
 * The query protocols the `gamedig` type speaks, and the port each one
 * conventionally answers on.
 *
 * Three families rather than a game list, and the distinction is the
 * whole honesty of this type. GameDig — the library Uptime Kuma calls —
 * ships a table of some three hundred game ids; nearly all of them
 * resolve to one of these three wire protocols, and the table's real
 * content is which port and which quirk each title uses. Vigil speaks
 * the protocols and does not have the table, so it asks the operator
 * for the protocol and the port instead of pretending to know the game.
 * See `docs/GAME-SERVERS.md` for exactly what that costs.
 *
 * Lives in the catalog, beside `DNS_RECORD_TYPES`, so the monitor form
 * can render the choice without importing zod.
 */
export const GAME_QUERY_PROTOCOL_IDS = [
  "source",
  "minecraft",
  "quake3",
] as const;

export type GameQueryProtocol = (typeof GAME_QUERY_PROTOCOL_IDS)[number];

/**
 * What each protocol is called and where it usually listens. Separate
 * from the id tuple above because `z.enum` wants the ids and nothing
 * else, and a schema built from `.map()` over this list would be a
 * `string[]` the compiler could no longer check the config against.
 */
export const GAME_QUERY_PROTOCOLS: readonly {
  id: GameQueryProtocol;
  label: string;
  defaultPort: number;
  /** Titles this family covers, for the form's help text. */
  games: string;
}[] = [
  {
    id: "source",
    label: "Source / GoldSrc (A2S)",
    defaultPort: DEFAULT_STEAM_PORT,
    games: "Counter-Strike, Team Fortress, Garry's Mod, Rust, ARK, Valheim",
  },
  {
    id: "minecraft",
    label: "Minecraft (query)",
    defaultPort: 25565,
    games: "Minecraft, with enable-query=true in server.properties",
  },
  {
    id: "quake3",
    label: "id Tech 3 (getstatus)",
    defaultPort: 27960,
    games: "Quake III, Call of Duty, Wolfenstein: Enemy Territory, OpenArena",
  },
];

export const gamedigDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "gamedig",
  label: "Game server (UDP query)",
  description:
    "Query a game server directly: Source/GoldSrc, Minecraft or id Tech 3.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "mc.example.com",
    help: "A bare hostname — no scheme. The port is the server's query port: 27015 for Source, 25565 for Minecraft, 27960 for id Tech 3.",
  },
  // No default: the right port is a property of the protocol, and one
  // guess would be wrong for two thirds of the servers this watches.
  // Required with a null default is what makes the form ask for it.
  port: { required: true, default: null },
  facts: [
    { key: "answered", label: "Answered the query", kind: "boolean" },
    { key: "serverName", label: "Server name", kind: "string" },
    { key: "map", label: "Map", kind: "string" },
    { key: "players", label: "Players", kind: "number" },
    { key: "maxPlayers", label: "Player slots", kind: "number" },
    RESPONSE_TIME,
  ],
  // The protocol is this type's only setting and the monitor form has no
  // section for it yet, so a monitor created in the UI queries Source and
  // one created by import or API queries whatever it asked for. Same
  // shape as `rabbitmq`'s credentials; both want a form section.
  form: ["port"],
  supportsRecovery: true,
};

/**
 * The three datagram types.
 *
 * UDP has no handshake, so none of them can borrow TCP's proof of life:
 * a connect that completes says a service is there, and a datagram that
 * is sent says only that the kernel accepted it. The evidence has to be
 * a *reply*, which is why all three send a payload the far end is
 * obliged to answer and why silence is reported as "no reply" rather
 * than as a connection failure — nothing was ever connected.
 */

/** RFC 5905. */
export const DEFAULT_NTP_PORT = 123;
/**
 * RFC 2865's authentication port. 1645 is the pre-standard one many
 * vendors still listen on, which is why the port field is offered even
 * though this default is right for most estates.
 */
export const DEFAULT_RADIUS_PORT = 1812;

export const udpDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "udp",
  label: "UDP port",
  description: "Send a datagram to a UDP port and wait for a reply.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "dns.example.com",
    help: "A bare hostname — no scheme, no port. UDP answers nothing it was not asked, so the check needs a payload the service will reply to.",
  },
  // No default, and required: there is no such thing as "the" UDP port.
  // A default here would be a guess dressed as a setting.
  port: { required: true, default: null },
  facts: [
    { key: "replyBytes", label: "Reply size", kind: "number", unit: "bytes" },
    { key: "replyPreview", label: "Reply", kind: "string" },
    { key: "responseMatches", label: "Reply matched", kind: "boolean" },
    RESPONSE_TIME,
  ],
  // The payload and the expected reply are this type's own config. The
  // monitor form renders no section for them yet, so a monitor created
  // in the UI sends an empty datagram and one created by import or API
  // sends what it asked for.
  form: ["port"],
  supportsRecovery: true,
};

export const ntpDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "ntp",
  label: "NTP server",
  description: "Ask a time server for the time and compare it with Vigil's.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "time.example.com",
    help: "A bare hostname — no scheme, no port. One server, not a pool name: a pool answers from a different machine every check, so a bad member hides in the average.",
  },
  port: { required: false, default: DEFAULT_NTP_PORT },
  facts: [
    { key: "stratum", label: "Stratum", kind: "number" },
    { key: "leapIndicator", label: "Leap indicator", kind: "number" },
    { key: "offsetMs", label: "Clock offset", kind: "number", unit: "ms" },
    { key: "delayMs", label: "Round-trip delay", kind: "number", unit: "ms" },
    { key: "referenceId", label: "Reference", kind: "string" },
    RESPONSE_TIME,
  ],
  form: ["port"],
  supportsRecovery: true,
};

export const radiusDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "radius",
  label: "RADIUS",
  description: "Send an Access-Request and read the answer it is signed with.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "radius.example.com",
    help: "A bare hostname — no scheme, no port. The shared secret and the test account are settings, not part of the address.",
  },
  port: { required: false, default: DEFAULT_RADIUS_PORT },
  facts: [
    { key: "replyCode", label: "Reply code", kind: "number" },
    { key: "replyType", label: "Reply", kind: "string" },
    {
      key: "authenticatorValid",
      label: "Reply signed with our secret",
      kind: "boolean",
    },
    RESPONSE_TIME,
  ],
  // The shared secret and the test account are this type's own config.
  // The monitor form renders no section for them yet, so a monitor
  // created in the UI reports `misconfigured` until one is supplied by
  // import or API — which is the correct answer, and never `down`.
  form: ["port"],
  supportsRecovery: true,
};

/**
 * SIP's registered port, for both UDP and TCP (RFC 3261 §19.1.2). TLS
 * runs on 5061 and is a different transport this type does not speak.
 */
export const DEFAULT_SIP_PORT = 5060;

/** The transports the `sip` type can put an OPTIONS request on. */
export const SIP_TRANSPORTS = ["udp", "tcp"] as const;

export type SipTransport = (typeof SIP_TRANSPORTS)[number];

export const sipDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "sip",
  label: "SIP (OPTIONS)",
  description:
    "Send a SIP OPTIONS request and read the status line that answers it.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "sip.example.com",
    help: "A bare hostname — no scheme, no port. The proxy, registrar or gateway that answers OPTIONS. UDP unless the monitor says otherwise; TLS on 5061 is a transport this check does not speak.",
  },
  port: { required: true, default: DEFAULT_SIP_PORT },
  facts: [
    // `answered` before `statusCode` on purpose: something that replies
    // on 5060 without speaking SIP is a different incident from a
    // registrar that answers 503, and the timeline has to tell them
    // apart even though both read as down.
    { key: "answered", label: "Answered SIP", kind: "boolean" },
    { key: "statusCode", label: "SIP status", kind: "number" },
    { key: "statusText", label: "Reason phrase", kind: "string" },
    { key: "server", label: "Server", kind: "string" },
    // How many requests it took to get an answer. Over UDP this is the
    // retransmission count, which is the only visible evidence of packet
    // loss on a link that is otherwise answering.
    { key: "requestsSent", label: "Requests sent", kind: "number" },
    RESPONSE_TIME,
  ],
  // `expectedStatusCode` is a flat column and a form section that
  // already exists, and a SIP status code is a three-digit code with the
  // same classes as HTTP's. Reusing it means an operator whose gateway
  // answers 405 to OPTIONS can say so in the UI, rather than needing an
  // API call to set a type-specific field.
  form: ["port", "expectedStatusCode"],
  supportsRecovery: true,
};

export const tailscalePingDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "tailscale-ping",
  label: "Tailscale ping",
  description: "Ping a peer inside your tailnet through the Tailscale CLI.",
  target: {
    kind: "label",
    // A label rather than a hostname, and the distinction is real: a
    // MagicDNS name (`db`, `db.tailnet-name.ts.net`) and a 100.x address
    // are resolved by tailscaled, not by DNS, and `monitorHostnameSchema`
    // would refuse the single-label form every tailnet actually uses.
    // The type validates the peer name itself — see
    // `specs/tailscale-ping.ts` — so this is not a weaker check, only a
    // different one.
    label: "Peer",
    placeholder: "db-1",
    help: "A MagicDNS name (`db-1`, `db-1.tailnet-name.ts.net`) or a 100.x tailnet address. Vigil asks the local tailscaled, so the peer never has to be reachable from anywhere else.",
  },
  port: null,
  facts: [
    { key: "outcome", label: "Result", kind: "string" },
    { key: "peer", label: "Peer", kind: "string" },
    { key: "peerAddress", label: "Tailnet address", kind: "string" },
    { key: "via", label: "Path", kind: "string" },
    { key: "direct", label: "Direct connection", kind: "boolean" },
    { key: "responseTimeMs", label: "Round trip", kind: "number", unit: "ms" },
  ],
  form: [],
  // The `tailscale` CLI, and a tailscaled that is logged into a tailnet.
  // Absent — which is every default install — the monitor reads
  // `misconfigured` and says what is missing, never `down`.
  requiresCapability: "tailscale",
  supportsRecovery: true,
};

export const realBrowserDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "real-browser",
  label: "Real browser",
  description:
    "Render a page in a headless browser and assert on what it actually shows.",
  target: {
    kind: "url",
    label: "URL",
    placeholder: "https://example.com/app",
    help: "The page to open. It is fetched by a browser, so a single-page app that renders its content in JavaScript is checked as a visitor sees it — not as curl sees it.",
  },
  port: null,
  facts: [
    { key: "rendered", label: "Rendered a document", kind: "boolean" },
    { key: "contentBytes", label: "Document size", kind: "number", unit: "B" },
    { key: "keywordPresent", label: "Keyword found", kind: "boolean" },
    RESPONSE_TIME,
  ],
  // The keyword is the whole point of rendering: the assertion runs on
  // the DOM after scripts have run, which is the difference between this
  // type and `http`. It is a flat column and an existing form section,
  // so an operator can set it without a type-specific field.
  form: ["keyword"],
  // A browser. Vigil does not ship one — Chromium is a hundred and fifty
  // megabytes and a pile of system libraries — so this type talks to a
  // rendering service over HTTP and reports `misconfigured` when none is
  // configured or reachable.
  requiresCapability: "headless-browser",
  supportsRecovery: true,
};

export const globalpingDescriptor: CheckTypeDescriptor<"active"> = {
  kind: "active",
  id: "globalping",
  label: "Globalping (worldwide)",
  description:
    "Ping the target from probes around the world through the Globalping API.",
  target: {
    kind: "hostname",
    label: "Hostname",
    placeholder: "example.com",
    help: "A bare hostname — no scheme, no port. Nothing is dialled from this machine: the measurement is run by Globalping's probe network, so what it reports is what the internet sees rather than what your network sees.",
  },
  port: null,
  facts: [
    { key: "probesTotal", label: "Probes", kind: "number" },
    {
      key: "probesReachable",
      label: "Probes that got a reply",
      kind: "number",
    },
    { key: "packetLossPct", label: "Packet loss", kind: "number", unit: "%" },
    { key: "worstProbe", label: "Worst probe", kind: "string" },
    { key: "resolvedAddress", label: "Resolved to", kind: "string" },
    // The mean round trip the probes measured — not Vigil's own wall
    // clock, which measures the API and says nothing about the target.
    { key: "responseTimeMs", label: "Round trip", kind: "number", unit: "ms" },
    // Vigil's own wall clock, kept as a separate fact rather than
    // discarded: it is how an operator sees that a check is expensive
    // (and why raising the monitor's timeout is the fix) without it ever
    // being mistaken for the target's latency.
    { key: "apiTimeMs", label: "Measurement took", kind: "number", unit: "ms" },
  ],
  // Where the measurement runs from, how many probes and the API token
  // are this type's own config; the monitor form renders no section for
  // them yet, so a monitor created in the UI measures from `world` with
  // three probes and one created by import or API measures what it asked
  // for.
  form: [],
  requiresCapability: "globalping-api",
  // Deliberately not recoverable. A recovery verification re-probes, and
  // one re-probe here spends three of an hourly quota that is shared by
  // every monitor on this install — a fix that has to be verified from
  // Tokyo is not worth exhausting the budget the scheduled checks run on.
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
  postgresDescriptor,
  mysqlDescriptor,
  mongodbDescriptor,
  redisDescriptor,
  dockerDescriptor,
  mqttDescriptor,
  smtpDescriptor,
  jsonQueryDescriptor,
  pushDescriptor,
  groupDescriptor,
  manualDescriptor,
  sqlserverDescriptor,
  oracledbDescriptor,
  memcachedDescriptor,
  elasticsearchDescriptor,
  rabbitmqDescriptor,
  kafkaProducerDescriptor,
  udpDescriptor,
  ntpDescriptor,
  radiusDescriptor,
  imapDescriptor,
  ftpDescriptor,
  ldapDescriptor,
  sshDescriptor,
  websocketDescriptor,
  grpcDescriptor,
  gamedigDescriptor,
  steamDescriptor,
  snmpDescriptor,
  systemServiceDescriptor,
  sipDescriptor,
  tailscalePingDescriptor,
  realBrowserDescriptor,
  globalpingDescriptor,
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

/**
 * The kind of a stored monitor's type — `active` for one this build
 * does not know, for the reason `unknownDescriptor` gives.
 */
export function checkTypeKind(id: string): CheckTypeKind {
  return describeCheckType(id).kind;
}

/**
 * Type ids the scheduler must never enqueue.
 *
 * Derived from the catalog rather than written out, so a later
 * aggregate or manual type is excluded by declaring its kind and not by
 * remembering this list exists. Callers put it straight into SQL: the
 * predicate is stated as "not one of these" rather than "one of the
 * scheduled ones", because a monitor whose type this build lost must
 * keep being evaluated (and keep saying so) rather than silently
 * dropping off the scheduler.
 */
export const UNSCHEDULED_CHECK_TYPE_IDS: readonly string[] =
  CHECK_TYPE_DESCRIPTORS.filter(
    (descriptor) => !isScheduledKind(descriptor.kind),
  ).map((descriptor) => descriptor.id);

/** Type ids that derive their state from other monitors. */
export const AGGREGATE_CHECK_TYPE_IDS: readonly string[] =
  CHECK_TYPE_DESCRIPTORS.filter(
    (descriptor) => descriptor.kind === "aggregate",
  ).map((descriptor) => descriptor.id);

/**
 * Type ids whose observations do not expire.
 *
 * Every other kind produces evidence that goes stale: a probe result
 * stands for a few intervals and then Vigil admits it no longer knows.
 * An operator's statement is not like that — nothing is going to
 * contradict it except another operator, so expiring it would report
 * "no data" for a monitor that is doing exactly what it was asked to
 * do. See `uptime.ts`, which reads this.
 */
export const STANDING_OBSERVATION_CHECK_TYPE_IDS: readonly string[] =
  CHECK_TYPE_DESCRIPTORS.filter(
    (descriptor) => descriptor.kind === "manual",
  ).map((descriptor) => descriptor.id);
