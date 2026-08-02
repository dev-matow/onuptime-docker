/**
 * The mapping matrix: what Uptime Kuma stores, and what becomes of it.
 *
 * Two tables, and they are the point of this module. An importer can be
 * written without them — read a row, write a row, ship — and what you
 * get is a migration whose losses are discovered one at a time, months
 * later, by the operator who trusted it. The matrices make the loss a
 * declared, testable property instead: every one of Kuma's 31 monitor
 * types and every one of its 111 `monitor` columns has a line here, and
 * a test proves the tables cover exactly what the pinned fixture
 * contains. A column Kuma adds in 2.5.0 fails that test; so does a
 * column this file forgets.
 *
 * The field matrix carries the storage kind as well as the semantics,
 * so `read.ts` derives its row type and its coercions from the same
 * table. One list, not two — a reader and a matrix that disagree about
 * which columns exist is the failure this whole arrangement is for.
 *
 * `unsupported` is written with a reason that names the Vigil
 * limitation, not a shrug. "Not supported" tells an operator nothing;
 * "Vigil's SMTP probe never issues STARTTLS" tells them whether the
 * monitor they are migrating still means what they think it means.
 */

/** How a column is stored in SQLite, and therefore how it is read. */
export type ColumnKind = "int" | "int?" | "text" | "text?" | "bool" | "real";

export type FieldClassification =
  /** Carried across unchanged, to the named Vigil column or config key. */
  | "mapped"
  /** Carried across with its meaning restated; `note` is the rule. */
  | "transformed"
  /** Vigil cannot express it; `note` says why. */
  | "unsupported"
  /** Kuma bookkeeping with no Vigil counterpart to lose. */
  | "not-applicable";

export interface FieldMapping {
  readonly column: string;
  readonly kind: ColumnKind;
  readonly classification: FieldClassification;
  /** Vigil column or config key. Null unless mapped or transformed. */
  readonly target: string | null;
  /** The rule, or the reason. Never empty — that is asserted. */
  readonly note: string;
}

export const FIELD_MATRIX = [
  {
    column: "id",
    kind: "int",
    classification: "not-applicable",
    target: null,
    note: "Kuma's own row identity. A Vigil monitor gets a uuidv7 and is referenced by nothing in Kuma.",
  },
  {
    column: "name",
    kind: "text?",
    classification: "mapped",
    target: "monitors.name",
    note: "A monitor with no name imports as `Kuma monitor <id>`, because Vigil's name is not nullable.",
  },
  {
    column: "active",
    kind: "bool",
    classification: "transformed",
    target: "monitors.paused",
    note: "Inverted: Kuma stores running, Vigil stores paused. Applied through setMonitorPaused so the resumed-monitor clean slate holds.",
  },
  {
    column: "user_id",
    kind: "int?",
    classification: "not-applicable",
    target: null,
    note: "Kuma is single-tenant; the imported monitor belongs to the organization the import was run in.",
  },
  {
    column: "interval",
    kind: "int",
    classification: "transformed",
    target: "monitors.interval_seconds",
    note: "Clamped to Vigil's 2-86400s. Vigil treats it as a baseline the adaptive scheduler tightens and relaxes around, not a fixed cadence.",
  },
  {
    column: "url",
    kind: "text?",
    classification: "transformed",
    target: "monitors.url",
    note: "The target only for the types whose Vigil equivalent takes a URL, http, keyword, json-query, real-browser and websocket-upgrade, plus globalping, whose hostname is lifted out of it. Kuma writes a filler `https://example.com` here for host-based types, which read `hostname` instead.",
  },
  {
    column: "type",
    kind: "text?",
    classification: "transformed",
    target: "monitors.check_type",
    note: "Resolved through the type matrix in this file.",
  },
  {
    column: "weight",
    kind: "int?",
    classification: "unsupported",
    target: null,
    note: "Kuma's dashboard sort order. Vigil orders monitors by creation time and has no per-monitor weight.",
  },
  {
    column: "hostname",
    kind: "text?",
    classification: "mapped",
    target: "monitors.url",
    note: "The target for every type whose Vigil equivalent takes a bare hostname or a tailnet peer. Not read by the types that keep their address somewhere else. A gRPC monitor's is in `grpc_url`, a Kafka monitor's in the broker list, a RabbitMQ monitor's in the node list, a system-service monitor's is a unit name and not an address at all.",
  },
  {
    column: "port",
    kind: "int?",
    classification: "mapped",
    target: "monitors.port",
    note: "Falls back to the Vigil type's default port when Kuma stored none.",
  },
  {
    column: "created_date",
    kind: "text",
    classification: "not-applicable",
    target: null,
    note: "The imported monitor is created now; back-dating it would make `created_at` disagree with the audit row that records the import.",
  },
  {
    column: "keyword",
    kind: "text?",
    classification: "mapped",
    target: "monitors.body_keyword",
    note: "Read for the `keyword` type, whose Vigil equivalent is an HTTP monitor with a body assertion. Kuma also stores a keyword on its gRPC and Globalping monitors, where Vigil's equivalents assert on a reported serving status and on packet loss rather than on a body, so it is reported and dropped there. On every other type Kuma simply leaves stale values here.",
  },
  {
    column: "maxretries",
    kind: "int",
    classification: "transformed",
    target: "monitors.failure_window_seconds",
    note: "With retry_interval: Kuma goes down after `maxretries` retries spaced `retry_interval` apart, so the equivalent Vigil window is their product. Zero retries means down on the first failure, which is a window of 0.",
  },
  {
    column: "ignore_tls",
    kind: "bool",
    classification: "unsupported",
    target: null,
    note: "Vigil's HTTP probe always verifies the certificate chain and offers no per-monitor opt-out.",
  },
  {
    column: "upside_down",
    kind: "bool",
    classification: "unsupported",
    target: null,
    note: "Vigil has no verdict inversion. A type's assertions are declared by the type and none of them can be negated per monitor.",
  },
  {
    column: "maxredirects",
    kind: "int",
    classification: "unsupported",
    target: null,
    note: "Vigil's HTTP probe uses fetch's own redirect policy and exposes no hop limit.",
  },
  {
    column: "accepted_statuscodes_json",
    kind: "text",
    classification: "transformed",
    target: "monitors.expected_status_code",
    note: 'A JSON array of codes and ranges. Vigil holds one exact code or none, so `["200-299"]` becomes none (Vigil accepts 2xx/3xx) and a lone exact code is carried. Anything richer cannot be expressed and is reported per monitor.',
  },
  {
    column: "dns_resolve_type",
    kind: "text?",
    classification: "transformed",
    target: "config.recordType",
    note: "Vigil resolves A, AAAA, CNAME, MX, NS and TXT. A Kuma monitor asking for any other record type is refused rather than silently downgraded to A.",
  },
  {
    column: "dns_resolve_server",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's DNS probe queries the worker's configured nameserver; there is no per-monitor resolver.",
  },
  {
    column: "dns_last_result",
    kind: "text?",
    classification: "not-applicable",
    target: null,
    note: "Kuma's cache of the previous answer, not a setting.",
  },
  {
    column: "retry_interval",
    kind: "int",
    classification: "transformed",
    target: "monitors.failure_window_seconds",
    note: "The spacing between Kuma's retries. Multiplied by maxretries it becomes the one Vigil number that means the same thing: how long a monitor may fail before an incident opens.",
  },
  {
    column: "push_token",
    kind: "text?",
    classification: "transformed",
    target: "config.token",
    note: "The token a job authenticates with at /api/push/<token>, on both sides. It is carried when it satisfies Vigil's 32-128 character rule and no monitor anywhere already holds it (the uniqueness is a database constraint, because that path resolves a caller to one monitor) and a fresh token is generated and reported otherwise.",
  },
  {
    column: "method",
    kind: "text",
    classification: "transformed",
    target: "monitors.method",
    note: "Vigil sends GET or HEAD. A monitor using any other verb is refused: a GET against an endpoint that expects POST is a different check, and importing it would manufacture an outage.",
  },
  {
    column: "body",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's HTTP probe sends no request body.",
  },
  {
    column: "headers",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil sends no per-monitor request headers.",
  },
  {
    column: "basic_auth_user",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's HTTP probe sends no Authorization header, and undici's fetch refuses a URL carrying userinfo, so there is nowhere for the credential to go.",
  },
  {
    column: "basic_auth_pass",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil sends no Authorization header and undici's fetch refuses a URL carrying userinfo, so the password has nowhere to go either.",
  },
  {
    column: "docker_host",
    kind: "int?",
    classification: "transformed",
    target: "config.socketPath",
    note: "A foreign key into `docker_host`. Vigil has no host registry, so the daemon address is copied onto each Docker monitor.",
  },
  {
    column: "docker_container",
    kind: "text?",
    classification: "mapped",
    target: "config.containerName",
    note: "The container name or id the daemon is asked about.",
  },
  {
    column: "proxy_id",
    kind: "int?",
    classification: "unsupported",
    target: null,
    note: "Vigil probes targets directly; there is no outbound proxy setting.",
  },
  {
    column: "expiry_notification",
    kind: "bool",
    classification: "mapped",
    target: "monitors.tls_check",
    note: "Kuma's certificate-expiry warning is Vigil's tlsCheck. Only the HTTP type declares that section, so it is carried for HTTP monitors and reported for the rest.",
  },
  {
    column: "mqtt_topic",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's MQTT check reads the CONNACK the broker answers with; it never subscribes, so there is no topic to watch.",
  },
  {
    column: "mqtt_success_message",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "See mqtt_topic. Vigil judges the connection, not a payload.",
  },
  {
    column: "mqtt_username",
    kind: "text?",
    classification: "mapped",
    target: "config.username",
    note: "Sent in the CONNECT packet.",
  },
  {
    column: "mqtt_password",
    kind: "text?",
    classification: "mapped",
    target: "config.password",
    note: "A secret: declared in the MQTT spec's secretFields, so it is masked by redactConfig on every path out of the database, the import report included.",
  },
  {
    column: "database_connection_string",
    kind: "text?",
    classification: "transformed",
    target: "monitors.url",
    note: "Kept whole for PostgreSQL, whose Vigil target is a connection string. For MySQL, MongoDB and Redis it is split: host and port become the target, and only Redis has anywhere to keep the password. SQL Server's ADO-style string is rewritten as the `sqlserver://` URL Vigil takes, credentials included; Oracle's Easy Connect string becomes an `oracle://` URL with the credentials removed, because that check never signs in.",
  },
  {
    column: "database_query",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's PostgreSQL and SQL Server probes run a fixed `SELECT 1`; MySQL and MongoDB read the handshake and Oracle asks the listener, so those run nothing at all. A custom query has no place to execute.",
  },
  {
    column: "auth_method",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil carries no HTTP authentication at all: it sends no Authorization header, and a credential in the URL is refused by fetch.",
  },
  {
    column: "auth_domain",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "NTLM domain. Vigil speaks no NTLM.",
  },
  {
    column: "auth_workstation",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "NTLM workstation. Vigil speaks no NTLM.",
  },
  {
    column: "grpc_url",
    kind: "text?",
    classification: "transformed",
    target: "monitors.url",
    note: "Kuma stores `host:port` in one string. Vigil's gRPC check takes a bare hostname and a port column, so it is split; a value with no port falls back to 50051.",
  },
  {
    column: "grpc_protobuf",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "The schema Kuma compiles to call a custom method. Vigil calls the standard health service, whose schema is fixed and built in, so there is nothing here to compile.",
  },
  {
    column: "grpc_body",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "The request Kuma sends to its custom method. Vigil sends the health service's own request, which carries a service name and nothing else.",
  },
  {
    column: "grpc_metadata",
    kind: "text?",
    classification: "transformed",
    target: "config.authorization",
    note: "Free-form `key: value` lines. Vigil's gRPC check carries one header (`authorization`, declared as a secret) so that line is lifted out and every other one is reported per monitor.",
  },
  {
    column: "grpc_method",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's gRPC check calls grpc.health.v1.Health/Check and no other method, so the method an operator named in Kuma has nowhere to be called.",
  },
  {
    column: "grpc_service_name",
    kind: "text?",
    classification: "transformed",
    target: "config.service",
    note: "The fully-qualified service Kuma addressed. Vigil asks the health service about that same name, which is what the gRPC health protocol's `service` field means, a name the server does not know comes back NOT_SERVING rather than silently passing.",
  },
  {
    column: "grpc_enable_tls",
    kind: "bool",
    classification: "mapped",
    target: "config.tls",
    note: "Whether the HTTP/2 connection is wrapped in TLS. The same switch on both sides.",
  },
  {
    column: "radius_username",
    kind: "text?",
    classification: "transformed",
    target: "config.username",
    note: "The test account whose Access-Request the RADIUS check sends. Kuma reuses the column for the OracleDB login, which Vigil's Oracle check never sends (it asks the listener and does not sign in) so on an Oracle monitor it is reported and dropped instead.",
  },
  {
    column: "radius_password",
    kind: "text?",
    classification: "transformed",
    target: "config.password",
    note: "Three settings share this column and each lands somewhere different: the RADIUS test account's password becomes `config.password`, the SNMP community string becomes `config.community` on a v1 or v2c monitor, and the OracleDB password is reported and dropped because Vigil's Oracle check never signs in. On an SNMP v3 monitor it is dropped too. Kuma stores no column saying which protocol the pass phrase is for, and Vigil requires the protocol beside it.",
  },
  {
    column: "radius_calling_station_id",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's Access-Request carries a NAS-Identifier and no station attributes, so there is no Calling-Station-Id on the packet to put this in.",
  },
  {
    column: "radius_called_station_id",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's Access-Request carries a NAS-Identifier and no station attributes, so there is no Called-Station-Id on the packet to put this in.",
  },
  {
    column: "radius_secret",
    kind: "text?",
    classification: "mapped",
    target: "config.secret",
    note: "The shared secret the server signs its reply with. Declared in the RADIUS spec's secretFields, so it is masked by redactConfig on every path out of the database, the import report included.",
  },
  {
    column: "resend_interval",
    kind: "int",
    classification: "unsupported",
    target: null,
    note: "Kuma re-notifies on a per-monitor timer. Vigil re-notifies through an escalation policy, which is a property of the policy rather than of the monitor.",
  },
  {
    column: "packet_size",
    kind: "int",
    classification: "unsupported",
    target: null,
    note: "Vigil's ping probe sends the system default payload and exposes no size.",
  },
  {
    column: "game",
    kind: "text?",
    classification: "transformed",
    target: "config.protocol",
    note: "A GameDig game id. Vigil speaks three query protocols rather than GameDig's hundreds, so the id is resolved to the family that answers it (Source/GoldSrc, Minecraft or id Tech 3) and a game Vigil cannot place is refused rather than queried with the wrong protocol.",
  },
  {
    column: "http_body_encoding",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil sends no request body, so there is nothing to encode.",
  },
  {
    column: "description",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's monitors table has no description column.",
  },
  {
    column: "tls_ca",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil verifies against the host trust store; there is no per-monitor CA.",
  },
  {
    column: "tls_cert",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil presents no client certificate.",
  },
  {
    column: "tls_key",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil presents no client certificate.",
  },
  {
    column: "parent",
    kind: "int?",
    classification: "transformed",
    target: "monitors.parent_id",
    note: "The group this monitor belongs to. Groups are imported before their members so the membership can be set on the way in; where the group itself was refused, the child imports without one and its report line names the group it lost.",
  },
  {
    column: "invert_keyword",
    kind: "bool",
    classification: "mapped",
    target: "monitors.keyword_absent",
    note: "Same meaning on both sides: the body must not contain the keyword.",
  },
  {
    column: "json_path",
    kind: "text?",
    classification: "transformed",
    target: "config.jsonPath",
    note: "Kuma stores JSONPath. Vigil's JSON query takes a dotted path with array indices and nothing else, so a leading `$.` is stripped and anything using wildcards, descent or filters is refused.",
  },
  {
    column: "expected_value",
    kind: "text?",
    classification: "mapped",
    target: "config.expectedValue",
    note: "Compared as a string on both sides.",
  },
  {
    column: "kafka_producer_topic",
    kind: "text?",
    classification: "mapped",
    target: "config.topic",
    note: "The topic the check publishes one message to, on both sides.",
  },
  {
    column: "kafka_producer_brokers",
    kind: "text?",
    classification: "transformed",
    target: "monitors.url",
    note: "A JSON array of `host:port`. Vigil takes one bootstrap broker and asks it which node leads the topic, so the first entry becomes the target and port and the rest are named in the monitor's report line.",
  },
  {
    column: "kafka_producer_sasl_options",
    kind: "text?",
    classification: "transformed",
    target: "config.password",
    note: "A JSON blob holding the SASL mechanism and its credentials. Vigil speaks PLAIN and nothing else, so a `plain` mechanism's user name and password carry and any other (SCRAM, GSSAPI, OAUTHBEARER) refuses the monitor: importing it would produce a check that cannot ever authenticate and would report an outage that is not one.",
  },
  {
    column: "kafka_producer_message",
    kind: "text?",
    classification: "mapped",
    target: "config.message",
    note: "The record's value. Carried, because a team whose consumers validate a schema chose that string on purpose.",
  },
  {
    column: "oauth_client_id",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's HTTP probe performs no OAuth client-credentials exchange.",
  },
  {
    column: "oauth_client_secret",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Part of Kuma's OAuth client-credentials exchange, which Vigil's HTTP probe does not perform.",
  },
  {
    column: "oauth_token_url",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Part of Kuma's OAuth client-credentials exchange, which Vigil's HTTP probe does not perform.",
  },
  {
    column: "oauth_scopes",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Part of Kuma's OAuth client-credentials exchange, which Vigil's HTTP probe does not perform.",
  },
  {
    column: "oauth_auth_method",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Part of Kuma's OAuth client-credentials exchange, which Vigil's HTTP probe does not perform.",
  },
  {
    column: "timeout",
    kind: "real",
    classification: "transformed",
    target: "monitors.timeout_ms",
    note: "Seconds to milliseconds, clamped to Vigil's 1000-30000ms. Zero means Kuma never stored one, and Vigil's own default applies.",
  },
  {
    column: "gamedig_given_port_only",
    kind: "bool",
    classification: "unsupported",
    target: null,
    note: "Off, Kuma also tries the ports beside the one it was given. Vigil queries the port on the monitor and nothing else, a probe that finds a different server on a neighbouring port would report the wrong one healthy.",
  },
  {
    column: "kafka_producer_ssl",
    kind: "bool",
    classification: "mapped",
    target: "config.tls",
    note: "Whether the connection is wrapped in TLS, an SSL or SASL_SSL listener. The same switch on both sides, and the one that decides whether a SASL/PLAIN password travels in the clear.",
  },
  {
    column: "kafka_producer_allow_auto_topic_creation",
    kind: "bool",
    classification: "unsupported",
    target: null,
    note: "Vigil produces to a topic that already exists and never asks a broker to create one. A monitoring tool that can conjure topics on a production cluster is a monitoring tool that can cause the incident.",
  },
  {
    column: "mqtt_check_type",
    kind: "text",
    classification: "unsupported",
    target: null,
    note: "Chooses between keyword and JSON-query matching on a received message. Vigil judges the CONNACK and never receives one.",
  },
  {
    column: "remote_browser",
    kind: "int?",
    classification: "transformed",
    target: "config.serviceUrl",
    note: "A foreign key into `remote_browser`. Vigil has no renderer registry, so the service URL is copied onto each monitor that named one; a monitor that named none falls back to the install's BROWSER_SERVICE_URL.",
  },
  {
    column: "snmp_oid",
    kind: "text?",
    classification: "mapped",
    target: "config.oid",
    note: "The numeric OID the agent is asked for. Names from a MIB are not resolved on either side.",
  },
  {
    column: "snmp_version",
    kind: "text?",
    classification: "mapped",
    target: "config.version",
    note: "`1`, `2c` or `3`, written the way both products and every agent's configuration file write it.",
  },
  {
    column: "json_path_operator",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's JSON query asserts equality and nothing else. The value is not carried; it decides whether the monitor imports at all, because importing `>` as `==` would change what the check means.",
  },
  {
    column: "cache_bust",
    kind: "bool",
    classification: "unsupported",
    target: null,
    note: "Vigil appends no cache-busting query parameter.",
  },
  {
    column: "conditions",
    kind: "text",
    classification: "transformed",
    target: "config.expectedValue",
    note: 'A nested expression tree. Two shapes map: a single `record contains "x"` on a DNS monitor and a single `oid == "x"` on an SNMP one, each of which is what that type\'s expectedValue already means. Every other tree (an `or` group, a `>` on a numeric variable, more than one expression). Is counted and reported per monitor rather than approximated, because a condition that half-carries is an alert that fires on something else.',
  },
  {
    column: "rabbitmq_nodes",
    kind: "text?",
    classification: "transformed",
    target: "monitors.url",
    note: "A JSON array of management API URLs. A Vigil monitor watches one node, so the first becomes the target and the rest are named in the monitor's report line, create a monitor per node to watch them all.",
  },
  {
    column: "rabbitmq_username",
    kind: "text?",
    classification: "mapped",
    target: "config.username",
    note: "The management API login, sent as basic auth on both sides.",
  },
  {
    column: "rabbitmq_password",
    kind: "text?",
    classification: "mapped",
    target: "config.password",
    note: "A secret: declared in the RabbitMQ spec's secretFields, so it is masked by redactConfig on every path out of the database, the import report included.",
  },
  {
    column: "smtp_security",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's SMTP probe is plaintext throughout and never issues STARTTLS, so what it observes is the mail server answering rather than TLS being healthy. A tls-expiry monitor on the same host answers the other question.",
  },
  {
    column: "ws_ignore_sec_websocket_accept_header",
    kind: "bool",
    classification: "unsupported",
    target: null,
    note: "Vigil always verifies that the server's Sec-WebSocket-Accept matches the key it sent, and offers no opt-out: a 101 with the wrong digest is something that is not a WebSocket server answering, which is the failure this check exists to catch.",
  },
  {
    column: "ws_subprotocol",
    kind: "text",
    classification: "mapped",
    target: "config.subprotocol",
    note: "The subprotocol offered in the handshake and asserted on in the answer. The same setting on both sides.",
  },
  {
    column: "ping_count",
    kind: "int",
    classification: "transformed",
    target: "config.packets",
    note: "Clamped to Vigil's 1-5 echo requests per check.",
  },
  {
    column: "ping_numeric",
    kind: "bool",
    classification: "unsupported",
    target: null,
    note: "Vigil's ping probe always passes `-n`, so reverse lookups are off whatever Kuma stored.",
  },
  {
    column: "ping_per_request_timeout",
    kind: "int",
    classification: "unsupported",
    target: null,
    note: "Vigil times the whole check rather than each echo.",
  },
  {
    column: "ip_family",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil resolves according to the host's own address preference and offers no per-monitor family.",
  },
  {
    column: "manual_status",
    kind: "int?",
    classification: "transformed",
    target: "config.status",
    note: "Kuma's numeric status. 1 is up and 0 is down; pending and maintenance arrive as degraded, because up, degraded and down are the three states a person can assert in Vigil, and dropping the monitor to `up` would publish a claim nobody made.",
  },
  {
    column: "oauth_audience",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Part of Kuma's OAuth client-credentials exchange, which Vigil's HTTP probe does not perform.",
  },
  {
    column: "mqtt_websocket_path",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's MQTT probe speaks the TCP protocol directly, not MQTT over WebSocket.",
  },
  {
    column: "domain_expiry_notification",
    kind: "bool",
    classification: "unsupported",
    target: null,
    note: "Vigil watches a registration with its own `domain-expiry` check type rather than as a flag on an HTTP monitor. The importer will not invent a second monitor to carry it, so the flag is reported instead.",
  },
  {
    column: "save_response",
    kind: "bool",
    classification: "unsupported",
    target: null,
    note: "Vigil records facts and never stores a response body, so there is nothing to turn on.",
  },
  {
    column: "save_error_response",
    kind: "bool",
    classification: "unsupported",
    target: null,
    note: "Vigil records facts and never stores a response body, so there is nothing here to bound or to switch on.",
  },
  {
    column: "response_max_length",
    kind: "int",
    classification: "unsupported",
    target: null,
    note: "Vigil records facts and never stores a response body, so there is nothing here to bound or to switch on.",
  },
  {
    column: "system_service_name",
    kind: "text?",
    classification: "transformed",
    target: "monitors.url",
    note: "The unit name is the target of Vigil's system-service check rather than a setting on it. Nothing is dialled, so the field that would hold an address holds the unit. A name without a systemd suffix is refused, because `nginx` leaves whoever is woken at 3am guessing which unit was meant.",
  },
  {
    column: "subtype",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "The Globalping measurement kind. Vigil runs one (a ping) so an HTTP, DNS, traceroute or MTR measurement arrives as a ping of the same host, and the monitor's report line says which measurement it used to be.",
  },
  {
    column: "location",
    kind: "text?",
    classification: "mapped",
    target: "config.location",
    note: "Where the Globalping probes measure from, a country, a continent, a network. The same magic string Globalping's own API takes, on both sides.",
  },
  {
    column: "protocol",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "The transport Kuma's Globalping measurement ran over. Vigil's runs ICMP and stores no protocol, so there is nothing here to set.",
  },
  {
    column: "snmp_v3_username",
    kind: "text?",
    classification: "mapped",
    target: "config.v3Username",
    note: "The user SNMP v3 identifies the caller by. Carried on a v3 monitor; the pass phrases beside it are not, because Kuma stores no column naming the protocol they belong to.",
  },
  {
    column: "expected_tls_alert",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's TLS check reports days remaining on the certificate; it does not assert on a handshake alert.",
  },
  {
    column: "retry_only_on_status_code_failure",
    kind: "bool",
    classification: "unsupported",
    target: null,
    note: "Vigil's failure window is time-based and does not distinguish why a check failed when deciding whether to keep waiting.",
  },
  {
    column: "screenshot_delay",
    kind: "int",
    classification: "unsupported",
    target: null,
    note: "How long Kuma waits before capturing a screenshot. Vigil keeps no screenshot (it reads the rendered DOM and records facts) so there is no capture for a delay to precede, and its own settle time is a separate setting whose unit is not this one's.",
  },
  {
    column: "bearer_token",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's HTTP probe sends no Authorization header.",
  },
  {
    column: "gamedig_token",
    kind: "text?",
    classification: "unsupported",
    target: null,
    note: "Vigil's game-server checks speak the servers' own query protocols, all three of which are unauthenticated, so there is no credential to send and the type declares no secret field to hold one.",
  },
] as const satisfies readonly FieldMapping[];

type MatrixEntry = (typeof FIELD_MATRIX)[number];
type ColumnKindOf = { [E in MatrixEntry as E["column"]]: E["kind"] };

type KindValue<K extends ColumnKind> = K extends "int"
  ? number
  : K extends "int?"
    ? number | null
    : K extends "text"
      ? string
      : K extends "text?"
        ? string | null
        : K extends "bool"
          ? boolean
          : K extends "real"
            ? number
            : never;

/**
 * One `monitor` row, typed from the matrix rather than beside it.
 *
 * Column names stay in Kuma's snake_case. Renaming them to camelCase
 * would put a translation table between the reader and the matrix, and
 * the whole guarantee here is that there is no gap for a column to fall
 * into.
 */
export type KumaMonitorRow = {
  [C in keyof ColumnKindOf]: KindValue<ColumnKindOf[C]>;
};

export function fieldMappingFor(column: string): FieldMapping | undefined {
  return FIELD_MATRIX.find((entry) => entry.column === column);
}

/* ────────────────────────────── types ────────────────────────────── */

export interface TypeMapping {
  /** The value Kuma stores in `monitor.type`. */
  readonly kumaType: string;
  /** The Vigil check type id, or null when there is none. */
  readonly checkType: string | null;
  /** What changes on the way across. Null when nothing does. */
  readonly transform: string | null;
  /** Why it cannot be imported. Null when it can. */
  readonly reason: string | null;
}

/**
 * Every value Kuma's 2.4.0 type selector can write, and what Vigil does
 * with it.
 *
 * All thirty-one now name a Vigil check type. Eighteen of them did not
 * until the registry reached forty types; the entries that used to read
 * "Vigil has no gRPC check type" were true when they were written and
 * are the reason this table is a table rather than a paragraph — a
 * capability that arrives has one place to be recorded.
 *
 * **A type having an equivalent is not a promise that every monitor of
 * that type imports.** The type decides which Vigil check is built; the
 * row decides whether Vigil's own rules accept it. A Kafka monitor
 * authenticating with SCRAM, an HTTP monitor watching an IP literal and
 * a Docker monitor on a unix socket all have a mapped type and are
 * still refused, each with its reason on the report. Keeping the two
 * questions apart is what stops "31 of 31 types" from being read as "31
 * of 31 monitors".
 *
 * Nothing here is aspirational. A type is mapped only if the importer
 * can build a monitor Vigil's own create schema accepts; inventing a
 * near-enough mapping to make the count look better is how a migration
 * tool ends up lying about what it moved. Where Vigil's check asks a
 * *different* question from Kuma's, `transform` says so in the sentence
 * an operator reads before deciding to trust the monitor.
 */
export const TYPE_MATRIX = [
  {
    kumaType: "http",
    checkType: "http",
    transform: null,
    reason: null,
  },
  {
    kumaType: "keyword",
    checkType: "http",
    transform:
      "Vigil has no separate keyword type: the body assertion is a setting on the HTTP check, so `keyword` becomes an HTTP monitor with bodyKeyword set and keywordAbsent from invert_keyword.",
    reason: null,
  },
  {
    kumaType: "json-query",
    checkType: "json-query",
    transform:
      "The JSONPath is rewritten as Vigil's dotted path; only the `==` operator is expressible.",
    reason: null,
  },
  {
    kumaType: "port",
    checkType: "tcp",
    transform: "Same check, different name: open a TCP connection.",
    reason: null,
  },
  {
    kumaType: "ping",
    checkType: "ping",
    transform: null,
    reason: null,
  },
  {
    kumaType: "dns",
    checkType: "dns",
    transform:
      "The record type carries; the per-monitor resolver does not, and a Kuma condition tree only carries in its single `record contains` form.",
    reason: null,
  },
  {
    kumaType: "docker",
    checkType: "docker",
    transform:
      "Kuma's docker_host row is resolved to a daemon address, which becomes the monitor's socketPath. Vigil's target names the machine being asked, so a Kuma host with no hostname cannot produce one.",
    reason: null,
  },
  {
    kumaType: "postgres",
    checkType: "postgres",
    transform:
      "The connection string is Vigil's target too, so it carries whole, credentials included, exactly as an operator typing it into Vigil would.",
    reason: null,
  },
  {
    kumaType: "mysql",
    checkType: "mysql",
    transform:
      "Vigil's MySQL check reads the handshake a server sends before authentication, so the target is a host and port and the credentials in Kuma's connection string have nowhere to go.",
    reason: null,
  },
  {
    kumaType: "mongodb",
    checkType: "mongodb",
    transform:
      "Vigil runs the unauthenticated hello handshake, so the target is a host and port and the credentials in Kuma's connection string have nowhere to go.",
    reason: null,
  },
  {
    kumaType: "redis",
    checkType: "redis",
    transform:
      "The connection string is split: host and port become the target and the password becomes the config secret. A Redis 6 ACL user name is dropped, because Vigil sends AUTH with a password alone.",
    reason: null,
  },
  {
    kumaType: "mqtt",
    checkType: "mqtt",
    transform:
      "Vigil connects and judges the CONNACK, so the credentials carry but the topic and the expected message do not.",
    reason: null,
  },
  {
    kumaType: "smtp",
    checkType: "smtp",
    transform:
      "Vigil reads the banner and sends EHLO in plaintext, so the host and port carry and Kuma's transport security setting does not.",
    reason: null,
  },
  {
    kumaType: "group",
    checkType: "group",
    transform:
      "A Kuma group becomes a Vigil group monitor. Membership moves onto each child's parentId (Vigil stores it on the member, never on the group) and the group's state is derived from its members rather than measured.",
    reason: null,
  },
  {
    kumaType: "manual",
    checkType: "manual",
    transform:
      "Kuma's numeric status becomes the status an operator has declared: 1 is up and 0 is down. Pending and maintenance arrive as degraded, because up, degraded and down are the three a person can state in Vigil.",
    reason: null,
  },
  {
    kumaType: "push",
    checkType: "push",
    transform:
      "Kuma's push token is carried when it satisfies Vigil's 32-128 character rule and no monitor already holds it; otherwise a fresh one is generated and the report says which. The deadline is the monitor's interval plus a 30-second grace, so point the job at /api/push/<token> and nothing else changes.",
    reason: null,
  },
  {
    kumaType: "real-browser",
    checkType: "real-browser",
    transform:
      "Vigil renders through a browser service it talks to over HTTP rather than one it ships, so the monitor reads misconfigured (never down) until BROWSER_SERVICE_URL or the monitor's own serviceUrl names a renderer. A Kuma remote browser, where the monitor named one, becomes that serviceUrl.",
    reason: null,
  },
  {
    kumaType: "globalping",
    checkType: "globalping",
    transform:
      "Vigil's Globalping check runs one measurement kind (a ping from the probe network) so a Kuma HTTP, DNS, traceroute or MTR measurement arrives as a ping of the same host from the same location, and the report says so on the monitor.",
    reason: null,
  },
  {
    kumaType: "grpc-keyword",
    checkType: "grpc",
    transform:
      "Vigil calls the standard gRPC health service rather than Kuma's own method and protobuf. The host, port, TLS setting and service name carry; the request body, the schema and the response keyword do not, and a server that does not implement grpc.health.v1.Health will read as down.",
    reason: null,
  },
  {
    kumaType: "kafka-producer",
    checkType: "kafka-producer",
    transform:
      "The first broker in Kuma's list becomes the bootstrap broker Vigil asks who leads the topic; the rest are reported. Vigil speaks SASL/PLAIN only, so a monitor authenticating with any other mechanism is refused rather than handed credentials its broker would reject.",
    reason: null,
  },
  {
    kumaType: "rabbitmq",
    checkType: "rabbitmq",
    transform:
      "Kuma polls a list of management APIs and Vigil watches one, so the first node becomes the target and the rest are reported. The credentials carry.",
    reason: null,
  },
  {
    kumaType: "sip-options",
    checkType: "sip",
    transform:
      "The same request on both sides: a SIP OPTIONS, and the status line that answers it. Kuma stores no transport, so the monitor keeps Vigil's UDP default.",
    reason: null,
  },
  {
    kumaType: "snmp",
    checkType: "snmp",
    transform:
      "The OID, the version and the v3 user name carry, and so does the community string Kuma keeps in `radius_password`. A v3 pass phrase does not: Kuma 2.4.0 has no column saying which authentication protocol it belongs to, and Vigil will not store a pass phrase without knowing what to sign with it.",
    reason: null,
  },
  {
    kumaType: "tailscale-ping",
    checkType: "tailscale-ping",
    transform:
      "The same check: the local tailscaled is asked to ping the peer. It is the worker's tailnet that is asked, not Kuma's, and where no tailscale binary is present the monitor reads misconfigured rather than down.",
    reason: null,
  },
  {
    kumaType: "websocket-upgrade",
    checkType: "websocket",
    transform:
      "The URL and the subprotocol carry. Vigil always verifies the Sec-WebSocket-Accept header the server returns, so Kuma's opt-out does not, a server that answers with a wrong one reads as down here.",
    reason: null,
  },
  {
    kumaType: "sqlserver",
    checkType: "sqlserver",
    transform:
      "Kuma's ADO-style connection string is rewritten as the URL form Vigil's target takes, credentials included. Vigil signs in and runs its own `SELECT 1`, so a custom query is reported and dropped.",
    reason: null,
  },
  {
    kumaType: "oracledb",
    checkType: "oracledb",
    transform:
      "Kuma's Easy Connect string becomes an `oracle://` URL. Vigil asks the listener whether it will accept a connection for the service and never signs in, so the login Kuma stored is reported rather than kept, a credential nothing sends is a credential nothing should store.",
    reason: null,
  },
  {
    kumaType: "radius",
    checkType: "radius",
    transform:
      "The shared secret and the test account carry, and the imported monitor expects an Access-Accept, which is what Kuma judged on. The calling and called station identifiers do not: Vigil's Access-Request carries a NAS-Identifier and no station attributes.",
    reason: null,
  },
  {
    kumaType: "gamedig",
    checkType: "gamedig",
    transform:
      "Kuma's GameDig game id is resolved to one of the three protocol families Vigil queries. Source/GoldSrc, Minecraft or id Tech 3. A game id that is not one of them is refused rather than queried with the wrong protocol.",
    reason: null,
  },
  {
    kumaType: "steam",
    checkType: "steam",
    transform:
      "The same check under a different name: the A2S_INFO reply a Source or GoldSrc server sends a player's client.",
    reason: null,
  },
  {
    kumaType: "system-service",
    checkType: "system-service",
    transform:
      "The unit name carries and the machine does not. Kuma asked the init system on the host running Kuma; Vigil asks the one on the host running the worker, so confirm the unit exists there before trusting the monitor. Where there is no systemd it reads misconfigured, never down.",
    reason: null,
  },
] as const satisfies readonly TypeMapping[];

export function typeMappingFor(kumaType: string): TypeMapping | undefined {
  return TYPE_MATRIX.find((entry) => entry.kumaType === kumaType);
}

/** Kuma types that produce a Vigil monitor. */
export function mappedTypes(): readonly TypeMapping[] {
  return TYPE_MATRIX.filter((entry) => entry.checkType !== null);
}

/** Kuma types that do not. */
export function unsupportedTypes(): readonly TypeMapping[] {
  return TYPE_MATRIX.filter((entry) => entry.checkType === null);
}

/* ─────────────────────────── notable drops ───────────────────────── */

/**
 * Settings that survive the type mapping and then quietly die anyway.
 *
 * A monitor that imports is the dangerous case. Its type mapped, a
 * Vigil monitor exists, and the operator has no reason to look at it
 * again — so a dropped `upside_down` or a dropped proxy is loss with a
 * green tick next to it. Each entry here fires only when Kuma actually
 * held a value, which is what keeps the report from drowning a real
 * loss under thirty lines of Kuma frontend defaults.
 *
 * The reason text is not written here. It is read from the field
 * matrix, so the report and the compatibility page cannot drift apart.
 */
export interface NotableDrop {
  readonly column: string;
  readonly isSet: (row: KumaMonitorRow) => boolean;
}

function filled(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

export const NOTABLE_DROPS: readonly NotableDrop[] = [
  { column: "upside_down", isSet: (row) => row.upside_down },
  { column: "proxy_id", isSet: (row) => row.proxy_id !== null },
  { column: "ignore_tls", isSet: (row) => row.ignore_tls },
  { column: "description", isSet: (row) => filled(row.description) },
  {
    column: "weight",
    isSet: (row) => row.weight !== null && row.weight !== 2000,
  },
  { column: "maxredirects", isSet: (row) => row.maxredirects !== 10 },
  { column: "body", isSet: (row) => filled(row.body) },
  { column: "headers", isSet: (row) => filled(row.headers) },
  { column: "basic_auth_user", isSet: (row) => filled(row.basic_auth_user) },
  { column: "bearer_token", isSet: (row) => filled(row.bearer_token) },
  { column: "oauth_client_id", isSet: (row) => filled(row.oauth_client_id) },
  { column: "auth_method", isSet: (row) => filled(row.auth_method) },
  { column: "resend_interval", isSet: (row) => row.resend_interval > 0 },
  { column: "cache_bust", isSet: (row) => row.cache_bust },
  {
    column: "retry_only_on_status_code_failure",
    isSet: (row) => row.retry_only_on_status_code_failure,
  },
  { column: "tls_cert", isSet: (row) => filled(row.tls_cert) },
  { column: "tls_ca", isSet: (row) => filled(row.tls_ca) },
  { column: "ip_family", isSet: (row) => filled(row.ip_family) },
  { column: "packet_size", isSet: (row) => row.packet_size !== 56 },
  {
    column: "domain_expiry_notification",
    isSet: (row) => row.domain_expiry_notification,
  },
  { column: "save_response", isSet: (row) => row.save_response },
  // Settings on the eighteen types that only became importable once the
  // registry had an equivalent. Each is a real capability difference
  // rather than a Kuma frontend default, which is why each has its own
  // predicate instead of a blanket "not null".
  { column: "screenshot_delay", isSet: (row) => row.screenshot_delay > 0 },
  { column: "gamedig_token", isSet: (row) => filled(row.gamedig_token) },
  {
    // Kuma's default is on. Off is the operator having asked for the
    // neighbouring-port scan Vigil will not do.
    column: "gamedig_given_port_only",
    isSet: (row) => row.type === "gamedig" && !row.gamedig_given_port_only,
  },
  {
    column: "kafka_producer_allow_auto_topic_creation",
    isSet: (row) => row.kafka_producer_allow_auto_topic_creation,
  },
  {
    column: "ws_ignore_sec_websocket_accept_header",
    isSet: (row) => row.ws_ignore_sec_websocket_accept_header,
  },
  {
    column: "radius_calling_station_id",
    isSet: (row) => filled(row.radius_calling_station_id),
  },
  {
    column: "radius_called_station_id",
    isSet: (row) => filled(row.radius_called_station_id),
  },
  {
    // Only a Globalping monitor stores one, and only when the operator
    // chose a transport other than the default.
    column: "protocol",
    isSet: (row) => filled(row.protocol),
  },
];

/* ─────────────────────── Kuma's game identifiers ─────────────────── */

/**
 * GameDig's game ids, resolved to the three query protocols Vigil
 * speaks.
 *
 * GameDig knows hundreds of titles; Vigil knows three wire protocols,
 * and almost every one of those titles is one of the three wearing a
 * different name. So the table maps ids rather than games — `csgo`,
 * `rust` and `valheim` are all A2S — and stops where the guessing would
 * start. A game id that is not here refuses its monitor, with the id
 * named, because querying a Minecraft server with an A2S packet
 * produces silence that is indistinguishable from a server that is down.
 *
 * Ids follow GameDig's own naming, including the ones that have since
 * been renamed upstream: a Kuma database written in 2023 holds `csgo`
 * and one written after Counter-Strike 2 holds `counterstrike2`, and
 * both are the same protocol.
 */
export const GAMEDIG_PROTOCOL_BY_GAME: Readonly<Record<string, string>> = {
  // Valve's A2S — Source and GoldSrc engines, and everything built on
  // them.
  arkse: "source",
  arma3: "source",
  assettocorsa: "source",
  cs16: "source",
  cs2: "source",
  csgo: "source",
  css: "source",
  counterstrike2: "source",
  counterstrike16: "source",
  counterstrikesource: "source",
  dayz: "source",
  garrysmod: "source",
  halflife: "source",
  hl2dm: "source",
  insurgency: "source",
  insurgencysandstorm: "source",
  left4dead2: "source",
  projectzomboid: "source",
  rust: "source",
  squad: "source",
  teamfortress2: "source",
  tf2: "source",
  valheim: "source",
  // Minecraft's own query protocol, which needs `enable-query=true`.
  minecraft: "minecraft",
  minecraftping: "minecraft",
  // id Tech 3's `getstatus`.
  callofduty: "quake3",
  cod: "quake3",
  cod2: "quake3",
  cod4: "quake3",
  openarena: "quake3",
  quake3: "quake3",
  urbanterror: "quake3",
  wolfensteinet: "quake3",
};

/** The Vigil game-query protocol for a Kuma `game` id, or null. */
export function gamedigProtocolFor(game: string): string | null {
  return GAMEDIG_PROTOCOL_BY_GAME[game.trim().toLowerCase()] ?? null;
}
