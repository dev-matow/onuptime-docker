"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type {
  ImportOutcome,
  ImportReport,
  ReportEntry,
  SourceKind,
} from "@/modules/importers/kuma";

import {
  previewKumaImportAction,
  runKumaImportAction,
  type KumaImportPreview,
} from "./actions";

/**
 * Choose a file, read what will happen, confirm.
 *
 * The summary is deliberately the largest thing on the screen. An
 * operator on this page is deciding whether to turn Uptime Kuma off,
 * and the number that decides it is not "27 monitors" — it is which
 * four did not come, and why. So the losses are listed first and in
 * full, and the successes are a count.
 *
 * The file is held in this component between the two clicks and sent
 * again on confirm; see `actions.ts` for why that is better than a
 * directory of half-imported databases on the server.
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
  notification: "Notification providers",
  "notification-link": "Monitor–notification links",
  "status-page": "Status pages",
  "status-page-group": "Status page sections",
  "status-page-monitor": "Monitors on a status page",
  tag: "Tags",
  "tag-application": "Tag applications",
  maintenance: "Maintenance windows",
  "maintenance-link": "Monitors in maintenance",
  "docker-host": "Docker hosts",
  "remote-browser": "Remote browsers",
  proxy: "Proxies",
  "heartbeat-history": "Heartbeat history",
};

function EntryList({ entries }: { entries: ReportEntry[] }) {
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

function Summary({ report }: { report: ImportReport }) {
  const monitors = report.entries.filter((entry) => entry.kind === "monitor");
  const refused = monitors.filter((entry) => entry.monitorId === null);
  const changed = report.entries.filter(
    (entry) => entry.kind !== "monitor" && entry.outcome !== "imported",
  );

  const byKind = new Map<SourceKind, ReportEntry[]>();
  for (const entry of changed) {
    byKind.set(entry.kind, [...(byKind.get(entry.kind) ?? []), entry]);
  }

  return (
    <div className="flex flex-col gap-6">
      {report.drift.length > 0 && (
        <div className="border-destructive/40 bg-destructive/5 border p-4">
          <h3 className="text-destructive text-sm font-medium">
            This is not the Uptime Kuma release the importer was written against
          </h3>
          <ul className="text-muted-foreground mt-2 flex flex-col gap-1 text-sm">
            {report.drift.map((entry) => (
              <li key={`${entry.subject}:${entry.detail}`}>{entry.detail}</li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-2 text-sm">
            A column whose meaning moved produces monitors that look right,
            which is the one failure nobody catches. Nothing will be written
            unless you tick the box below.
          </p>
        </div>
      )}

      <p className="text-sm">
        <strong className="text-lg font-semibold">
          {report.totals.monitorsCreated}
        </strong>{" "}
        of {monitors.length} monitors
        {report.status === "preview" ? " will be imported" : " imported"}.{" "}
        {refused.length > 0 && (
          <>
            {refused.length}{" "}
            {refused.length === 1 ? "does not come" : "do not come"} across —
            each is listed below with the rule that refused it.
          </>
        )}
      </p>

      {refused.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">
            Monitors that will not be imported
          </h3>
          <EntryList entries={refused} />
        </section>
      )}

      {[...byKind.entries()].map(([kind, entries]) => (
        <details key={kind} className="border-border border-t pt-3">
          <summary className="cursor-pointer text-sm font-medium">
            {KIND_LABEL[kind]}{" "}
            <span className="text-muted-foreground font-normal">
              ({entries.length})
            </span>
          </summary>
          <div className="mt-3">
            <EntryList entries={entries.slice(0, 25)} />
            {entries.length > 25 && (
              <p className="text-muted-foreground mt-2 text-sm">
                and {entries.length - 25} more of the same.
              </p>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

export function ImportWizard({ canImport }: { canImport: boolean }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [allowDrift, setAllowDrift] = useState(false);
  const [preview, setPreview] = useState<KumaImportPreview | null>(null);
  const [result, setResult] = useState<KumaImportPreview | null>(null);
  const [pending, setPending] = useState<"preview" | "import" | null>(null);

  function reset(): void {
    setPreview(null);
    setResult(null);
    setFile(null);
    setAllowDrift(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function check(): Promise<void> {
    if (!file) return;
    const body = new FormData();
    body.set("file", file);
    if (allowDrift) body.set("allowSchemaDrift", "on");
    setPending("preview");
    const outcome = await previewKumaImportAction(body);
    setPending(null);
    if (!outcome.ok) {
      toast.error(outcome.error);
      return;
    }
    setPreview(outcome.data);
  }

  async function confirm(): Promise<void> {
    if (!file || !preview) return;
    const body = new FormData();
    body.set("file", file);
    body.set("digest", preview.digest);
    if (allowDrift) body.set("allowSchemaDrift", "on");
    setPending("import");
    const outcome = await runKumaImportAction(body);
    setPending(null);
    if (!outcome.ok) {
      toast.error(outcome.error);
      return;
    }
    setResult(outcome.data);
    setPreview(null);
    toast.success(
      `Imported ${outcome.data.report.totals.monitorsCreated} monitor(s).`,
    );
  }

  if (result) {
    return (
      <div className="flex flex-col gap-6">
        <Summary report={result.report} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={reset}>
            Import another database
          </Button>
        </div>
      </div>
    );
  }

  if (preview) {
    const blocked =
      preview.report.status === "refused" ||
      preview.report.totals.monitorsCreated === 0;
    return (
      <div className="flex flex-col gap-6">
        <p className="text-muted-foreground text-sm">
          From <code className="font-mono">{preview.fileName}</code>. This is
          what a real import did before it was rolled back, not an estimate.
        </p>
        <Summary report={preview.report} />
        {preview.report.drift.length > 0 && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowDrift}
              onChange={(event) => setAllowDrift(event.target.checked)}
              className="mt-1"
            />
            <span>
              Import anyway, from a schema this build has not been read against.
              Check every imported monitor afterwards.
            </span>
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void confirm()}
            disabled={pending !== null || blocked}
          >
            {pending === "import" && <Spinner />}
            Import {preview.report.totals.monitorsCreated} monitor
            {preview.report.totals.monitorsCreated === 1 ? "" : "s"}
          </Button>
          <Button variant="outline" onClick={reset} disabled={pending !== null}>
            Choose another file
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void check();
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="kuma-db">Uptime Kuma database</FieldLabel>
          <Input
            id="kuma-db"
            ref={fileInput}
            type="file"
            accept=".db,.sqlite,.sqlite3,application/octet-stream"
            disabled={!canImport}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <FieldDescription>
            A copy of <code className="font-mono">kuma.db</code> from your Kuma
            volume. It is opened read-only and deleted as soon as it has been
            read. If Kuma is still running, checkpoint it first —{" "}
            <code className="font-mono">
              sqlite3 kuma.db &quot;PRAGMA wal_checkpoint(TRUNCATE);&quot;
            </code>{" "}
            — because everything since the last checkpoint lives in the{" "}
            <code className="font-mono">-wal</code> sidecar and an upload
            carries one file.
          </FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <Button
            type="submit"
            disabled={!canImport || !file || pending !== null}
          >
            {pending === "preview" && <Spinner />}
            Check what will be imported
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
