import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The golden migration fixture.
 *
 * `docs/UPGRADE.md` promises that a minor release ships additive
 * migrations only. This suite is what makes that a fact rather than an
 * intention: it builds a real 1.9.x database, puts realistic rows in it,
 * runs 0010, and checks that nothing an operator configured moved.
 *
 * A round-trip assertion would not be enough — the interesting failures
 * are row-level, and the interesting rows are the ones already in a
 * strange state when the upgrade lands (mid-outage, paused, at a
 * non-default threshold).
 */
const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");
const LAST_1_9_MIGRATION = "0009";
const R1_MIGRATION = "0010";

const HTTP_ID = "11111111-1111-1111-1111-111111111111";
const TCP_ID = "22222222-2222-2222-2222-222222222222";
const FAILING_ID = "33333333-3333-3333-3333-333333333333";

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
    // `--> statement-breakpoint` is a SQL line comment, so the whole
    // file runs as one script exactly as Drizzle would send it.
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await client.query(sql);
  }
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  database = `vigil_upgrade_${randomUUID().slice(0, 8)}`;

  admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);

  url.pathname = `/${database}`;
  client = new Client({ connectionString: url.toString() });
  await client.connect();

  await apply(await migrationsUpTo(LAST_1_9_MIGRATION));

  // A 1.9.x deployment, as an operator would actually have left it.
  await client.query(`
    INSERT INTO "user"(id, name, email, email_verified, created_at, updated_at)
      VALUES ('u1', 'Ada', 'ada@example.com', true, now(), now());
    INSERT INTO organization(id, name, slug, created_at)
      VALUES ('o1', 'Acme', 'acme', now());

    INSERT INTO monitors
      (id, organization_id, name, url, check_type, method, interval_seconds,
       timeout_ms, degraded_threshold_ms, expected_status_code, body_keyword,
       keyword_absent, tls_check, tls_warn_days, failure_threshold,
       current_status, consecutive_failures, last_checked_at, paused, created_by)
    VALUES
      ('${HTTP_ID}', 'o1', 'Marketing site', 'https://example.com/health',
       'http', 'HEAD', 300, 5000, 1500, 204, 'healthy', false, true, 21, 5,
       'up', 0, now() - interval '100 seconds', false, 'u1'),
      ('${TCP_ID}', 'o1', 'Primary database', 'db.example.com',
       'tcp', 'GET', 60, 10000, 3000, NULL, NULL, false, false, 14, 1,
       'up', 0, now() - interval '10 seconds', true, 'u1'),
      ('${FAILING_ID}', 'o1', 'Checkout', 'https://shop.example.com/health',
       'http', 'GET', 60, 10000, 3000, NULL, NULL, false, false, 14, 3,
       'down', 4, now() - interval '5 seconds', false, 'u1');

    UPDATE monitors SET port = 5432 WHERE id = '${TCP_ID}';

    INSERT INTO monitor_checks(monitor_id, ok, status_code, response_time_ms)
      VALUES ('${HTTP_ID}', true, 200, 42), ('${FAILING_ID}', false, 503, 250);
  `);

  await apply([`${R1_MIGRATION}_sharp_vampiro.sql`]);
}, 60_000);

afterAll(async () => {
  await client?.end();
  await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin?.end();
});

async function monitor(id: string) {
  const { rows } = await client.query("SELECT * FROM monitors WHERE id = $1", [
    id,
  ]);
  return rows[0];
}

describe("upgrading a 1.9.x database", () => {
  it("converts check_type to text without touching a single value", async () => {
    const { rows } = await client.query(`
      SELECT data_type, column_default FROM information_schema.columns
      WHERE table_name = 'monitors' AND column_name = 'check_type'
    `);
    expect(rows[0].data_type).toBe("text");
    expect(rows[0].column_default).toBe("'http'::text");

    expect((await monitor(HTTP_ID)).check_type).toBe("http");
    expect((await monitor(TCP_ID)).check_type).toBe("tcp");
  });

  it("drops the enum type, so a new check type never needs two deploys", async () => {
    const { rows } = await client.query(
      "SELECT 1 FROM pg_type WHERE typname = 'monitor_check_type'",
    );
    expect(rows).toHaveLength(0);
  });

  it("leaves every configured setting exactly as it was", async () => {
    expect(await monitor(HTTP_ID)).toMatchObject({
      url: "https://example.com/health",
      method: "HEAD",
      interval_seconds: 300,
      timeout_ms: 5000,
      degraded_threshold_ms: 1500,
      expected_status_code: 204,
      body_keyword: "healthy",
      tls_check: true,
      tls_warn_days: 21,
      current_status: "up",
    });
    expect(await monitor(TCP_ID)).toMatchObject({
      url: "db.example.com",
      port: 5432,
      paused: true,
    });
  });

  it("translates the failure threshold into the window that behaves the same", async () => {
    // At a fixed interval the Nth consecutive failure lands (N-1)
    // intervals after the first, so this is equality, not an
    // approximation: 5 checks at 300s is 1200s of failing.
    expect((await monitor(HTTP_ID)).failure_window_seconds).toBe(1200);
    expect((await monitor(FAILING_ID)).failure_window_seconds).toBe(120);
    // A threshold of 1 meant "open on the first failed check", which is
    // a window of zero.
    expect((await monitor(TCP_ID)).failure_window_seconds).toBe(0);
  });

  it("keeps the deprecated column so a downgrade still runs", async () => {
    expect((await monitor(HTTP_ID)).failure_threshold).toBe(5);
  });

  it("carries a mid-outage monitor's failure run across the upgrade", async () => {
    // Upgrading during an incident must not restart the clock and
    // delay the page.
    const failing = await monitor(FAILING_ID);
    expect(failing.first_failure_at).not.toBeNull();
    const failingForSeconds =
      (Date.now() - new Date(failing.first_failure_at).getTime()) / 1000;
    expect(failingForSeconds).toBeGreaterThan(failing.failure_window_seconds);
  });

  it("leaves a healthy monitor with no failure run", async () => {
    expect((await monitor(HTTP_ID)).first_failure_at).toBeNull();
  });

  it("seeds the scheduler from where each monitor already was", async () => {
    // Leaving these null would make every monitor due at once and
    // stampede the first tick after an upgrade.
    for (const id of [HTTP_ID, TCP_ID, FAILING_ID]) {
      expect((await monitor(id)).next_evaluation_at).not.toBeNull();
    }
    const http = await monitor(HTTP_ID);
    const dueInSeconds =
      (new Date(http.next_evaluation_at).getTime() - Date.now()) / 1000;
    expect(dueInSeconds).toBeGreaterThan(0);
    expect(dueInSeconds).toBeLessThanOrEqual(http.interval_seconds);
  });

  it("adds the ledger columns without inventing history", async () => {
    const { rows } = await client.query(
      "SELECT actor_id, hlc, seq, prev_hash, hash, signatures, spec_version FROM monitor_checks",
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // A 1.9.x observation had no actor and no chain. Backfilling one
      // would be a lie about who saw what.
      expect(row.actor_id).toBeNull();
      expect(row.hash).toBeNull();
      expect(row.seq).toBeNull();
      expect(row.signatures).toEqual([]);
    }
  });

  it("starts every monitor at spec version 1 with no config blob", async () => {
    for (const id of [HTTP_ID, TCP_ID, FAILING_ID]) {
      const row = await monitor(id);
      expect(row.spec_version).toBe(1);
      expect(row.config).toBeNull();
    }
  });

  it("keeps existing check history", async () => {
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM monitor_checks",
    );
    expect(rows[0].n).toBe(2);
  });
});
