"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db";
import {
  actionOk,
  actionError,
  toActionError,
  type ActionResult,
} from "@/lib/action-result";
import { requirePermission } from "@/lib/session";
import {
  createMonitorSchema,
  updateMonitorSchema,
} from "@/modules/monitors/schemas";
import {
  createMonitor,
  deleteMonitor,
  setMonitorPaused,
  updateMonitor,
} from "@/modules/monitors/service";

export async function createMonitorAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission({ monitor: ["create"] });
    const parsed = createMonitorSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    const monitor = await createMonitor(db, ctx, parsed.data);
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
    await updateMonitor(db, ctx, monitorId, parsed.data);
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
    await setMonitorPaused(db, ctx, monitorId, paused);
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
    await deleteMonitor(db, ctx, monitorId);
    revalidatePath("/monitors");
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}
