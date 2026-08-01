import type { SchemaDrift } from "./pinned";

/**
 * The migration report.
 *
 * One rule holds this module up: **nothing leaves Kuma without a line
 * here**. Not a monitor, not a notification provider, not a tag, not a
 * maintenance window. An import that moves ten of thirty-one monitors
 * and says "done" is worse than one that refuses, because the operator
 * turns Kuma off believing the other twenty-one came too.
 *
 * That is why `skipped` and `unsupported` are outcomes rather than
 * silence, and why every entry carries a `detail` the reader can act
 * on. "Unsupported" alone would satisfy the letter of the rule and none
 * of its purpose.
 *
 * The four outcomes answer two different questions, and keeping them
 * apart is what makes the totals honest:
 *
 * | outcome       | monitor created | what it means                          |
 * |---------------|-----------------|----------------------------------------|
 * | `imported`    | yes             | nothing changed on the way across       |
 * | `transformed` | yes             | it exists, and it means something else  |
 * | `skipped`     | no              | Vigil could map the type, not this row  |
 * | `unsupported` | no              | Vigil has nothing to map it to          |
 *
 * `skipped` and `unsupported` are worth separating: the first is a
 * record an operator can usually fix and re-import, the second is a
 * capability that does not exist and no amount of editing will conjure.
 */

export type ImportOutcome =
  "imported" | "transformed" | "skipped" | "unsupported";

/**
 * What kind of Kuma record a line is about.
 *
 * `heartbeat-history` is per monitor rather than per beat. A heartbeat
 * is not a record an operator addresses — its identity is the monitor
 * and the window it covers — and a real Kuma holds millions, so a line
 * each would bury the report in the one thing nobody can act on.
 */
export type SourceKind =
  | "monitor"
  | "notification"
  | "notification-link"
  | "status-page"
  | "status-page-group"
  | "status-page-monitor"
  | "tag"
  | "tag-application"
  | "maintenance"
  | "maintenance-link"
  | "docker-host"
  | "remote-browser"
  | "proxy"
  | "heartbeat-history";

export interface ReportEntry {
  kind: SourceKind;
  /** Identity within the source database, for tracing back. */
  sourceId: string;
  /** What an operator would call it. */
  label: string;
  outcome: ImportOutcome;
  /** The rule applied, or the reason nothing was. Never empty. */
  detail: string;
  /**
   * The Vigil monitor this became, when it became one.
   *
   * Set on `monitor` lines and on nothing else, which is load-bearing:
   * `monitorsCreated` is derived by counting the entries that carry
   * one, so putting a monitor id on a status-page line to say which
   * monitor it published would silently inflate the headline number.
   * Those lines name the monitor in `label` instead.
   */
  monitorId: string | null;
  /**
   * The stored config as the caller may render it — every secret
   * already replaced by `SECRET_MASK`. Present only where a type has a
   * config blob. Passing the raw blob would put an MQTT password in
   * whatever renders the report, which is the same leak `redactConfig`
   * exists to close on the monitor page.
   */
  configPreview?: unknown;
}

export interface ImportTotals {
  imported: number;
  transformed: number;
  skipped: number;
  unsupported: number;
  /** Rows in Vigil's `monitors` table at the end of it. */
  monitorsCreated: number;
}

export interface ImportReport {
  /**
   * `refused` means nothing was written. The transaction is rolled
   * back, so a refused import leaves no half-migrated organisation
   * behind for someone to reconcile by hand.
   *
   * `preview` means nothing was written *either*, and for a happier
   * reason: the caller asked what would happen. The work was done in
   * full — every monitor built, validated and inserted, every
   * constraint the database has actually checked — and then rolled
   * back, which is why a preview can promise things an estimate cannot.
   * The consequence is that the ids on its lines name rows that no
   * longer exist; nothing may follow them, and the status is how a
   * caller knows.
   */
  status: "completed" | "refused" | "preview";
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
 * Accumulates entries and counts them once at the end.
 *
 * A builder rather than an array the engine pushes to, so the totals
 * cannot disagree with the lines they summarise — the number is derived
 * from the entries, never incremented alongside them.
 */
export class ReportBuilder {
  private readonly entries: ReportEntry[] = [];

  add(entry: ReportEntry): void {
    if (entry.detail.trim().length === 0) {
      // A line with no reason is the failure this class exists to
      // prevent, wearing the costume of compliance.
      throw new Error(
        `Report entry ${entry.kind}:${entry.sourceId} has no detail`,
      );
    }
    this.entries.push(entry);
  }

  finish(
    status: ImportReport["status"],
    source: ImportReport["source"],
    drift: SchemaDrift[],
  ): ImportReport {
    const totals: ImportTotals = {
      imported: 0,
      transformed: 0,
      skipped: 0,
      unsupported: 0,
      monitorsCreated: 0,
    };
    for (const entry of this.entries) {
      totals[entry.outcome] += 1;
      if (entry.monitorId !== null) totals.monitorsCreated += 1;
    }
    return { status, source, drift, entries: [...this.entries], totals };
  }
}

/** Entries for one kind, in the order they were recorded. */
export function entriesOfKind(
  report: ImportReport,
  kind: SourceKind,
): ReportEntry[] {
  return report.entries.filter((entry) => entry.kind === kind);
}

/**
 * The report as text, for a CLI run or a support ticket.
 *
 * Lists everything that did not import in full, and only counts what
 * did: a clean line is not news, and burying twenty-one losses under
 * ten successes is how a report becomes decoration.
 */
export function summariseReport(report: ImportReport): string {
  const lines: string[] = [];
  lines.push(
    report.status === "refused"
      ? "Import refused — nothing was written."
      : report.status === "preview"
        ? `Dry run — nothing was written. ${report.totals.monitorsCreated} monitor(s) would be imported.`
        : `Imported ${report.totals.monitorsCreated} monitor(s).`,
  );
  for (const entry of report.drift) {
    lines.push(`  schema: ${entry.detail}`);
  }
  lines.push(
    `  ${report.totals.imported} imported, ${report.totals.transformed} transformed, ` +
      `${report.totals.skipped} skipped, ${report.totals.unsupported} unsupported.`,
  );
  for (const entry of report.entries) {
    if (entry.outcome === "imported") continue;
    lines.push(
      `  [${entry.outcome}] ${entry.kind} "${entry.label}": ${entry.detail}`,
    );
  }
  return lines.join("\n");
}
