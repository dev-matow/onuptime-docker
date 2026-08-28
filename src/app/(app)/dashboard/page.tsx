import { ArrowRightIcon, PulseIcon } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import Link from "next/link";

import {
  IncidentStatusBadge,
  MonitorStatusIndicator,
  SeverityBadge,
} from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { db } from "@/db";
import { formatRelativeTime, formatUptime } from "@/lib/format";
import { requireOrgContext } from "@/lib/session";
import { cn } from "@/lib/utils";
import { listIncidents } from "@/modules/incidents/service";
import { listMonitors } from "@/modules/monitors/service";


export const metadata: Metadata = { title: "Dashboard · Vigil" };

export default async function DashboardPage() {
  const ctx = await requireOrgContext();
  const [monitors, activeIncidents] = await Promise.all([
    listMonitors(db, ctx.organizationId),
    listIncidents(db, ctx.organizationId, { activeOnly: true }),
  ]);

  const active = monitors.filter((m) => !m.paused);
  const up = active.filter((m) => m.currentStatus === "up").length;
  const down = active.filter((m) => m.currentStatus === "down").length;
  const degraded = active.filter((m) => m.currentStatus === "degraded").length;

  const allClear = down === 0 && degraded === 0 && activeIncidents.length === 0;

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
        <p className="text-primary mb-1 text-xs font-semibold tracking-[0.08em] uppercase">
          Overview
        </p>
        <h1 className="text-2xl font-semibold tracking-[-0.025em]">Dashboard</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          {allClear
            ? "All systems operational."
            : "Something needs your attention."}
        </p>
        </div>
        <div className="bg-card flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium shadow-xs">
          <span
            aria-hidden
            className={cn(
              "size-2 rounded-full",
              allClear ? "bg-ok-dot" : "bg-destructive",
            )}
          />
          {allClear ? "Healthy" : "Attention required"}
        </div>
      </header>

      {/* The counters are the aggregate signal: "everything is fine" is
          readable here in one number before the list confirms it row by
          row. The rows below carry the same dot vocabulary, so the legend
          and the list stay one language. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCell
          label="Operational"
          value={`${up}/${active.length}`}
          tone="ok"
        />
        <StatCell label="Down" value={String(down)} tone="down" />
        <StatCell label="Degraded" value={String(degraded)} tone="degraded" />
        <StatCell
          label="Active incidents"
          value={String(activeIncidents.length)}
          tone={activeIncidents.length > 0 ? "down" : undefined}
        />
      </div>


      {activeIncidents.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Active incidents</CardTitle>
            <CardDescription>
              Ongoing disruptions, newest first.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y">
              {activeIncidents.map((incident) => (
                <li key={incident.id}>
                  <Link
                    href={`/incidents/${incident.id}`}
                    className="hover:bg-accent -mx-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md px-2 py-3"
                  >
                    <SeverityBadge severity={incident.severity} />
                    {/* The title is what an operator opened the app for:
                        it wins the space fight, and the process badges
                        wrap to a second line before it loses a letter. */}
                    <span className="min-w-0 flex-1 basis-[55%] truncate font-medium">
                      {incident.title}
                    </span>
                    <span className="flex items-center gap-3">
                      <IncidentStatusBadge status={incident.status} />
                      <span className="text-muted-foreground text-xs">
                        {formatRelativeTime(incident.startedAt)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>
              Monitors
              <span className="text-muted-foreground ml-2 text-xs font-normal">
                uptime, last 24h
              </span>
            </span>
            <Button asChild variant="ghost" size="sm">
              <Link href="/monitors">
                View all
                <ArrowRightIcon aria-hidden />
              </Link>
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {monitors.length === 0 ? (
            <Empty className="border-0 p-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PulseIcon aria-hidden />
                </EmptyMedia>
                <EmptyTitle>No monitors yet</EmptyTitle>
                <EmptyDescription>
                  Add your first monitor to start tracking uptime.
                </EmptyDescription>
              </EmptyHeader>
              <Button asChild size="sm">
                <Link href="/monitors">Create a monitor</Link>
              </Button>
            </Empty>
          ) : (
            <ul className="flex flex-col divide-y">
              {monitors.map((monitor) => (
                <li key={monitor.id}>
                  <Link
                    href={`/monitors/${monitor.id}`}
                    className="hover:bg-accent -mx-2 flex h-10 items-center gap-3 px-2"
                  >
                    <MonitorStatusIndicator
                      status={monitor.currentStatus}
                      paused={monitor.paused}
                      className="w-28 shrink-0 sm:w-32"
                    />
                    {/* On a phone the name is the row; the uptime figure
                        returns when there is room for both. */}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {monitor.name}
                    </span>
                    <span className="text-muted-foreground hidden font-mono text-xs tabular-nums sm:inline">
                      {formatUptime(monitor.uptime24hPct)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * A counter carries the same dot as the rows it is counting, so the
 * legend and the list are one vocabulary rather than two. The number is
 * set in the sans like every other sentence the product speaks; the
 * digits share the mono's cell anyway, so the column still holds.
 */
function StatCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "down" | "degraded";
}) {
  const zero = value === "0";
  return (
    // 2x2 on phones, one row on desktop. The hairlines follow the shape:
    // stacked rows rule the top edge, the desktop band rules the left.
    <div className="bg-card rounded-xl border px-5 py-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      <div className="text-muted-foreground flex items-center gap-2 text-[10.5px] font-medium tracking-[0.09em] uppercase">
        <span
          aria-hidden
          className={cn(
            "inline-block size-2 shrink-0 rounded-full",
            tone === "down" && !zero && "bg-destructive",
            tone === "degraded" && !zero && "bg-warn-dot",
            tone === "ok" && "bg-ok-dot",
            (!tone || (zero && tone !== "ok")) &&
              "border-line-quiet border bg-transparent",
          )}
        />
        {label}
      </div>
      <div
        className={cn(
          "mt-2 text-[30px] leading-none font-semibold tracking-[-0.03em] sm:text-[34px]",
          tone === "down" && !zero && "text-destructive",
          tone === "degraded" && !zero && "text-warn",
        )}
      >
        {value}
      </div>
    </div>
  );
}
