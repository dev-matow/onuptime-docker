import { and, eq } from "drizzle-orm";

import type { DbClient } from "@/db";
import { monitors } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { writeAudit } from "@/modules/audit";
import { ensureActor } from "@/modules/ledger/service";

import type { CheckResult } from "./check";
import { evaluateMonitor } from "./evaluate";
import { openEvidence, recordEvidence } from "./evidence";
import { applyOutcome } from "./outcome";
import { checkTypeKind } from "./types/catalog";
import { isScheduledKind } from "./types/contract";

/**
 * "Check it now", from the interface.
 *
 * Deliberately general rather than a synthetics feature, even though
 * scripted synthetics is what made it necessary. Every check type
 * benefits from "I have just fixed the config, does it work?", and a
 * button that only appeared for two of forty types would be a smaller
 * version of the same product.
 *
 * It runs INLINE, in the request, and that is a considered choice
 * against the obvious alternative of enqueueing a job. Enqueueing would
 * mean the answer arrives somewhere else, at some point, and the
 * operator has to go and look for it - which for a person who is
 * iterating on a journey is the difference between a usable editor and
 * an unusable one. The cost is a request that can take tens of seconds,
 * which is why {@link MANUAL_RUN_BUDGET_MS} exists.
 *
 * The observation it produces is a real one. It is written to
 * `monitor_checks`, it is judged by the same engine, it moves the
 * monitor's status, and it can open or resolve an incident - because a
 * manual check that could not do those things would be a different
 * measurement wearing the same name, and an operator would have no way
 * to know which one they were looking at.
 */

/**
 * How long an interactive run may take before it is cancelled.
 *
 * Well under the largest journey budget on purpose. A scheduled browser
 * journey may run for five minutes; a request that did would be killed
 * by a proxy somewhere in between, and the operator would be left with a
 * spinner and a run row nothing closed. Cancelling at a number we
 * choose - and reporting it as a cancellation, in the run's own record -
 * is the version of this failure that explains itself.
 */
export const MANUAL_RUN_BUDGET_MS = 45_000;

export interface ManualRunActor {
  organizationId: string;
  userId: string;
}

export interface ManualRunResult {
  monitorId: string;
  verdict: CheckResult["verdict"];
  error: string | null;
  responseTimeMs: number | null;
  /** The synthetic run this produced, when the type keeps one. */
  syntheticRunId: string | null;
}

export async function runMonitorNow(
  db: DbClient,
  actor: ManualRunActor,
  monitorId: string,
): Promise<ManualRunResult> {
  const monitor = await db.query.monitors.findFirst({
    // Tenant-scoped in the query rather than checked afterwards. A
    // monitor id is a uuid a person can paste, and "read it then compare
    // the organization" is one forgotten comparison away from letting
    // one tenant probe another tenant's target.
    where: and(
      eq(monitors.id, monitorId),
      eq(monitors.organizationId, actor.organizationId),
    ),
  });
  if (!monitor) throw new AppError("That monitor does not exist.");

  // A group, a heartbeat and a manual monitor have nothing to dial, and
  // "check now" on one of them would either do nothing or - worse -
  // write an observation on a cadence that means nothing for that kind,
  // on top of the one the operator's own edit already recorded.
  if (!isScheduledKind(checkTypeKind(monitor.checkType))) {
    throw new AppError(
      "This kind of monitor is not checked on demand: its state arrives, is derived, or is stated by a person.",
    );
  }

  // Opened before the check runs, for the types that keep a record of
  // their own. A manual run gets its OWN record and never collapses onto
  // the scheduled run it happens to share an instant with: they are two
  // measurements, and one of them was asked for by a person.
  const evidenceId = await openEvidence(db, monitor, actor, "manual");

  const outcome = await evaluateMonitor(db, monitor, {
    allowPrivateTargets: env.ALLOW_PRIVATE_MONITOR_TARGETS,
    signal: AbortSignal.timeout(MANUAL_RUN_BUDGET_MS),
    subject: {
      trigger: "manual",
      actorUserId: actor.userId,
      runId: evidenceId,
      scheduledFor: null,
    },
  });

  // Before the outcome is applied, so that an incident opened by it
  // links to a record that already exists.
  await recordEvidence(db, evidenceId, outcome.evidence);

  // The same door every other observation comes through. No boss, so no
  // recovery chain is started from here - a person who has just pressed
  // "check now" is present and does not need an automated restart racing
  // them, and the scheduled check ninety seconds later will start one if
  // the outage is real.
  await applyOutcome(monitor, outcome, {
    actorId: await ensureActor(db, "human", actor.userId),
  });

  await writeAudit(db, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: "monitor.checked",
    targetType: "monitor",
    targetId: monitor.id,
    // The verdict and nothing else. The error text can quote a response
    // body, and an audit trail outlives every other copy of that.
    metadata: { verdict: outcome.verdict, checkType: monitor.checkType },
  });

  return {
    monitorId: monitor.id,
    verdict: outcome.verdict,
    error: outcome.error,
    responseTimeMs: outcome.responseTimeMs,
    syntheticRunId: evidenceId,
  };
}
