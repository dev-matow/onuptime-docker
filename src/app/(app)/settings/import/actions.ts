"use server";

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  importKumaDatabase,
  readKumaDatabase,
  type ImportReport,
} from "@/modules/importers/kuma";

/**
 * The two clicks.
 *
 * Click one uploads a `kuma.db` and gets a summary. Click two applies
 * it. Both actions do the same work against the same file; the only
 * difference is whether the transaction is committed, which is what
 * makes the summary worth confirming — it is a result, not a forecast.
 *
 * **The file is uploaded twice, on purpose.** The alternative is to
 * keep it on the server between the two clicks, which means a directory
 * of other people's monitoring databases with a lifetime nobody owns,
 * cleaned up by a job that does not exist yet. Re-sending it costs one
 * upload and leaves no state at all. What the second click promises —
 * that it applies the run that was shown — is kept by the digest: the
 * preview returns the file's SHA-256, the confirm sends it back, and a
 * body that hashes to anything else is refused rather than imported.
 *
 * Neither action trusts the digest as an authorisation. It says "this
 * is the same file", not "you may import"; the permission check runs
 * first and independently, on every call.
 */

/**
 * The largest upload this accepts, under the body limit configured in
 * `next.config.ts` so that an oversized file produces this sentence
 * rather than a framework error with no advice in it.
 *
 * A Kuma database is mostly heartbeats. An install with years of them
 * can exceed this, and the answer is not a bigger number — buffering a
 * gigabyte of someone else's history through a server action to import
 * the 200KB of it that is monitors is the wrong shape. Point
 * `importKumaFile()` at the file instead.
 */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export interface KumaImportPreview {
  /** SHA-256 of the uploaded bytes, echoed back on confirm. */
  digest: string;
  fileName: string;
  /** `preview` on a dry run, `completed` or `refused` on a real one. */
  report: ImportReport;
}

interface Upload {
  digest: string;
  fileName: string;
  /** Where the bytes were written. The caller must remove the dir. */
  path: string;
  dir: string;
}

/**
 * The uploaded database on disk, because SQLite reads files.
 *
 * Written to a fresh temp directory per call and removed in the
 * caller's `finally`. `node:sqlite` has no way to open a buffer, and
 * inventing one — a FUSE mount, a VFS shim — would be a great deal of
 * machinery to avoid a file that exists for the length of one request.
 */
async function receive(formData: FormData): Promise<Upload | string> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return "Choose a kuma.db file to import.";
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `That file is ${Math.round(file.size / 1024 / 1024)}MB and the limit here is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB. Most of a large Kuma database is heartbeat history, which does not import, see docs/KUMA-IMPORT.md for the command-line path.`;
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const dir = mkdtempSync(join(tmpdir(), "vigil-kuma-"));
  const path = join(dir, "kuma.db");
  writeFileSync(path, bytes);
  return {
    digest: createHash("sha256").update(bytes).digest("hex"),
    fileName: file.name,
    path,
    dir,
  };
}

/** Anything that is not a SQLite database Kuma wrote, said plainly. */
function unreadable(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `That file could not be read as an Uptime Kuma database: ${message}. Copy kuma.db out of your Kuma volume, and if Kuma is still running, checkpoint it first with PRAGMA wal_checkpoint(TRUNCATE), because everything since the last checkpoint lives in the -wal sidecar.`;
}

/**
 * What the import would do, from a real import that was rolled back.
 *
 * Every monitor is built, validated and inserted and every database
 * constraint is actually checked before the transaction is abandoned,
 * which is why this can say that a status page slug is taken or that a
 * push token is already in use. An estimate could not.
 */
export async function previewKumaImportAction(
  formData: FormData,
): Promise<ActionResult<KumaImportPreview>> {
  try {
    const ctx = await requirePermission({ monitor: ["create"] });
    assertPermission(ctx.role, { statusPage: ["update"] });

    const upload = await receive(formData);
    if (typeof upload === "string") return actionError(upload);
    try {
      const source = readKumaDatabase(upload.path);
      const report = await importKumaDatabase(db, ctx, source, {
        dryRun: true,
        allowSchemaDrift: formData.get("allowSchemaDrift") === "on",
      });
      return actionOk({
        digest: upload.digest,
        fileName: upload.fileName,
        report,
      });
    } catch (error) {
      return actionError(unreadable(error));
    } finally {
      rmSync(upload.dir, { recursive: true, force: true });
    }
  } catch (error) {
    return toActionError(error);
  }
}

/** The same run, committed. */
export async function runKumaImportAction(
  formData: FormData,
): Promise<ActionResult<KumaImportPreview>> {
  try {
    const ctx = await requirePermission({ monitor: ["create"] });
    assertPermission(ctx.role, { statusPage: ["update"] });

    const upload = await receive(formData);
    if (typeof upload === "string") return actionError(upload);
    try {
      if (formData.get("digest") !== upload.digest) {
        return actionError(
          "This is not the file the summary was produced from. Choose it again and re-read the summary before importing.",
        );
      }
      const source = readKumaDatabase(upload.path);
      const report = await importKumaDatabase(db, ctx, source, {
        allowSchemaDrift: formData.get("allowSchemaDrift") === "on",
      });
      revalidatePath("/monitors");
      revalidatePath("/dashboard");
      return actionOk({
        digest: upload.digest,
        fileName: upload.fileName,
        report,
      });
    } catch (error) {
      return actionError(unreadable(error));
    } finally {
      rmSync(upload.dir, { recursive: true, force: true });
    }
  } catch (error) {
    return toActionError(error);
  }
}
