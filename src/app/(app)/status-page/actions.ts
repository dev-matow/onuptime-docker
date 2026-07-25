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
  statusPageMonitorsSchema,
  updateStatusPageSchema,
} from "@/modules/status-pages/schemas";
import {
  setStatusPageMonitors,
  updateStatusPage,
} from "@/modules/status-pages/service";

export async function updateStatusPageAction(
  input: unknown,
): Promise<ActionResult<{ slug: string }>> {
  try {
    const ctx = await requirePermission({ statusPage: ["update"] });
    const parsed = updateStatusPageSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    const page = await updateStatusPage(db, ctx, parsed.data);
    revalidatePath("/status-page");
    revalidatePath(`/status/${page.slug}`);
    return actionOk({ slug: page.slug });
  } catch (error) {
    return toActionError(error);
  }
}

export async function setStatusPageMonitorsAction(
  input: unknown,
): Promise<ActionResult> {
  try {
    const ctx = await requirePermission({ statusPage: ["update"] });
    const parsed = statusPageMonitorsSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    await setStatusPageMonitors(db, ctx, parsed.data);
    revalidatePath("/status-page");
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}
