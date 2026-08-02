import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  ArrowLeftIcon,
  PulseIcon,
  UserIcon,
} from "@phosphor-icons/react/dist/ssr";

import { IncidentStatusBadge, SeverityBadge } from "@/components/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db";
import { isAiEnabled } from "@/lib/env";
import { NotFoundError } from "@/lib/errors";
import { formatDateTime, formatDuration } from "@/lib/format";
import { hasPermission } from "@/lib/permissions";
import { requireOrgContext } from "@/lib/session";
import { getIncidentDetail } from "@/modules/incidents/service";

import { PostmortemCard } from "./postmortem-card";
import { StatusControls } from "./status-controls";
import { IncidentTimeline } from "./timeline";
import { UpdateComposer } from "./update-composer";

export const metadata: Metadata = { title: "Incident · Vigil" };

export default async function IncidentDetailPage(
  props: PageProps<"/incidents/[id]">,
) {
  const ctx = await requireOrgContext();
  const { id } = await props.params;

  const detail = await getIncidentDetail(db, ctx.organizationId, id).catch(
    (error: unknown) => {
      if (error instanceof NotFoundError) notFound();
      throw error;
    },
  );
  const { incident, monitor, timeline } = detail;

  const canUpdate = hasPermission(ctx.role, { incident: ["update"] });
  const canResolve = hasPermission(ctx.role, { incident: ["resolve"] });
  const canPostmortem = hasPermission(ctx.role, { incident: ["postmortem"] });

  const resolved = incident.status === "resolved";
  const openedBy =
    timeline.find((event) => event.type === "created")?.authorName ?? "System";
  const durationMs =
    (incident.resolvedAt ?? new Date()).getTime() -
    incident.startedAt.getTime();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/incidents"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs transition-colors"
        >
          <ArrowLeftIcon className="size-3.5" aria-hidden />
          Back to incidents
        </Link>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={incident.severity} />
          <IncidentStatusBadge status={incident.status} />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {incident.title}
        </h1>
        <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-sm">
          {incident.source === "monitor" ? (
            <span className="inline-flex items-center gap-1.5">
              <PulseIcon className="size-3.5" aria-hidden />
              Auto-opened by monitor{" "}
              {monitor ? (
                <Link
                  href={`/monitors/${monitor.id}`}
                  className="text-foreground font-medium underline-offset-4 hover:underline"
                >
                  {monitor.name}
                </Link>
              ) : (
                <span className="text-foreground font-medium">
                  (deleted monitor)
                </span>
              )}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <UserIcon className="size-3.5" aria-hidden />
              Opened by{" "}
              <span className="text-foreground font-medium">{openedBy}</span>
            </span>
          )}
          <span aria-hidden>·</span>
          <span>Started {formatDateTime(incident.startedAt)}</span>
          <span aria-hidden>·</span>
          {resolved ? (
            <span>
              Resolved in{" "}
              <span className="text-foreground font-mono">
                {formatDuration(durationMs)}
              </span>
            </span>
          ) : (
            <span>
              Ongoing for{" "}
              <span className="text-foreground font-mono">
                {formatDuration(durationMs)}
              </span>
            </span>
          )}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          {resolved && (
            <PostmortemCard
              incidentId={incident.id}
              postmortem={incident.postmortem}
              canEdit={canPostmortem}
              aiEnabled={isAiEnabled}
            />
          )}
          {!resolved && canUpdate && (
            <UpdateComposer incidentId={incident.id} aiEnabled={isAiEnabled} />
          )}
          <section
            className="flex flex-col gap-4"
            aria-label="Incident timeline"
          >
            <h2 className="text-sm font-medium">Timeline</h2>
            <IncidentTimeline events={timeline} />
          </section>
        </div>

        <div className="flex flex-col gap-6">
          {(canUpdate || canResolve) && (
            <StatusControls
              incidentId={incident.id}
              status={incident.status}
              severity={incident.severity}
              acknowledged={incident.acknowledgedAt !== null}
              canUpdate={canUpdate}
              canResolve={canResolve}
            />
          )}
          <Card size="sm">
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="flex flex-col gap-2.5 text-xs">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Source</dt>
                  <dd className="capitalize">{incident.source}</dd>
                </div>
                {monitor && (
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-muted-foreground">Monitor</dt>
                    <dd className="truncate">
                      <Link
                        href={`/monitors/${monitor.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {monitor.name}
                      </Link>
                    </dd>
                  </div>
                )}
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Started</dt>
                  <dd>{formatDateTime(incident.startedAt)}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Resolved</dt>
                  <dd>
                    {incident.resolvedAt
                      ? formatDateTime(incident.resolvedAt)
                      : "-"}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Duration</dt>
                  <dd className="font-mono">{formatDuration(durationMs)}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Timeline events</dt>
                  <dd className="font-mono">{timeline.length}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
