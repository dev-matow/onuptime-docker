import { sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { monitorHfRollups, monitorHfSamples } from "@/db/schema";

import {
  HF_DAY_ROLLUP_RETENTION_DAYS,
  HF_HOUR_ROLLUP_RETENTION_DAYS,
  HF_MINUTE_ROLLUP_RETENTION_DAYS,
  HF_RAW_RETENTION_MINUTES,
} from "./limits";

/**
 * Raw samples in, minute/hour/day buckets out, raw samples gone.
 *
 * The shape is forced by the arithmetic. A thousand monitors at 500ms is
 * 172 million rows a day; the same information as minute buckets is 1.4
 * million, as hours 24 thousand, as days a thousand. Keeping the raw
 * stream for the two hours anyone actually looks at it and rolling the
 * rest up is not an optimisation, it is the only version of this feature
 * that can be left running.
 *
 * ── what a bucket must carry, and why ────────────────────────────────
 *
 * Counts and latency are obvious. `firstObservedAt`, `lastObservedAt`
 * and `maxGapMs` are the ones that get left out and then wanted: without
 * them a rolled-up hour can say there were 7,200 samples but not whether
 * they were 500ms apart. "7,200 samples in an hour" is equally
 * consistent with a steady 500ms cadence and with a 250ms cadence that
 * stopped for half the hour — and the whole point of this plane is being
 * able to tell those apart *after* the fact.
 *
 * ── idempotence ──────────────────────────────────────────────────────
 *
 * Every rollup recomputes a trailing window and upserts. A job that runs
 * twice, or that missed its last three runs, converges instead of
 * double-counting. That is why the aggregate is `sum` and not `+=`, and
 * why the conflict target is the bucket's identity rather than a
 * surrogate key.
 */

/**
 * How far back each pass recomputes.
 *
 * Wide enough that a missed run repairs itself on the next one, and that
 * a sample flushed late still lands in its own bucket. Bounded by the
 * retention of the level below: recomputing further back than the source
 * data exists would rewrite complete buckets as empty ones, which is the
 * one way an idempotent upsert can destroy something.
 */
const MINUTE_WINDOW_MINUTES = 10;
const HOUR_WINDOW_HOURS = 3;
const DAY_WINDOW_DAYS = 3;

export interface RollupResult {
  minuteBuckets: number;
  hourBuckets: number;
  dayBuckets: number;
  samplesPruned: number;
  rollupsPruned: number;
}

/**
 * Minute buckets, computed from the raw samples.
 *
 * The gap is computed with `lag` over the whole window and then
 * aggregated per bucket, not per bucket independently: a gap that spans
 * a minute boundary is a real gap, and computing gaps inside each bucket
 * separately would silently report a plane that stopped at :59 and
 * resumed at :01 as two flawless minutes.
 */
export async function rollupMinutes(db: DbClient): Promise<number> {
  const result = await db.execute(sql`
    insert into ${monitorHfRollups} (
      monitor_id, granularity, bucket_start,
      samples, ok_samples, degraded_samples, down_samples, indeterminate_samples,
      min_response_ms, max_response_ms, sum_response_ms, response_samples,
      first_observed_at, last_observed_at, max_gap_ms
    )
    select
      s.monitor_id,
      'minute',
      s.bucket,
      count(*)::int,
      count(*) filter (where s.ok)::int,
      count(*) filter (where s.verdict = 'degraded')::int,
      count(*) filter (where s.verdict = 'down')::int,
      count(*) filter (where s.verdict = 'indeterminate')::int,
      min(s.response_time_ms)::int,
      max(s.response_time_ms)::int,
      sum(s.response_time_ms)::bigint,
      count(s.response_time_ms)::int,
      min(s.observed_at),
      max(s.observed_at),
      max(s.gap_ms)::int
    from (
      select
        ${monitorHfSamples.monitorId} as monitor_id,
        date_trunc('minute', ${monitorHfSamples.observedAt}) as bucket,
        ${monitorHfSamples.ok} as ok,
        ${monitorHfSamples.verdict} as verdict,
        ${monitorHfSamples.responseTimeMs} as response_time_ms,
        ${monitorHfSamples.observedAt} as observed_at,
        extract(epoch from (
          ${monitorHfSamples.observedAt}
          - lag(${monitorHfSamples.observedAt}) over (
              partition by ${monitorHfSamples.monitorId}
              order by ${monitorHfSamples.observedAt}
            )
        )) * 1000 as gap_ms
      from ${monitorHfSamples}
      where ${monitorHfSamples.observedAt}
            >= date_trunc('minute', now() - make_interval(mins => ${MINUTE_WINDOW_MINUTES}))
    ) s
    group by s.monitor_id, s.bucket
    ${upsertBucket()}
  `);
  return result.rowCount ?? 0;
}

/**
 * Hours from minutes, and days from hours.
 *
 * Re-aggregating the level below rather than re-reading the raw samples
 * is what lets the raw table be two hours long. It also means every
 * aggregate has to be re-aggregatable, which is why the table stores
 * `sumResponseMs` and `responseSamples` instead of a mean: a mean of
 * means weights a minute with four samples the same as a minute with
 * 120, and nothing downstream would ever notice.
 *
 * The gap across a boundary is recovered the same way it was at the
 * minute level — `lag` over the source buckets — so an hour that
 * contains a fifteen-minute stall reports it even though no single
 * minute bucket saw a gap at all. A minute with no samples writes no
 * row, so the lag reaches over the hole and measures it.
 */
export async function rollupCoarser(
  db: DbClient,
  granularity: "hour" | "day",
): Promise<number> {
  const source = granularity === "hour" ? "minute" : "hour";
  const window =
    granularity === "hour"
      ? sql`make_interval(hours => ${HOUR_WINDOW_HOURS})`
      : sql`make_interval(days => ${DAY_WINDOW_DAYS})`;
  const unit = sql.raw(`'${granularity}'`);

  const result = await db.execute(sql`
    insert into ${monitorHfRollups} (
      monitor_id, granularity, bucket_start,
      samples, ok_samples, degraded_samples, down_samples, indeterminate_samples,
      min_response_ms, max_response_ms, sum_response_ms, response_samples,
      first_observed_at, last_observed_at, max_gap_ms
    )
    select
      b.monitor_id,
      ${granularity},
      b.bucket,
      sum(b.samples)::int,
      sum(b.ok_samples)::int,
      sum(b.degraded_samples)::int,
      sum(b.down_samples)::int,
      sum(b.indeterminate_samples)::int,
      min(b.min_response_ms)::int,
      max(b.max_response_ms)::int,
      sum(b.sum_response_ms)::bigint,
      sum(b.response_samples)::int,
      min(b.first_observed_at),
      max(b.last_observed_at),
      greatest(max(b.max_gap_ms), max(b.boundary_gap_ms))::int
    from (
      select
        ${monitorHfRollups.monitorId} as monitor_id,
        date_trunc(${unit}, ${monitorHfRollups.bucketStart}) as bucket,
        ${monitorHfRollups.samples} as samples,
        ${monitorHfRollups.okSamples} as ok_samples,
        ${monitorHfRollups.degradedSamples} as degraded_samples,
        ${monitorHfRollups.downSamples} as down_samples,
        ${monitorHfRollups.indeterminateSamples} as indeterminate_samples,
        ${monitorHfRollups.minResponseMs} as min_response_ms,
        ${monitorHfRollups.maxResponseMs} as max_response_ms,
        ${monitorHfRollups.sumResponseMs} as sum_response_ms,
        ${monitorHfRollups.responseSamples} as response_samples,
        ${monitorHfRollups.firstObservedAt} as first_observed_at,
        ${monitorHfRollups.lastObservedAt} as last_observed_at,
        ${monitorHfRollups.maxGapMs} as max_gap_ms,
        extract(epoch from (
          ${monitorHfRollups.firstObservedAt}
          - lag(${monitorHfRollups.lastObservedAt}) over (
              partition by ${monitorHfRollups.monitorId}
              order by ${monitorHfRollups.bucketStart}
            )
        )) * 1000 as boundary_gap_ms
      from ${monitorHfRollups}
      where ${monitorHfRollups.granularity} = ${source}
        and ${monitorHfRollups.bucketStart}
            >= date_trunc(${unit}, now() - ${window})
    ) b
    group by b.monitor_id, b.bucket
    ${upsertBucket()}
  `);
  return result.rowCount ?? 0;
}

/**
 * The conflict clause every level shares.
 *
 * `EXCLUDED` throughout rather than a merge of old and new: the source
 * rows are recomputed from scratch each pass, so the new value is
 * complete and adding it to the stored one would double every count on
 * the second run. This is the line that makes the whole job safe to
 * repeat.
 */
function upsertBucket() {
  return sql`
    on conflict (monitor_id, granularity, bucket_start) do update set
      samples = excluded.samples,
      ok_samples = excluded.ok_samples,
      degraded_samples = excluded.degraded_samples,
      down_samples = excluded.down_samples,
      indeterminate_samples = excluded.indeterminate_samples,
      min_response_ms = excluded.min_response_ms,
      max_response_ms = excluded.max_response_ms,
      sum_response_ms = excluded.sum_response_ms,
      response_samples = excluded.response_samples,
      first_observed_at = excluded.first_observed_at,
      last_observed_at = excluded.last_observed_at,
      max_gap_ms = excluded.max_gap_ms
  `;
}

/**
 * One full pass: aggregate upward, then discard what is now redundant.
 *
 * Pruning after aggregating, in the same call, and never the other way
 * round. A prune that ran first would delete raw samples the minute
 * rollup had not read yet, and the loss would be silent — the bucket
 * would simply be smaller than the truth, with nothing anywhere saying
 * so.
 */
export async function runHighFrequencyRollup(
  db: DbClient,
): Promise<RollupResult> {
  const minuteBuckets = await rollupMinutes(db);
  const hourBuckets = await rollupCoarser(db, "hour");
  const dayBuckets = await rollupCoarser(db, "day");

  const pruned = await db.execute(sql`
    delete from ${monitorHfSamples}
    where ${monitorHfSamples.observedAt}
          < now() - make_interval(mins => ${HF_RAW_RETENTION_MINUTES})
  `);

  const prunedRollups = await db.execute(sql`
    delete from ${monitorHfRollups}
    where (${monitorHfRollups.granularity} = 'minute'
           and ${monitorHfRollups.bucketStart} < now() - make_interval(days => ${HF_MINUTE_ROLLUP_RETENTION_DAYS}))
       or (${monitorHfRollups.granularity} = 'hour'
           and ${monitorHfRollups.bucketStart} < now() - make_interval(days => ${HF_HOUR_ROLLUP_RETENTION_DAYS}))
       or (${monitorHfRollups.granularity} = 'day'
           and ${monitorHfRollups.bucketStart} < now() - make_interval(days => ${HF_DAY_ROLLUP_RETENTION_DAYS}))
  `);

  return {
    minuteBuckets,
    hourBuckets,
    dayBuckets,
    samplesPruned: pruned.rowCount ?? 0,
    rollupsPruned: prunedRollups.rowCount ?? 0,
  };
}
