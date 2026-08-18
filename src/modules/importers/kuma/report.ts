import {
  ReportBuilder as EntryLog,
  summariseEntries,
  type ImportStatus,
  type ImportTotals,
  type ReportEntry,
} from "../report";
import type { SchemaDrift } from "./pinned";

/**
 * The Uptime Kuma migration report.
 *
 * The vocabulary lives in `../report.ts`, which is where every migration
 * shares it. What stays here is what only a `kuma.db` has: a schema
 * version, a column count, and the drift between the file in front of
 * the importer and the release it was written against.
 */

export {
  entriesOfKind,
  ReportBuilder as EntryLog,
  type ImportOutcome,
  type ImportStatus,
  type ImportTotals,
  type ReportEntry,
  type SourceKind,
} from "../report";

export interface ImportReport {
  /**
   * `refused` means nothing was written. The transaction is rolled
   * back, so a refused import leaves no half-migrated organisation
   * behind for someone to reconcile by hand.
   *
   * `preview` means nothing was written *either*, and for a happier
   * reason: the caller asked what would happen. The work was done in
   * full, every monitor built, validated and inserted, every constraint
   * the database has actually checked, and then rolled back, which is
   * why a preview can promise things an estimate cannot. The consequence
   * is that the ids on its lines name rows that no longer exist; nothing
   * may follow them, and the status is how a caller knows.
   */
  status: ImportStatus;
  source: {
    databaseVersion: number | null;
    monitorColumnCount: number;
    monitorTypesPresent: number;
  };
  /** Empty when the source is the pinned release. */
  drift: SchemaDrift[];
  entries: ReportEntry[];
  totals: ImportTotals;
}

/**
 * The shared builder, plus the one thing a Kuma report has that a
 * provider report does not: schema drift.
 */
export class ReportBuilder extends EntryLog {
  finish(
    status: ImportStatus,
    source: ImportReport["source"],
    drift: SchemaDrift[],
  ): ImportReport {
    return {
      status,
      source,
      drift,
      entries: this.list(),
      totals: this.totals(),
    };
  }
}

/**
 * The report as text, for a CLI run or a support ticket.
 */
export function summariseReport(report: ImportReport): string {
  const lines: string[] = [];
  lines.push(
    report.status === "refused"
      ? "Import refused. Nothing was written."
      : report.status === "preview"
        ? `Dry run. Nothing was written. ${report.totals.monitorsCreated} monitor(s) would be imported.`
        : `Imported ${report.totals.monitorsCreated} monitor(s).`,
  );
  for (const entry of report.drift) {
    lines.push(`  schema: ${entry.detail}`);
  }
  lines.push(...summariseEntries(report.totals, report.entries));
  return lines.join("\n");
}
