import { eq, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { actors } from "@/db/schema";

import { factHash, type FactInput } from "./chain";
import { nextHlc } from "./hlc";

/**
 * The single fact-writing code path.
 *
 * The architecture names three mechanical enforcements that matter more
 * than any diagram: schema separation, one fact-writing path, and a CI
 * rebuild test. This is the second. Every observation and every
 * decision gets its identity, clock, sequence and chain link here, or
 * it does not get one at all — and "or it does not get one at all" is
 * why this is a function rather than a convention.
 */

export type ActorKind =
  "control-plane" | "worker" | "edge" | "human" | "external";

export interface LedgerStamp {
  actorId: string;
  hlc: bigint;
  seq: bigint;
  prevHash: string | null;
  hash: string;
  specVersion: number | null;
}

/**
 * Actor ids are stable for the life of a process, and a check writes one
 * fact — so without a cache every observation would cost an extra
 * round trip to learn something that never changes.
 *
 * Bounded, because the key is not always ours to choose. In the worker
 * it holds one entry (the replica's own name); in the web process it is
 * keyed by user id and grows with everyone who has ever acted in this
 * process's lifetime. The bound is far above any real population — an
 * eviction only costs the round trip back — and follows the rule
 * `lib/rate-limit.ts` wrote down after measuring the unbounded version
 * of exactly this shape: a Map that grows with the world is a leak with
 * a flattering name.
 */
const ACTOR_CACHE_MAX = 10_000;
const actorIdCache = new Map<string, string>();

export async function ensureActor(
  db: DbClient,
  kind: ActorKind,
  name: string,
): Promise<string> {
  const cacheKey = `${kind}:${name}`;
  const cached = actorIdCache.get(cacheKey);
  if (cached) return cached;

  await db.insert(actors).values({ kind, name }).onConflictDoNothing();
  const actor = await db.query.actors.findFirst({
    where: (row, { and, eq: equals }) =>
      and(equals(row.kind, kind), equals(row.name, name)),
    columns: { id: true },
  });
  if (!actor) throw new Error(`Could not resolve actor ${cacheKey}`);

  if (actorIdCache.size >= ACTOR_CACHE_MAX) {
    // Oldest-inserted first: a Map iterates in insertion order, and the
    // long-lived entries (the worker's own identity, the active staff)
    // re-enter on their next fact. Simpler than LRU and wrong by at
    // most one extra query per evicted actor.
    const oldest = actorIdCache.keys().next().value;
    if (oldest !== undefined) actorIdCache.delete(oldest);
  }
  actorIdCache.set(cacheKey, actor.id);
  return actor.id;
}

/** Test seam — the cache outlives a per-test database otherwise. */
export function resetActorCache(): void {
  actorIdCache.clear();
}

export type StampInput = Omit<
  FactInput,
  "actorId" | "seq" | "hlc" | "prevHash"
> & { actorId: string };

/**
 * Advances an actor's chain by one fact and returns the stamp to store
 * alongside it.
 *
 * MUST be called inside the same transaction that writes the fact.
 * The first UPDATE takes the actor's row lock, which is what serialises
 * the chain; if the fact were written in a different transaction, a
 * crash between the two would leave a chain link pointing at a fact
 * that does not exist.
 *
 * The row lock is also the cost: one actor's facts serialise against
 * each other. That is bounded by design — chains are per-actor, so more
 * writers means more chains rather than more contention on one.
 */
export async function stampFact(
  tx: DbClient,
  input: StampInput,
  nowMs: number = Date.now(),
): Promise<LedgerStamp> {
  const [advanced] = await tx
    .update(actors)
    .set({ sequence: sql`${actors.sequence} + 1` })
    .where(eq(actors.id, input.actorId))
    .returning({
      sequence: actors.sequence,
      lastHlc: actors.lastHlc,
      headHash: actors.headHash,
    });
  if (!advanced) throw new Error(`Unknown actor ${input.actorId}`);

  const hlc = nextHlc(advanced.lastHlc, nowMs);
  const seq = advanced.sequence;
  const prevHash = advanced.headHash;

  const hash = factHash({
    actorId: input.actorId,
    seq,
    hlc,
    prevHash,
    kind: input.kind,
    subject: input.subject,
    specVersion: input.specVersion,
    claim: input.claim,
  });

  await tx
    .update(actors)
    .set({ lastHlc: hlc, headHash: hash })
    .where(eq(actors.id, input.actorId));

  return {
    actorId: input.actorId,
    hlc,
    seq,
    prevHash,
    hash,
    specVersion: input.specVersion,
  };
}
