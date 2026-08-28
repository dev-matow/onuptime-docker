import { formatDateTime, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MonitorCheck } from "@/modules/monitors/service";

type Outcome = "healthy" | "degraded" | "failed" | "indeterminate";

function outcomeFor(check: MonitorCheck, degradedThresholdMs: number): Outcome {
  if (check.verdict === "indeterminate") return "indeterminate";
  if (!check.ok || check.verdict === "down") return "failed";
  if (
    check.verdict === "degraded" ||
    (check.responseTimeMs !== null &&
      check.responseTimeMs > degradedThresholdMs)
  ) {
    return "degraded";
  }
  return "healthy";
}

const OUTCOME_STYLE: Record<Outcome, { label: string; className: string }> = {
  healthy: { label: "Healthy", className: "bg-ok-dot" },
  degraded: { label: "Degraded", className: "bg-warn-dot" },
  failed: { label: "Failed", className: "bg-destructive" },
  indeterminate: {
    label: "Could not measure",
    className: "border-line-quiet border bg-transparent",
  },
};

/** A compact event strip: oldest left, newest right, one block per check. */
export function CheckOutcomeChart({
  checks,
  degradedThresholdMs,
}: {
  checks: MonitorCheck[];
  degradedThresholdMs: number;
}) {
  if (checks.length === 0) {
    return (
      <div className="text-muted-foreground flex h-24 items-center justify-center border border-dashed text-xs">
        No checks yet. The first check runs within a minute.
      </div>
    );
  }

  const ordered = [...checks].reverse();
  const counts: Record<Outcome, number> = {
    healthy: 0,
    degraded: 0,
    failed: 0,
    indeterminate: 0,
  };
  for (const check of ordered) {
    counts[outcomeFor(check, degradedThresholdMs)] += 1;
  }

  const oldest = ordered[0]!;
  const newest = ordered[ordered.length - 1]!;

  return (
    <div>
      <div className="text-muted-foreground mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        {(
          Object.entries(OUTCOME_STYLE) as [
            Outcome,
            (typeof OUTCOME_STYLE)[Outcome],
          ][]
        ).map(([outcome, style]) => (
          <span key={outcome} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn("size-2 rounded-[2px]", style.className)}
            />
            {style.label} {counts[outcome]}
          </span>
        ))}
      </div>

      <div className="flex h-20 items-stretch gap-px" role="list">
        {ordered.map((check, index) => {
          const outcome = outcomeFor(check, degradedThresholdMs);
          const style = OUTCOME_STYLE[outcome];
          const details = [
            formatDateTime(check.checkedAt),
            style.label,
            check.statusCode === null ? null : `HTTP ${check.statusCode}`,
            check.responseTimeMs === null
              ? null
              : formatDuration(check.responseTimeMs),
            check.error,
          ].filter(Boolean);

          return (
            <span
              key={check.id}
              role="listitem"
              tabIndex={0}
              aria-label={details.join(". ")}
              className="group/check focus-visible:ring-ring relative min-w-0 flex-1 rounded-[2px] outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-offset-1"
            >
              <span
                aria-hidden
                className={cn("block size-full rounded-[2px]", style.className)}
              />
              <span
                role="tooltip"
                className={cn(
                  "bg-foreground text-background pointer-events-none absolute bottom-[calc(100%+8px)] z-30 hidden w-56 rounded-lg px-3 py-2 text-left text-xs leading-5 shadow-xl group-hover/check:block group-focus-visible/check:block",
                  index < 8
                    ? "left-0"
                    : index > ordered.length - 9
                      ? "right-0"
                      : "left-1/2 -translate-x-1/2",
                )}
              >
                <strong className="block font-semibold">{style.label}</strong>
                <span className="block opacity-80">
                  {formatDateTime(check.checkedAt)}
                </span>
                {(check.statusCode !== null ||
                  check.responseTimeMs !== null) && (
                  <span className="border-background/20 mt-1 block border-t pt-1 font-mono">
                    {check.statusCode !== null && `HTTP ${check.statusCode}`}
                    {check.statusCode !== null &&
                      check.responseTimeMs !== null &&
                      " · "}
                    {check.responseTimeMs !== null &&
                      formatDuration(check.responseTimeMs)}
                  </span>
                )}
                {check.error && (
                  <span className="border-background/20 mt-1 block border-t pt-1">
                    {check.error}
                  </span>
                )}
              </span>
            </span>
          );
        })}
      </div>

      <div className="text-muted-foreground mt-1.5 flex items-center justify-between font-mono text-[11px]">
        <span>{formatDateTime(oldest.checkedAt)}</span>
        <span>{formatDateTime(newest.checkedAt)}</span>
      </div>
    </div>
  );
}
