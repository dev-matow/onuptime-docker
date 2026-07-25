/**
 * In-memory sliding-window rate limiter for expensive server actions
 * (AI generation). Per-process state: with several app replicas each
 * enforces its own window, which is acceptable for a cost guard —
 * swap for a Postgres/Redis-backed limiter if strictness matters.
 */
const windows = new Map<string, number[]>();

export function checkRateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;
  const hits = (windows.get(key) ?? []).filter((ts) => ts > cutoff);
  if (hits.length >= limit) {
    windows.set(key, hits);
    return false;
  }
  hits.push(now);
  windows.set(key, hits);
  return true;
}
