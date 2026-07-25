import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Shared status → color vocabulary. Every surface (dashboard, tables,
 * public status page) renders state through these so the same condition
 * never shows two different colors.
 */
type MonitorStatus = "up" | "down" | "degraded" | "unknown";

const MONITOR_STATUS_STYLES: Record<
  MonitorStatus,
  { dot: string; label: string }
> = {
  up: { dot: "bg-emerald-500", label: "Operational" },
  degraded: { dot: "bg-amber-500", label: "Degraded" },
  down: { dot: "bg-red-500", label: "Down" },
  unknown: { dot: "bg-muted-foreground/40", label: "Pending" },
};

export function MonitorStatusIndicator({
  status,
  paused,
  className,
}: {
  status: MonitorStatus;
  paused?: boolean;
  className?: string;
}) {
  const style = paused
    ? { dot: "bg-muted-foreground/40", label: "Paused" }
    : MONITOR_STATUS_STYLES[status];
  return (
    <span className={cn("flex items-center gap-2 text-sm", className)}>
      <span className="relative flex size-2.5" aria-hidden>
        {status === "down" && !paused && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
        )}
        <span
          className={cn(
            "relative inline-flex size-2.5 rounded-full",
            style.dot,
          )}
        />
      </span>
      {style.label}
    </span>
  );
}

type IncidentStatus =
  "investigating" | "identified" | "monitoring" | "resolved";

const INCIDENT_STATUS_STYLES: Record<IncidentStatus, string> = {
  investigating: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  identified:
    "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  monitoring: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  resolved:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
};

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return (
    <Badge
      variant="secondary"
      className={cn("capitalize", INCIDENT_STATUS_STYLES[status])}
    >
      {status}
    </Badge>
  );
}

type IncidentSeverity = "critical" | "major" | "minor";

const SEVERITY_STYLES: Record<IncidentSeverity, string> = {
  critical: "border-red-300 text-red-700 dark:border-red-800 dark:text-red-400",
  major:
    "border-orange-300 text-orange-700 dark:border-orange-800 dark:text-orange-400",
  minor:
    "border-yellow-300 text-yellow-700 dark:border-yellow-800 dark:text-yellow-500",
};

export function SeverityBadge({ severity }: { severity: IncidentSeverity }) {
  return (
    <Badge
      variant="outline"
      className={cn("font-mono uppercase", SEVERITY_STYLES[severity])}
    >
      {severity}
    </Badge>
  );
}
