import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { env } from "@/lib/env";

import * as schema from "./schema";

/**
 * A single pool per process. Next.js dev-mode hot reload re-evaluates
 * modules, so the pool is cached on globalThis to avoid connection leaks.
 */
const globalForDb = globalThis as unknown as { pgPool?: Pool };

const pool =
  globalForDb.pgPool ??
  new Pool({ connectionString: env.DATABASE_URL, max: 10 });

if (env.NODE_ENV !== "production") {
  globalForDb.pgPool = pool;
}

export const db = drizzle(pool, { schema, casing: "snake_case" });

export type Database = typeof db;

/** What service functions accept: the root client or a transaction. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type DbClient = Database | Transaction;
