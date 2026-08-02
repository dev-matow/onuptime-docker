import { and, count, eq, ne } from "drizzle-orm";

import type { DbClient } from "@/db";
import { monitors } from "@/db/schema";
import { AppError, NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit";

import type { Monitor } from "../service";
import {
  highFrequencyCapability,
  HF_MAX_INTERVAL_MS,
  HF_MIN_INTERVAL_MS,
} from "./capabilities";
import { HF_MAX_MONITORS_PER_ORG } from "./limits";

/**
 * Putting a monitor on the high-frequency plane, and taking it off.
 *
 * A separate operation from editing a monitor, deliberately. Every other
 * field on the form describes what to check; this one changes which
 * machinery checks it, costs measurably more CPU and storage, and is
 * refusable for reasons that have nothing to do with the monitor itself
 * (the organization's quota, the check type's cost). Folding it into the
 * general update would mean an operator who renamed a monitor could be
 * told "your organization has too many high-frequency monitors", which
 * is a confusing thing to hear about a rename.
 */

export interface HighFrequencySettings {
  enabled: boolean;
  /** Required when enabling; ignored when disabling. */
  intervalMs?: number;
}

interface Actor {
  organizationId: string;
  userId: string;
}

/**
 * Validates a request, applies it, and writes the audit entry.
 *
 * Every refusal names the limit and the number, because the operator's
 * next question is always "then what may I have" and an error that does
 * not answer it sends them to the documentation to guess.
 */
export async function setHighFrequency(
  db: DbClient,
  actor: Actor,
  monitorId: string,
  settings: HighFrequencySettings,
): Promise<Monitor> {
  const existing = await db.query.monitors.findFirst({
    where: and(
      eq(monitors.id, monitorId),
      eq(monitors.organizationId, actor.organizationId),
    ),
  });
  if (!existing) throw new NotFoundError("Monitor not found.");

  if (!settings.enabled) {
    return update(db, actor, monitorId, false, null);
  }

  const capability = highFrequencyCapability(existing.checkType);
  if (!capability.supportsHighFrequency) {
    throw new AppError(
      `A ${existing.checkType} monitor cannot run at high frequency. ${capability.excludedBecause}`,
    );
  }

  const intervalMs = settings.intervalMs;
  if (intervalMs === undefined || !Number.isInteger(intervalMs)) {
    throw new AppError("A high-frequency interval is required.");
  }
  if (intervalMs < capability.minimumIntervalMs) {
    throw new AppError(
      `The shortest interval this plane delivers is ${capability.minimumIntervalMs}ms.`,
    );
  }
  if (intervalMs > HF_MAX_INTERVAL_MS) {
    // Refused rather than accepted-and-ignored: above this the ordinary
    // scheduler already delivers the cadence, and running it here would
    // move the monitor onto a plane with worse restart behaviour for no
    // gain the operator could observe.
    throw new AppError(
      `Intervals above ${HF_MAX_INTERVAL_MS}ms are handled by the ordinary scheduler, set "Check interval" instead.`,
    );
  }

  // Counted excluding this monitor, so re-enabling one that is already
  // on the plane is never refused by the quota it is itself occupying.
  const rows = await db
    .select({ enabled: count() })
    .from(monitors)
    .where(
      and(
        eq(monitors.organizationId, actor.organizationId),
        eq(monitors.highFrequency, true),
        ne(monitors.id, monitorId),
      ),
    );
  const enabled = rows[0]?.enabled ?? 0;
  if (enabled >= HF_MAX_MONITORS_PER_ORG) {
    throw new AppError(
      `This organization already has ${enabled} high-frequency monitors, which is the limit of ${HF_MAX_MONITORS_PER_ORG}.`,
    );
  }

  return update(db, actor, monitorId, true, intervalMs);
}

async function update(
  db: DbClient,
  actor: Actor,
  monitorId: string,
  enabled: boolean,
  intervalMs: number | null,
): Promise<Monitor> {
  const [updated] = await db
    .update(monitors)
    .set({
      highFrequency: enabled,
      highFrequencyIntervalMs: intervalMs,
      // Turning the plane off hands the monitor back to the queue, and
      // it must not wait out a `next_evaluation_at` computed while it
      // was being probed twice a second — nor sit unchecked because the
      // last promotion scheduled it for a minute's time.
      nextEvaluationAt: enabled ? undefined : new Date(),
    })
    .where(
      and(
        eq(monitors.id, monitorId),
        eq(monitors.organizationId, actor.organizationId),
      ),
    )
    .returning();
  if (!updated) throw new NotFoundError("Monitor not found.");

  await writeAudit(db, {
    organizationId: actor.organizationId,
    actorId: actor.userId,
    action: enabled
      ? "monitor.high_frequency.enabled"
      : "monitor.high_frequency.disabled",
    targetType: "monitor",
    targetId: monitorId,
    metadata: { intervalMs },
  });

  return updated;
}

export { HF_MAX_INTERVAL_MS, HF_MIN_INTERVAL_MS };
