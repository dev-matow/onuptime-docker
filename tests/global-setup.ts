import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { applyTestEnv } from "./env";

/** Runs once per vitest invocation: bring the test schema up to date. */
export default async function globalSetup(): Promise<void> {
  applyTestEnv();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  } finally {
    await pool.end();
  }
}
