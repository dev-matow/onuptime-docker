import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
} from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { MonitorStatusIndicator } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { db } from "@/db";
import { NotFoundError } from "@/lib/errors";
import {
  formatDateTime,
  formatDuration,
  formatRelativeTime,
  formatUptime,
} from "@/lib/format";
import { hasPermission } from "@/lib/permissions";
import { requireOrgContext } from "@/lib/session";
import { cn } from "@/lib/utils";
import {
  getMonitorDetail,
  type MonitorCheck,
  type MonitorDetail,
  type UptimeWindow,
} from "@/modules/monitors/service";
import {
  describeMonitorTarget,
  redactTargetCredentials,
} from "@/modules/monitors/spec";
import { describeCheckType } from "@/modules/monitors/types/catalog";
import { redactConfig } from "@/modules/monitors/types/config";
import { requireSpec } from "@/modules/monitors/types/specs";

import { MonitorDetailActions } from "./monitor-detail-actions";
import { ResponseTimeChart } from "./response-time-chart";

export const metadata: Metadata = { title: "Monitor · Vigil" };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WINDOW_LABELS: Record<UptimeWindow["label"], string> = {
  "24h": "Uptime · last 24 hours",
  "7d": "Uptime · last 7 days",
  "30d": "Uptime · last 30 days",
};

export default async function MonitorDetailPage(
  props: PageProps<"/monitors/[id]">,
) {
  const { id } = await props.params;
  if (!UUID_PATTERN.test(id)) notFound();

  const ctx = await requireOrgContext();

  let detail: MonitorDetail;
  try {
    detail = await getMonitorDetail(db, ctx.organizationId, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const { monitor, windows, recentChecks } = detail;
  const checkType = describeCheckType(monitor.checkType);
  // `getMonitorDetail` already replaced the password with the sentinel so
  // the edit dialog can round-trip it. Nothing should read the sentinel,
  // so the label drops the userinfo altogether.
  const displayTarget = redactTargetCredentials(monitor.url);
  const canUpdate = hasPermission(ctx.role, { monitor: ["update"] });
  const canDelete = hasPermission(ctx.role, { monitor: ["delete"] });


  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/monitors"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
        >
          <ArrowLeftIcon aria-hidden className="size-3.5" />
          Monitors
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              {monitor.name}
            </h1>
            {monitor.paused && <Badge variant="secondary">Paused</Badge>}
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <MonitorStatusIndicator
              status={monitor.currentStatus}
              paused={monitor.paused}
            />
            {checkType.target.kind === "url" ? (
              // The url branch is the one that can carry a credential —
              // `postgres` and `sqlserver` targets are the reason this
              // function exists — and it was the branch showing the
              // target verbatim while the other went through the spec.
              // An href is worse than a label: it survives in history and
              // in whatever the next page reads as a referrer.
              <a
                href={displayTarget}
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground inline-flex max-w-96 items-center gap-1 font-mono text-xs transition-colors hover:underline"
              >
                <span className="truncate">{displayTarget}</span>
                <ArrowSquareOutIcon aria-hidden className="size-3 shrink-0" />
              </a>
            ) : (
              <span className="font-mono text-xs">
                {checkType.label} · {describeMonitorTarget(monitor)}
              </span>
            )}
            <span className="font-mono text-xs">
              {checkType.form.includes("method") ? monitor.method : "check"} ·
              around every {formatDuration(monitor.intervalSeconds * 1000)}
            </span>
            {monitor.bodyKeyword && (
              <span className="font-mono text-xs">
                body {monitor.keywordAbsent ? "excludes" : "contains"} “
                {monitor.bodyKeyword}”
              </span>
            )}
            {monitor.tlsCheck && monitor.tlsDaysRemaining !== null && (
              <span
                className={cn(
                  "font-mono text-xs",
                  monitor.tlsDaysRemaining < monitor.tlsWarnDays &&
                    "text-foreground",
                )}
              >
                cert {monitor.tlsDaysRemaining}d left
              </span>
            )}
            <span className="text-xs">
              {monitor.lastCheckedAt
                ? `Last checked ${formatRelativeTime(monitor.lastCheckedAt)}`
                : "First check runs within a minute"}
            </span>
          </div>
        </div>
        <MonitorDetailActions
          monitor={{
            id: monitor.id,
            name: monitor.name,
            checkType: monitor.checkType,
            url: monitor.url,
            parentId: monitor.parentId,
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
            // Masked, not raw. This object crosses into a client
            // component, which means it lands in the page source of
            // anyone who can open the monitor — including a viewer-role
            // member who cannot edit it. The form sends the mask back
            // untouched when the operator does not retype the secret.
            config:
              (redactConfig(
                requireSpec(monitor.checkType),
                monitor.config,
              ) as Record<string, unknown> | null) ?? null,
            paused: monitor.paused,
          }}
          canUpdate={canUpdate}
          canDelete={canDelete}
        />
      </div>


      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {windows.map((window) => (
          <Card key={window.label} size="sm">
            <CardContent className="space-y-1">
              <p className="text-muted-foreground text-xs">
                {WINDOW_LABELS[window.label]}
              </p>
              <p className="font-mono text-2xl font-semibold tabular-nums">
                {formatUptime(window.uptimePct)}
              </p>
              <p className="text-muted-foreground text-xs">
                {window.avgResponseMs === null
                  ? "No successful checks"
                  : `avg response ${formatDuration(window.avgResponseMs)}`}
              </p>
              {/*
                Uptime is a ratio of the time an observation vouched for,
                not of the whole window. 100% over a third of the window
                is a different claim from 100% over all of it, and a
                reader who is not told cannot tell them apart. Shown only
                when there is a real gap, so the ordinary case stays
                quiet.
              */}
              {window.coveragePct < 95 && (
                <p className="text-muted-foreground text-xs">
                  measured {Math.round(window.coveragePct)}% of the window
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Response time</CardTitle>
          <CardDescription>
            {recentChecks.length === 0
              ? "No checks recorded yet"
              : `Last ${recentChecks.length} checks · oldest first · degraded above ${formatDuration(monitor.degradedThresholdMs)}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponseTimeChart
            checks={recentChecks}
            degradedThresholdMs={monitor.degradedThresholdMs}
          />
        </CardContent>
      </Card>




      <section className="space-y-3">
        <h2 className="text-sm font-medium">Recent checks</h2>
        {recentChecks.length === 0 ? (
          <p className="text-muted-foreground border border-dashed p-6 text-center text-xs">
            No checks recorded yet. The first check runs within a minute.
          </p>
        ) : (
          <Card className="gap-0 py-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Time</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">Status code</TableHead>
                  <TableHead className="text-right">Response time</TableHead>
                  <TableHead className="pr-4">Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentChecks.map((check) => (
                  <TableRow key={check.id}>
                    <TableCell className="text-muted-foreground pl-4">
                      {formatDateTime(check.checkedAt)}
                    </TableCell>
                    <TableCell>
                      <CheckResultBadge
                        check={check}
                        degradedThresholdMs={monitor.degradedThresholdMs}
                      />
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {check.statusCode ?? "-"}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {check.responseTimeMs === null
                        ? "-"
                        : formatDuration(check.responseTimeMs)}
                    </TableCell>
                    <TableCell className="pr-4">
                      {check.error ? (
                        <span
                          className="text-muted-foreground block max-w-72 truncate"
                          title={check.error}
                        >
                          {check.error}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>
    </div>
  );
}


function CheckResultBadge({
  check,
  degradedThresholdMs,
}: {
  check: MonitorCheck;
  degradedThresholdMs: number;
}) {
  if (!check.ok) {
    return (
      <Badge variant="outline" className="border-destructive text-destructive">
        Failed
      </Badge>
    );
  }
  if (
    check.responseTimeMs !== null &&
    check.responseTimeMs > degradedThresholdMs
  ) {
    return (
      <Badge variant="outline" className="border-line-tag text-foreground">
        Degraded
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-line-tag text-muted-foreground">
      OK
    </Badge>
  );
}
