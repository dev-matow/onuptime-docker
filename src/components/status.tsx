import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The state vocabulary. Every surface — dashboard, tables, the public
 * status page — renders condition through this file, so a monitor that
 * is down cannot look like one thing here and another thing there.
 *
 * The encoding is three axes and only the last one is colour:
 *
 *   fill        answers "is this row an exception". A hollow square is
 *               the background a filled one breaks against.
 *   luminance   answers "how loud". A degraded row goes white and bold
 *               without spending any hue on it.
 *   hue         is the last rung and only the last rung. Red means down.
 *
 * Which is why a screen where nothing is wrong contains no colour at
 * all, and why the red means something when it finally appears. An
 * operator scanning fifteen rows — or five hundred — is verifying
 * exceptions, not confirmations, so there is no green here: the positive
 * signal lives in the aggregate counter, one number instead of five
 * hundred dots, and it survives red-green colourblindness for free.
 *
 * Squares, never circles. The mark is drawn on an integer grid and so is
 * everything that reports to it.
 */
type MonitorStatus = "up" | "down" | "degraded" | "unknown";

type StateStyle = { square: string; row: string; label: string };

const MONITOR_STATUS_STYLES: Record<MonitorStatus, StateStyle> = {
  unknown: {
    square: "border-muted-foreground",
    row: "text-muted-foreground font-normal",
    label: "Pending",
  },
  up: {
    square: "border-muted-foreground",
    row: "text-body font-normal",
    label: "Operational",
  },
  degraded: {
    square: "border-foreground bg-foreground",
    row: "text-foreground font-semibold",
    label: "Degraded",
  },
  down: {
    square: "border-destructive bg-destructive",
    row: "text-destructive font-semibold",
    label: "Down",
  },
};

/**
 * Paused sits off the ladder rather than on it, because the schema says
 * so: pausing is an operator setting, not an observed state. A paused
 * monitor is not reporting anything, so it gets the quietest square in
 * the system and no rung.
 */
const PAUSED_STYLE: StateStyle = {
  square: "border-faint",
  row: "text-muted-foreground font-normal",
  label: "Paused",
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
  const style = paused ? PAUSED_STYLE : MONITOR_STATUS_STYLES[status];
  return (
    <span
      className={cn(
        "flex items-center gap-2 text-[11.5px]",
        style.row,
        className,
      )}
    >
      <span
        className={cn("inline-block size-1.5 shrink-0 border", style.square)}
        aria-hidden
      />
      {style.label}
    </span>
  );
}

/**
 * The lifecycle tag. A quiet outlined word, not a coloured pill: which
 * state an incident is in is a fact about process, and the screen has
 * already spent its one colour on whether the thing is down.
 */
type IncidentStatus =
  "investigating" | "identified" | "monitoring" | "resolved";

const INCIDENT_STATUS_STYLES: Record<IncidentStatus, string> = {
  investigating: "border-line-tag text-foreground",
  identified: "border-line-tag text-foreground",
  monitoring: "border-line-tag text-muted-foreground",
  resolved: "border-line-tag text-muted-foreground",
};

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "px-2 py-[3px] text-[11px] font-semibold capitalize",
        INCIDENT_STATUS_STYLES[status],
      )}
    >
      {status}
    </Badge>
  );
}

/**
 * Severity is the one badge allowed to be red, and only at critical.
 * Major and minor are the same outline in white and grey: they are
 * degrees of a thing that has not taken the site down.
 */
type IncidentSeverity = "critical" | "major" | "minor";

const SEVERITY_STYLES: Record<IncidentSeverity, string> = {
  critical: "border-destructive text-destructive",
  major: "border-line-tag text-foreground",
  minor: "border-line-tag text-muted-foreground",
};

export function SeverityBadge({ severity }: { severity: IncidentSeverity }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "px-[7px] py-[3px] font-mono text-[10px] font-bold tracking-[0.1em] uppercase",
        SEVERITY_STYLES[severity],
      )}
    >
      {severity}
    </Badge>
  );
}
