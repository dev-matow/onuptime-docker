"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db";
import {
  actionError,
  actionOk,
  toActionError,
  type ActionResult,
} from "@/lib/action-result";
import { assertPermission, requirePermission } from "@/lib/session";
import type { MigrationReport } from "@/modules/importers/engine";
import {
  abandonBridge,
  connectBridge,
  cutOverBridge,
  deleteBridge,
  disconnectBridge,
  generateCutoverReport,
  pollBridgeNow,
  runBridgeImport,
} from "@/modules/importers/bridge/service";

/**
 * The bridge's mutations, each the thinnest possible wrapper over the
 * service: permissions, the call, the revalidate. The double permission
 * gate mirrors the one-time importer's, because a bridge import creates
 * exactly what a one-time import creates.
 */

const BRIDGE_PATH = "/settings/import/bridge";

async function requireBridgeActor() {
  const ctx = await requirePermission({ monitor: ["create"] });
  assertPermission(ctx.role, { statusPage: ["update"] });
  return ctx;
}

export async function connectBridgeAction(
  formData: FormData,
): Promise<ActionResult<{ connected: true }>> {
  try {
    const ctx = await requireBridgeActor();
    const token = String(formData.get("token") ?? "");
    if (token.trim().length === 0) {
      return actionError("Paste a Better Stack API token first.");
    }
    await connectBridge(db, ctx, { token });
    revalidatePath(BRIDGE_PATH);
    return actionOk({ connected: true });
  } catch (error) {
    return toActionError(error);
  }
}

export async function disconnectBridgeAction(): Promise<
  ActionResult<{ disconnected: true }>
> {
  try {
    const ctx = await requireBridgeActor();
    await disconnectBridge(db, ctx);
    revalidatePath(BRIDGE_PATH);
    return actionOk({ disconnected: true });
  } catch (error) {
    return toActionError(error);
  }
}

export async function previewBridgeImportAction(): Promise<
  ActionResult<{ report: MigrationReport }>
> {
  try {
    const ctx = await requireBridgeActor();
    const report = await runBridgeImport(db, ctx, { dryRun: true });
    return actionOk({ report });
  } catch (error) {
    return toActionError(error);
  }
}

export async function runBridgeImportAction(): Promise<
  ActionResult<{ report: MigrationReport }>
> {
  try {
    const ctx = await requireBridgeActor();
    const report = await runBridgeImport(db, ctx, { dryRun: false });
    revalidatePath(BRIDGE_PATH);
    revalidatePath("/monitors");
    revalidatePath("/dashboard");
    return actionOk({ report });
  } catch (error) {
    return toActionError(error);
  }
}

export async function pollBridgeNowAction(): Promise<
  ActionResult<{ status: string; incidentsSeen: number; detail: string | null }>
> {
  try {
    const ctx = await requireBridgeActor();
    const outcome = await pollBridgeNow(db, ctx);
    revalidatePath(BRIDGE_PATH);
    return actionOk(outcome);
  } catch (error) {
    return toActionError(error);
  }
}

export async function generateCutoverReportAction(): Promise<
  ActionResult<{ reportId: string; verdict: string }>
> {
  try {
    const ctx = await requireBridgeActor();
    const { id, report } = await generateCutoverReport(db, ctx);
    revalidatePath(BRIDGE_PATH);
    return actionOk({ reportId: id, verdict: report.verdict });
  } catch (error) {
    return toActionError(error);
  }
}

export async function cutOverBridgeAction(): Promise<
  ActionResult<{ monitorsLive: number; incidentsClosed: number }>
> {
  try {
    const ctx = await requireBridgeActor();
    const outcome = await cutOverBridge(db, ctx);
    revalidatePath(BRIDGE_PATH);
    revalidatePath("/monitors");
    revalidatePath("/dashboard");
    return actionOk(outcome);
  } catch (error) {
    return toActionError(error);
  }
}

export async function abandonBridgeAction(): Promise<
  ActionResult<{ monitorsLive: number; incidentsClosed: number }>
> {
  try {
    const ctx = await requireBridgeActor();
    const outcome = await abandonBridge(db, ctx);
    revalidatePath(BRIDGE_PATH);
    revalidatePath("/monitors");
    return actionOk(outcome);
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteBridgeAction(): Promise<
  ActionResult<{ deleted: true }>
> {
  try {
    const ctx = await requireBridgeActor();
    await deleteBridge(db, ctx);
    revalidatePath(BRIDGE_PATH);
    return actionOk({ deleted: true });
  } catch (error) {
    return toActionError(error);
  }
}
