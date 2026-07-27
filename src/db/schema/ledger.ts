import { sql } from "drizzle-orm";
import {
  bigint,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Who wrote a fact.
 *
 * Every observation and every decision is attributable to an actor, and
 * ordering is per-actor rather than global. That is not
 * over-engineering for a single-writer product: the moment a second
 * observer exists — a second worker replica, an edge probe, a heartbeat
 * sender, a human attesting — a serial primary key and `now()` stop
 * being an ordering. Retrofitting logical time later means rewriting
 * every historical row and every query that reads one; adding it now is
 * one table and three columns.
 *
 * Kinds are `text`, not an enum, for the same reason `monitors.check_type`
 * is: Postgres will not let a newly added enum value be used in the
 * transaction that adds it, and Drizzle wraps migrations in one.
 */
export const actors = pgTable(
  "actors",
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    /** control-plane | worker | edge | human | external */
    kind: text().notNull(),
    /** Stable within a kind — the worker's hostname, a user id. */
    name: text().notNull(),
    /**
     * Public half of this actor's signing key. Null until signing is
     * switched on: the architecture says write the fields and build the
     * verifier when someone needs to verify.
     */
    publicKey: text(),
    /**
     * Monotonic sequence, incremented under this row's lock. The lock is
     * what serialises the actor's chain, which is why the chains are
     * per-actor: one global chain would need one global lock, and that
     * is exactly what edge autonomy forbids.
     */
    sequence: bigint({ mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** Hash of this actor's most recent fact — the head of its chain. */
    headHash: text(),
    /** Last hybrid logical clock this actor issued. */
    lastHlc: bigint({ mode: "bigint" })
      .notNull()
      .default(sql`0`),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex().on(t.kind, t.name)],
);

/**
 * The columns that make a row a ledger record. Spread into the tables
 * that hold facts — `monitor_checks` (observations) and
 * `recovery_attempts` (decisions) — so the two can never drift.
 *
 * `incident_events` deliberately does not get these: it is a projection
 * of decisions and observations, not a fact of its own, and giving a
 * projection a hash chain is how projections quietly become facts.
 *
 * All nullable. A 1.9.x row has no actor and no chain, and inventing
 * one would be a lie about history.
 */
export function ledgerColumns() {
  return {
    actorId: uuid().references(() => actors.id, { onDelete: "set null" }),
    /**
     * Hybrid logical clock: wall-clock milliseconds in the high bits, a
     * per-millisecond counter in the low 16. One bigint that gives
     * causal ordering across actors without coordination.
     */
    hlc: bigint({ mode: "bigint" }),
    /** Position in the writing actor's own sequence. */
    seq: bigint({ mode: "bigint" }),
    /** Chain link: the hash of the actor's previous fact. */
    prevHash: text(),
    /** This record's content hash. */
    hash: text(),
    /**
     * A collection from day one, not a column. One signature today; the
     * counter-signature that turns "Vigil says" into "two mutually
     * distrusting parties agree" needs N, and a column would be a table
     * migration on the largest table in the product.
     */
    signatures: jsonb()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The spec version this fact was produced under. */
    specVersion: integer(),
  } as const;
}
