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
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {allClear
            ? "All systems operational."
            : "Something needs your attention."}
        </p>
      </header>

      {/* The counters are the positive signal. There are no green dots in
          the list below, on purpose, so "everything is fine" has to be
          readable here in one number instead of scanned for down a
          column of fifteen rows, or five hundred. */}
      <div className="grid border sm:grid-cols-2 lg:grid-cols-4">
        <StatCell label="Operational" value={`${up}/${active.length}`} />
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
                    className="hover:bg-accent -mx-2 flex flex-wrap items-center gap-3 px-2 py-3"
                  >
                    <SeverityBadge severity={incident.severity} />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {incident.title}
                    </span>
                    <IncidentStatusBadge status={incident.status} />
                    <span className="text-muted-foreground text-xs">
                      {formatRelativeTime(incident.startedAt)}
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
            Monitors
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
                      className="w-32 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {monitor.name}
                    </span>
                    <span className="text-muted-foreground font-mono text-xs tabular-nums">
                      {formatUptime(monitor.uptime24hPct)} · 24h
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
 * A counter carries the same square as the rows it is counting, so the
 * legend and the list are one vocabulary rather than two. The number is
 * mono: the console is instruments, and a counter is an instrument that
 * happens to be large.
 */
function StatCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "down" | "degraded";
}) {
  const zero = value === "0";
  return (
    <div className="border-line-inner border-l px-4 py-3 first:border-l-0">
      <div className="text-muted-foreground flex items-center gap-2 text-[10px] font-medium tracking-[0.08em] uppercase">
        <span
          aria-hidden
          className={cn(
            "inline-block size-1.5 shrink-0 border",
            tone === "down" && !zero && "border-destructive bg-destructive",
            tone === "degraded" && !zero && "border-foreground bg-foreground",
            (!tone || zero) && "border-muted-foreground",
          )}
        />
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-mono text-[36px] leading-none font-bold tabular-nums",
          tone === "down" && !zero && "text-destructive",
        )}
      >
        {value}
      </div>
    </div>
  );
}
