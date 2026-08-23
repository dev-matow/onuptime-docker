import { sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { logger } from "@/lib/logger";

import { HIGH_CHURN_DELETE_AFTER_SECONDS, HIGH_CHURN_QUEUES } from "./queues";

const log = logger.child({ process: "worker" });

/** Small enough to hold locks for milliseconds; large enough that a
 * seven-day backlog at a thousand monitors (~10M rows) drains in a few
 * thousand bites rather than a few million. */
const DRAIN_BATCH = 5_000;

/**
 * Deletes finished high-churn job rows that predate the retention
 * change.
 *
 * Needed because pg-boss stamps `deletion_seconds` PER ROW at insert
 * and its maintenance sweep filters on that per-row value — so
 * `updateQueue` at boot governs only rows created afterwards, and an
 * upgraded installation's existing backlog (up to seven days of
 * finished transport jobs, gigabytes on a large fleet) would keep its
 * old windows and shrink over a week. These rows are already past the
 * new policy; the memory they hold is the reason the policy changed.
 *
 * Runs off the boot path (the caller fires and forgets), in bounded
 * batches per queue with a breath between them, so a first boot after
 * upgrade drains millions of rows without ever holding a lock longer
 * than one batch. Idempotent and cheap when there is nothing to do:
 * one short-circuiting DELETE per queue.
 */
export async function drainStaleQueueBacklog(db: DbClient): Promise<number> {
  let total = 0;
  for (const queue of HIGH_CHURN_QUEUES) {
    for (;;) {
      const { rowCount } = await db.execute(sql`
        delete from pgboss.job
        where name = ${queue}
          and id in (
            select id from pgboss.job
            where name = ${queue}
              and completed_on
                < now() - make_interval(secs => ${HIGH_CHURN_DELETE_AFTER_SECONDS})
            limit ${DRAIN_BATCH}
          )
      `);
      total += rowCount ?? 0;
      if ((rowCount ?? 0) < DRAIN_BATCH) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (total > 0) {
    log.info(
      { deleted: total },
      "drained finished queue jobs from before the retention change",
    );
  }
  return total;
}
