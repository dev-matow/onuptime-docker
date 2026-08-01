import { db } from "@/db";
import { logger } from "@/lib/logger";
import { runHighFrequencyRollup } from "@/modules/monitors/highfreq";

const log = logger.child({ job: "high-frequency-rollup" });

/**
 * The minute tick that turns raw high-frequency samples into buckets and
 * throws the raw ones away.
 *
 * On the queue rather than inside the plane, and that separation is
 * deliberate: the plane is a scheduler whose one job is issuing probes on
 * time, and a rollup is a multi-second aggregate over a large table.
 * Running it inside the plane's process on the plane's event loop would
 * make every monitor's cadence a function of how long the aggregate
 * took. It is also the kind of work pg-boss is good at — one runner
 * across replicas, retried, cron-scheduled — so it belongs there.
 *
 * Silent when there was nothing to do. This fires every minute on every
 * installation, and the vast majority have no high-frequency monitors at
 * all; a log line per idle tick would bury the ones that matter.
 */
export async function runHighFrequencyRollupJob(): Promise<void> {
  const result = await runHighFrequencyRollup(db);
  const touched =
    result.minuteBuckets + result.hourBuckets + result.dayBuckets > 0;
  if (touched || result.samplesPruned > 0) {
    log.info(result, "high-frequency rollup");
  }
}
