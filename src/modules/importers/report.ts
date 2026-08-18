/**
 * The vocabulary every migration report is written in.
 *
 * One rule holds this module up: **nothing leaves the source system
 * without a line here**. Not a check, not an alerting integration, not a
 * tag, not a maintenance window. An import that moves ten of thirty-one
 * monitors and says "done" is worse than one that refuses, because the
 * operator turns the old system off believing the other twenty-one came
 * too.
 *
 * That is why `skipped` and `unsupported` are outcomes rather than
 * silence, and why every entry carries a `detail` the reader can act on.
 * "Unsupported" alone would satisfy the letter of the rule and none of
 * its purpose.
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
 *
 * This module was extracted from the Uptime Kuma importer when the
 * second source arrived. It holds the parts that are true of any
 * migration; `kuma/report.ts` keeps the parts that are true of a SQLite
 * file with a pinned schema, and every other provider goes through
 * `engine.ts`. The important consequence is that one component renders
 * both, so a reader comparing a Pingdom migration to a Kuma one is
 * reading the same four words with the same meanings.
 */

export type ImportOutcome =
  "imported" | "transformed" | "skipped" | "unsupported";

/**
 * What kind of source record a line is about.
 *
 * Deliberately a closed union rather than a free string. A report is
 * grouped and counted by this, and an adapter that invents
 * `"statuspage"` next to `"status-page"` produces two sections that
 * should have been one.
 *
 * `heartbeat-history` is per monitor rather than per beat. A heartbeat
 * is not a record an operator addresses, its identity is the monitor and
 * the window it covers, and a real install holds millions, so a line
 * each would bury the report in the one thing nobody can act on.
 */
export type SourceKind =
  /* records every source has */
  | "monitor"
  | "group"
  | "tag"
  | "tag-application"
  | "status-page"
  | "status-page-group"
  | "status-page-monitor"
  | "maintenance"
  | "maintenance-link"
  | "notification"
  | "notification-link"
  /* records the hosted providers have */
  | "alerting"
  | "region"
  | "variable"
  | "script"
  | "account"
  /* records Uptime Kuma has */
  | "docker-host"
  | "remote-browser"
  | "proxy"
  | "heartbeat-history";

export interface ReportEntry {
  kind: SourceKind;
  /** Identity within the source system, for tracing back. */
  sourceId: string;
  /** What an operator would call it. */
  label: string;
  outcome: ImportOutcome;
  /** The rule applied, or the reason nothing was. Never empty. */
  detail: string;
  /**
   * The Vigil monitor this became, when it became one.
   *
   * Set on `monitor` and `group` lines and on nothing else, which is
   * load-bearing: `monitorsCreated` is derived by counting the entries
   * that carry one, so putting a monitor id on a status-page line to say
   * which monitor it published would silently inflate the headline
   * number. Those lines name the monitor in `label` instead.
   */
  monitorId: string | null;
  /**
   * The stored config as the caller may render it, every secret already
   * replaced by `SECRET_MASK`. Present only where a type has a config
   * blob. Passing the raw blob would put an MQTT password in whatever
   * renders the report, which is the same leak `redactConfig` exists to
   * close on the monitor page.
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

/** Whether anything was written, and why not when nothing was. */
export type ImportStatus = "completed" | "refused" | "preview";

/**
 * Accumulates entries and counts them once at the end.
 *
 * A builder rather than an array the engine pushes to, so the totals
 * cannot disagree with the lines they summarise: the number is derived
 * from the entries, never incremented alongside them.
 */
export class ReportBuilder {
  readonly #entries: ReportEntry[] = [];

  add(entry: ReportEntry): void {
    if (entry.detail.trim().length === 0) {
      // A line with no reason is the failure this class exists to
      // prevent, wearing the costume of compliance.
      throw new Error(
        `Report entry ${entry.kind}:${entry.sourceId} has no detail`,
      );
    }
    this.#entries.push(entry);
  }

  /** The entries, in the order they were recorded. */
  list(): ReportEntry[] {
    return [...this.#entries];
  }

  /** Counts derived from the entries, never kept alongside them. */
  totals(): ImportTotals {
    const totals: ImportTotals = {
      imported: 0,
      transformed: 0,
      skipped: 0,
      unsupported: 0,
      monitorsCreated: 0,
    };
    for (const entry of this.#entries) {
      totals[entry.outcome] += 1;
      if (entry.monitorId !== null) totals.monitorsCreated += 1;
    }
    return totals;
  }
}

/**
 * A database error as a report line.
 *
 * Truncated and stripped of newlines because a Postgres error carries a
 * statement, a position and sometimes the offending values, and this
 * string is rendered in a browser and pasted into support tickets.
 *
 * Here rather than in one importer because both of them now catch the
 * same class of failure, and a per-record failure that reads one way on
 * a Pingdom report and another way on a Kuma one is the drift this
 * module was extracted to stop.
 */
export function insertFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Entries for one kind, in the order they were recorded. */
export function entriesOfKind(
  report: { entries: readonly ReportEntry[] },
  kind: SourceKind,
): ReportEntry[] {
  return report.entries.filter((entry) => entry.kind === kind);
}

/**
 * The lines of a report as text, for a CLI run or a support ticket.
 *
 * Lists everything that did not import in full, and only counts what
 * did: a clean line is not news, and burying twenty-one losses under ten
 * successes is how a report becomes decoration.
 */
export function summariseEntries(
  totals: ImportTotals,
  entries: readonly ReportEntry[],
): string[] {
  const lines = [
    `  ${totals.imported} imported, ${totals.transformed} transformed, ` +
      `${totals.skipped} skipped, ${totals.unsupported} unsupported.`,
  ];
  for (const entry of entries) {
    if (entry.outcome === "imported") continue;
    lines.push(
      `  [${entry.outcome}] ${entry.kind} "${entry.label}": ${entry.detail}`,
    );
  }
  return lines;
}
