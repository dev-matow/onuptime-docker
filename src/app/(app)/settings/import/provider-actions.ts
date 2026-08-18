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
import {
  importSnapshot,
  type MigrationReport,
} from "@/modules/importers/engine";
import { findProvider } from "@/modules/importers/providers";

/**
 * The two clicks, for a source that lives behind an API.
 *
 * Click one reads the account and rolls the import back. Click two reads
 * it again and keeps it. Both do the same work; the only difference is
 * whether the transaction commits, which is what makes the summary worth
 * confirming: it is a result, not a forecast.
 *
 * **The account is read twice, on purpose.** The alternative is to hold
 * the snapshot on the server between the clicks, which means a store of
 * other people's monitoring configuration with a lifetime nobody owns.
 * The cost of re-reading is that a check created in the source between
 * the two clicks appears in the second report and not the first, and the
 * report the operator keeps is always the one from the run that
 * actually happened.
 *
 * **Credentials are never stored.** They arrive in the form body, are
 * used to authenticate one read, and go out of scope. Nothing writes
 * them to the database, to a log or to the report; the transport that
 * holds them never gives them back, and every error it raises is built
 * from a redacted URL and a status code.
 */

export interface ProviderImportResult {
  providerId: string;
  providerLabel: string;
  report: MigrationReport;
}

/** Credential fields for one provider, out of the submitted form. */
function credentialsFrom(
  formData: FormData,
  provider: { credentials: readonly { name: string }[] },
): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const field of provider.credentials) {
    const value = formData.get(field.name);
    if (typeof value === "string") credentials[field.name] = value;
  }
  return credentials;
}

async function run(
  formData: FormData,
  dryRun: boolean,
): Promise<ActionResult<ProviderImportResult>> {
  const ctx = await requirePermission({ monitor: ["create"] });
  assertPermission(ctx.role, { statusPage: ["update"] });

  const providerId = String(formData.get("provider") ?? "");
  const provider = findProvider(providerId);
  if (provider === undefined) {
    return actionError("Choose a source to import from.");
  }

  for (const field of provider.credentials) {
    if (
      field.required &&
      String(formData.get(field.name) ?? "").trim() === ""
    ) {
      return actionError(`${field.label} is required.`);
    }
  }

  let report: MigrationReport;
  try {
    const snapshot = await provider.read({
      credentials: credentialsFrom(formData, provider),
    });
    report = await importSnapshot(db, ctx, snapshot, { dryRun });
  } catch (error) {
    // The adapter and the transport already word their failures for an
    // operator and neither of them puts a credential in one. Anything
    // else is a bug here, and its message is still safe to show because
    // nothing in this file has ever held the token in a string that gets
    // interpolated.
    const message = error instanceof Error ? error.message : String(error);
    return actionError(
      `${provider.label} could not be read: ${message} Nothing was imported.`,
    );
  }

  if (!dryRun) {
    revalidatePath("/monitors");
    revalidatePath("/dashboard");
  }

  return actionOk({
    providerId: provider.id,
    providerLabel: provider.label,
    report,
  });
}

/** What the import would do, from a real import that was rolled back. */
export async function previewProviderImportAction(
  formData: FormData,
): Promise<ActionResult<ProviderImportResult>> {
  try {
    return await run(formData, true);
  } catch (error) {
    return toActionError(error);
  }
}

/** The same run, committed. */
export async function runProviderImportAction(
  formData: FormData,
): Promise<ActionResult<ProviderImportResult>> {
  try {
    return await run(formData, false);
  } catch (error) {
    return toActionError(error);
  }
}
