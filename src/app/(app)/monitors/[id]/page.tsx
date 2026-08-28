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
} from "@/modules/monitors/service";
import {
  describeMonitorTarget,
  redactTargetCredentials,
} from "@/modules/monitors/spec";
import { describeCheckType } from "@/modules/monitors/types/catalog";
import { redactConfig } from "@/modules/monitors/types/config";
import { requireSpec } from "@/modules/monitors/types/specs";

import { MonitorDetailActions } from "./monitor-detail-actions";
import { CheckOutcomeChart } from "./check-outcome-chart";
import { ResponseTimeChart } from "./response-time-chart";

export const metadata: Metadata = { title: "Monitor · Vigil" };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const latestCheck = recentChecks[0] ?? null;
  const latestIssue = recentChecks.find(
    (check) =>
      !check.ok ||
      check.verdict === "down" ||
      check.verdict === "degraded" ||
      check.verdict === "indeterminate",
  );
  const latestIssueTone = !latestIssue
    ? null
    : latestIssue.verdict === "indeterminate"
      ? "indeterminate"
      : latestIssue.ok &&
          (latestIssue.verdict === "degraded" ||
            (latestIssue.responseTimeMs !== null &&
              latestIssue.responseTimeMs > monitor.degradedThresholdMs))
        ? "degraded"
        : "failed";
  const healthyChecks = recentChecks.filter(
    (check) =>
      check.ok &&
      check.verdict !== "degraded" &&
      (check.responseTimeMs === null ||
        check.responseTimeMs <= monitor.degradedThresholdMs),
  ).length;
  const failedChecks = recentChecks.filter(
    (check) => !check.ok || check.verdict === "down",
  ).length;
  const degradedChecks = recentChecks.filter(
    (check) =>
      check.ok &&
      (check.verdict === "degraded" ||
        (check.responseTimeMs !== null &&
          check.responseTimeMs > monitor.degradedThresholdMs)),
  ).length;
  const recentHealthyPct =
    recentChecks.length === 0
      ? null
      : (healthyChecks / recentChecks.length) * 100;
  const uptime24h = windows.find((window) => window.label === "24h") ?? null;

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

      <section className="space-y-3" aria-label="Monitor overview">
        <h2 className="text-sm font-medium">Monitor overview</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card size="sm">
            <CardContent className="space-y-2">
              <p className="text-muted-foreground text-xs">Current status</p>
              <MonitorStatusIndicator
                status={monitor.currentStatus}
                paused={monitor.paused}
                className="text-sm"
              />
              <p className="text-muted-foreground text-xs">
                {currentStatusExplanation(monitor)}
              </p>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardContent className="space-y-1">
              <p className="text-muted-foreground text-xs">Uptime · 24 hours</p>
              <p className="font-mono text-2xl font-semibold tabular-nums">
                {formatUptime(uptime24h?.uptimePct ?? null)}
              </p>
              <p className="text-muted-foreground text-xs">
                {uptime24h
                  ? `${Math.round(uptime24h.coveragePct)}% measured coverage`
                  : "No measured coverage"}
              </p>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardContent className="space-y-1">
              <p className="text-muted-foreground text-xs">Latest response</p>
              <p className="font-mono text-2xl font-semibold tabular-nums">
                {latestCheck?.responseTimeMs === null || !latestCheck
                  ? "—"
                  : formatDuration(latestCheck.responseTimeMs)}
              </p>
              <p className="text-muted-foreground text-xs">
                {latestCheck
                  ? `${checkResultLabel(latestCheck, monitor.degradedThresholdMs)} · ${formatRelativeTime(latestCheck.checkedAt)}`
                  : "No checks recorded yet"}
              </p>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardContent className="space-y-1">
              <p className="text-muted-foreground text-xs">
                Recent healthy checks
              </p>
              <p className="font-mono text-2xl font-semibold tabular-nums">
                {recentHealthyPct === null
                  ? "—"
                  : `${recentHealthyPct.toFixed(1)}%`}
              </p>
              <p className="text-muted-foreground text-xs">
                {recentChecks.length === 0
                  ? "No recent checks"
                  : `${failedChecks} failed · ${degradedChecks} degraded of ${recentChecks.length}`}
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      <section
        className="grid gap-4 lg:grid-cols-2"
        aria-label="Monitor charts"
      >
        <Card size="sm">
          <CardHeader>
            <CardTitle>Response time</CardTitle>
            <CardDescription>
              {recentChecks.length === 0
                ? "No checks recorded yet"
                : `Last ${recentChecks.length} checks · degraded above ${formatDuration(monitor.degradedThresholdMs)} · hover for details`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResponseTimeChart
              checks={recentChecks}
              degradedThresholdMs={monitor.degradedThresholdMs}
            />
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Check outcomes</CardTitle>
            <CardDescription>
              Oldest on the left · latest on the right · hover for details
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CheckOutcomeChart
              checks={recentChecks}
              degradedThresholdMs={monitor.degradedThresholdMs}
            />
          </CardContent>
        </Card>
      </section>

      <section
        className="grid gap-4 lg:grid-cols-2"
        aria-label="Monitor analysis"
      >
        <Card size="sm">
          <CardHeader>
            <CardTitle>Availability by period</CardTitle>
            <CardDescription>
              Duration-weighted uptime and successful response average
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {windows.map((window) => (
              <div
                key={window.label}
                className="py-3 first:pt-0 last:pb-0 sm:px-3 sm:py-0 sm:first:pl-0 sm:last:pr-0"
              >
                <p className="text-muted-foreground text-xs">{window.label}</p>
                <p className="mt-1 font-mono text-lg font-semibold tabular-nums">
                  {formatUptime(window.uptimePct)}
                </p>
                <p className="text-muted-foreground mt-1 text-[11px]">
                  {window.avgResponseMs === null
                    ? "No successful checks"
                    : `${formatDuration(window.avgResponseMs)} avg`}
                </p>
                {window.coveragePct < 95 && (
                  <p className="text-muted-foreground mt-1 text-[11px]">
                    {Math.round(window.coveragePct)}% coverage
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Diagnosis</CardTitle>
            <CardDescription>
              Latest abnormal observation and the rule that judged it
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {latestIssue ? (
              <div
                className={cn(
                  "rounded-lg border p-3",
                  latestIssueTone === "degraded" &&
                    "border-warn-dot/30 bg-warn-dot/5",
                  latestIssueTone === "failed" &&
                    "border-destructive/25 bg-destructive/5",
                  latestIssueTone === "indeterminate" &&
                    "border-line-quiet bg-muted/30",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p
                    className={cn(
                      "text-sm font-medium",
                      latestIssueTone === "degraded" && "text-warn",
                      latestIssueTone === "failed" && "text-destructive",
                    )}
                  >
                    {checkIssueLabel(latestIssue)}
                  </p>
                  <time
                    dateTime={latestIssue.checkedAt.toISOString()}
                    className="text-muted-foreground text-xs"
                  >
                    {formatRelativeTime(latestIssue.checkedAt)}
                  </time>
                </div>
                <p className="text-muted-foreground mt-1 text-xs break-words">
                  {latestIssue.error ??
                    "The observation did not meet the monitor rule."}
                </p>
                {(latestIssue.statusCode !== null ||
                  latestIssue.responseTimeMs !== null) && (
                  <p className="text-muted-foreground mt-2 font-mono text-xs">
                    {latestIssue.statusCode !== null &&
                      `HTTP ${latestIssue.statusCode}`}
                    {latestIssue.statusCode !== null &&
                      latestIssue.responseTimeMs !== null &&
                      " · "}
                    {latestIssue.responseTimeMs !== null &&
                      formatDuration(latestIssue.responseTimeMs)}
                  </p>
                )}
              </div>
            ) : (
              <div className="border-ok-dot/20 bg-ok-dot/5 rounded-lg border p-3">
                <p className="text-ok text-sm font-medium">
                  No abnormal checks in the recent sample
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  The latest {recentChecks.length} checks contain no failures or
                  degraded observations.
                </p>
              </div>
            )}

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
              <div>
                <dt className="text-muted-foreground">Interval</dt>
                <dd className="mt-0.5 font-mono">
                  {formatDuration(monitor.intervalSeconds * 1000)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Timeout</dt>
                <dd className="mt-0.5 font-mono">
                  {formatDuration(monitor.timeoutMs)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Degraded above</dt>
                <dd className="mt-0.5 font-mono">
                  {formatDuration(monitor.degradedThresholdMs)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Failure window</dt>
                <dd className="mt-0.5 font-mono">
                  {formatDuration(monitor.failureWindowSeconds * 1000)}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </section>

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

function currentStatusExplanation(monitor: MonitorDetail["monitor"]) {
  if (monitor.paused) return "Checks are paused by an operator.";
  if (!monitor.lastCheckedAt) return "Waiting for the first observation.";

  if (monitor.currentStatus === "up") {
    return "Latest observation passed the monitor rule.";
  }
  if (monitor.currentStatus === "degraded") {
    return `Responding slower than ${formatDuration(monitor.degradedThresholdMs)} or carrying a warning.`;
  }
  if (monitor.currentStatus === "down") {
    if (monitor.firstFailureAt) {
      return `Failing since ${formatRelativeTime(monitor.firstFailureAt)} · ${monitor.consecutiveFailures} consecutive failures.`;
    }
    return `${monitor.consecutiveFailures} consecutive failures.`;
  }
  return "The latest observation could not determine health.";
}

function checkResultLabel(check: MonitorCheck, degradedThresholdMs: number) {
  if (check.verdict === "indeterminate") return "Could not measure";
  if (!check.ok || check.verdict === "down") return "Failed";
  if (
    check.verdict === "degraded" ||
    (check.responseTimeMs !== null &&
      check.responseTimeMs > degradedThresholdMs)
  ) {
    return "Degraded";
  }
  return "Healthy";
}

function checkIssueLabel(check: MonitorCheck) {
  if (check.failureClass === "transport") {
    return "Connection or network failure";
  }
  if (check.failureClass === "assertion") {
    return "Response validation failed";
  }
  if (check.failureClass === "misconfigured") {
    return "Monitor configuration problem";
  }
  if (check.verdict === "degraded") {
    return "Response exceeded the degraded threshold";
  }
  if (check.statusCode !== null && check.statusCode >= 400) {
    return `Unexpected HTTP ${check.statusCode} response`;
  }
  if (check.verdict === "indeterminate") {
    return "The target could not be measured";
  }
  return "Check failed";
}

function CheckResultBadge({
  check,
  degradedThresholdMs,
}: {
  check: MonitorCheck;
  degradedThresholdMs: number;
}) {
  if (check.verdict === "indeterminate") {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        No result
      </Badge>
    );
  }
  if (!check.ok || check.verdict === "down") {
    return (
      <Badge variant="outline" className="border-destructive text-destructive">
        Failed
      </Badge>
    );
  }
  if (
    check.verdict === "degraded" ||
    (check.responseTimeMs !== null &&
      check.responseTimeMs > degradedThresholdMs)
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
