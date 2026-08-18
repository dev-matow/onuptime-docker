import { formatDateTime, formatDuration } from "@/lib/format";
import type { MonitorCheck } from "@/modules/monitors/service";

const CHART_HEIGHT = 96;
const BAR_WIDTH = 6;
const BAR_GAP = 2;

/**
 * Dependency-free SVG bar strip: one bar per check, oldest on the left.
 * Bar height is proportional to response time (scaled to the slowest
 * observed check); failed checks render as full-height red bars.
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
  const failedCount = ordered.filter((check) => !check.ok).length;
  const degradedCount = ordered.filter(
    (check) =>
      check.ok &&
      check.responseTimeMs !== null &&
      check.responseTimeMs > degradedThresholdMs,
  ).length;
  const healthyCount = ordered.length - failedCount - degradedCount;
  const width = ordered.length * (BAR_WIDTH + BAR_GAP) - BAR_GAP;
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
      <svg
        viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        className="border-foreground/10 h-24 w-full border-b"
        role="img"
        aria-label={summary}
      >
        {ordered.map((check, index) => {
          const x = index * (BAR_WIDTH + BAR_GAP);
          const failed = !check.ok;
          const responseMs = check.responseTimeMs;
          const barHeight = failed
            ? CHART_HEIGHT
            : Math.max(
                responseMs === null
                  ? 2
                  : Math.round((responseMs / maxMs) * CHART_HEIGHT),
                2,
              );
          // The same state palette as every other surface: quiet moss for
          // healthy, ochre for degraded, red for failed. A chart that
          // invents its own vocabulary makes the operator translate.
          const barClass = failed
            ? "fill-destructive"
            : responseMs !== null && responseMs > degradedThresholdMs
              ? "fill-warn-dot"
              : "fill-chart-1";
          const label = failed
            ? (check.error ?? "Check failed")
            : responseMs !== null
              ? formatDuration(responseMs)
              : "OK";
          return (
            <rect
              key={check.id}
              x={x}
              y={CHART_HEIGHT - barHeight}
              width={BAR_WIDTH}
              height={barHeight}
              className={barClass}
            >
              <title>{`${formatDateTime(check.checkedAt)}, ${label}`}</title>
            </rect>
          );
        })}
      </svg>
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
