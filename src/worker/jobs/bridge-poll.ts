import { db } from "@/db";
import { logger } from "@/lib/logger";
import {
  listPollableBridges,
  pollBridgeEvidence,
} from "@/modules/importers/bridge/service";

const log = logger.child({ module: "bridge-poll" });

export interface BridgePollResult {
  bridges: number;
  ok: number;
  failed: number;
}

/**
 * One tick of migration-bridge evidence collection: every connected
 * bridge, in sequence, each poll fenced from the others by its own
 * try/catch so one tenant's revoked token cannot stop another tenant's
 * history from being read.
 *
 * Sequential rather than fanned out on purpose. Bridges are rare (one
 * per migrating organisation), each poll is a handful of GETs, and the
 * source is a third party whose rate limits are undocumented - a fleet
 * of concurrent polls is how an importer gets a customer's account
 * throttled during the week they most need it readable.
 */
export async function runBridgePoll(): Promise<BridgePollResult> {
  const bridges = await listPollableBridges(db);
  const result: BridgePollResult = {
    bridges: bridges.length,
    ok: 0,
    failed: 0,
  };
  for (const bridge of bridges) {
    try {
      const outcome = await pollBridgeEvidence(db, bridge);
      if (outcome.status === "ok") result.ok += 1;
      else if (outcome.status === "failed") result.failed += 1;
    } catch (error) {
      // `pollBridgeEvidence` records read failures itself; reaching here
      // means the recording failed too (a database error), which the
      // next tick retries by construction.
      result.failed += 1;
      log.error(
        { err: error, bridgeId: bridge.id },
        "bridge evidence poll could not be recorded",
      );
    }
  }
  return result;
}
