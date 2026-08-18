import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { DbClient } from "@/db";
import { monitors } from "@/db/schema";

import { createMonitorSchema } from "./schemas";
import { createMonitor, type Monitor } from "./service";
import { maskTargetSecret, restoreTargetSecret } from "./spec";
import { SECRET_MASK, secretFieldsOf } from "./types/config";
import { requireSpec } from "./types/specs";

/**
 * Exporting and re-importing a monitor without losing anything that
 * matters, and without leaking anything that must not travel.
 *
 * Section 9 of the release reference asks for a create/edit/export/import
 * round trip per type as the proof that edits are safe. The interesting
 * half is not the round trip — it is the two things that must NOT round
 * trip:
 *
 *  - **Secrets.** An export is a file an operator emails to themselves,
 *    commits, or pastes into a ticket. Putting a Redis password in it
 *    turns a convenience feature into a credential-disclosure bug. They
 *    are replaced by `SECRET_MASK`, exactly as the edit form receives
 *    them, and an import that sees the mask leaves the field unset
 *    rather than writing the sentinel.
 *  - **Identity.** Ids, timestamps, current status, failure counters and
 *    the organization are properties of a monitor's *life*, not of its
 *    configuration. Carrying them across would either collide on import
 *    or resurrect a stale status that was never observed here.
 *
 * The format is versioned from the first release, because the first
 * unversioned export is the one nobody can safely change later.
 */

/** Bumped when the shape changes in a way an older importer misreads. */
export const EXPORT_FORMAT_VERSION = 1;

const exportedMonitorSchema = z.object({
  name: z.string().min(1).max(200),
  checkType: z.string().min(1),
  url: z.string().min(1),
  port: z.number().int().nullable(),
  method: z.enum(["GET", "HEAD"]),
  intervalSeconds: z.number().int(),
  timeoutMs: z.number().int(),
  degradedThresholdMs: z.number().int(),
  expectedStatusCode: z.number().int().nullable(),
  bodyKeyword: z.string().nullable(),
  keywordAbsent: z.boolean(),
  tlsCheck: z.boolean(),
  tlsWarnDays: z.number().int(),
  failureWindowSeconds: z.number().int(),
  config: z.unknown().nullable(),
  paused: z.boolean(),
});

export const monitorExportSchema = z.object({
  format: z.literal("vigil.monitors"),
  version: z.number().int(),
  exportedAt: z.string(),
  monitors: z.array(exportedMonitorSchema),
});

export type ExportedMonitor = z.infer<typeof exportedMonitorSchema>;
export type MonitorExport = z.infer<typeof monitorExportSchema>;

/**
 * Strips a stored monitor down to its configuration, masking secrets.
 *
 * Masking rather than omitting: an operator reading the file needs to
 * see that a credential exists and has to be re-entered. An omitted key
 * looks like a monitor that never had one.
 */
function toExported(monitor: Monitor): ExportedMonitor {
  const spec = requireSpec(monitor.checkType);
  const secrets = secretFieldsOf(spec);
  let config = monitor.config;

  if (secrets.length > 0 && config !== null && typeof config === "object") {
    const masked: Record<string, unknown> = {
      ...(config as Record<string, unknown>),
    };
    for (const field of secrets) {
      if (masked[field] !== null && masked[field] !== undefined) {
        masked[field] = SECRET_MASK;
      }
    }
    config = masked;
  }

  return {
    name: monitor.name,
    checkType: monitor.checkType,
    // A target carries a secret too. `postgres` and `sqlserver` are
    // addressed by a connection string and the catalog's placeholder
    // tells the operator to put the password in it, so an export that
    // masked `config.password` and wrote the same credential out inside
    // `url` was masking one copy of a secret and publishing the other.
    // Same rule as the config blob, same sentinel: the name travels,
    // the password does not.
    url: maskTargetSecret(monitor.url),
    port: monitor.port,
    method: monitor.method,
    intervalSeconds: monitor.intervalSeconds,
    timeoutMs: monitor.timeoutMs,
    degradedThresholdMs: monitor.degradedThresholdMs,
    expectedStatusCode: monitor.expectedStatusCode,
    bodyKeyword: monitor.bodyKeyword,
    keywordAbsent: monitor.keywordAbsent,
    tlsCheck: monitor.tlsCheck,
    tlsWarnDays: monitor.tlsWarnDays,
    failureWindowSeconds: monitor.failureWindowSeconds,
    config,
    paused: monitor.paused,
  };
}

/**
 * Every monitor in an organization, or a named subset.
 *
 * @param monitorIds when given, restricts the export — always scoped to
 * the organization as well, so an id from another tenant exports nothing
 * rather than someone else's monitor.
 */
export async function exportMonitors(
  db: DbClient,
  organizationId: string,
  monitorIds?: readonly string[],
): Promise<MonitorExport> {
  const rows = await db
    .select()
    .from(monitors)
    .where(
      monitorIds && monitorIds.length > 0
        ? and(
            eq(monitors.organizationId, organizationId),
            inArray(monitors.id, [...monitorIds]),
          )
        : eq(monitors.organizationId, organizationId),
    );

  return {
    format: "vigil.monitors",
    version: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    monitors: rows.map(toExported),
  };
}

export interface ImportOutcome {
  name: string;
  checkType: string;
  status: "imported" | "skipped";
  /** Present on `skipped`. Never empty — a skip with no reason is a drop. */
  reason?: string;
  monitorId?: string;
  /** Secret fields the operator has to re-enter, because they were masked. */
  secretsToReenter: string[];
}

export interface ImportReport {
  imported: number;
  skipped: number;
  outcomes: ImportOutcome[];
}

/**
 * Recreates monitors from an export.
 *
 * Every input record produces exactly one outcome. That is the whole
 * contract: a record that cannot be imported is reported, never dropped,
 * because a silent drop in a migration tool is indistinguishable from
 * success until the outage nobody was watching for.
 *
 * Masked secrets are removed rather than written, so an imported Redis
 * monitor arrives with no password and says so in `secretsToReenter`. It
 * will fail authentication until an operator supplies one — which is the
 * honest outcome, and better than a monitor that silently authenticates
 * with the literal string `__vigil_unchanged_secret__`.
 */
export async function importMonitors(
  db: DbClient,
  actor: { organizationId: string; userId: string },
  input: unknown,
): Promise<ImportReport> {
  const parsed = monitorExportSchema.parse(input);
  if (parsed.version > EXPORT_FORMAT_VERSION) {
    throw new Error(
      `This file was written by a newer Vigil (format ${parsed.version}); this one understands ${EXPORT_FORMAT_VERSION}.`,
    );
  }

  const outcomes: ImportOutcome[] = [];

  for (const record of parsed.monitors) {
    const secretsToReenter: string[] = [];
    let spec;
    try {
      spec = requireSpec(record.checkType);
    } catch {
      outcomes.push({
        name: record.name,
        checkType: record.checkType,
        status: "skipped",
        reason: `This build has no check type "${record.checkType}".`,
        secretsToReenter,
      });
      continue;
    }

    let config = record.config;
    const secrets = secretFieldsOf(spec);
    if (secrets.length > 0 && config !== null && typeof config === "object") {
      const incoming: Record<string, unknown> = {
        ...(config as Record<string, unknown>),
      };
      for (const field of secrets) {
        if (incoming[field] === SECRET_MASK) {
          delete incoming[field];
          secretsToReenter.push(field);
        }
      }
      config = incoming;
    }

    // The target's own secret, by the same rule. `restoreTargetSecret`
    // with nothing to restore drops the sentinel and keeps the user
    // name, so the imported monitor addresses the right server as the
    // right user and fails authentication with a message that says so —
    // rather than dialling out with `__vigil_unchanged_secret__` as a
    // password, which is the one thing the sentinel must never do.
    const url = restoreTargetSecret(record.url, null);
    if (url !== record.url) secretsToReenter.push("url");

    try {
      // Validated with the SAME schema the create form uses, not just
      // the export shape. `createMonitor` trusts its input — target
      // validation lives at the action layer — so an importer that
      // called it directly would be a route around every rule the UI
      // enforces, including the one that refuses a target resolving into
      // private space.
      const validated = createMonitorSchema.parse({
        name: record.name,
        checkType: record.checkType,
        url,
        port: record.port,
        method: record.method,
        intervalSeconds: record.intervalSeconds,
        timeoutMs: record.timeoutMs,
        degradedThresholdMs: record.degradedThresholdMs,
        expectedStatusCode: record.expectedStatusCode,
        bodyKeyword: record.bodyKeyword,
        keywordAbsent: record.keywordAbsent,
        tlsCheck: record.tlsCheck,
        tlsWarnDays: record.tlsWarnDays,
        failureWindowSeconds: record.failureWindowSeconds,
        config,
      });
      const monitor = await createMonitor(db, actor, validated);

      if (record.paused) {
        await db
          .update(monitors)
          .set({ paused: true })
          .where(eq(monitors.id, monitor.id));
      }

      outcomes.push({
        name: record.name,
        checkType: record.checkType,
        status: "imported",
        monitorId: monitor.id,
        secretsToReenter,
      });
    } catch (error) {
      // Validation is per-record, so one bad monitor in a file of fifty
      // does not cost the other forty-nine. The message is the
      // operator's only route to fixing it, so it is carried verbatim.
      outcomes.push({
        name: record.name,
        checkType: record.checkType,
        status: "skipped",
        reason: error instanceof Error ? error.message : String(error),
        secretsToReenter,
      });
    }
  }

  return {
    imported: outcomes.filter((o) => o.status === "imported").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    outcomes,
  };
}
