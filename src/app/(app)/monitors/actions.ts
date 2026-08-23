"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db";
import {
  actionOk,
  actionError,
  toActionError,
  type ActionResult,
} from "@/lib/action-result";
import { requireOrgContext, requirePermission } from "@/lib/session";
import { ensureActor } from "@/modules/ledger/service";
import {
  refreshDeclaredState,
  refreshGroups,
} from "@/modules/monitors/outcome";
import {
  createMonitorSchema,
  updateMonitorSchema,
} from "@/modules/monitors/schemas";
import { runMonitorNow } from "@/modules/monitors/manual-run";
import {
  cloneMonitor,
  createMonitor,
  deleteMonitor,
  listGroups,
  pushEndpointFor,
  regeneratePushToken,
  setMonitorPaused,
  updateMonitor,
} from "@/modules/monitors/service";

/**
 * The ledger identity for an observation a person caused.
 *
 * `human`, not `worker`: a manual monitor's state was asserted by
 * someone, and the chain that records it should say who rather than
 * attributing it to whichever replica happened to serve the request.
 */
function operatorActor(userId: string): Promise<string> {
  return ensureActor(db, "human", userId);
}

/**
 * The groups a monitor may be put into.
 *
 * Fetched by the form rather than passed down as a prop, deliberately.
 * Group membership applies to every check type, so the picker is on
 * every monitor form, and there are already two dialogs that render one
 * — threading a new prop through each of them makes adding the third a
 * change to three files instead of none. Read-only and tenant-scoped,
 * so it is safe to expose to anyone who can already see the monitor
 * list.
 */
export async function listGroupOptionsAction(
  excludeId?: string,
): Promise<ActionResult<{ id: string; name: string }[]>> {
  try {
    const ctx = await requireOrgContext();
    const groups = await listGroups(db, ctx.organizationId, excludeId);
    return actionOk(groups);
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * The push endpoint for one monitor, revealed on request.
 *
 * The token is a bearer credential and is masked out of everything the
 * server renders, which is what stops it reaching a viewer's page
 * source along with the rest of the config. An operator who may edit
 * the monitor may see it — but they have to ask, and the ask is
 * permission-checked here rather than assumed by whatever component
 * happened to receive the row.
 */
export async function pushEndpointAction(
  monitorId: string,
): Promise<ActionResult<{ url: string }>> {
  try {
    const ctx = await requirePermission({ monitor: ["update"] });
    return actionOk({ url: await pushEndpointFor(db, ctx, monitorId) });
  } catch (error) {
    return toActionError(error);
  }
}

/** Issues a fresh token, and invalidates whatever holds the old one. */
export async function regeneratePushTokenAction(
  monitorId: string,
): Promise<ActionResult<{ url: string }>> {
  try {
    const ctx = await requirePermission({ monitor: ["update"] });
    const url = await regeneratePushToken(db, ctx, monitorId);
    revalidatePath(`/monitors/${monitorId}`);
    return actionOk({ url });
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * "Check it now."
 *
 * Guarded by `monitor: ["update"]` rather than by a read permission,
 * because this writes: it produces a real observation, it can move the
 * monitor's status, and it can open or resolve an incident. A viewer who
 * could press it could page an on-call engineer.
 *
 * It also runs the check inline, which means this action can take tens
 * of seconds. That is the point - an operator iterating on a journey
 * needs the answer here rather than in a run history they have to go and
 * refresh - and `MANUAL_RUN_BUDGET_MS` is what stops it being unbounded.
 */
export async function runMonitorNowAction(monitorId: string): Promise<
  ActionResult<{
    verdict: string;
    error: string | null;
    syntheticRunId: string | null;
  }>
> {
  try {
    const ctx = await requirePermission({ monitor: ["update"] });
    const result = await runMonitorNow(db, ctx, monitorId);
    revalidatePath(`/monitors/${monitorId}`);
    return actionOk({
      verdict: result.verdict,
      error: result.error,
      syntheticRunId: result.syntheticRunId,
    });
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Duplicate a monitor, paused.
 *
 * `monitor: ["create"]` and not `["update"]`: the result of this is a
 * new monitor, and somebody who may edit the fleet but not grow it must
 * not be able to grow it sideways.
 */
export async function cloneMonitorAction(
  monitorId: string,
): Promise<ActionResult<{ id: string; name: string }>> {
  try {
    const ctx = await requirePermission({ monitor: ["create"] });
    const monitor = await cloneMonitor(db, ctx, monitorId);
    revalidatePath("/monitors");
    return actionOk({ id: monitor.id, name: monitor.name });
  } catch (error) {
    return toActionError(error);
  }
}

export async function createMonitorAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission({ monitor: ["create"] });
    const parsed = createMonitorSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    // One transaction for one logical change. Creating the monitor and
    // routing its pages are not two decisions an operator made — they
    // filled in one form. Committing the monitor first left a live,
    // already-scheduled monitor with no escalation policy whenever the
    // second call failed, which is the configuration most likely to page
    // nobody during the outage it then detects.
    const monitor = await db.transaction(async (tx) => {
      const created = await createMonitor(tx, ctx, parsed.data);
      return created;
    });
    // Outside the transaction, and it has to be: a manual monitor's
    // first observation and a group's first derivation are what give
    // them a state at all, and both can open an incident. Doing that
    // inside the create would mean an incident whose monitor is not yet
    // visible to any other connection.
    await refreshDeclaredState(monitor, {
      actorId: await operatorActor(ctx.userId),
    });
    revalidatePath("/monitors");
    return actionOk({ id: monitor.id });
  } catch (error) {
    return toActionError(error);
  }
}

export async function updateMonitorAction(
  monitorId: string,
  input: unknown,
): Promise<ActionResult> {
  try {
    const ctx = await requirePermission({ monitor: ["update"] });
    const parsed = updateMonitorSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    // One transaction, for the same reason as create: a policy change
    // that failed after the monitor committed left the two halves of one
    // edit disagreeing, with no error the operator could act on.
    const updated = await db.transaction(async (tx) => {
      const monitor = await updateMonitor(tx, ctx, monitorId, parsed.data);
      return monitor;
    });
    // An edit is the only moment a manual monitor's status changes and
    // one of the moments a group's membership does, so the consequences
    // are applied here — through the same path a failed probe takes, so
    // that a vendor an operator marks down pages exactly like an
    // endpoint that stopped answering.
    await refreshDeclaredState(updated, {
      actorId: await operatorActor(ctx.userId),
    });
    revalidatePath("/monitors");
    revalidatePath(`/monitors/${monitorId}`);
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

export async function setMonitorPausedAction(
  monitorId: string,
  paused: boolean,
): Promise<ActionResult> {
  try {
    const ctx = await requirePermission({ monitor: ["update"] });
    const monitor = await setMonitorPaused(db, ctx, monitorId, paused);
    // Pausing a member changes what its group is derived from: a paused
    // monitor is counted as nothing, so silencing the one that is down
    // is exactly the case where the group must stop being red.
    await refreshGroups(monitor.parentId, {
      actorId: await operatorActor(ctx.userId),
    });
    revalidatePath("/monitors");
    revalidatePath(`/monitors/${monitorId}`);
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteMonitorAction(
  monitorId: string,
): Promise<ActionResult> {
  try {
    const ctx = await requirePermission({ monitor: ["delete"] });
    const { releasedGroupId } = await deleteMonitor(db, ctx, monitorId);
    // The group it was in has one member fewer, and nothing else will
    // ever tell it — a group is only re-derived when a member reports,
    // and this one never will again.
    await refreshGroups(releasedGroupId, {
      actorId: await operatorActor(ctx.userId),
    });
    revalidatePath("/monitors");
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

