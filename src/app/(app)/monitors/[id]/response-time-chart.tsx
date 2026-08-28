import { formatDateTime, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MonitorCheck } from "@/modules/monitors/service";

/**
 * Dependency-free bar strip: one bar per check, oldest on the left.
 * Every bar can be hovered or keyboard-focused for the underlying observation.
 */
export function ResponseTimeChart({
  checks,
  degradedThresholdMs,
}: {
  /** Newest-first, as returned by getMonitorDetail. */
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
  const maxMs = Math.max(
    1,
    ...ordered.map((check) => check.responseTimeMs ?? 0),
  );
  const failedCount = ordered.filter(
    (check) => !check.ok || check.verdict === "down",
  ).length;
  const degradedCount = ordered.filter(
    (check) =>
      check.ok &&
      (check.verdict === "degraded" ||
        (check.responseTimeMs !== null &&
          check.responseTimeMs > degradedThresholdMs)),
  ).length;
  const healthyCount = ordered.length - failedCount - degradedCount;
  const oldest = ordered[0];
  const newest = ordered[ordered.length - 1];
  if (!oldest || !newest) return null;

  const summary = `Response times for the last ${ordered.length} checks: ${healthyCount} healthy, ${degradedCount} degraded, ${failedCount} failed. Slowest response ${formatDuration(maxMs)}.`;

  return (
    <div>
      <div className="text-muted-foreground mb-2 flex items-center justify-between gap-4 text-[11px]">
        <div className="flex items-center gap-3" aria-hidden>
          <span className="flex items-center gap-1.5">
            <span className="bg-chart-1 size-2 rounded-[2px]" />
            Healthy
          </span>
          <span className="flex items-center gap-1.5">
            <span className="bg-warn-dot size-2 rounded-[2px]" />
            Degraded
          </span>
          <span className="flex items-center gap-1.5">
            <span className="bg-destructive size-2 rounded-[2px]" />
            Failed
          </span>
        </div>
        <span className="font-mono tabular-nums">
          max {formatDuration(maxMs)}
        </span>
      </div>
      <div
        className="border-foreground/10 flex h-24 items-end gap-px border-b"
        role="list"
        aria-label={summary}
      >
        {ordered.map((check, index) => {
          const failed = !check.ok || check.verdict === "down";
          const responseMs = check.responseTimeMs;
          const heightPct = failed
            ? 100
            : Math.max(
                responseMs === null
                  ? 3
                  : Math.round((responseMs / maxMs) * 100),
                3,
              );
          const degraded =
            check.verdict === "degraded" ||
            (responseMs !== null && responseMs > degradedThresholdMs);
          const barClass = failed
            ? "bg-destructive"
            : degraded
              ? "bg-warn-dot"
              : "bg-chart-1";
          const stateLabel = failed
            ? "Failed"
            : degraded
              ? "Degraded"
              : "Healthy";
          const label = failed
            ? (check.error ?? "Check failed")
            : responseMs !== null
              ? formatDuration(responseMs)
              : "OK";

          return (
            <span
              key={check.id}
              role="listitem"
              tabIndex={0}
              aria-label={`${formatDateTime(check.checkedAt)}. ${stateLabel}. ${label}`}
              className="group/check focus-visible:ring-ring relative min-w-0 flex-1 rounded-t-[2px] outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-offset-1"
              style={{ height: `${heightPct}%` }}
            >
              <span
                aria-hidden
                className={cn("block size-full rounded-t-[2px]", barClass)}
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
                <strong className="block font-semibold">{stateLabel}</strong>
                <span className="block opacity-80">
                  {formatDateTime(check.checkedAt)}
                </span>
                {(check.statusCode !== null || responseMs !== null) && (
                  <span className="border-background/20 mt-1 block border-t pt-1 font-mono">
                    {check.statusCode !== null && `HTTP ${check.statusCode}`}
                    {check.statusCode !== null && responseMs !== null && " · "}
                    {responseMs !== null && formatDuration(responseMs)}
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
      <div
        className="text-muted-foreground mt-1.5 flex items-center justify-between font-mono text-[11px]"
        aria-hidden
      >
        <span>{formatDateTime(oldest.checkedAt)}</span>
        <span>{formatDateTime(newest.checkedAt)}</span>
      </div>
    </div>
  );
}
