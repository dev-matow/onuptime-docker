import type { DailyUptime } from "@/modules/status-pages/service";

const DAYS_SHOWN = 90;

function barColor(pct: number | null): string {
  if (pct === null) return "bg-muted";
  if (pct >= 99) return "bg-emerald-500";
  if (pct >= 90) return "bg-amber-400";
  return "bg-red-500";
}

/**
 * The classic 90-day uptime strip. Days without checks render muted.
 * Bars are right-aligned to today.
 */
export function UptimeBars({ dailyUptime }: { dailyUptime: DailyUptime[] }) {
  const byDay = new Map(dailyUptime.map((d) => [d.day, d.uptimePct]));
  const days: { day: string; pct: number | null }[] = [];
  const today = new Date();
  for (let i = DAYS_SHOWN - 1; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - i);
    const key = date.toISOString().slice(0, 10);
    days.push({ day: key, pct: byDay.get(key) ?? null });
  }

  return (
    <div
      className="flex h-8 items-stretch gap-px"
      role="img"
      aria-label={`Daily uptime for the last ${DAYS_SHOWN} days`}
    >
      {days.map(({ day, pct }) => (
        <span
          key={day}
          title={
            pct === null
              ? `${day}: no data`
              : `${day}: ${pct.toFixed(2)}% uptime`
          }
          className={`min-w-0 flex-1 rounded-[1px] ${barColor(pct)}`}
        />
      ))}
    </div>
  );
}
