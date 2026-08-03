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

/**
 * What the pool is, and what it is doing.
 *
 * Exported because the notification drain derives its concurrency from
 * the pool size rather than guessing it, and because a benchmark that
 * claims to measure database pressure has to be able to see the pool
 * rather than assume it. `waiting` above zero during a drain is the
 * measurement that says the concurrency is too high for this
 * installation - see `docs/NOTIFICATIONS.md`.
 */
export function poolStats(): {
  max: number;
  total: number;
  idle: number;
  waiting: number;
} {
  return {
    max: pool.options.max ?? 10,
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}
