import { sql } from "drizzle-orm";

import { db } from "@/db";
import { monitorChecks } from "@/db/schema";
import { logger } from "@/lib/logger";

import { CHECK_RETENTION_DAYS } from "../queues";

/** Nightly: drop check rows past the retention window. */
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
}
