const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 1000 * 60 * 60 * 24 * 365],
  ["month", 1000 * 60 * 60 * 24 * 30],
  ["day", 1000 * 60 * 60 * 24],
  ["hour", 1000 * 60 * 60],
  ["minute", 1000 * 60],
];

const relativeFormatter = new Intl.RelativeTimeFormat("en", {
  numeric: "auto",
});

export function formatRelativeTime(date: Date, now = new Date()): string {
  const diff = date.getTime() - now.getTime();
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (Math.abs(diff) >= ms) {
      return relativeFormatter.format(Math.round(diff / ms), unit);
    }
  }
  return "just now";
}

const dateTimeFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDateTime(date: Date): string {
  return dateTimeFormatter.format(date);
}

/** 95000 -> "1h 35m", 125000 -> "2m 5s", 900 -> "900ms" */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * Truncates instead of rounding: 99.995% of a month is ~22 minutes of
 * downtime — displaying it as "100.00%" would overstate availability.
 */
export function formatUptime(pct: number | null): string {
  if (pct === null) return "-";
  return `${(Math.floor(pct * 100) / 100).toFixed(2)}%`;
}
