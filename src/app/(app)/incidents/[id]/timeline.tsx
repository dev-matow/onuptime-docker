import type { Icon } from "@phosphor-icons/react";
import {
  ArrowRightIcon,
  ChatCircleIcon,
  FlagIcon,
  RobotIcon,
  WarningIcon,
} from "@phosphor-icons/react/dist/ssr";

import { IncidentStatusBadge } from "@/components/status";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TimelineEvent } from "@/modules/incidents/service";

const EVENT_ICONS: Record<TimelineEvent["type"], Icon> = {
  created: FlagIcon,
  status_change: ArrowRightIcon,
  severity_change: WarningIcon,
  update: ChatCircleIcon,
  system: RobotIcon,
};

const EVENT_LABELS: Record<TimelineEvent["type"], string> = {
  created: "opened this incident",
  status_change: "changed the status",
  severity_change: "changed the severity",
  update: "posted an update",
  system: "system event",
};

function iconTone(event: TimelineEvent): string {
  if (event.type === "status_change" && event.status === "resolved") {
    return "text-muted-foreground";
  }
  if (event.type === "created") {
    return "bg-foreground text-background";
  }
  if (event.type === "severity_change") {
    return "text-foreground";
  }
  return "bg-muted text-muted-foreground";
}

export function IncidentTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">No timeline events yet.</p>
    );
  }

  return (
    <ol className="flex flex-col">
      {events.map((event, index) => {
        const EventIcon = EVENT_ICONS[event.type];
        return (
          <li key={event.id} className="relative flex gap-4 pb-8 last:pb-0">
            {index < events.length - 1 && (
              <span
                aria-hidden
                className="bg-border absolute top-9 bottom-1 left-4 w-px -translate-x-1/2"
              />
            )}
            <span
              className={cn(
                "ring-foreground/10 flex size-8 shrink-0 items-center justify-center rounded-full ring-1",
                iconTone(event),
              )}
            >
              <EventIcon className="size-4" aria-hidden />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="font-medium">
                  {event.authorName ?? "System"}
                </span>
                <span className="text-muted-foreground">
                  {EVENT_LABELS[event.type]}
                </span>
                {event.status && <IncidentStatusBadge status={event.status} />}
                {event.internal && (
                  <span className="text-foreground rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                    Internal
                  </span>
                )}
                <span aria-hidden className="text-muted-foreground/50">
                  ·
                </span>
                <time
                  dateTime={event.createdAt.toISOString()}
                  title={formatDateTime(event.createdAt)}
                  className="text-muted-foreground"
                >
                  {formatRelativeTime(event.createdAt)}
                </time>
              </div>
              <p className="text-foreground/90 text-sm/relaxed whitespace-pre-wrap">
                {event.message}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
