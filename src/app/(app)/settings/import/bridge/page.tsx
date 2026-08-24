import type { Metadata } from "next";

import { db } from "@/db";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { hasPermission } from "@/lib/permissions";
import { requireOrgContext } from "@/lib/session";
import {
  getBridgeView,
  getCutoverReport,
} from "@/modules/importers/bridge/service";

import {
  BridgeConnectForm,
  BridgeControls,
  BridgeImportPanel,
} from "./bridge-panel";
import { ReportDetail } from "./report-detail";

export const metadata: Metadata = { title: "Migration bridge · Vigil" };

/**
 * The Better Stack migration bridge: connect, import into shadow mode,
 * watch both systems, and decide on evidence.
 *
 * One page rather than a wizard, because the bridge is a standing thing
 * with a current state, not a flow to be walked once. Everything the
 * page shows is computed from stored rows; nothing here reads the
 * source system, so the page renders identically whether or not Better
 * Stack is reachable right now.
 */
export default async function BridgePage(props: {
  searchParams: Promise<{ report?: string }>;
}) {
  const ctx = await requireOrgContext();
  const canManage =
    hasPermission(ctx.role, { monitor: ["create"] }) &&
    hasPermission(ctx.role, { statusPage: ["update"] });
  const view = await getBridgeView(db, ctx.organizationId);
  const { report: reportId } = await props.searchParams;
  const report =
    reportId === undefined || view === null
      ? null
      : await getCutoverReport(db, ctx.organizationId, reportId);

  if (!canManage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Better Stack migration bridge</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            The bridge imports monitors and can end in a cutover, so it needs an
            owner or admin role.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Better Stack migration bridge</CardTitle>
          <CardDescription>
            Connect your Better Stack account read-only, import everything Vigil
            can hold faithfully, and run both systems side by side. Imported
            monitors run in shadow mode: checks run and incidents are recorded,
            but nothing pages, nothing reaches a channel, and nothing appears on
            a public status page until you cut over. The bridge only ever issues
            reads against Better Stack; it cannot change anything there.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {view === null || !view.connected ? (
            <BridgeConnectForm reconnect={view !== null} />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge>connected</Badge>
                <span className="text-muted-foreground">
                  since {formatDateTime(view.createdAt)}
                </span>
                {view.shadowMonitorCount > 0 && (
                  <Badge variant="secondary">
                    {view.shadowMonitorCount} monitor(s) in shadow
                  </Badge>
                )}
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">Last evidence poll</dt>
                  <dd className="font-mono">
                    {view.lastPolledAt === null
                      ? "never"
                      : formatRelativeTime(view.lastPolledAt)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Poll status</dt>
                  <dd>
                    {view.lastPollStatus === null ? (
                      <span className="text-muted-foreground">
                        no polls yet
                      </span>
                    ) : view.lastPollStatus === "ok" ? (
                      <span className="text-ok">ok</span>
                    ) : (
                      <span className="text-destructive">
                        {view.lastPollStatus}
                        {view.consecutivePollFailures > 1
                          ? ` (${view.consecutivePollFailures} in a row)`
                          : ""}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Evidence coverage</dt>
                  <dd className="font-mono">{view.coveredHours}h</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    Source incidents seen
                  </dt>
                  <dd className="font-mono">{view.sourceIncidentCount}</dd>
                </div>
              </dl>
              {view.lastPollError !== null && (
                <p className="border-destructive/40 bg-destructive/5 border p-3 text-sm">
                  Last poll failed: {view.lastPollError}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {view !== null && view.connected && (
        <Card>
          <CardHeader>
            <CardTitle>Import and mapping</CardTitle>
            <CardDescription>
              The import runs through the same engine as the one-time importer:
              preview first, a real run rolled back, then commit. Everything
              committed here starts in shadow mode, and the full report is kept
              for the cutover record.
              {view.mapping.total > 0 && (
                <>
                  {" "}
                  Mapped so far: {view.mapping.imported} imported,{" "}
                  {view.mapping.transformed} transformed, {view.mapping.skipped}{" "}
                  skipped, {view.mapping.unsupported} unsupported;{" "}
                  {view.mapping.compared} pair(s) compared for incidents.
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BridgeImportPanel
              hasImports={view.imports.length > 0}
              imports={view.imports.map((i) => ({
                id: i.id,
                createdAt: formatDateTime(i.createdAt),
                monitorsCreated: i.totals.monitorsCreated ?? 0,
              }))}
            />
          </CardContent>
        </Card>
      )}

      {view !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Cutover</CardTitle>
            <CardDescription>
              A cutover report compares Better Stack&rsquo;s incident record
              against Vigil&rsquo;s over the covered window and states, with
              reasons, whether switching is safe. Reports are frozen when
              generated; generate a new one after anything changes.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {view.reports.length > 0 && (
              <ul className="flex flex-col gap-1 text-sm">
                {view.reports.map((r) => (
                  <li key={r.id} className="flex items-center gap-2">
                    <Badge
                      variant={r.verdict === "safe" ? "default" : "destructive"}
                    >
                      {r.verdict === "safe" ? "SAFE" : "NOT SAFE"}
                    </Badge>
                    <a
                      className="underline underline-offset-2"
                      href={`/settings/import/bridge?report=${r.id}`}
                    >
                      {formatDateTime(r.createdAt)}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <BridgeControls
              connected={view.connected}
              shadowMonitorCount={view.shadowMonitorCount}
            />
          </CardContent>
        </Card>
      )}

      {report !== null && <ReportDetail report={report} />}
    </div>
  );
}
