import { and, eq, inArray, lt, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { monitorHfLeases } from "@/db/schema";

import { HF_LEASE_TTL_MS } from "./limits";
import { ALL_SHARDS } from "./shards";

/**
 * Shard leases: the only thing standing between two worker replicas and
 * two probes of the same monitor at the same instant.
 *
 * On the pg-boss plane, exclusivity is a row lock on a job. There is no
 * job row here — not writing one per probe is most of why this plane is
 * affordable — so exclusivity is held over a *shard* for a stretch of
 * time instead, and the correctness argument moves from "one worker
 * holds this row" to "one worker holds this shard, and knows when it
 * stops holding it".
 *
 * The second half of that is the part that is easy to get wrong.
 * Acquiring a lease is trivial; the failure mode is a replica that has
 * lost its lease (a slow query, a long GC pause, a partitioned network)
 * and keeps probing because it has not noticed. So the plane checks the
 * expiry it was granted before every batch of slots — see
 * `holdsShard` — rather than trusting that a renewal loop is running.
 */

export interface Lease {
  shard: number;
  expiresAt: Date;
}

/**
 * Claims or renews every shard this replica can get.
 *
 * One statement, and it has to be one statement: read-then-write would
 * let two replicas both read "expired" and both write themselves as the
 * owner. The `WHERE` on the `DO UPDATE` is what makes the conditional
 * take atomic — a row already held by somebody else, and not yet
 * expired, matches nothing and is simply absent from the result.
 *
 * `now()` throughout, which is Postgres's clock rather than any
 * replica's. Two workers with clocks a minute apart is an ordinary
 * consequence of a broken NTP config, and it must not be able to produce
 * two owners of one shard.
 */
export async function claimShards(
  db: DbClient,
  ownerId: string,
  shards: readonly number[] = ALL_SHARDS,
): Promise<Lease[]> {
  if (shards.length === 0) return [];

  const values = shards.map(
    (shard) =>
      sql`(${shard}, ${ownerId}, now(), now(), now() + make_interval(secs => ${HF_LEASE_TTL_MS / 1000}))`,
  );

  const result = await db.execute<{ shard: number; expires_at: Date }>(sql`
    insert into ${monitorHfLeases} (shard, owner_id, acquired_at, renewed_at, expires_at)
    values ${sql.join(values, sql`, `)}
    on conflict (shard) do update set
      owner_id = excluded.owner_id,
      renewed_at = now(),
      expires_at = excluded.expires_at,
      -- Renewing keeps the original acquisition time; taking over an
      -- abandoned shard resets it. The column is only read by an
      -- operator asking "how long has this replica had this?", and
      -- overwriting it on every renewal would make the answer "two
      -- seconds" forever.
      acquired_at = case
        when ${monitorHfLeases.ownerId} = excluded.owner_id
        then ${monitorHfLeases.acquiredAt}
        else now()
      end
    where ${monitorHfLeases.ownerId} = excluded.owner_id
       or ${monitorHfLeases.expiresAt} < now()
    returning shard, expires_at
  `);

  return result.rows.map((row) => ({
    shard: Number(row.shard),
    expiresAt: new Date(row.expires_at),
  }));
}

/**
 * Gives every held shard back.
 *
 * Called on shutdown, and it is the difference between a rolling deploy
 * that hands its monitors over in milliseconds and one where they sit
 * unprobed for a full lease period because the new replica is politely
 * waiting for a lease its predecessor will never renew.
 *
 * Scoped to this owner: a replica must never release a shard another one
 * has already taken over, which is exactly the state a slow shutdown
 * finds itself in.
 */
export async function releaseShards(
  db: DbClient,
  ownerId: string,
  shards: readonly number[],
): Promise<void> {
  if (shards.length === 0) return;
  await db
    .delete(monitorHfLeases)
    .where(
      and(
        eq(monitorHfLeases.ownerId, ownerId),
        inArray(monitorHfLeases.shard, [...shards]),
      ),
    );
}

/** Shards nobody currently holds — for diagnostics, not for probing. */
export async function expiredShards(db: DbClient): Promise<number[]> {
  const rows = await db
    .select({ shard: monitorHfLeases.shard })
    .from(monitorHfLeases)
    .where(lt(monitorHfLeases.expiresAt, sql`now()`));
  return rows.map((row) => row.shard);
}

/**
 * Which shards are covered by a live lease right now, whoever holds it.
 *
 * The ordinary pg-boss plane reads this to decide whether to leave a
 * high-frequency monitor alone. That direction matters: the question is
 * not "do I hold it" but "is *anybody* probing it", because the answer
 * "nobody" has to mean the ordinary plane picks the monitor back up. A
 * monitor whose high-frequency worker died should fall back to a 2s
 * cadence, not to none.
 */
export async function liveShards(db: DbClient): Promise<Set<number>> {
  const rows = await db
    .select({ shard: monitorHfLeases.shard })
    .from(monitorHfLeases)
    .where(sql`${monitorHfLeases.expiresAt} > now()`);
  return new Set(rows.map((row) => row.shard));
}
