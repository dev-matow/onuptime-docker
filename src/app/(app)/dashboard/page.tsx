import {
  ArrowRightIcon,
  CheckCircleIcon,
  PulseIcon,
  SirenIcon,
  WarningIcon,
} from "@phosphor-icons/react/dist/ssr";
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
import { listIncidents } from "@/modules/incidents/service";
import { listMonitors } from "@/modules/monitors/service";

export const metadata: Metadata = { title: "Dashboard — Vigil" };

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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Operational"
          value={`${up}/${active.length}`}
          icon={
            <CheckCircleIcon className="size-4 text-emerald-500" aria-hidden />
          }
        />
        <StatCard
          label="Down"
          value={String(down)}
          icon={<WarningIcon className="size-4 text-red-500" aria-hidden />}
          alert={down > 0}
        />
        <StatCard
          label="Degraded"
          value={String(degraded)}
          icon={<PulseIcon className="size-4 text-amber-500" aria-hidden />}
          alert={degraded > 0}
        />
        <StatCard
          label="Active incidents"
          value={String(activeIncidents.length)}
          icon={<SirenIcon className="size-4 text-red-500" aria-hidden />}
          alert={activeIncidents.length > 0}
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
                    className="hover:bg-muted/50 -mx-2 flex flex-wrap items-center gap-3 rounded-md px-2 py-3"
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
                    className="hover:bg-muted/50 -mx-2 flex items-center gap-3 rounded-md px-2 py-2.5"
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

function StatCard({
  label,
  value,
  icon,
  alert = false,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  alert?: boolean;
}) {
  return (
    <Card className={alert ? "border-red-200 dark:border-red-900" : undefined}>
      <CardContent className="flex flex-col gap-1">
        <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
          {icon}
          {label}
        </div>
        <div className="font-mono text-2xl font-semibold tabular-nums">
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
