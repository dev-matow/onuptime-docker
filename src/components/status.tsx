import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The state vocabulary. Every surface — dashboard, tables, the public
 * status page — renders condition through this file, so a monitor that
 * is down cannot look like one thing here and another thing there.
 *
 * On the porcelain ground the encoding is a dot and a weight:
 *
 *   dot      a small filled disc in the state's colour. Moss means
 *            operational, ochre means degraded, red means down. A hollow
 *            ring means the monitor is not reporting (pending, paused).
 *   weight   answers "how loud". Exceptions set their label semibold and
 *            take the state's colour into the text; operational rows stay
 *            body-quiet, because an operator scanning five hundred rows
 *            is verifying exceptions, not confirmations.
 *
 * Red remains the only alarm. Moss and ochre are report colours, chosen
 * to survive red-green colourblindness by weight and fill as well as
 * hue, and every text use clears AA on the lightest surface.
 */
type MonitorStatus = "up" | "down" | "degraded" | "unknown";

type StateStyle = { dot: string; row: string; label: string };

const MONITOR_STATUS_STYLES: Record<MonitorStatus, StateStyle> = {
  unknown: {
    dot: "border border-line-quiet bg-transparent",
    row: "text-muted-foreground font-normal",
    label: "Pending",
  },
  up: {
    dot: "bg-ok-dot",
    row: "text-ok font-medium",
    label: "Operational",
  },
  degraded: {
    dot: "bg-warn-dot",
    row: "text-warn font-semibold",
    label: "Degraded",
  },
  down: {
    dot: "bg-destructive",
    row: "text-destructive font-semibold",
    label: "Down",
  },
};

/**
 * Paused sits off the ladder rather than on it, because the schema says
 * so: pausing is an operator setting, not an observed state. A paused
 * monitor is not reporting anything, so it gets the quietest ring in
 * the system and no colour.
 */
const PAUSED_STYLE: StateStyle = {
  dot: "border border-line-tag bg-transparent",
  row: "text-muted-foreground font-normal",
  label: "Paused",
};

export function MonitorStatusIndicator({
  status,
  paused,
  className,
  compactLabel = false,
}: {
  status: MonitorStatus;
  paused?: boolean;
  className?: string;
  /**
   * On phone-width tables the dot carries the state and the word yields
   * its column to the name; the label stays for screen readers.
   */
  compactLabel?: boolean;
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
        className={cn("inline-block size-2 shrink-0 rounded-full", style.dot)}
        aria-hidden
      />
      <span className={cn(compactLabel && "max-sm:sr-only")}>
        {style.label}
      </span>
    </span>
  );
}

/**
 * The lifecycle tag. A quiet outlined word, not a coloured pill: which
 * state an incident is in is a fact about process, and the screen
 * reserves colour for whether the thing is down.
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
        "px-2 py-[3px] text-[11px] font-medium capitalize",
        INCIDENT_STATUS_STYLES[status],
      )}
    >
      {status}
    </Badge>
  );
}


/**
 * Severity is the one badge allowed to be red, and only at critical.
 * Major and minor are the same outline at two text weights: they are
 * degrees of a thing that has not taken the site down.
 */
type IncidentSeverity = "critical" | "major" | "minor";

const SEVERITY_STYLES: Record<IncidentSeverity, string> = {
  critical: "border-destructive/45 bg-destructive/6 text-destructive",
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
