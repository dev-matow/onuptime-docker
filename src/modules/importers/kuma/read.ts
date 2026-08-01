import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import {
  FIELD_MATRIX,
  TYPE_MATRIX,
  type ColumnKind,
  type KumaMonitorRow,
} from "./mapping";
import { KUMA_PIN, type SchemaDrift } from "./pinned";

/**
 * Reading an Uptime Kuma database. Nothing here writes anything.
 *
 * `node:sqlite` ships with Node 24 and later, so this costs no
 * dependency — which matters more than it sounds. An importer that
 * pulls a native SQLite binding into the production image adds a
 * compile step and a supply-chain edge to a feature that runs once per
 * customer, ever.
 *
 * The handle is opened read-only and closed in a `finally`. A migration
 * tool that corrupts the database it was pointed at is worse than one
 * that refuses to run: the operator still has Kuma, and Kuma is what
 * they are relying on until the migration is proved. `readOnly` is as
 * far as that goes: SQLite still touches the `-shm` index beside a
 * WAL-mode database to read it at all, so the file is byte-identical
 * afterwards but its sidecar's mtime is not. Pointing this at a copy
 * remains the right advice.
 *
 * Rows are coerced through the field matrix rather than trusted as they
 * come back. SQLite is dynamically typed — a column declared BOOLEAN
 * holds whatever was written to it — so `active` arrives as 0, 1, '0',
 * '1' or null depending on which Kuma version wrote the row, and
 * `if (row.active)` is true for the string '0'.
 */

type RawRow = Record<string, SQLOutputValue>;

function readText(row: RawRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return typeof value === "string" ? value : String(value);
}

function readNumber(row: RawRow, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * SQLite's truthiness, not JavaScript's. `'0'` is what Kuma's later
 * migrations write for false — a non-empty string, and therefore true
 * to every naive check.
 */
function readBoolean(row: RawRow, column: string): boolean {
  const value = row[column];
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0";
  return true;
}

function coerce(row: RawRow, column: string, kind: ColumnKind): unknown {
  switch (kind) {
    case "bool":
      return readBoolean(row, column);
    case "int":
    case "real":
      return readNumber(row, column) ?? 0;
    case "int?":
      return readNumber(row, column);
    case "text":
      return readText(row, column) ?? "";
    case "text?":
      return readText(row, column);
  }
}

/* ───────────────────────── the other tables ──────────────────────── */

export interface KumaNotification {
  id: number;
  name: string;
  active: boolean;
  isDefault: boolean;
  /** Kuma's provider id, read out of the JSON config blob. */
  provider: string | null;
}

export interface KumaMonitorNotification {
  monitorId: number;
  notificationId: number;
}

export interface KumaStatusPage {
  id: number;
  slug: string;
  title: string;
  published: boolean;
  autoRefreshInterval: number | null;
  hasCustomCss: boolean;
  hasFooterText: boolean;
  analyticsType: string | null;
  /** Kuma's "Powered by Uptime Kuma" line — Vigil's `showBranding`. */
  showPoweredBy: boolean;
  /**
   * Whether Kuma held a shared password for this page.
   *
   * The hash itself is deliberately not read — it is bcrypt over a
   * secret Vigil hashes with scrypt, so it could never be verified —
   * but *that there was one* has to travel, because a page imported as
   * `public` when Kuma kept it behind a password is a disclosure, not a
   * migration. It decides the visibility the page is created with.
   */
  passwordProtected: boolean;
}

/** A public group on a status page — Kuma's `group` table. */
export interface KumaStatusPageGroup {
  id: number;
  name: string;
  statusPageId: number | null;
  isPublic: boolean;
}

export interface KumaStatusPageGroupMonitor {
  groupId: number;
  monitorId: number;
}

export interface KumaTag {
  id: number;
  name: string;
  color: string | null;
}

export interface KumaMonitorTag {
  monitorId: number;
  tagId: number;
  value: string | null;
}

export interface KumaMaintenance {
  id: number;
  title: string;
  strategy: string;
  active: boolean;
  cron: string | null;
  timezone: string | null;
}

export interface KumaMonitorMaintenance {
  monitorId: number;
  maintenanceId: number;
}

export interface KumaDockerHost {
  id: number;
  name: string;
  /** `socket`, `tcp` or `host` — decides how `daemon` is read. */
  dockerType: string;
  daemon: string;
}

export interface KumaProxy {
  id: number;
  protocol: string;
  host: string;
  port: number | null;
  /** Whether the proxy carries credentials. The credentials themselves
   * are deliberately not read: nothing downstream can use them, and a
   * secret that is never loaded is a secret that cannot leak. */
  authenticated: boolean;
}

/**
 * A browser Kuma renders through — the `remote_browser` table.
 *
 * Read for the same reason `docker_host` is: it is a registry Vigil
 * does not have, and its one useful field belongs on each monitor that
 * pointed at it rather than nowhere.
 */
export interface KumaRemoteBrowser {
  id: number;
  name: string;
  /** The renderer's base URL. */
  url: string;
}

/**
 * Heartbeats, counted rather than listed — plus the most recent one.
 *
 * A fixture holds a few hundred; a real Kuma holds millions, and
 * loading them to report that none of them are imported would make the
 * report cost more than the import. The count is what the report needs
 * — an operator has to know how much history stays behind.
 *
 * The *last* beat is read as well, and only the last, because it is the
 * one thing a Vigil monitor can hold: `monitor_heartbeats` stores the
 * latest report a passive monitor received and nothing before it. For a
 * push monitor that is the difference between arriving with "last heard
 * from at 09:14" and arriving having never been heard from at all.
 *
 * Cheap, despite the aggregate: SQLite resolves the bare columns beside
 * a `max()` from the row that produced the maximum, so this is one
 * grouped scan rather than a correlated subquery per monitor.
 */
export interface KumaHeartbeatHistory {
  monitorId: number;
  beats: number;
  /** Kuma's timestamp for the last beat, as it stored it. */
  lastAt: string | null;
  /** Kuma's numeric status: 0 down, 1 up, 2 pending, 3 maintenance. */
  lastStatus: number | null;
  lastMessage: string | null;
  /** Round trip Kuma measured, in milliseconds. */
  lastPingMs: number | null;
}

export interface KumaSchemaFacts {
  /** `setting.database_version`, or null when the row is missing. */
  databaseVersion: number | null;
  /** Every column on `monitor`, in declaration order. */
  monitorColumns: string[];
  /** Distinct values present in `monitor.type`. */
  monitorTypes: string[];
}

export interface KumaDatabase {
  schema: KumaSchemaFacts;
  monitors: KumaMonitorRow[];
  notifications: KumaNotification[];
  monitorNotifications: KumaMonitorNotification[];
  statusPages: KumaStatusPage[];
  statusPageGroups: KumaStatusPageGroup[];
  statusPageGroupMonitors: KumaStatusPageGroupMonitor[];
  tags: KumaTag[];
  monitorTags: KumaMonitorTag[];
  maintenances: KumaMaintenance[];
  monitorMaintenances: KumaMonitorMaintenance[];
  dockerHosts: KumaDockerHost[];
  remoteBrowsers: KumaRemoteBrowser[];
  proxies: KumaProxy[];
  heartbeats: KumaHeartbeatHistory[];
}

function all(db: DatabaseSync, sql: string): RawRow[] {
  return db.prepare(sql).all();
}

function readMonitor(row: RawRow): KumaMonitorRow {
  const monitor: Record<string, unknown> = {};
  for (const field of FIELD_MATRIX) {
    monitor[field.column] = coerce(row, field.column, field.kind);
  }
  // Sound because the loop assigns exactly the columns the matrix
  // declares, with exactly the kinds `KumaMonitorRow` is derived from —
  // and the schema check proves the source has no others.
  return monitor as KumaMonitorRow;
}

/** The JSON `config` blob's `type`, which is the provider id. */
function providerOf(config: string | null): string | null {
  if (config === null) return null;
  try {
    const parsed: unknown = JSON.parse(config);
    if (typeof parsed !== "object" || parsed === null) return null;
    const type = (parsed as Record<string, unknown>).type;
    return typeof type === "string" ? type : null;
  } catch {
    // A config Kuma cannot parse either. The notification is still
    // reported; only its provider name is unknown.
    return null;
  }
}

/**
 * Reads one Kuma database into memory.
 *
 * @param path filesystem path to `kuma.db`; opened read-only
 */
export function readKumaDatabase(path: string): KumaDatabase {
  // A busy timeout because the likely source is a *running* Kuma. WAL
  // readers do not block on a writer, but a database still in rollback
  // -journal mode does, and failing an entire migration on one
  // SQLITE_BUSY the operator cannot see is not a useful default.
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
  try {
    const columns = all(db, "pragma table_info(monitor)")
      .map((row) => readText(row, "name"))
      .filter((name): name is string => name !== null);

    const versionRow = db
      .prepare("select value from setting where key = 'database_version'")
      .get();
    const databaseVersion =
      versionRow === undefined ? null : readNumber(versionRow, "value");

    const monitors = all(db, "select * from monitor order by id").map(
      readMonitor,
    );

    return {
      schema: {
        databaseVersion,
        monitorColumns: columns,
        monitorTypes: all(
          db,
          "select distinct type from monitor where type is not null order by type",
        )
          .map((row) => readText(row, "type"))
          .filter((type): type is string => type !== null),
      },
      monitors,
      notifications: all(db, "select * from notification order by id").map(
        (row) => ({
          id: readNumber(row, "id") ?? 0,
          name: readText(row, "name") ?? "",
          active: readBoolean(row, "active"),
          isDefault: readBoolean(row, "is_default"),
          provider: providerOf(readText(row, "config")),
        }),
      ),
      monitorNotifications: all(
        db,
        "select monitor_id, notification_id from monitor_notification order by id",
      ).map((row) => ({
        monitorId: readNumber(row, "monitor_id") ?? 0,
        notificationId: readNumber(row, "notification_id") ?? 0,
      })),
      statusPages: all(db, "select * from status_page order by id").map(
        (row) => ({
          id: readNumber(row, "id") ?? 0,
          slug: readText(row, "slug") ?? "",
          title: readText(row, "title") ?? "",
          published: readBoolean(row, "published"),
          autoRefreshInterval: readNumber(row, "auto_refresh_interval"),
          hasCustomCss: (readText(row, "custom_css") ?? "").trim().length > 0,
          hasFooterText: (readText(row, "footer_text") ?? "").trim().length > 0,
          analyticsType: readText(row, "analytics_type"),
          showPoweredBy: readBoolean(row, "show_powered_by"),
          passwordProtected:
            (readText(row, "password") ?? "").trim().length > 0,
        }),
      ),
      // `group` is a reserved word in SQL; Kuma's own queries quote it.
      statusPageGroups: all(db, 'select * from "group" order by id').map(
        (row) => ({
          id: readNumber(row, "id") ?? 0,
          name: readText(row, "name") ?? "",
          statusPageId: readNumber(row, "status_page_id"),
          isPublic: readBoolean(row, "public"),
        }),
      ),
      statusPageGroupMonitors: all(
        db,
        "select group_id, monitor_id from monitor_group order by id",
      ).map((row) => ({
        groupId: readNumber(row, "group_id") ?? 0,
        monitorId: readNumber(row, "monitor_id") ?? 0,
      })),
      tags: all(db, "select * from tag order by id").map((row) => ({
        id: readNumber(row, "id") ?? 0,
        name: readText(row, "name") ?? "",
        color: readText(row, "color"),
      })),
      monitorTags: all(
        db,
        "select monitor_id, tag_id, value from monitor_tag order by id",
      ).map((row) => ({
        monitorId: readNumber(row, "monitor_id") ?? 0,
        tagId: readNumber(row, "tag_id") ?? 0,
        value: readText(row, "value"),
      })),
      maintenances: all(db, "select * from maintenance order by id").map(
        (row) => ({
          id: readNumber(row, "id") ?? 0,
          title: readText(row, "title") ?? "",
          strategy: readText(row, "strategy") ?? "",
          active: readBoolean(row, "active"),
          cron: readText(row, "cron"),
          timezone: readText(row, "timezone"),
        }),
      ),
      monitorMaintenances: all(
        db,
        "select monitor_id, maintenance_id from monitor_maintenance order by id",
      ).map((row) => ({
        monitorId: readNumber(row, "monitor_id") ?? 0,
        maintenanceId: readNumber(row, "maintenance_id") ?? 0,
      })),
      dockerHosts: all(db, "select * from docker_host order by id").map(
        (row) => ({
          id: readNumber(row, "id") ?? 0,
          name: readText(row, "name") ?? "",
          dockerType: readText(row, "docker_type") ?? "socket",
          daemon: readText(row, "docker_daemon") ?? "",
        }),
      ),
      remoteBrowsers: all(db, "select * from remote_browser order by id").map(
        (row) => ({
          id: readNumber(row, "id") ?? 0,
          name: readText(row, "name") ?? "",
          url: readText(row, "url") ?? "",
        }),
      ),
      proxies: all(db, "select * from proxy order by id").map((row) => ({
        id: readNumber(row, "id") ?? 0,
        protocol: readText(row, "protocol") ?? "",
        host: readText(row, "host") ?? "",
        port: readNumber(row, "port"),
        authenticated: readBoolean(row, "auth"),
      })),
      heartbeats: all(
        db,
        // `max(time)` with bare columns beside it: SQLite fills them
        // from the row that produced the maximum, which is the last
        // beat. Documented behaviour, not an accident of the planner.
        "select monitor_id, count(*) as beats, max(time) as last_time, status as last_status, msg as last_msg, ping as last_ping from heartbeat group by monitor_id order by monitor_id",
      ).map((row) => ({
        monitorId: readNumber(row, "monitor_id") ?? 0,
        beats: readNumber(row, "beats") ?? 0,
        lastAt: readText(row, "last_time"),
        lastStatus: readNumber(row, "last_status"),
        lastMessage: readText(row, "last_msg"),
        lastPingMs: readNumber(row, "last_ping"),
      })),
    };
  } finally {
    db.close();
  }
}

/**
 * Every way the source disagrees with the pinned release.
 *
 * Empty means the database is the one this importer was written and
 * tested against. Anything else is a database whose columns might mean
 * something other than what the field matrix says they mean — which is
 * precisely the condition under which importing anyway is worse than
 * refusing, because the result is a set of monitors that look right.
 *
 * Reports the drift rather than throwing: the caller renders it, and an
 * operator on Kuma 2.5.0 deserves to be told what changed instead of
 * getting a stack trace.
 */
export function schemaDrift(facts: KumaSchemaFacts): SchemaDrift[] {
  const drift: SchemaDrift[] = [];

  if (facts.databaseVersion !== KUMA_PIN.databaseVersion) {
    drift.push({
      subject: "database_version",
      detail: `This importer was written against Uptime Kuma ${KUMA_PIN.release} (database_version ${KUMA_PIN.databaseVersion}). The source reports ${facts.databaseVersion ?? "no version at all"}.`,
    });
  }

  const known: ReadonlySet<string> = new Set<string>(
    FIELD_MATRIX.map((field) => field.column),
  );
  const present: ReadonlySet<string> = new Set(facts.monitorColumns);
  const added = facts.monitorColumns.filter((column) => !known.has(column));
  const missing = FIELD_MATRIX.map((field) => field.column).filter(
    (column) => !present.has(column),
  );
  if (added.length > 0) {
    drift.push({
      subject: "monitor_columns",
      detail: `The monitor table has ${added.length} column(s) this importer has never classified: ${added.join(", ")}. Whatever they hold would be dropped without a word.`,
    });
  }
  if (missing.length > 0) {
    drift.push({
      subject: "monitor_columns",
      detail: `The monitor table is missing ${missing.length} column(s) this importer expects: ${missing.join(", ")}.`,
    });
  }

  const unknownTypes = facts.monitorTypes.filter(
    (type) => !KNOWN_TYPES.has(type),
  );
  if (unknownTypes.length > 0) {
    drift.push({
      subject: "monitor_types",
      detail: `The source contains monitor type(s) this importer has no matrix entry for: ${unknownTypes.join(", ")}. A type nobody has classified is a monitor nobody can promise to carry across.`,
    });
  }

  return drift;
}

/** Built once, so drift checking stays linear in the source's types. */
const KNOWN_TYPES: ReadonlySet<string> = new Set(
  TYPE_MATRIX.map((entry) => entry.kumaType),
);
