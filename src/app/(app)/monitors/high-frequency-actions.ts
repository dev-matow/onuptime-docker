"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { monitors } from "@/db/schema";
import {
  actionError,
  actionOk,
  toActionError,
  type ActionResult,
} from "@/lib/action-result";
import { requireOrgContext, requirePermission } from "@/lib/session";
import {
  achievedCadence,
  setHighFrequency,
  HF_MAX_INTERVAL_MS,
  HF_MIN_INTERVAL_MS,
  type AchievedCadence,
} from "@/modules/monitors/highfreq";

/**
 * The two server actions the high-frequency toggle needs.
 *
 * A file of its own rather than lines in `actions.ts`, for the same
 * reason `setHighFrequency` is not part of `updateMonitor`: this is a
 * change of which machinery runs the check, not a change to the check.
 * Keeping it separate also keeps the general monitor form's submit path
 * untouched, which matters while several people are editing it.
 */

const settingsSchema = z.object({
  enabled: z.boolean(),
  intervalMs: z
    .number()
    .int()
    .min(HF_MIN_INTERVAL_MS)
    .max(HF_MAX_INTERVAL_MS)
    .optional(),
});

export async function setHighFrequencyAction(
  monitorId: string,
  input: unknown,
): Promise<ActionResult> {
  try {
    const ctx = await requirePermission({ monitor: ["update"] });
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    await setHighFrequency(db, ctx, monitorId, parsed.data);
    revalidatePath("/monitors");
    revalidatePath(`/monitors/${monitorId}`);
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

export interface CadenceReport {
  configuredIntervalMs: number | null;
  achieved: AchievedCadence;
}

/**
 * What the operator asked for, and what actually happened — returned as
 * two fields, never reconciled into one.
 *
 * The UI renders them side by side for the same reason they are two
 * fields here: a configured interval is a request and the achieved
 * figure is the answer, and every version of this product before this
 * release showed only the request. Read-only, so it is gated on being
 * able to see the monitor rather than on being able to change it.
 */
export async function cadenceReportAction(
  monitorId: string,
): Promise<ActionResult<CadenceReport>> {
  try {
    const ctx = await requireOrgContext();
    const monitor = await db.query.monitors.findFirst({
      where: and(
        eq(monitors.id, monitorId),
        // Tenant-scoped in the predicate, not checked afterwards: this
        // reads a monitor by an id the caller supplied.
        eq(monitors.organizationId, ctx.organizationId),
      ),
      columns: { highFrequencyIntervalMs: true },
    });
    if (!monitor) return actionError("Monitor not found.");
    return actionOk({
      configuredIntervalMs: monitor.highFrequencyIntervalMs,
      achieved: await achievedCadence(
        db,
        monitorId,
        undefined,
        monitor.highFrequencyIntervalMs,
      ),
    });
  } catch (error) {
    return toActionError(error);
  }
}
