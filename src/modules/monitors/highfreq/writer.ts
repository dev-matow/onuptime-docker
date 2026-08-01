import { sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { monitorHfSamples } from "@/db/schema";
import { logger } from "@/lib/logger";

import {
  HF_BATCH_ROWS,
  HF_FLUSH_MS,
  HF_WRITER_HIGH_WATER_ROWS,
} from "./limits";

const log = logger.child({ module: "highfreq-writer" });

/** The longest error text a sample carries. See `MAX_ERROR_CHARS`. */
const MAX_ERROR_CHARS = 200;

/**
 * One high-frequency observation, as it is stored.
 *
 * `observedAt` is supplied by the caller from the scheduler's clock
 * rather than defaulted to `now()` in SQL, because a batch flushed 250ms
 * after its first row would otherwise stamp every sample in it with the
 * flush time — turning a stream of 500ms samples into bursts of five
 * simultaneous ones, and making the achieved-cadence measurement report
 * the batch size instead of the cadence.
 */
export interface HfSample {
  monitorId: string;
  observedAt: Date;
  ok: boolean;
  verdict: string;
  responseTimeMs: number | null;
  error: string | null;
}

export interface WriterStats {
  /** Rows accepted from the scheduler since start. */
  accepted: number;
  /** Rows actually written. */
  written: number;
  /** Rows refused because the buffer was over its high-water mark. */
  rejected: number;
  /** Rows lost to a failed statement. */
  dropped: number;
  /** How many INSERT statements those rows were written by. */
  statements: number;
  /** Rows waiting right now. */
  pending: number;
}

/**
 * Micro-batched writes for the high-frequency plane.
 *
 * At two thousand samples a second, a row per statement is two thousand
 * transactions a second: two thousand WAL records, two thousand commits
 * and two thousand round trips, to move six columns. Batching five
 * hundred rows into one multi-row INSERT makes that four statements a
 * second, and the difference is not a tuning detail — it is the
 * difference between the database being idle and the database being the
 * reason the cadence is missed.
 *
 * The flush deadline is the other half. Batching on size alone means a
 * plane with three monitors on it holds their samples until five hundred
 * accumulate, which at 500ms is nearly three minutes of invisible
 * measurements. Whichever comes first.
 */
export class SampleWriter {
  private buffer: HfSample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private stopped = false;
  private stats: WriterStats = {
    accepted: 0,
    written: 0,
    rejected: 0,
    dropped: 0,
    statements: 0,
    pending: 0,
  };

  constructor(private readonly db: DbClient) {}

  /**
   * Whether the writer is keeping up.
   *
   * The scheduler asks before issuing a probe, and sheds the slot when
   * the answer is no. That is the backpressure: the alternative is a
   * buffer that grows until the process is killed, taking with it the
   * monitors that were keeping up perfectly well.
   */
  saturated(): boolean {
    return this.buffer.length >= HF_WRITER_HIGH_WATER_ROWS;
  }

  /**
   * Queues one sample. Never awaits the database — the caller is on the
   * scheduler's hot path, and a write that blocks a slot is a write that
   * has become the cadence.
   */
  add(sample: HfSample): void {
    if (this.stopped) return;
    this.stats.accepted += 1;
    if (this.saturated()) {
      this.stats.rejected += 1;
      return;
    }
    this.buffer.push({
      ...sample,
      error:
        sample.error === null ? null : sample.error.slice(0, MAX_ERROR_CHARS),
    });
    this.stats.pending = this.buffer.length;

    if (this.buffer.length >= HF_BATCH_ROWS) {
      void this.flush();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, HF_FLUSH_MS);
    // Unreferenced so a pending flush cannot hold the process open
    // during a shutdown that has already drained the buffer.
    this.timer.unref();
  }

  /**
   * Writes everything buffered.
   *
   * Serialised against itself: two overlapping flushes would take two
   * connections out of a pool the probes are also using, and the second
   * one exists only because the first is slow — which is precisely when
   * adding a second is the wrong move.
   */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];
    this.stats.pending = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.flushing = this.write(batch).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async write(batch: HfSample[]): Promise<void> {
    try {
      await this.db.insert(monitorHfSamples).values(batch);
      this.stats.written += batch.length;
      this.stats.statements += 1;
    } catch (error) {
      // Dropped rather than retried, and counted rather than logged
      // once. A retry queue here would compete with live probes for the
      // same connections at the exact moment the database is already
      // struggling, and a high-frequency sample is worth nothing by the
      // time a retry succeeds — the observation of record is on
      // `monitor_checks` and was written by a different path. What must
      // not happen is the loss being invisible, so it is a number the
      // plane reports.
      this.stats.dropped += batch.length;
      log.error(
        { err: error, rows: batch.length },
        "high-frequency sample batch lost",
      );
    }
  }

  /** Stops accepting, then writes what is already queued. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
    await this.flushing;
  }

  snapshot(): WriterStats {
    return { ...this.stats, pending: this.buffer.length };
  }
}

/**
 * Deletes raw samples past the retention window.
 *
 * Bounded by an explicit cutoff rather than by a row count, because the
 * table is a fixed-length buffer in time and not in size: pruning "the
 * oldest ten thousand" would keep six hours for one monitor and four
 * minutes for a thousand.
 */
export async function pruneSamples(
  db: DbClient,
  retentionMinutes: number,
): Promise<number> {
  const result = await db
    .delete(monitorHfSamples)
    .where(
      sql`${monitorHfSamples.observedAt} < now() - make_interval(mins => ${retentionMinutes})`,
    );
  return result.rowCount ?? 0;
}
