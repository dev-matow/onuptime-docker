import Link from "next/link";

import type { DailyUptime } from "@/modules/status-pages/service";
import { cn } from "@/lib/utils";

const DAYS_SHOWN = 90;
const MOBILE_DAYS_SHOWN = 60;
const BANGKOK_OFFSET_MS = 7 * 60 * 60_000;

const dayFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Bangkok",
});

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Bangkok",
});

function dayLabel(day: string): string {
  return dayFormatter.format(new Date(`${day}T00:00:00+07:00`));
}

function barColor(pct: number | null): string {
  if (pct === null) return "bg-muted";
  if (pct >= 99) return "bg-ok-dot";
  if (pct >= 90) return "bg-warn-dot";
  return "bg-destructive";
}

/**
 * The classic 90-day uptime strip. Days without checks render muted.
 * Bars are right-aligned to today.
 */
export function UptimeBars({
  dailyUptime,
  slug,
  componentIndex,
  selectedDay,
}: {
  dailyUptime: DailyUptime[];
  slug: string;
  componentIndex: number;
  selectedDay?: string;
}) {
  const byDay = new Map(dailyUptime.map((d) => [d.day, d]));
  const days: DailyUptime[] = [];
  const now = new Date();
  const bangkokToday = new Date(now.getTime() + BANGKOK_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
  const today = new Date(`${bangkokToday}T00:00:00Z`);
  for (let i = DAYS_SHOWN - 1; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - i);
    const key = date.toISOString().slice(0, 10);
    days.push(byDay.get(key) ?? { day: key, uptimePct: null, issues: [] });
  }

  return (
    <>
      <div className="sm:hidden">
        <UptimeStrip
          days={days.slice(-MOBILE_DAYS_SHOWN)}
          slug={slug}
          componentIndex={componentIndex}
          selectedDay={selectedDay}
        />
      </div>
      <div className="hidden sm:block">
        <UptimeStrip
          days={days}
          slug={slug}
          componentIndex={componentIndex}
          selectedDay={selectedDay}
        />
      </div>
    </>
  );
}

function UptimeStrip({
  days,
  slug,
  componentIndex,
  selectedDay,
}: {
  days: DailyUptime[];
  slug: string;
  componentIndex: number;
  selectedDay?: string;
}) {
  const firstDay = days[0]!.day;
  const lastDay = days[days.length - 1]!.day;

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex h-8 items-stretch gap-px"
        role="img"
        aria-label={`Daily uptime from ${dayLabel(firstDay)} to ${dayLabel(lastDay)}`}
      >
        {days.map((entry, index) => {
          const isSelected = selectedDay === entry.day;
          const issueLines = entry.issues.map(
            (issue) =>
              `${timeFormatter.format(new Date(issue.checkedAt))} UTC+7 · ${issue.summary}`,
          );
          const title = [
            dayLabel(entry.day),
            entry.uptimePct === null
              ? "No uptime data"
              : `${entry.uptimePct.toFixed(2)}% uptime`,
            ...issueLines,
          ].join("\n");
          return (
            <Link
              key={entry.day}
              href={
                isSelected
                  ? `/status/${encodeURIComponent(slug)}#component-${componentIndex}`
                  : `/status/${encodeURIComponent(slug)}?component=${componentIndex}&day=${entry.day}#component-${componentIndex}`
              }
              title={title}
              aria-label={`${dayLabel(entry.day)}: ${
                entry.uptimePct === null
                  ? "no uptime data"
                  : `${entry.uptimePct.toFixed(2)}% uptime`
              }. ${
                isSelected
                  ? "Hide 30-minute details."
                  : "Select this day for 30-minute details."
              }`}
              aria-current={isSelected ? "date" : undefined}
              className={cn(
                "group/bar focus-visible:ring-ring relative min-w-0 flex-1 rounded-[2px] outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-offset-1",
                isSelected &&
                  "ring-primary z-10 ring-2 ring-offset-1 ring-offset-background",
              )}
            >
              <span
                className={`block size-full rounded-[2px] ${barColor(entry.uptimePct)}`}
              />
              <span
                role="tooltip"
                className={`bg-foreground text-background pointer-events-none absolute bottom-[calc(100%+8px)] z-20 hidden w-56 rounded-lg px-3 py-2 text-left text-xs leading-5 shadow-xl group-hover/bar:block group-focus-visible/bar:block ${
                  index < 12
                    ? "left-0"
                    : index > days.length - 13
                      ? "right-0"
                      : "left-1/2 -translate-x-1/2"
                }`}
              >
                <strong className="block font-semibold">
                  {dayLabel(entry.day)}
                </strong>
                <span className="block opacity-80">
                  {entry.uptimePct === null
                    ? "No uptime data"
                    : `${entry.uptimePct.toFixed(2)}% uptime`}
                </span>
                {entry.issues.length > 0 && (
                  <span className="border-background/20 mt-1.5 block border-t pt-1.5">
                    {entry.issues.map((issue) => (
                      <span key={issue.checkedAt} className="block">
                        {timeFormatter.format(new Date(issue.checkedAt))} UTC+7
                        · {issue.summary}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </Link>
          );
        })}
      </div>
      <div className="text-muted-foreground flex items-center justify-between text-[11px]">
        <time dateTime={firstDay}>{dayLabel(firstDay)}</time>
        <time dateTime={lastDay}>{dayLabel(lastDay)}</time>
      </div>
    </div>
  );
}
