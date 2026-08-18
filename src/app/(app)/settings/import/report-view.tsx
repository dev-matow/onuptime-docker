"use client";

import { Badge } from "@/components/ui/badge";
import type {
  ImportOutcome,
  ImportStatus,
  ImportTotals,
  ReportEntry,
  SourceKind,
} from "@/modules/importers/report";

/**
 * One report, rendered the same way whatever produced it.
 *
 * The losses are deliberately the largest thing on the screen. An
 * operator on this page is deciding whether to turn their old monitoring
 * off, and the number that decides it is not "27 monitors", it is which
 * four did not come and what changed about the rest. So the monitors
 * that were refused and the monitors that arrived meaning something else
 * are both listed in full, and only the clean ones are a count.
 *
 * Shared by the Uptime Kuma importer and every provider adapter, which
 * is the visible half of sharing the report vocabulary: a customer
 * comparing a Pingdom migration to a Kuma one reads the same four words
 * with the same meanings.
 */

const OUTCOME_LABEL: Record<ImportOutcome, string> = {
  imported: "imported",
  transformed: "imported, with changes",
  skipped: "not imported",
  unsupported: "no Vigil equivalent",
};

const OUTCOME_VARIANT: Record<
  ImportOutcome,
  "default" | "secondary" | "outline" | "destructive"
> = {
  imported: "default",
  transformed: "secondary",
  skipped: "destructive",
  unsupported: "outline",
};

const KIND_LABEL: Record<SourceKind, string> = {
  monitor: "Monitors",
  group: "Groups",
  notification: "Notification providers",
  "notification-link": "Monitor-notification links",
  "status-page": "Status pages",
  "status-page-group": "Status page sections",
  "status-page-monitor": "Monitors on a status page",
  tag: "Tags",
  "tag-application": "Tag applications",
  maintenance: "Maintenance windows",
  "maintenance-link": "Monitors in maintenance",
  alerting: "Alerting and escalation",
  region: "Probe locations",
  variable: "Variables and secrets",
  script: "Scripted checks",
  account: "Account-level settings",
  "docker-host": "Docker hosts",
  "remote-browser": "Remote browsers",
  proxy: "Proxies",
  "heartbeat-history": "Heartbeat history",
};

export function EntryList({ entries }: { entries: readonly ReportEntry[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {entries.map((entry) => (
        <li key={`${entry.kind}:${entry.sourceId}`} className="text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{entry.label}</span>
            <Badge variant={OUTCOME_VARIANT[entry.outcome]}>
              {OUTCOME_LABEL[entry.outcome]}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-0.5">{entry.detail}</p>
        </li>
      ))}
    </ul>
  );
}

export function ReportBody({
  status,
  totals,
  entries,
}: {
  status: ImportStatus;
  totals: ImportTotals;
  entries: readonly ReportEntry[];
}) {
  const monitors = entries.filter((entry) => entry.kind === "monitor");
  const refused = monitors.filter((entry) => entry.monitorId === null);
  /**
   * Monitors that arrived and mean something else.
   *
   * These were invisible here until a customer would have been the one
   * to notice: they are not refused, so they were not in the list above,
   * and they are monitors, so they were not in the per-kind sections
   * below either. Every note about a dropped header, a widened status
   * expectation or a schedule that could not be reproduced hung off
   * exactly these lines, and the page showed a count instead. A report
   * that says "27 imported" and hides what changed about them is the
   * failure this whole feature exists to avoid, printed in the product's
   * own voice.
   */
  const transformed = monitors.filter(
    (entry) => entry.monitorId !== null && entry.outcome === "transformed",
  );
  const changed = entries.filter(
    (entry) => entry.kind !== "monitor" && entry.outcome !== "imported",
  );

  const byKind = new Map<SourceKind, ReportEntry[]>();
  for (const entry of changed) {
    byKind.set(entry.kind, [...(byKind.get(entry.kind) ?? []), entry]);
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm">
        <strong className="text-lg font-semibold">
          {totals.monitorsCreated}
        </strong>{" "}
        of {monitors.length} monitors
        {status === "preview" ? " will be imported" : " imported"}.{" "}
        {refused.length > 0 && (
          <>
            {refused.length}{" "}
            {refused.length === 1 ? "does not come" : "do not come"} across,
            each is listed below with the rule that refused it.
          </>
        )}{" "}
        {transformed.length > 0 && (
          <>
            {transformed.length}{" "}
            {transformed.length === 1 ? "arrives" : "arrive"} meaning something
            different, and {transformed.length === 1 ? "it is" : "they are"}{" "}
            listed too.
          </>
        )}
      </p>

      {refused.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">
            {status === "preview"
              ? "Monitors that will not be imported"
              : "Monitors that were not imported"}
          </h3>
          <EntryList entries={refused} />
        </section>
      )}

      {transformed.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">
            {status === "preview"
              ? "Monitors that will be imported, with changes"
              : "Monitors that were imported, with changes"}
          </h3>
          <EntryList entries={transformed} />
        </section>
      )}

      {[...byKind.entries()].map(([kind, kindEntries]) => (
        <details key={kind} className="border-border border-t pt-3">
          <summary className="cursor-pointer text-sm font-medium">
            {KIND_LABEL[kind]}{" "}
            <span className="text-muted-foreground font-normal">
              ({kindEntries.length})
            </span>
          </summary>
          <div className="mt-3">
            <EntryList entries={kindEntries.slice(0, 25)} />
            {kindEntries.length > 25 && (
              <p className="text-muted-foreground mt-2 text-sm">
                and {kindEntries.length - 25} more of the same.
              </p>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
