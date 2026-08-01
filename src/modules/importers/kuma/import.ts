import { and, eq, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { monitorHeartbeats, monitors, statusPages } from "@/db/schema";
import {
  DEFAULT_DOCKER_SOCKET,
  DEFAULT_GRPC_PORT,
  DEFAULT_KAFKA_PORT,
  DEFAULT_MONGODB_PORT,
  DEFAULT_MQTT_PORT,
  DEFAULT_MYSQL_PORT,
  DEFAULT_ORACLE_PORT,
  DEFAULT_RADIUS_PORT,
  DEFAULT_REDIS_PORT,
  DEFAULT_SIP_PORT,
  DEFAULT_SMTP_PORT,
  DEFAULT_SNMP_PORT,
  DEFAULT_SQLSERVER_PORT,
  DEFAULT_STEAM_PORT,
  DNS_RECORD_TYPES,
} from "@/modules/monitors/types/catalog";
import { redactConfig } from "@/modules/monitors/types/config";
import { requireSpec } from "@/modules/monitors/types/specs";
import { pushStoredSchema } from "@/modules/monitors/types/specs/push";
import {
  MAX_FAILURE_WINDOW_SECONDS,
  MAX_INTERVAL_SECONDS,
  MIN_FAILURE_WINDOW_SECONDS,
  MIN_INTERVAL_SECONDS,
  createMonitorSchema,
} from "@/modules/monitors/schemas";
import { createMonitor, setMonitorPaused } from "@/modules/monitors/service";
import {
  createStatusPage,
  setStatusPageMonitors,
  updateStatusPage,
} from "@/modules/status-pages/service";

import {
  NOTABLE_DROPS,
  fieldMappingFor,
  gamedigProtocolFor,
  typeMappingFor,
  type KumaMonitorRow,
} from "./mapping";
import {
  schemaDrift,
  type KumaDatabase,
  type KumaDockerHost,
  type KumaRemoteBrowser,
} from "./read";
import { ReportBuilder, type ImportReport, type ReportEntry } from "./report";

/**
 * The import engine.
 *
 * Everything is written through the modules that own the thing being
 * written — `createMonitor`, `createStatusPage`, `setStatusPageMonitors`
 * — rather than through `db.insert(...)`. The monitor service applies
 * `monitorColumnsFor`, which resets every setting the target type does
 * not declare a form section for, so an imported Redis monitor cannot
 * arrive carrying an `expectedStatusCode` that nothing will ever read
 * but that a later type switch would resurrect. It also writes the audit
 * row, which is the difference between a monitor that appeared and a
 * monitor someone can be shown to have created. The same argument
 * applies to a status page, whose slug is globally unique and whose
 * visibility decides who may read it.
 *
 * One transaction for the whole import, and that is deliberate. A
 * migration that half-succeeds leaves an operator reconciling two
 * systems by hand at exactly the moment they were trying to stop doing
 * that. Either the organisation has the monitors or it does not.
 *
 * That single transaction is also what makes `dryRun` worth having. The
 * preview is not an estimate: it builds every monitor, validates it,
 * inserts it, lets Postgres check every constraint — and then rolls the
 * whole thing back. An operator confirming the second click is
 * confirming a result, not a forecast.
 *
 * Two orderings matter and they are not the same one. Monitors are
 * *created* parents-first, because a member's `parentId` has to name a
 * row that exists; they are *reported* in Kuma's own id order, because
 * a report is read by a person comparing it to a Kuma screen. The
 * entries are therefore collected into a map and emitted afterwards.
 *
 * No migration accompanies this module. The report is returned to the
 * caller and rendered; it is not persisted. Storing it would put an
 * import log in the schema, and the schema is the one place where a
 * feature nobody has shipped yet costs everybody a migration.
 */

export interface KumaImportActor {
  organizationId: string;
  userId: string;
}

export interface KumaImportOptions {
  /**
   * Import from a database that is not the pinned release anyway.
   *
   * Off by default. A schema this importer has not been read against
   * may hold a column whose meaning moved, and a monitor built from a
   * misread column is worse than no monitor: it looks right, so nobody
   * checks it. The drift is reported either way — this only decides
   * whether the write happens.
   */
  allowSchemaDrift?: boolean;
  /**
   * Do the whole import and roll it back, returning what would have
   * happened.
   *
   * The report is identical to the one a real run produces, ids
   * included — and those ids name rows that no longer exist, which is
   * what `status: "preview"` is for.
   */
  dryRun?: boolean;
}

/** Vigil's create input before validation. */
type RawInput = Record<string, unknown>;

export interface Build {
  input: RawInput;
  /** What changed on the way across. Empty means a clean import. */
  notes: string[];
  /** Why this row cannot become a monitor. Empty means it can. */
  refusals: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function filled(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}

/** The field matrix's reason for a column, quoted into a report line. */
function reasonFor(column: string): string {
  return fieldMappingFor(column)?.note ?? "";
}

function drop(column: string, held?: string): string {
  const what = held === undefined ? column : `${column} (${held})`;
  return `${what} not carried: ${reasonFor(column)}`;
}

function monitorName(row: KumaMonitorRow): string {
  const name = (row.name ?? "").trim();
  return name.length > 0 ? name : `Kuma monitor ${row.id}`;
}

/**
 * Vigil's name column stops at 100 characters and Kuma's at 150.
 *
 * Truncated rather than refused. A monitor lost to three characters of
 * name is the most infuriating kind of migration failure — nothing is
 * wrong with the check, and the operator has to recreate it by hand to
 * learn that — so the name is cut and the cut is reported.
 */
const MAX_NAME_LENGTH = 100;

function nameFor(row: KumaMonitorRow, notes: string[]): string {
  const name = monitorName(row);
  if (name.length <= MAX_NAME_LENGTH) return name;
  const cut = name.slice(0, MAX_NAME_LENGTH).trimEnd();
  notes.push(
    `The name was cut to "${cut}": Kuma allows 150 characters and Vigil's name column stops at ${MAX_NAME_LENGTH}.`,
  );
  return cut;
}

/**
 * Kuma's retry policy as Vigil's failure window.
 *
 * Kuma counts failures and spaces them by `retry_interval`; Vigil asks
 * how long the monitor has been failing. The product of the two is the
 * same wall-clock tolerance, which is the thing the operator actually
 * chose — see the `failureWindowSeconds` comment in the schema for why
 * counting stopped meaning anything once intervals became adaptive.
 */
function failureWindowFor(row: KumaMonitorRow): number {
  return clamp(
    row.maxretries * row.retry_interval,
    MIN_FAILURE_WINDOW_SECONDS,
    MAX_FAILURE_WINDOW_SECONDS,
  );
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;

function timeoutFor(row: KumaMonitorRow, notes: string[]): number {
  // Zero is Kuma never having stored one, not a zero-second timeout.
  // Nothing is lost by falling back to Vigil's default, so nothing is
  // reported — a report line per monitor for "the default applied"
  // would bury the lines that matter.
  if (row.timeout <= 0) return DEFAULT_TIMEOUT_MS;
  const requested = Math.round(row.timeout * 1000);
  const applied = clamp(requested, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  if (applied !== requested) {
    notes.push(
      `timeout ${requested}ms clamped to ${applied}ms, Vigil's bound.`,
    );
  }
  return applied;
}

function intervalFor(row: KumaMonitorRow, notes: string[]): number {
  const applied = clamp(
    row.interval,
    MIN_INTERVAL_SECONDS,
    MAX_INTERVAL_SECONDS,
  );
  if (applied !== row.interval) {
    notes.push(
      `interval ${row.interval}s clamped to ${applied}s, Vigil's bound.`,
    );
  }
  return applied;
}

/* ───────────────────────── value transforms ──────────────────────── */

interface Endpoint {
  hostname: string;
  port: number | null;
  username: string | null;
  password: string | null;
}

/**
 * A connection string split into parts.
 *
 * Kuma stores credentials inline in `database_connection_string`, which
 * is the single most dangerous column in the schema: three of the types
 * that use it map to Vigil types whose target is a bare host, so the
 * password has to be lifted out deliberately or it travels into a
 * column that renders on the monitor page.
 */
function parseEndpoint(value: string): Endpoint | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname.length === 0) return null;
  const decode = (part: string): string | null => {
    if (part.length === 0) return null;
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  return {
    hostname,
    port: url.port === "" ? null : Number(url.port),
    username: decode(url.username),
    password: decode(url.password),
  };
}

/**
 * A bare `host:port`, which is how Kuma stores a gRPC endpoint and each
 * Kafka broker. Not a URL: there is no scheme, so one is lent for the
 * parse and thrown away.
 */
function hostPort(
  value: string,
  fallbackPort: number,
): { host: string; port: number } | null {
  const raw = value.trim();
  if (raw.length === 0) return null;
  const withScheme = raw.includes("://") ? raw : `tcp://${raw}`;
  try {
    const url = new URL(withScheme);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host.length === 0) return null;
    return { host, port: url.port === "" ? fallbackPort : Number(url.port) };
  } catch {
    return null;
  }
}

/** Kuma's JSON list columns — brokers, RabbitMQ nodes — as strings. */
function jsonStrings(json: string | null): string[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

/** Kuma's accepted-status list as Vigil's single expected code. */
function expectedStatusCodeFrom(
  json: string,
  notes: string[],
): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    notes.push(
      "accepted_statuscodes_json could not be parsed; Vigil accepts any 2xx or 3xx instead.",
    );
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const codes = parsed.map((entry) => String(entry));
  // Kuma's own default. Vigil's "no expectation" rule — any 2xx or 3xx
  // passes — is a superset of it, so nothing is lost and nothing is
  // said.
  if (codes.length === 1 && codes[0] === "200-299") return undefined;
  if (codes.length === 1 && /^\d{3}$/.test(codes[0] ?? "")) {
    return Number(codes[0]);
  }
  if (codes.length === 0) return undefined;
  notes.push(
    `accepted status codes ${codes.join(", ")} cannot be expressed: ${reasonFor("accepted_statuscodes_json")} This monitor now accepts any 2xx or 3xx.`,
  );
  return undefined;
}

/**
 * Vigil's dotted path from Kuma's JSONPath, or null when the expression
 * is richer than a fixed location.
 *
 * A wildcard or a filter cannot be narrowed into a single path without
 * choosing a meaning the operator did not write, so it is refused.
 */
const DOTTED_PATH =
  /^[A-Za-z0-9_-]+(?:\[\d+\])*(?:\.[A-Za-z0-9_-]+(?:\[\d+\])*)*$/;

export function vigilJsonPath(kumaPath: string): string | null {
  let path = kumaPath.trim();
  if (path.startsWith("$.")) path = path.slice(2);
  else if (path === "$") return null;
  return DOTTED_PATH.test(path) ? path : null;
}

interface KumaCondition {
  type?: unknown;
  variable?: unknown;
  operator?: unknown;
  value?: unknown;
}

/**
 * Kuma's condition tree, reduced to the one expression a Vigil
 * `expectedValue` can be.
 *
 * Two shapes reach a home: `record contains "x"` on a DNS monitor and
 * `oid == "x"` on an SNMP one, each of which is exactly what that
 * type's `expectedValue` already means. Every other tree — an `or`
 * group, a `>` on a numeric variable, more than one expression — is
 * counted and reported rather than approximated, because a condition
 * that half-carries is an alert rule that fires on something else.
 */
function expectationFrom(
  conditionsJson: string,
  variable: string,
  operator: string,
): { expectedValue: string | null; unmapped: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(conditionsJson);
  } catch {
    return { expectedValue: null, unmapped: 1 };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { expectedValue: null, unmapped: 0 };
  }
  if (parsed.length === 1) {
    const only = parsed[0] as KumaCondition;
    if (
      only.type === "expression" &&
      only.variable === variable &&
      only.operator === operator &&
      typeof only.value === "string" &&
      only.value.length > 0
    ) {
      return { expectedValue: only.value, unmapped: 0 };
    }
  }
  return { expectedValue: null, unmapped: parsed.length };
}

function conditionCount(conditionsJson: string): number {
  try {
    const parsed: unknown = JSON.parse(conditionsJson);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** The host a Docker daemon address points at, or null for a socket. */
function daemonHost(daemon: string): string | null {
  const value = daemon.trim();
  if (value.startsWith("/")) return null;
  const withScheme = value.includes("://") ? value : `tcp://${value}`;
  try {
    const hostname = new URL(withScheme).hostname.replace(/^\[|\]$/g, "");
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

/**
 * Kuma's SQL Server connection string as the URL Vigil's target takes.
 *
 * Kuma stores the ADO/.NET form (`Server=host,1433;Database=…`) and
 * Vigil's target is a URL, so the keys are read out and reassembled.
 * The user name and password are percent-encoded on the way in: a SQL
 * Server password containing an `@` or a `/` would otherwise produce a
 * URL that parses into a different host, which is the kind of bug that
 * shows up as "wrong password" and means "wrong parser".
 *
 * A named instance with no port is refused. Reaching one means asking
 * the SQL Browser on UDP 1434 which port it listens on, which Vigil
 * does not do, so an imported monitor would dial 1433 and report an
 * outage on a server that is fine.
 */
function sqlserverTarget(connection: string): string | null {
  const raw = connection.trim();
  if (raw.length === 0) return null;
  if (/^(?:sqlserver|mssql):\/\//i.test(raw)) return raw;

  const parts = new Map<string, string>();
  for (const segment of raw.split(";")) {
    const at = segment.indexOf("=");
    if (at < 0) continue;
    const key = segment.slice(0, at).trim().toLowerCase().replace(/\s+/g, " ");
    if (key.length > 0) parts.set(key, segment.slice(at + 1).trim());
  }
  const pick = (...keys: string[]): string =>
    keys.map((key) => parts.get(key) ?? "").find((v) => v.length > 0) ?? "";

  const server = pick(
    "server",
    "data source",
    "address",
    "addr",
    "network address",
  );
  if (server.length === 0) return null;
  const [hostPart = "", portPart] = server.split(",");
  const explicitPort = /^\d+$/.test((portPart ?? "").trim())
    ? Number((portPart ?? "").trim())
    : null;
  const named = hostPart.includes("\\");
  if (named && explicitPort === null) return null;
  const host = (named ? (hostPart.split("\\")[0] ?? "") : hostPart).trim();
  if (host.length === 0) return null;

  const username = pick("user id", "uid", "user");
  const password = pick("password", "pwd");
  // Vigil's SQL Server check has no useful unauthenticated form: the
  // greeting is answered to anyone, and everything past it needs a
  // login. Its target schema says so, and refusing here says which.
  if (username.length === 0) return null;
  const database = pick("database", "initial catalog");

  return `sqlserver://${encodeURIComponent(username)}:${encodeURIComponent(
    password,
  )}@${host}:${explicitPort ?? DEFAULT_SQLSERVER_PORT}${
    database.length > 0 ? `/${encodeURIComponent(database)}` : ""
  }`;
}

/**
 * Kuma's Oracle Easy Connect string as the `oracle://` URL Vigil takes.
 *
 * Any credentials in it are removed rather than carried: Vigil's Oracle
 * check speaks TNS to the listener and never signs in, and its target
 * schema refuses a password outright — a secret nothing sends is a
 * secret nothing should store.
 */
function oracleTarget(connection: string): string | null {
  let raw = connection.trim();
  if (raw.length === 0) return null;
  if (/^(?:oracle|oracledb):\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      url.username = "";
      url.password = "";
      return url.toString();
    } catch {
      return null;
    }
  }
  if (raw.startsWith("//")) raw = raw.slice(2);
  const match = /^(?:[^/@]*@)?([^:/]+)(?::(\d+))?\/(.+)$/.exec(raw);
  if (!match) return null;
  const [, host, port, service] = match;
  return `oracle://${host}:${port ?? DEFAULT_ORACLE_PORT}/${(service ?? "").trim()}`;
}

/** Kuma's SASL blob, as far as a PLAIN-only client can read it. */
interface KafkaSasl {
  /** Lower-cased; null when Kuma stored none or stored "None". */
  mechanism: string | null;
  username: string | null;
  password: string | null;
}

function parseKafkaSasl(json: string | null): KafkaSasl {
  const none: KafkaSasl = { mechanism: null, username: null, password: null };
  if (json === null) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return none;
  }
  if (typeof parsed !== "object" || parsed === null) return none;
  const record = parsed as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = record[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const mechanism = (text("mechanism") ?? "").trim().toLowerCase();
  return {
    mechanism:
      mechanism.length === 0 || mechanism === "none" ? null : mechanism,
    username: text("username"),
    password: text("password"),
  };
}

/**
 * The one gRPC metadata line Vigil can send.
 *
 * Kuma stores free-form `key: value` lines; Vigil's gRPC check carries
 * `authorization` and nothing else, so that one is lifted out and the
 * rest are named. Naming them rather than counting them matters — an
 * operator whose service needs an `x-api-key` has to know the imported
 * monitor will be answered with UNAUTHENTICATED.
 */
function grpcAuthorization(
  metadata: string | null,
  notes: string[],
): string | null {
  if (!filled(metadata)) return null;
  let authorization: string | null = null;
  const others: string[] = [];
  for (const line of metadata.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const at = line.indexOf(":");
    const key = (at < 0 ? line : line.slice(0, at)).trim();
    const value = at < 0 ? "" : line.slice(at + 1).trim();
    if (key.toLowerCase() === "authorization") authorization = value;
    else others.push(key);
  }
  if (others.length > 0) {
    notes.push(
      `gRPC metadata ${others.join(", ")} not carried: ${reasonFor("grpc_metadata")}`,
    );
  }
  return authorization;
}

/** Kuma's numeric status, as one of the three a person can assert. */
const MANUAL_STATUS_BY_KUMA: Readonly<Record<number, string>> = {
  0: "down",
  1: "up",
};

function manualStatusFor(value: number | null, notes: string[]): string {
  if (value === null) return "up";
  const mapped = MANUAL_STATUS_BY_KUMA[value];
  if (mapped !== undefined) return mapped;
  notes.push(
    `Kuma's manual status ${value} arrives as degraded: ${reasonFor("manual_status")}`,
  );
  return "degraded";
}

/* ────────────────────────── the row builder ──────────────────────── */

export interface BuildContext {
  dockerHostsById: Map<number, KumaDockerHost>;
  remoteBrowsersById: Map<number, KumaRemoteBrowser>;
}

/**
 * Kuma types whose monitor actually has a domain to look at, and for
 * which `expiry_notification` and `domain_expiry_notification`
 * therefore mean something. On every other type Kuma's frontend writes
 * the flag and nothing reads it, so reporting it would be noise
 * standing exactly where a real loss should be visible.
 */
const URL_BEARING_KUMA_TYPES: ReadonlySet<string> = new Set([
  "http",
  "keyword",
  "json-query",
  "real-browser",
]);

/**
 * Kuma types whose form actually offers a keyword. On `keyword` it
 * becomes Vigil's body assertion; on the other two Vigil's equivalent
 * judges a reported status instead, so the keyword is a real loss and
 * says so. Everywhere else the column holds a stale value Kuma's own UI
 * never showed, and reporting it would be noise.
 */
const KEYWORD_BEARING_KUMA_TYPES: ReadonlySet<string> = new Set([
  "keyword",
  "grpc-keyword",
  "globalping",
]);

/** Types whose Vigil equivalent can express one Kuma condition. */
const CONDITION_AWARE_CHECK_TYPES: ReadonlySet<string> = new Set([
  "dns",
  "snmp",
]);

/**
 * One Kuma row as Vigil's create input, plus everything worth saying
 * about the journey.
 *
 * Exported so the transforms can be exercised against real fixture rows
 * without a database — including the rows that never reach one. The
 * fixture's HTTP monitors watch `http://127.0.0.1:3001/`, which Vigil's
 * target schema refuses, so the keyword and status-code rules would
 * otherwise be the least tested part of the most used type.
 */
export function buildMonitorInput(
  row: KumaMonitorRow,
  checkType: string,
  context: BuildContext,
): Build {
  const notes: string[] = [];
  const refusals: string[] = [];
  const spec = requireSpec(checkType);

  const base: RawInput = {
    name: nameFor(row, notes),
    checkType,
    intervalSeconds: intervalFor(row, notes),
    timeoutMs: timeoutFor(row, notes),
    failureWindowSeconds: failureWindowFor(row),
  };

  switch (checkType) {
    case "http": {
      base.url = row.url ?? "";
      if (row.method !== "GET" && row.method !== "HEAD") {
        refusals.push(`Kuma sends ${row.method}. ${reasonFor("method")}`);
        base.method = "GET";
      } else {
        base.method = row.method;
      }
      const expected = expectedStatusCodeFrom(
        row.accepted_statuscodes_json,
        notes,
      );
      if (expected !== undefined) base.expectedStatusCode = expected;
      if (row.type === "keyword") {
        base.bodyKeyword = row.keyword;
        base.keywordAbsent = row.invert_keyword;
      }
      base.tlsCheck = row.expiry_notification;
      break;
    }
    case "json-query": {
      base.url = row.url ?? "";
      if (row.json_path_operator !== null && row.json_path_operator !== "==") {
        refusals.push(
          `Kuma compares with "${row.json_path_operator}". ${reasonFor("json_path_operator")}`,
        );
      }
      const sourcePath = row.json_path ?? "";
      const path = vigilJsonPath(sourcePath);
      if (path === null) {
        refusals.push(
          `The JSON path "${sourcePath}" cannot be rewritten. ${reasonFor("json_path")}`,
        );
      } else {
        if (path !== sourcePath) {
          notes.push(
            `JSON path rewritten from "${sourcePath}" to "${path}", Vigil's dotted form.`,
          );
        }
        base.config = {
          jsonPath: path,
          expectedValue: row.expected_value ?? "",
        };
      }
      break;
    }
    case "tcp": {
      base.url = row.hostname ?? "";
      base.port = row.port;
      break;
    }
    case "ping": {
      base.url = row.hostname ?? "";
      const packets = clamp(row.ping_count, 1, 5);
      if (packets !== row.ping_count) {
        notes.push(
          `ping_count ${row.ping_count} clamped to ${packets}, Vigil's bound.`,
        );
      }
      base.config = { packets };
      break;
    }
    case "dns": {
      base.url = row.hostname ?? "";
      const recordType = (row.dns_resolve_type ?? "A").toUpperCase();
      const known: readonly string[] = DNS_RECORD_TYPES;
      if (!known.includes(recordType)) {
        refusals.push(
          `Kuma resolves ${recordType} records. ${reasonFor("dns_resolve_type")}`,
        );
        break;
      }
      const expectation = expectationFrom(row.conditions, "record", "contains");
      if (expectation.unmapped > 0) {
        notes.push(
          `${expectation.unmapped} Kuma condition(s) dropped: ${reasonFor("conditions")}`,
        );
      }
      if (row.dns_resolve_server !== null) {
        notes.push(drop("dns_resolve_server", row.dns_resolve_server));
      }
      base.config = {
        recordType,
        expectedValue: expectation.expectedValue,
      };
      break;
    }
    case "docker": {
      const host =
        row.docker_host === null
          ? undefined
          : context.dockerHostsById.get(row.docker_host);
      if (host === undefined) {
        refusals.push(
          `The monitor references Docker host ${row.docker_host ?? "none"}, which is not in this database.`,
        );
        base.url = "";
        break;
      }
      const viaNetwork = daemonHost(host.daemon);
      // Over a unix socket there is no host to name, and Vigil's target
      // is a hostname whatever the descriptor's help text says about it
      // being a label. Kuma's host name is a free-text label ("local"),
      // so it only works when the operator happened to type one.
      base.url = viaNetwork ?? host.name;
      if (viaNetwork === null) {
        notes.push(
          `Docker host "${host.name}" is a local socket, so its Kuma name is used as the target Vigil needs for the machine being asked.`,
        );
      }
      base.config = {
        containerName: row.docker_container,
        socketPath:
          host.daemon.length > 0 ? host.daemon : DEFAULT_DOCKER_SOCKET,
      };
      break;
    }
    case "postgres": {
      base.url = row.database_connection_string ?? "";
      break;
    }
    case "mysql":
    case "mongodb":
    case "redis": {
      const raw = row.database_connection_string ?? "";
      const endpoint = parseEndpoint(raw);
      if (endpoint === null) {
        refusals.push(
          `The connection string could not be parsed into a host and port, which is what Vigil's ${checkType} check targets.`,
        );
        base.url = "";
        break;
      }
      base.url = endpoint.hostname;
      base.port =
        endpoint.port ??
        (checkType === "mysql"
          ? DEFAULT_MYSQL_PORT
          : checkType === "mongodb"
            ? DEFAULT_MONGODB_PORT
            : DEFAULT_REDIS_PORT);
      if (checkType === "redis") {
        base.config = { password: endpoint.password };
        if (endpoint.username !== null) {
          notes.push(
            "The Redis ACL user name is dropped; Vigil sends AUTH with a password alone.",
          );
        }
      } else if (endpoint.username !== null || endpoint.password !== null) {
        notes.push(
          `The credentials in the connection string are dropped: ${
            checkType === "mysql"
              ? "Vigil reads the handshake a MySQL server sends before authentication"
              : "Vigil runs the hello handshake a MongoDB server answers unauthenticated"
          }, so there is no login to make.`,
        );
      }
      break;
    }
    case "sqlserver": {
      const target = sqlserverTarget(row.database_connection_string ?? "");
      if (target === null) {
        refusals.push(
          "The connection string could not be rewritten as the URL Vigil's SQL Server check takes: it needs a host, a login and — for a named instance — an explicit port, because Vigil does not ask the SQL Browser which port an instance is on.",
        );
        base.url = "";
        break;
      }
      base.url = target;
      notes.push(
        "The ADO connection string was rewritten as Vigil's URL form, credentials included.",
      );
      break;
    }
    case "oracledb": {
      const target = oracleTarget(row.database_connection_string ?? "");
      if (target === null) {
        refusals.push(
          "The connection string is not a host, port and service name, which is what Vigil's Oracle check needs to build a TNS descriptor.",
        );
        base.url = "";
        break;
      }
      base.url = target;
      if (filled(row.radius_username) || filled(row.radius_password)) {
        notes.push(
          "The Oracle login Kuma stored is not carried: Vigil asks the listener whether it will accept a connection for the service and never signs in, so a password here would be stored and never sent.",
        );
      }
      break;
    }
    case "mqtt": {
      base.url = row.hostname ?? "";
      base.port = row.port ?? DEFAULT_MQTT_PORT;
      let username = row.mqtt_username;
      let password = row.mqtt_password;
      if (username !== null && username.length === 0) username = null;
      if (password !== null && password.length === 0) password = null;
      if (username === null && password !== null) {
        // MQTT 3.1.1 §3.1.2.9 forbids a password without a user name,
        // and Vigil's stored schema enforces it. Kuma allows the row, so
        // the credential is unusable on either side — dropped loudly
        // rather than smuggled through as a username.
        password = null;
        notes.push(
          "The MQTT password is dropped: it had no user name, which MQTT 3.1.1 forbids and Vigil refuses.",
        );
      }
      base.config = { username, password };
      for (const column of [
        "mqtt_topic",
        "mqtt_success_message",
        "mqtt_websocket_path",
      ] as const) {
        const value = row[column];
        if (value !== null && value.length > 0) notes.push(drop(column, value));
      }
      if (row.mqtt_check_type !== "keyword") {
        notes.push(drop("mqtt_check_type", row.mqtt_check_type));
      }
      break;
    }
    case "smtp": {
      base.url = row.hostname ?? "";
      base.port = row.port ?? DEFAULT_SMTP_PORT;
      if (row.smtp_security !== null && row.smtp_security.length > 0) {
        notes.push(drop("smtp_security", row.smtp_security));
      }
      break;
    }
    case "group": {
      // Nothing is dialled, so the target field holds what the group
      // covers. Kuma stores no description for a group, and its name is
      // the only thing an operator ever wrote about it.
      base.url = monitorName(row);
      break;
    }
    case "manual": {
      base.url = monitorName(row);
      base.config = {
        status: manualStatusFor(row.manual_status, notes),
        note: null,
      };
      break;
    }
    case "push": {
      base.url = monitorName(row);
      const token = (row.push_token ?? "").trim();
      const usable =
        token.length > 0 && pushStoredSchema.safeParse({ token }).success;
      if (token.length > 0 && !usable) {
        notes.push(
          "The Kuma push token was not carried and a new one was generated: Vigil's tokens are 32–128 characters of letters, digits, hyphen or underscore, and this one is not. Point the job at the new endpoint on the monitor page.",
        );
      }
      base.config = usable ? { token } : {};
      break;
    }
    case "real-browser": {
      base.url = row.url ?? "";
      let serviceUrl: string | null = null;
      if (row.remote_browser !== null) {
        const browser = context.remoteBrowsersById.get(row.remote_browser);
        if (browser === undefined) {
          notes.push(
            `The monitor names Kuma remote browser ${row.remote_browser}, which is not in this database; the install's BROWSER_SERVICE_URL applies instead.`,
          );
        } else if (!isHttpUrl(browser.url)) {
          notes.push(
            `Kuma remote browser "${browser.name}" has no usable http(s) URL, so the install's BROWSER_SERVICE_URL applies instead.`,
          );
        } else {
          serviceUrl = browser.url;
        }
      }
      base.config = { serviceUrl, token: null, settleMs: 0 };
      break;
    }
    case "globalping": {
      // Kuma keeps the target in `url` for its HTTP measurement and in
      // `hostname` for the rest. Vigil pings a host either way, so the
      // hostname is lifted out of whichever one holds it.
      const host = filled(row.hostname)
        ? row.hostname.trim()
        : (hostPort(row.url ?? "", 0)?.host ?? "");
      base.url = host;
      const location = (row.location ?? "").trim();
      base.config = location.length > 0 ? { location } : {};
      const subtype = (row.subtype ?? "").trim();
      if (subtype.length > 0 && subtype.toLowerCase() !== "ping") {
        notes.push(
          `Kuma ran a "${subtype}" measurement here and Vigil runs a ping: ${reasonFor("subtype")}`,
        );
      }
      break;
    }
    case "grpc": {
      const endpoint = hostPort(row.grpc_url ?? "", DEFAULT_GRPC_PORT);
      if (endpoint === null) {
        refusals.push(
          `Kuma's gRPC endpoint "${row.grpc_url ?? ""}" is not a host and port, which is what Vigil's gRPC check dials.`,
        );
        base.url = "";
        break;
      }
      base.url = endpoint.host;
      base.port = endpoint.port;
      base.config = {
        service: row.grpc_service_name ?? "",
        tls: row.grpc_enable_tls,
        authorization: grpcAuthorization(row.grpc_metadata, notes),
      };
      for (const column of [
        "grpc_protobuf",
        "grpc_body",
        "grpc_method",
      ] as const) {
        if (filled(row[column])) notes.push(drop(column));
      }
      notes.push(
        "Vigil calls the standard grpc.health.v1.Health service rather than Kuma's method, so confirm the server implements it before trusting this monitor.",
      );
      break;
    }
    case "kafka-producer": {
      const brokers = jsonStrings(row.kafka_producer_brokers);
      if (brokers.length === 0) {
        refusals.push(
          "Kuma stored no broker for this monitor, so there is no bootstrap broker for Vigil to ask who leads the topic.",
        );
        base.url = "";
        break;
      }
      const endpoint = hostPort(brokers[0] ?? "", DEFAULT_KAFKA_PORT);
      if (endpoint === null) {
        refusals.push(
          `The first Kafka broker "${brokers[0] ?? ""}" is not a host and port.`,
        );
        base.url = "";
        break;
      }
      base.url = endpoint.host;
      base.port = endpoint.port;
      if (brokers.length > 1) {
        notes.push(
          `${brokers.length - 1} further broker(s) — ${brokers.slice(1).join(", ")} — not carried: ${reasonFor("kafka_producer_brokers")}`,
        );
      }
      const sasl = parseKafkaSasl(row.kafka_producer_sasl_options);
      if (sasl.mechanism !== null && sasl.mechanism !== "plain") {
        refusals.push(
          `Kuma authenticates to this cluster with ${sasl.mechanism.toUpperCase()}. ${reasonFor("kafka_producer_sasl_options")}`,
        );
      }
      base.config = {
        topic: row.kafka_producer_topic,
        message: row.kafka_producer_message ?? undefined,
        username: sasl.mechanism === "plain" ? sasl.username : null,
        password: sasl.mechanism === "plain" ? sasl.password : null,
        tls: row.kafka_producer_ssl,
      };
      break;
    }
    case "rabbitmq": {
      const nodes = jsonStrings(row.rabbitmq_nodes);
      if (nodes.length === 0) {
        refusals.push(
          "Kuma stored no management API URL for this monitor, so there is no node for Vigil to ask.",
        );
        base.url = "";
        break;
      }
      base.url = nodes[0] ?? "";
      if (nodes.length > 1) {
        notes.push(
          `${nodes.length - 1} further node(s) — ${nodes.slice(1).join(", ")} — not carried: ${reasonFor("rabbitmq_nodes")}`,
        );
      }
      base.config = {
        username: row.rabbitmq_username,
        password: row.rabbitmq_password,
      };
      break;
    }
    case "sip": {
      base.url = row.hostname ?? "";
      base.port = row.port ?? DEFAULT_SIP_PORT;
      base.config = { transport: "udp", requestUser: null };
      break;
    }
    case "snmp": {
      base.url = row.hostname ?? "";
      base.port = row.port ?? DEFAULT_SNMP_PORT;
      const version = (row.snmp_version ?? "2c").trim();
      const expectation = expectationFrom(row.conditions, "oid", "==");
      if (expectation.unmapped > 0) {
        notes.push(
          `${expectation.unmapped} Kuma condition(s) dropped: ${reasonFor("conditions")}`,
        );
      }
      const config: RawInput = {
        oid: row.snmp_oid ?? undefined,
        version,
        expectedValue: expectation.expectedValue,
      };
      if (version === "3") {
        config.v3Username = row.snmp_v3_username;
        config.community = null;
        if (filled(row.radius_password)) {
          notes.push(
            "The SNMP v3 pass phrase is not carried: Kuma 2.4.0 stores no column saying which authentication protocol it belongs to, and Vigil will not store a pass phrase without knowing what to sign with it. This monitor polls as noAuthNoPriv until you set one.",
          );
        }
      } else if (filled(row.radius_password)) {
        config.community = row.radius_password;
      }
      base.config = config;
      break;
    }
    case "tailscale-ping": {
      base.url = row.hostname ?? "";
      base.config = {};
      break;
    }
    case "websocket": {
      base.url = row.url ?? "";
      const subprotocol = row.ws_subprotocol.trim();
      base.config = {
        subprotocol: subprotocol.length > 0 ? subprotocol : null,
        authorization: null,
      };
      break;
    }
    case "radius": {
      base.url = row.hostname ?? "";
      base.port = row.port ?? DEFAULT_RADIUS_PORT;
      base.config = {
        secret: row.radius_secret,
        username: row.radius_username,
        password: row.radius_password,
        // Kuma's RADIUS check is up only when the server answers
        // Access-Accept, so the imported monitor asserts the same thing.
        // Leaving it off would keep the monitor green through exactly
        // the failure the operator set it up to catch.
        expectAccept: true,
      };
      break;
    }
    case "gamedig": {
      base.url = row.hostname ?? "";
      base.port = row.port;
      const game = (row.game ?? "").trim();
      const protocol = gamedigProtocolFor(game);
      if (protocol === null) {
        refusals.push(
          `Kuma queries the game "${game.length > 0 ? game : "(none)"}". ${reasonFor("game")}`,
        );
        break;
      }
      base.config = { protocol };
      break;
    }
    case "steam": {
      base.url = row.hostname ?? "";
      base.port = row.port ?? DEFAULT_STEAM_PORT;
      break;
    }
    case "system-service": {
      base.url = (row.system_service_name ?? "").trim();
      notes.push(
        "This monitor reads the systemd on the machine running Vigil's worker, not the machine that ran Kuma. Confirm the unit exists there before trusting it.",
      );
      break;
    }
    default: {
      // Unreachable while the type matrix only names types the registry
      // has. The conformance test proves that; this keeps the failure a
      // loud one rather than a monitor with no target if it ever stops
      // being true.
      refusals.push(
        `The type matrix maps this to "${checkType}", which this build has no spec for.`,
      );
      base.url = "";
    }
  }

  // Reported before validation, so the operator reading a skipped row
  // still learns what else would have been lost had it imported.
  if (filled(row.database_query)) {
    notes.push(drop("database_query", row.database_query));
  }
  if (
    KEYWORD_BEARING_KUMA_TYPES.has(row.type ?? "") &&
    row.type !== "keyword" &&
    filled(row.keyword)
  ) {
    notes.push(drop("keyword", row.keyword));
  }
  if (checkType !== "http" && row.expiry_notification) {
    if (URL_BEARING_KUMA_TYPES.has(row.type ?? "")) {
      notes.push(drop("expiry_notification"));
    }
  }
  const conditions = conditionCount(row.conditions);
  if (!CONDITION_AWARE_CHECK_TYPES.has(checkType) && conditions > 0) {
    notes.push(
      `${conditions} Kuma condition(s) dropped: ${reasonFor("conditions")}`,
    );
  }
  for (const candidate of NOTABLE_DROPS) {
    if (!candidate.isSet(row)) continue;
    if (
      candidate.column === "domain_expiry_notification" &&
      !URL_BEARING_KUMA_TYPES.has(row.type ?? "")
    ) {
      continue;
    }
    notes.push(drop(candidate.column));
  }

  // The target is checked here as well as by the create schema so that
  // a row failing for two reasons reports both. An operator who fixes
  // the verb and re-runs should not then discover the URL.
  const target = typeof base.url === "string" ? base.url : "";
  const targetCheck = spec.targetSchema.safeParse(target);
  if (!targetCheck.success) {
    refusals.push(
      `Vigil rejects the target "${target}": ${targetCheck.error.issues[0]?.message ?? "invalid target"}`,
    );
  }

  return { input: base, notes, refusals };
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
}

/* ──────────────────────────── the engine ─────────────────────────── */

/**
 * Rolls back the whole import when the caller only wanted to know.
 *
 * A sentinel thrown from inside the transaction rather than a flag
 * checked after it: Postgres has to be *told* to roll back, and the
 * only way to say so from inside a Drizzle transaction callback is to
 * leave it by throwing. Catching exactly this class is what keeps a
 * genuine failure from being read as a successful dry run.
 */
class DryRunRollback extends Error {
  constructor() {
    super("kuma import dry run");
    this.name = "DryRunRollback";
  }
}

async function withRollbackOnDryRun(
  db: DbClient,
  dryRun: boolean,
  work: (tx: DbClient) => Promise<void>,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await work(tx);
      if (dryRun) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
}

/**
 * Monitors in an order where a group is always created before its
 * members.
 *
 * Kuma allows a group inside a group, so this is a walk rather than a
 * partition. A parent that is missing or that closes a cycle simply
 * stops the walk — the row is still emitted, and `createMonitor` is the
 * one that decides what a nonsensical membership means.
 */
function creationOrder(rows: readonly KumaMonitorRow[]): KumaMonitorRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: KumaMonitorRow[] = [];
  const placed = new Set<number>();
  const visiting = new Set<number>();

  const visit = (row: KumaMonitorRow): void => {
    if (placed.has(row.id) || visiting.has(row.id)) return;
    visiting.add(row.id);
    const parent = row.parent === null ? undefined : byId.get(row.parent);
    if (parent !== undefined) visit(parent);
    visiting.delete(row.id);
    placed.add(row.id);
    ordered.push(row);
  };

  for (const row of rows) visit(row);
  return ordered;
}

/** Whether any monitor anywhere already answers on this push token. */
async function pushTokenTaken(db: DbClient, token: string): Promise<boolean> {
  const rows = await db
    .select({ id: monitors.id })
    .from(monitors)
    .where(
      and(
        eq(monitors.checkType, "push"),
        sql`${monitors.config} ->> 'token' = ${token}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Kuma's timestamps, which are UTC without saying so.
 *
 * `new Date("2026-08-01 02:39:33.673")` is parsed in the *host's* zone
 * by V8, so a worker in Europe/Berlin would read every imported
 * heartbeat as two hours older than it is — and a heartbeat's age is
 * the entire judgment a push monitor makes.
 */
function kumaTimestamp(value: string | null): Date | null {
  if (!filled(value)) return null;
  const normalised = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim())
    ? value.trim()
    : `${value.trim().replace(" ", "T")}Z`;
  const parsed = new Date(normalised);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A slug Vigil's status page rules accept, derived from Kuma's. */
export function vigilStatusPageSlug(kumaSlug: string): string | null {
  const slug = kumaSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return slug.length >= 3 ? slug : null;
}

/**
 * Imports one already-read Kuma database into an organisation.
 *
 * Takes the parsed database rather than a path so the caller controls
 * the file handle — and so a test can hand this a database it mutated
 * in memory without writing a second fixture.
 */
export async function importKumaDatabase(
  db: DbClient,
  actor: KumaImportActor,
  source: KumaDatabase,
  options: KumaImportOptions = {},
): Promise<ImportReport> {
  const drift = schemaDrift(source.schema);
  const sourceFacts = {
    databaseVersion: source.schema.databaseVersion,
    monitorColumnCount: source.schema.monitorColumns.length,
    monitorTypesPresent: source.schema.monitorTypes.length,
  };

  if (drift.length > 0 && options.allowSchemaDrift !== true) {
    const refused = new ReportBuilder();
    for (const monitor of source.monitors) {
      refused.add({
        kind: "monitor",
        sourceId: String(monitor.id),
        label: monitorName(monitor),
        outcome: "skipped",
        detail:
          "Not read: the source database is not the Uptime Kuma release this importer was written against. See the schema drift on this report.",
        monitorId: null,
      });
    }
    return refused.finish("refused", sourceFacts, drift);
  }

  const dryRun = options.dryRun === true;
  const report = new ReportBuilder();
  const dockerHostsById = new Map(
    source.dockerHosts.map((host) => [host.id, host]),
  );
  const remoteBrowsersById = new Map(
    source.remoteBrowsers.map((browser) => [browser.id, browser]),
  );
  const monitorNames = new Map(
    source.monitors.map((monitor) => [monitor.id, monitorName(monitor)]),
  );
  const dockerHostsUsed = new Set<number>();
  const remoteBrowsersUsed = new Set<number>();

  /** Kuma monitor id → the Vigil monitor it became. */
  const created = new Map<number, { id: string; name: string }>();
  /** Kuma monitor id → its report line, emitted in source order later. */
  const monitorEntries = new Map<number, ReportEntry>();
  /** Monitors whose last Kuma heartbeat was carried across. */
  const heartbeatsCarried = new Set<number>();
  const pageEntries: ReportEntry[] = [];

  await withRollbackOnDryRun(db, dryRun, async (tx) => {
    for (const row of creationOrder(source.monitors)) {
      const label = monitorName(row);
      const sourceId = String(row.id);
      const mapping = typeMappingFor(row.type ?? "");

      if (mapping === undefined || mapping.checkType === null) {
        monitorEntries.set(row.id, {
          kind: "monitor",
          sourceId,
          label,
          outcome: "unsupported",
          detail:
            mapping === undefined
              ? `Kuma type "${row.type ?? "(none)"}" has no entry in the type matrix, so nothing can be promised about it.`
              : `Kuma type "${mapping.kumaType}": ${mapping.reason ?? ""}`,
          monitorId: null,
        });
        continue;
      }

      const built = buildMonitorInput(row, mapping.checkType, {
        dockerHostsById,
        remoteBrowsersById,
      });

      if (row.parent !== null) {
        const parent = created.get(row.parent);
        if (parent === undefined) {
          built.notes.push(
            `Belonged to the Kuma group "${monitorNames.get(row.parent) ?? row.parent}", which did not import, so this monitor arrives without a group.`,
          );
        } else {
          built.input.parentId = parent.id;
          built.notes.push(`Kept in the group "${parent.name}".`);
        }
      }

      // The push token is the one setting whose validity depends on
      // rows outside this file: `/api/push/<token>` resolves a caller to
      // exactly one monitor, and the database says so with a unique
      // index. A token already answering for somebody else has to be
      // replaced here rather than blowing up the insert.
      if (mapping.checkType === "push") {
        const config = built.input.config as { token?: string };
        if (typeof config.token === "string") {
          if (await pushTokenTaken(tx, config.token)) {
            delete config.token;
            built.notes.push(
              "The Kuma push token is already in use by another monitor and a new one was generated: one token resolves to one monitor, which the database enforces. Point the job at the new endpoint on the monitor page.",
            );
          }
        }
      }

      const parsed = createMonitorSchema.safeParse(built.input);
      const refusals = [...built.refusals];
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const at = issue.path.join(".");
          const message =
            at.length > 0 ? `${at}: ${issue.message}` : issue.message;
          if (!refusals.some((existing) => existing.includes(issue.message))) {
            refusals.push(`Vigil's monitor rules refuse it — ${message}`);
          }
        }
      }

      if (refusals.length > 0 || !parsed.success) {
        // The notes come too, even though nothing was written. An
        // operator who fixes the URL and re-runs should already know
        // the proxy and the request headers are not coming either,
        // rather than finding out on the second pass.
        const alsoLost =
          built.notes.length === 0
            ? ""
            : ` Had it imported: ${built.notes.join(" ")}`;
        monitorEntries.set(row.id, {
          kind: "monitor",
          sourceId,
          label,
          outcome: "skipped",
          detail: `${refusals.join(" ")}${alsoLost}`,
          monitorId: null,
        });
        continue;
      }

      const monitor = await createMonitor(tx, actor, parsed.data);
      created.set(row.id, { id: monitor.id, name: monitor.name });
      if (!row.active) {
        await setMonitorPaused(tx, actor, monitor.id, true);
      }
      if (row.docker_host !== null) dockerHostsUsed.add(row.docker_host);
      if (row.remote_browser !== null) {
        remoteBrowsersUsed.add(row.remote_browser);
      }

      if (mapping.checkType === "push") {
        const carried = await carryLastHeartbeat(
          tx,
          source,
          row.id,
          monitor.id,
        );
        if (carried !== null) {
          heartbeatsCarried.add(row.id);
          built.notes.push(carried);
        }
      }

      const spec = requireSpec(mapping.checkType);
      const detail =
        built.notes.length === 0
          ? (mapping.transform ?? "Imported unchanged.")
          : [mapping.transform, ...built.notes].filter(Boolean).join(" ");
      monitorEntries.set(row.id, {
        kind: "monitor",
        sourceId,
        label,
        outcome: built.notes.length === 0 ? "imported" : "transformed",
        detail,
        monitorId: monitor.id,
        // Redacted, not raw. The report is rendered, and a rendered
        // MQTT password is the same leak the monitor page closed.
        configPreview:
          monitor.config === null
            ? undefined
            : redactConfig(spec, monitor.config),
      });
    }

    await importStatusPages(tx, actor, source, created, pageEntries);
  });

  /* The report, in Kuma's own order. Creation had to run parents-first;
   * a person reading this is comparing it to a Kuma screen. */
  for (const row of source.monitors) {
    const entry = monitorEntries.get(row.id);
    if (entry !== undefined) report.add(entry);
  }
  for (const entry of pageEntries) report.add(entry);

  /* Everything Kuma holds that Vigil has nowhere to put. None of it is
   * created — notification providers, tags and maintenance windows are
   * capabilities Vigil does not have rather than shapes it stores
   * differently — so each record gets the line that stops it
   * disappearing quietly. */

  for (const notification of source.notifications) {
    report.add({
      kind: "notification",
      sourceId: String(notification.id),
      label: notification.name,
      outcome: "unsupported",
      detail: `A Kuma "${notification.provider ?? "unknown"}" provider. Vigil routes alerts through an organisation-wide webhook endpoint and its escalation policies rather than per-monitor providers, and this importer copies no provider credentials — it does not even read them. Recreate the channel under Settings → Notifications; the imported monitors will use it without being attached to it.`,
      monitorId: null,
    });
  }

  for (const link of source.monitorNotifications) {
    report.add({
      kind: "notification-link",
      sourceId: `${link.monitorId}:${link.notificationId}`,
      label: `${monitorNames.get(link.monitorId) ?? link.monitorId} → notification ${link.notificationId}`,
      outcome: "unsupported",
      detail:
        "Kuma attaches notification providers to individual monitors. Vigil decides who is told by escalation policy, which is a property of the policy rather than of the monitor, so there is no per-monitor attachment to recreate.",
      monitorId: null,
    });
  }

  for (const tag of source.tags) {
    report.add({
      kind: "tag",
      sourceId: String(tag.id),
      label: tag.name,
      outcome: "unsupported",
      detail:
        "Vigil has no monitor tags. Nothing in the schema can hold the name or its colour.",
      monitorId: null,
    });
  }

  for (const applied of source.monitorTags) {
    report.add({
      kind: "tag-application",
      sourceId: `${applied.monitorId}:${applied.tagId}`,
      label: `${monitorNames.get(applied.monitorId) ?? applied.monitorId} tagged ${applied.tagId}`,
      outcome: "unsupported",
      detail: `Tag applied${applied.value !== null && applied.value.length > 0 ? ` with the value "${applied.value}"` : ""}. Vigil has no monitor tags. A group is the nearest thing and is not the same thing — a monitor belongs to one group and carries any number of tags.`,
      monitorId: null,
    });
  }

  for (const window of source.maintenances) {
    report.add({
      kind: "maintenance",
      sourceId: String(window.id),
      label: window.title,
      outcome: "unsupported",
      detail: `A "${window.strategy}" maintenance window${window.cron !== null && window.cron.length > 0 ? ` on cron "${window.cron}"` : ""}${window.timezone !== null && window.timezone.length > 0 ? ` in ${window.timezone}` : ""}. Vigil has no maintenance windows, so the imported monitors will alert during it. Pause them for planned work instead.`,
      monitorId: null,
    });
  }

  for (const link of source.monitorMaintenances) {
    report.add({
      kind: "maintenance-link",
      sourceId: `${link.monitorId}:${link.maintenanceId}`,
      label: `${monitorNames.get(link.monitorId) ?? link.monitorId} in maintenance ${link.maintenanceId}`,
      outcome: "unsupported",
      detail:
        "Vigil has no maintenance windows to attach a monitor to. Pause the monitor for planned work instead.",
      monitorId: null,
    });
  }

  for (const host of source.dockerHosts) {
    const used = dockerHostsUsed.has(host.id);
    report.add({
      kind: "docker-host",
      sourceId: String(host.id),
      label: host.name,
      outcome: used ? "transformed" : "unsupported",
      detail: used
        ? "Vigil has no Docker host registry. The daemon address was copied onto each imported Docker monitor's socketPath, so editing it later is a per-monitor edit."
        : "Vigil has no Docker host registry, and no imported monitor referenced this host.",
      monitorId: null,
    });
  }

  for (const browser of source.remoteBrowsers) {
    const used = remoteBrowsersUsed.has(browser.id);
    report.add({
      kind: "remote-browser",
      sourceId: String(browser.id),
      label: browser.name,
      outcome: used ? "transformed" : "unsupported",
      detail: used
        ? "Vigil has no renderer registry. The service URL was copied onto each imported real-browser monitor's serviceUrl, so editing it later is a per-monitor edit."
        : "Vigil has no renderer registry, and no imported monitor referenced this browser. Set BROWSER_SERVICE_URL to give every real-browser monitor one renderer.",
      monitorId: null,
    });
  }

  for (const proxy of source.proxies) {
    report.add({
      kind: "proxy",
      sourceId: String(proxy.id),
      label: `${proxy.protocol}://${proxy.host}${proxy.port === null ? "" : `:${proxy.port}`}`,
      outcome: "unsupported",
      detail: `${reasonFor("proxy_id")}${proxy.authenticated ? " Its credentials were not read from the source at all." : ""}`,
      monitorId: null,
    });
  }

  for (const history of source.heartbeats) {
    const carried = heartbeatsCarried.has(history.monitorId);
    report.add({
      kind: "heartbeat-history",
      sourceId: String(history.monitorId),
      label: monitorNames.get(history.monitorId) ?? String(history.monitorId),
      outcome: carried ? "transformed" : "unsupported",
      detail: carried
        ? `The last of ${history.beats} heartbeat(s) was carried, so this monitor arrives knowing when it was last heard from rather than knowing nothing. The beats before it, and the daily, hourly and minutely statistics derived from them, stay in Kuma: Vigil's uptime is duration-weighted over observations it made itself and hashed into its own ledger, so importing another system's beats would put unverifiable rows in a chain whose whole purpose is that every row is verifiable.`
        : `${history.beats} heartbeat(s), and the daily, hourly and minutely statistics derived from them, stay in Kuma. Vigil's uptime is duration-weighted over observations it made itself and hashed into its own ledger, so importing another system's beats would put unverifiable rows in a chain whose whole purpose is that every row is verifiable. Only a push monitor's latest beat has a Vigil row to land in, and this monitor has none.`,
      monitorId: null,
    });
  }

  return report.finish(dryRun ? "preview" : "completed", sourceFacts, drift);
}

/**
 * Carries a push monitor's most recent Kuma heartbeat, or explains why
 * not.
 *
 * Only the latest, because `monitor_heartbeats` holds one row per
 * monitor: it is current state, not history. Carrying it is the more
 * honest of the two options, not the more generous one — a monitor
 * created with no beat is "silent since it was created ten seconds
 * ago", which is a claim nobody made, where "last heard from at 09:14"
 * is a fact Kuma recorded. When that fact is old, the monitor reads
 * down on its first evaluation, and it is right to.
 *
 * @returns a note for the report, or null when there was nothing to carry
 */
async function carryLastHeartbeat(
  db: DbClient,
  source: KumaDatabase,
  kumaMonitorId: number,
  monitorId: string,
): Promise<string | null> {
  const history = source.heartbeats.find(
    (entry) => entry.monitorId === kumaMonitorId,
  );
  if (history === undefined) return null;
  const receivedAt = kumaTimestamp(history.lastAt);
  if (receivedAt === null) return null;
  // 1 is up and 0 is down; Kuma's `pending` and `maintenance` are
  // states of Kuma's own scheduler rather than things the job said
  // about itself, and there is no honest way to report them as a
  // heartbeat.
  const reportedStatus =
    history.lastStatus === 1 ? "up" : history.lastStatus === 0 ? "down" : null;
  if (reportedStatus === null) {
    return `The last Kuma heartbeat was in state ${history.lastStatus ?? "(none)"}, which is Kuma's own scheduler talking rather than the job, so it was not carried.`;
  }

  await db.insert(monitorHeartbeats).values({
    monitorId,
    receivedAt,
    reportedStatus,
    message: history.lastMessage,
    responseTimeMs: history.lastPingMs,
  });

  return `The last heartbeat Kuma received (${reportedStatus}, ${receivedAt.toISOString()}) was carried, so this monitor is judged against when the job actually last reported in.`;
}

/**
 * Status pages, which Vigil does have — unlike notification providers,
 * tags and maintenance windows.
 *
 * Three things carry: the page, its published state and which monitors
 * are on it. Two do not, and one of them matters more than it looks:
 *
 * - **Kuma's public groups.** A Kuma page arranges its monitors into
 *   named sections; Vigil's holds one ordered list. The monitors are
 *   carried, the sections are reported, and the order within them is
 *   preserved so the page reads the same way top to bottom.
 * - **A shared password.** Kuma hashes it with bcrypt and Vigil with
 *   scrypt, so it cannot be verified and cannot be re-hashed without
 *   the plaintext. A page that was behind a password is therefore
 *   created **private** — members of the organisation only — and never
 *   public. Publishing it openly would turn a migration into a
 *   disclosure, and doing that silently is worse than not importing it.
 */
async function importStatusPages(
  db: DbClient,
  actor: KumaImportActor,
  source: KumaDatabase,
  created: ReadonlyMap<number, { id: string; name: string }>,
  entries: ReportEntry[],
): Promise<void> {
  /** Vigil's status page cap; anything past it is reported, not lost. */
  const MAX_PAGE_MONITORS = 50;

  /** Kuma monitor ids that ended up on a Vigil page, per group row. */
  const placed = new Set<number>();
  /** Group rows whose page produced a `status-page-group` line already. */
  const reportedGroups = new Set<number>();

  for (const page of source.statusPages) {
    const label = page.title.length > 0 ? page.title : page.slug;
    const notes: string[] = [];
    const groups = source.statusPageGroups.filter(
      (group) => group.statusPageId === page.id,
    );
    const base = vigilStatusPageSlug(page.slug);

    const refusePage = (detail: string): void => {
      entries.push({
        kind: "status-page",
        sourceId: String(page.id),
        label,
        outcome: "skipped",
        detail,
        monitorId: null,
      });
      for (const group of groups) {
        reportedGroups.add(group.id);
        entries.push({
          kind: "status-page-group",
          sourceId: String(group.id),
          label: group.name,
          outcome: "unsupported",
          detail: `A public section on a Kuma status page that did not import, so there is no Vigil page for it to be a section of. The page's own report line says why.`,
          monitorId: null,
        });
      }
    };

    if (base === null) {
      refusePage(
        `The Kuma slug "${page.slug}" cannot become a Vigil one: a slug is 3–63 characters of lowercase letters, digits and dashes, because it is the public URL. Create the page by hand and add the imported monitors to it.`,
      );
      continue;
    }

    // Asked before inserting rather than caught afterwards. A slug is
    // globally unique because it is a public URL, so the clash may be
    // with another tenant's page — and a failed insert inside this
    // transaction would take the whole migration down with it.
    //
    // Suffixed rather than refused, because losing a page and its whole
    // monitor list over a name somebody else took first is a bad trade
    // for an operator who can rename it in one edit. The new URL is on
    // the report; nothing about it is silent.
    const slug = await freeSlug(db, base);
    if (slug === null) {
      refusePage(
        `The slug "${base}" and every variation of it this importer tried are already in use, and a slug is the public URL so it can only belong to one page. Create the page under another slug and add the imported monitors to it.`,
      );
      continue;
    }
    if (slug !== page.slug) {
      notes.push(
        `The slug was rewritten from "${page.slug}" to "${slug}", so the public URL is /status/${slug}.`,
      );
    }

    const vigilPage = await createStatusPage(db, actor, {
      name: label.slice(0, 100),
      slug,
    });

    if (page.passwordProtected) {
      notes.push(
        "Kuma kept this page behind a shared password, which cannot be carried — Kuma hashes it with bcrypt and Vigil with scrypt, and neither can produce the other without the plaintext. The page is imported as private, visible to members of this organisation only, so a migration cannot become a disclosure. Set a password to make it shared again.",
      );
    }
    await updateStatusPage(db, actor, {
      statusPageId: vigilPage.id,
      name: label.slice(0, 100),
      slug,
      published: page.published,
      showBranding: page.showPoweredBy,
      visibility: page.passwordProtected ? "private" : "public",
    });

    const untheme = [
      page.hasCustomCss ? "custom CSS" : null,
      page.hasFooterText ? "footer text" : null,
      page.analyticsType !== null ? `${page.analyticsType} analytics` : null,
      page.autoRefreshInterval !== null
        ? `a ${page.autoRefreshInterval}s refresh interval`
        : null,
    ].filter((value): value is string => value !== null);
    if (untheme.length > 0) {
      notes.push(
        `${untheme.join(", ")} not carried: Vigil's status pages have their own theming and their own refresh, and no field holds injected CSS or a third-party analytics script.`,
      );
    }

    // Kuma's public groups, in their own order, flattened into the one
    // ordered list a Vigil page holds.
    const members: { monitorId: string; displayName: null }[] = [];
    for (const group of groups) {
      const inGroup = source.statusPageGroupMonitors.filter(
        (member) => member.groupId === group.id,
      );
      let carried = 0;
      for (const member of inGroup) {
        const monitor = created.get(member.monitorId);
        if (monitor === undefined) continue;
        if (members.some((existing) => existing.monitorId === monitor.id)) {
          continue;
        }
        if (members.length >= MAX_PAGE_MONITORS) continue;
        members.push({ monitorId: monitor.id, displayName: null });
        placed.add(member.monitorId);
        carried += 1;
      }
      reportedGroups.add(group.id);
      entries.push({
        kind: "status-page-group",
        sourceId: String(group.id),
        label: group.name,
        outcome: "unsupported",
        detail: `A public section on a Kuma status page. Vigil's status page holds one ordered list rather than named sections, so ${carried} of this section's ${inGroup.length} monitor(s) were added to /status/${slug} in their Kuma order and the section's own name was not.`,
        monitorId: null,
      });
    }

    await setStatusPageMonitors(db, actor, {
      statusPageId: vigilPage.id,
      monitors: members,
    });

    entries.push({
      kind: "status-page",
      sourceId: String(page.id),
      label,
      outcome: notes.length === 0 ? "imported" : "transformed",
      detail:
        `Imported as /status/${slug} with ${members.length} monitor(s)${page.published ? ", published" : ", unpublished as it was in Kuma"}. ${notes.join(" ")}`.trim(),
      monitorId: null,
    });
  }

  // A group row whose `status_page_id` names no page in this database.
  // Kuma leaves these behind when a page is deleted, and the rule is
  // that nothing leaves without a line.
  for (const group of source.statusPageGroups) {
    if (reportedGroups.has(group.id)) continue;
    entries.push({
      kind: "status-page-group",
      sourceId: String(group.id),
      label: group.name,
      outcome: "unsupported",
      detail:
        "A public section belonging to no status page in this database, so there was nothing to import it onto. Vigil's status pages hold one ordered list rather than named sections in any case.",
      monitorId: null,
    });
  }

  // Every monitor a Kuma page showed, whether or not it made the trip.
  for (const member of source.statusPageGroupMonitors) {
    const monitor = created.get(member.monitorId);
    const onPage = placed.has(member.monitorId);
    entries.push({
      kind: "status-page-monitor",
      sourceId: `${member.groupId}:${member.monitorId}`,
      label: `${
        source.monitors.find((row) => row.id === member.monitorId)?.name ??
        member.monitorId
      } on status page group ${member.groupId}`,
      outcome: onPage ? "imported" : "unsupported",
      detail: onPage
        ? `Published on the imported status page as "${monitor?.name ?? member.monitorId}".`
        : monitor === undefined
          ? "This monitor did not import, so it is not on a Vigil status page either. Its own report line says why."
          : "The status page it appeared on did not import, so this monitor is not published anywhere yet. Add it to a Vigil status page to publish it.",
      // Deliberately null even though a monitor exists: `monitorsCreated`
      // counts the entries that carry an id, and this monitor is
      // already counted by its own line.
      monitorId: null,
    });
  }
}

/**
 * The first free slug at or after `base`, or null when there is none
 * within a handful of tries.
 *
 * Bounded rather than open-ended: a loop that keeps counting would, on
 * a busy install, spend a query per attempt inside the one transaction
 * the whole migration depends on. Ten is more than enough for a real
 * collision and small enough that an adversary learns nothing about
 * other tenants' slugs that the "already in use" message does not
 * already tell them.
 */
async function freeSlug(db: DbClient, base: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base.slice(0, 60)}-${attempt}`;
    const taken = await db.query.statusPages.findFirst({
      where: eq(statusPages.slug, candidate),
      columns: { id: true },
    });
    if (taken === undefined) return candidate;
  }
  return null;
}
