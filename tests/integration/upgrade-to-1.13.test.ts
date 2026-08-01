import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Upgrading a database that already carries the damage.
 *
 * `incidents_one_active_per_monitor` is the invariant the pre-1.13.0
 * code could not hold, so a database that has been running long enough
 * may already contain exactly the rows the new index forbids. A
 * migration that simply issues CREATE UNIQUE INDEX fails on those
 * databases and takes the whole upgrade down — on the deployments that
 * hit the bug hardest, which is the worst possible selection.
 *
 * This builds a 1.12.0 database, puts duplicate active automatic
 * incidents in it by hand, runs 0015, and checks that the upgrade
 * succeeds, keeps the incident operators were actually paged about, and
 * explains what it closed.
 */
const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");
const LAST_1_12_MIGRATION = "0014";
const INVARIANT_MIGRATION = "0015";

const MONITOR_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MONITOR_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ORIGINAL = "10000000-0000-0000-0000-000000000001";
const DUPLICATE_ONE = "10000000-0000-0000-0000-000000000002";
const DUPLICATE_TWO = "10000000-0000-0000-0000-000000000003";
const MANUAL = "10000000-0000-0000-0000-000000000004";
const OTHER_MONITOR = "10000000-0000-0000-0000-000000000005";
const ORPHANED = "10000000-0000-0000-0000-000000000006";

let admin: Client;
let client: Client;
let database: string;

async function migrationsUpTo(prefix: string): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const index = files.findIndex((name) => name.startsWith(prefix));
  if (index === -1) throw new Error(`No migration starting with ${prefix}`);
  return files.slice(0, index + 1);
}

async function apply(files: string[]): Promise<void> {
  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await client.query(sql);
  }
}

async function migrationNamed(prefix: string): Promise<string> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) =>
    name.startsWith(prefix),
  );
  const file = files[0];
  if (!file) throw new Error(`No migration starting with ${prefix}`);
  return file;
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  database = `vigil_upgrade_113_${randomUUID().slice(0, 8)}`;

  admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);

  url.pathname = `/${database}`;
  client = new Client({ connectionString: url.toString() });
  await client.connect();

  await apply(await migrationsUpTo(LAST_1_12_MIGRATION));

  await client.query(`
    INSERT INTO "user"(id, name, email, email_verified, created_at, updated_at)
      VALUES ('u1', 'Ada', 'ada@example.com', true, now(), now());
    INSERT INTO organization(id, name, slug, created_at)
      VALUES ('o1', 'Acme', 'acme', now());

    INSERT INTO monitors
      (id, organization_id, name, url, check_type, method, interval_seconds,
       timeout_ms, degraded_threshold_ms, tls_check, tls_warn_days,
       current_status, paused, created_by)
    VALUES
      ('${MONITOR_A}', 'o1', 'Checkout', 'https://shop.example.com/health',
       'http', 'GET', 60, 10000, 3000, false, 14, 'down', false, 'u1'),
      ('${MONITOR_B}', 'o1', 'Search', 'https://search.example.com/health',
       'http', 'GET', 60, 10000, 3000, false, 14, 'down', false, 'u1');

    -- What the race actually produced: three live automatic incidents for
    -- one monitor, the first of which is the one that paged people.
    INSERT INTO incidents
      (id, organization_id, title, status, severity, source, monitor_id,
       started_at, notified_at, created_at, updated_at)
    VALUES
      ('${ORIGINAL}', 'o1', 'Checkout is down', 'identified', 'critical',
       'monitor', '${MONITOR_A}', now() - interval '3 hours',
       now() - interval '3 hours', now() - interval '3 hours', now()),
      ('${DUPLICATE_ONE}', 'o1', 'Checkout is down', 'investigating', 'critical',
       'monitor', '${MONITOR_A}', now() - interval '2 hours', NULL,
       now() - interval '2 hours', now()),
      ('${DUPLICATE_TWO}', 'o1', 'Checkout is down', 'monitoring', 'critical',
       'monitor', '${MONITOR_A}', now() - interval '1 hour', NULL,
       now() - interval '1 hour', now()),
      -- A manual incident on the same monitor: not the invariant's business.
      ('${MANUAL}', 'o1', 'Customer reports', 'investigating', 'major',
       'manual', '${MONITOR_A}', now() - interval '90 minutes', NULL,
       now() - interval '90 minutes', now()),
      -- A different monitor's single incident: must be left alone.
      ('${OTHER_MONITOR}', 'o1', 'Search is down', 'investigating', 'major',
       'monitor', '${MONITOR_B}', now() - interval '30 minutes', NULL,
       now() - interval '30 minutes', now()),
      -- Orphaned by ON DELETE SET NULL when its monitor was deleted.
      ('${ORPHANED}', 'o1', 'Deleted monitor was down', 'investigating',
       'minor', 'monitor', NULL, now() - interval '5 days', NULL,
       now() - interval '5 days', now());

    INSERT INTO incident_events(incident_id, type, status, message, created_by)
      VALUES ('${ORIGINAL}', 'created', 'investigating', 'Checkout was marked down.', NULL);
  `);

  await apply([await migrationNamed(INVARIANT_MIGRATION)]);
}, 60_000);

afterAll(async () => {
  await client?.end();
  await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin?.end();
});

async function incident(id: string) {
  const { rows } = await client.query("SELECT * FROM incidents WHERE id = $1", [
    id,
  ]);
  return rows[0];
}

describe("upgrading a 1.12.0 database that already has duplicate incidents", () => {
  it("completes rather than failing on the existing duplicates", async () => {
    // The migration ran in beforeAll. Reaching here at all is the claim.
    const { rows } = await client.query(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'incidents_one_active_per_monitor'",
    );
    expect(rows).toHaveLength(1);
  });

  it("keeps the incident operators were actually paged about", async () => {
    const kept = await incident(ORIGINAL);
    expect(kept.status).toBe("identified");
    expect(kept.resolved_at).toBeNull();
    expect(kept.notified_at).not.toBeNull();
  });

  it("closes the later duplicates rather than deleting them", async () => {
    for (const id of [DUPLICATE_ONE, DUPLICATE_TWO]) {
      const closed = await incident(id);
      expect(closed).toBeDefined();
      expect(closed.status).toBe("resolved");
      expect(closed.resolved_at).not.toBeNull();
    }
  });

  it("explains each closure on the timeline", async () => {
    const { rows } = await client.query(
      `SELECT incident_id, message, internal FROM incident_events
       WHERE incident_id = ANY($1) AND type = 'status_change'`,
      [[DUPLICATE_ONE, DUPLICATE_TWO]],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.message).toContain("duplicate automatic incident");
      expect(row.internal).toBe(true);
    }
  });

  it("leaves the manual incident on the same monitor open", async () => {
    const manual = await incident(MANUAL);
    expect(manual.status).toBe("investigating");
  });

  it("leaves an unaffected monitor's incident open", async () => {
    const other = await incident(OTHER_MONITOR);
    expect(other.status).toBe("investigating");
  });

  it("leaves an orphaned incident open, and lets it coexist", async () => {
    // `monitor_id IS NULL` is outside the invariant: an incident whose
    // monitor was deleted must not be closed, and must not block others.
    const orphan = await incident(ORPHANED);
    expect(orphan.status).toBe("investigating");
  });

  it("refuses a new duplicate afterwards", async () => {
    await expect(
      client.query(
        `INSERT INTO incidents (organization_id, title, source, monitor_id)
         VALUES ('o1', 'Another one', 'monitor', $1)`,
        [MONITOR_A],
      ),
    ).rejects.toMatchObject({ constraint: "incidents_one_active_per_monitor" });
  });

  it("is idempotent — re-running the migration body changes nothing", async () => {
    // Operators re-run migrations. The reconciliation must be a no-op
    // the second time rather than closing the survivor too.
    const file = await migrationNamed(INVARIANT_MIGRATION);
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const [reconcile] = sql.split("--> statement-breakpoint");
    await client.query(reconcile!);

    const kept = await incident(ORIGINAL);
    expect(kept.status).toBe("identified");
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM incident_events
       WHERE incident_id = $1 AND type = 'status_change'`,
      [DUPLICATE_ONE],
    );
    expect(rows[0].n).toBe(1);
  });
});
