"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { MigrationReport } from "@/modules/importers/engine";

import {
  abandonBridgeAction,
  connectBridgeAction,
  cutOverBridgeAction,
  deleteBridgeAction,
  disconnectBridgeAction,
  generateCutoverReportAction,
  pollBridgeNowAction,
  previewBridgeImportAction,
  runBridgeImportAction,
} from "./actions";
import { ReportBody } from "../report-view";

/** The token form, for first connection and for reconnection alike. */
export function BridgeConnectForm({ reconnect }: { reconnect: boolean }) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);

  async function connect() {
    setPending(true);
    const body = new FormData();
    body.set("token", token);
    const result = await connectBridgeAction(body);
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setToken("");
    toast.success(
      reconnect
        ? "Bridge reconnected"
        : "Bridge connected. Run the import next.",
    );
    router.refresh();
  }

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="bridge-token">Uptime API token</FieldLabel>
        <Input
          id="bridge-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Better Stack API token"
        />
        <FieldDescription>
          From Better Stack, API tokens. The token is verified with one read,
          then stored encrypted so the bridge can keep reading incident history
          while the comparison runs. Better Stack publishes no read-only scope,
          so create a token for this migration and revoke it there once you have
          cut over; disconnecting here deletes the stored copy. The bridge only
          ever issues reads.
        </FieldDescription>
      </Field>
      <div>
        <Button onClick={connect} disabled={pending || token.trim() === ""}>
          {pending && <Spinner />}
          {reconnect ? "Reconnect" : "Connect Better Stack"}
        </Button>
      </div>
    </FieldGroup>
  );
}

/** Preview and commit, mirroring the one-time wizard's two clicks. */
export function BridgeImportPanel({
  hasImports,
  imports,
}: {
  hasImports: boolean;
  imports: { id: string; createdAt: string; monitorsCreated: number }[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"preview" | "import" | null>(null);
  const [preview, setPreview] = useState<MigrationReport | null>(null);
  const [result, setResult] = useState<MigrationReport | null>(null);

  async function analyse() {
    setPending("preview");
    setResult(null);
    const response = await previewBridgeImportAction();
    setPending(null);
    if (!response.ok) {
      toast.error(response.error);
      return;
    }
    setPreview(response.data.report);
  }

  async function confirm() {
    setPending("import");
    const response = await runBridgeImportAction();
    setPending(null);
    if (!response.ok) {
      toast.error(response.error);
      return;
    }
    setPreview(null);
    setResult(response.data.report);
    toast.success(
      `Imported ${response.data.report.totals.monitorsCreated} monitor(s) into shadow mode`,
    );
    router.refresh();
  }

  const report = result ?? preview;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={analyse} disabled={pending !== null}>
          {pending === "preview" && <Spinner />}
          Preview import
        </Button>
        <Button
          onClick={confirm}
          disabled={pending !== null || preview === null}
        >
          {pending === "import" && <Spinner />}
          {hasImports ? "Import again" : "Import into shadow mode"}
        </Button>
      </div>
      {preview !== null && result === null && (
        <p className="text-muted-foreground text-sm">
          This is a real import, rolled back. Confirm to keep it; the account is
          read again on confirm, so the committed report is always from the run
          that happened.
        </p>
      )}
      {report !== null && (
        <ReportBody
          status={report.status}
          totals={report.totals}
          entries={report.entries}
        />
      )}
      {imports.length > 0 && (
        <div className="flex flex-col gap-1 text-sm">
          <h4 className="font-medium">Committed runs</h4>
          <ul className="text-muted-foreground flex flex-col gap-1">
            {imports.map((run) => (
              <li key={run.id}>
                {run.createdAt}: {run.monitorsCreated} monitor(s) created
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ConfirmButton({
  label,
  pendingLabel,
  title,
  description,
  variant = "destructive",
  action,
  onDone,
}: {
  label: string;
  pendingLabel: string;
  title: string;
  description: string;
  variant?: "destructive" | "default" | "outline";
  action: () => Promise<
    { ok: true; message: string } | { ok: false; error: string }
  >;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function run() {
    setPending(true);
    const result = await action();
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setOpen(false);
    toast.success(result.message);
    onDone();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant === "default" ? "default" : variant}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant={variant} onClick={run} disabled={pending}>
            {pending ? pendingLabel : label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Evidence, report and the three ways a bridge ends. */
export function BridgeControls({
  connected,
  shadowMonitorCount,
}: {
  connected: boolean;
  shadowMonitorCount: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"poll" | "report" | null>(null);

  async function pollNow() {
    setPending("poll");
    const result = await pollBridgeNowAction();
    setPending(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    if (result.data.status === "ok") {
      toast.success(
        `Evidence refreshed: ${result.data.incidentsSeen} source incident(s) on record`,
      );
    } else {
      toast.error(result.data.detail ?? "The evidence poll failed.");
    }
    router.refresh();
  }

  async function generate() {
    setPending("report");
    const result = await generateCutoverReportAction();
    setPending(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    router.push(
      `/settings/import/bridge?report=${result.data.reportId}#report`,
    );
    router.refresh();
  }

  return (
    <div className="flex flex-wrap gap-2">
      {connected && (
        <Button variant="outline" onClick={pollNow} disabled={pending !== null}>
          {pending === "poll" && <Spinner />}
          Refresh evidence now
        </Button>
      )}
      <Button variant="outline" onClick={generate} disabled={pending !== null}>
        {pending === "report" && <Spinner />}
        Generate cutover report
      </Button>
      {shadowMonitorCount > 0 && (
        <ConfirmButton
          label="Cut over"
          pendingLabel="Cutting over…"
          variant="default"
          title={`Take ${shadowMonitorCount} monitor(s) live?`}
          description="Shadow mode ends: from the next check, these monitors page, notify channels, trigger automation and may appear on status pages, exactly like any other monitor. Open shadow incidents are closed with a note; a target that is still down opens a live incident on its next check. Read the latest cutover report first: cutting over against a NOT SAFE verdict is your call to make, not the bridge's."
          action={async () => {
            const result = await cutOverBridgeAction();
            return result.ok
              ? {
                  ok: true,
                  message: `${result.data.monitorsLive} monitor(s) are live`,
                }
              : result;
          }}
          onDone={() => router.refresh()}
        />
      )}
      {shadowMonitorCount > 0 && (
        <ConfirmButton
          label="Abandon shadow"
          pendingLabel="Abandoning…"
          title="Abandon the comparison?"
          description="The imported monitors are paused and taken out of shadow mode, and their comparison incidents are closed. Nothing is deleted: the fleet stays visible and silent, cheap to resume or delete deliberately later."
          action={async () => {
            const result = await abandonBridgeAction();
            return result.ok
              ? {
                  ok: true,
                  message: `${result.data.monitorsLive} monitor(s) paused`,
                }
              : result;
          }}
          onDone={() => router.refresh()}
        />
      )}
      {connected && (
        <ConfirmButton
          label="Disconnect"
          pendingLabel="Disconnecting…"
          title="Disconnect Better Stack?"
          description="The stored token is deleted outright and evidence polling stops. Mappings, collected evidence and reports stay; reconnecting with a fresh token resumes where it left off."
          action={async () => {
            const result = await disconnectBridgeAction();
            return result.ok
              ? { ok: true, message: "Bridge disconnected" }
              : result;
          }}
          onDone={() => router.refresh()}
        />
      )}
      {shadowMonitorCount === 0 && (
        <ConfirmButton
          label="Delete bridge"
          pendingLabel="Deleting…"
          title="Delete the bridge?"
          description="Deletes the connection, the mapping table, all collected evidence, the poll log and every stored cutover report. The audit log keeps its record of what was done and when. Monitors are never deleted by this."
          action={async () => {
            const result = await deleteBridgeAction();
            return result.ok ? { ok: true, message: "Bridge deleted" } : result;
          }}
          onDone={() => router.refresh()}
        />
      )}
    </div>
  );
}
