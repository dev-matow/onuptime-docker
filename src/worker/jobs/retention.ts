import { sql } from "drizzle-orm";

import { db } from "@/db";
import { monitorChecks } from "@/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  pruneNotificationHistory,
  sweepStaleAttempts,
} from "@/modules/notifications/outbox";

import { CHECK_RETENTION_DAYS } from "../queues";

/** Any real attempt finishes well within this; beyond it, the chain died. */
const STALE_ATTEMPT_HOURS = 1;

/**
 * How long a notification attempt may sit unfinished before it is
 * called `unknown`.
 *
 * Must exceed the delivery lease (ten minutes), or this would close
 * attempts that are legitimately still running and manufacture the very
 * uncertainty it is meant to record. An hour is six times the lease.
 */
const STALE_CLAIM_HOURS = 1;

/**
 * The most rows one retention pass may remove.
 *
 * A first run on an installation that has never pruned would otherwise
 * be a single delete of everything, holding locks for as long as it
 * takes. Bounded, it converges over a few nights instead of stalling
 * once - and the log says whether there is more to do.
 */
const PRUNE_BATCH = 5_000;

/** Nightly: drop check rows past the retention window and close
 * recovery attempts orphaned by worker interruptions. */
export async function pruneOldChecks(): Promise<void> {
  const result = await db
    .delete(monitorChecks)
    .where(
      sql`${monitorChecks.checkedAt} < now() - make_interval(days => ${CHECK_RETENTION_DAYS})`,
    );
  logger.info(
    { deleted: result.rowCount, retentionDays: CHECK_RETENTION_DAYS },
    "pruned old monitor checks",
  );

  // Finished notifications past the retention window, and the attempt
  // evidence with them by cascade. Never anything queued or in flight:
  // a late message is not an old one.
  const pruned = await pruneNotificationHistory(
    db,
    env.NOTIFICATION_RETENTION_DAYS,
    PRUNE_BATCH,
  );
  if (pruned.deliveries > 0 || pruned.more) {
    logger.info(
      {
        deliveries: pruned.deliveries,
        attempts: pruned.attempts,
        more: pruned.more,
        retentionDays: env.NOTIFICATION_RETENTION_DAYS,
      },
      "pruned notification history",
    );
  }

  // Attempts whose worker never came back. Turning them into `unknown`
  // is not tidying up - it is the record that a request may have gone
  // out and nobody learned what happened to it.
  const stale = await sweepStaleAttempts(
    db,
    new Date(Date.now() - STALE_CLAIM_HOURS * 60 * 60 * 1000),
  );
  if (stale > 0) {
    logger.warn(
      { attempts: stale },
      "closed notification attempts whose worker never reported",
    );
  }

}
