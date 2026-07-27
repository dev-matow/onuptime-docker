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
  createStatusPageSchema,
  statusPageMonitorsSchema,
  updateStatusPageSchema,
} from "@/modules/status-pages/schemas";
import {
  createStatusPage,
  deleteStatusPage,
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

export async function createStatusPageAction(
  input: unknown,
): Promise<ActionResult<{ slug: string }>> {
  try {
    const ctx = await requirePermission({ statusPage: ["update"] });
    const parsed = createStatusPageSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    const page = await createStatusPage(db, ctx, parsed.data);
    revalidatePath("/status-page");
    return actionOk({ slug: page.slug });
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteStatusPageAction(
  statusPageId: string,
): Promise<ActionResult> {
  try {
    const ctx = await requirePermission({ statusPage: ["update"] });
    const page = await deleteStatusPage(db, ctx, statusPageId);
    revalidatePath("/status-page");
    revalidatePath(`/status/${page.slug}`);
    return actionOk(undefined);
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
    const page = await setStatusPageMonitors(db, ctx, parsed.data);
    revalidatePath("/status-page");
    // Removing a component used to keep serving its name for up to 60s
    // because only the settings route was revalidated. The page is named
    // in the input now, so there is no excuse.
    revalidatePath(`/status/${page.slug}`);
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}
