import { sql } from "drizzle-orm";

import { db } from "@/db";
import { bridgePolls, monitorChecks, monitors } from "@/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { pruneExpandedIntents } from "@/modules/notifications/intents";
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

export interface RetentionOptions {
  /**
   * Restricts the observation sweep below to one tenant.
   *
   * Deliberately narrow, and named for what it actually covers rather
   * than for the whole job: the notification, synthetic, maintenance and
   * cluster sweeps further down are unaffected and stay
   * installation-wide.
   *
   * The worker never passes it. It exists for the reason
   * `materializeDueSlos`, `expandPendingIntents` and
   * `reconcileMaintenance` all take one: a test that drives this job
   * runs beside suites whose fixtures are dated months into the past, so
   * an unscoped pass reaches over and deletes another suite's evidence
   * mid-assertion. That is not hypothetical - it made the burn suite
   * fail about one run in four, from a delete in a different file.
   */
  organizationId?: string;
}

/** Nightly: drop check rows past the retention window and close
 * recovery attempts orphaned by worker interruptions. */
export async function pruneOldChecks(
  options: RetentionOptions = {},
): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - CHECK_RETENTION_DAYS * 86_400_000);
  // Batched, like every other prune in this file — this one was the
  // exception, and it is the biggest table in the product. A first run
  // on an installation that had never pruned (or an SLO floor that just
  // moved by months) was one statement deleting millions of rows: locks
  // for the duration, a WAL burst, and Postgres memory for the whole
  // dead set at once. `ctid`-batched, it converges in bounded bites and
  // the last short batch says it is done.
  let deleted = 0;
  let batches = 0;
  for (;;) {
    const result = await db.execute(sql`
      delete from ${monitorChecks}
      where ctid in (
        select ctid from ${monitorChecks}
        where ${monitorChecks.checkedAt} < ${cutoff}::timestamptz
        ${
          options.organizationId
            ? sql`and ${monitorChecks.monitorId} in (
                select ${monitors.id} from ${monitors}
                where ${monitors.organizationId} = ${options.organizationId}
              )`
            : sql``
        }
        limit ${PRUNE_BATCH}
      )
    `);
    deleted += result.rowCount ?? 0;
    batches += 1;
    if ((result.rowCount ?? 0) < PRUNE_BATCH) break;
  }
  logger.info(
    {
      deleted,
      batches,
      retentionDays: CHECK_RETENTION_DAYS,
      cutoff: cutoff.toISOString(),
    },
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

  // Migration-bridge poll rows age with the observation history their
  // coverage claims sit beside; a coverage claim older than the check
  // retention window has nothing left to vouch for, and losing one only
  // turns old extras unprovable, which is the conservative direction.
  // The source-incident COPIES are deliberately not pruned at all: a
  // recorded miss is the source's row plus Vigil's absence, deleting
  // the copy would delete the miss from the next report, and a verdict
  // must never improve because time passed. Copies, import reports and
  // cutover reports all live until the bridge itself is deleted.
  let bridgePollsPruned = 0;
  for (;;) {
    const result = await db.execute(sql`
      delete from ${bridgePolls}
      where ctid in (
        select ctid from ${bridgePolls}
        where ${bridgePolls.createdAt} < ${cutoff.toISOString()}::timestamptz
        ${
          options.organizationId
            ? sql`and ${bridgePolls.organizationId} = ${options.organizationId}`
            : sql``
        }
        limit ${PRUNE_BATCH}
      )
    `);
    bridgePollsPruned += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < PRUNE_BATCH) break;
  }
  if (bridgePollsPruned > 0) {
    logger.info(
      { polls: bridgePollsPruned, retentionDays: CHECK_RETENTION_DAYS },
      "pruned migration bridge poll history",
    );
  }


  // Expanded dispatch intents, on the same clock as the deliveries they
  // produced. A PENDING intent is never pruned however old it is: it is
  // a notification still owed, and deleting it would be the same loss
  // the intent exists to prevent, arriving on a timer.
  const intents = await pruneExpandedIntents(
    db,
    new Date(
      Date.now() - env.NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ),
    PRUNE_BATCH,
  );
  if (intents > 0) {
    logger.info({ intents }, "pruned expanded dispatch intents");
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
