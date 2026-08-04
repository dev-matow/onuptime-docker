/**
 * In-memory sliding-window rate limiter for expensive or public actions.
 *
 * Per-process state: with several app replicas each enforces its own
 * window, which is acceptable for a cost guard — swap for a
 * Postgres/Redis-backed limiter if strictness matters.
 *
 * **The keys are attacker-chosen, so the map has to be bounded.** Several
 * call sites key on something that arrives with the request: a push
 * token, an email address, a status-page slug. Nothing here used to
 * remove an entry, so every distinct value that was ever tried stayed for
 * the life of the process — half a million guessed push tokens measured
 * at 132 MB, and the guesser only had to keep guessing. A limiter that
 * leaks under exactly the traffic it exists to refuse is not a limiter.
 *
 * Two mechanisms, and no timer (a timer here would hold the process open
 * and outlive every test): entries expire, and the map is swept when it
 * grows past a soft cap. If a sweep cannot get it under the hard cap —
 * which takes more live keys than any real install has — the entries
 * closest to expiring are evicted. Evicting grants that caller one extra
 * window's worth of attempts, which is the right way to be wrong here:
 * the alternative is refusing everybody.
 */

interface Window {
  /** Attempt timestamps inside the window, oldest first. */
  hits: number[];
  /** When the newest hit falls out, so a sweeper needs no window size. */
  expiresAt: number;
}

const windows = new Map<string, Window>();

/** What the map is trimmed back to, so a sweep buys real headroom. */
const TARGET = 10_000;
/** Never hold more than this, whatever the expiry sweep recovers. */
const HARD_CAP = 20_000;
/** Sweep at least this often, so a quiet map still lets its entries go. */
const SWEEP_EVERY = 1_000;

let sinceSweep = 0;

function sweep(now: number): void {
  sinceSweep = 0;
  for (const [key, entry] of windows) {
    if (entry.expiresAt <= now) windows.delete(key);
  }
  if (windows.size <= HARD_CAP) return;
  // Still oversized, so the flood is faster than the windows expire: drop
  // whatever expires soonest, down to TARGET rather than to the cap. Going
  // only as far as the cap would put the next insertion right back here,
  // and turn one sort into one sort per request.
  const byExpiry = [...windows.entries()].sort(
    (a, b) => a[1].expiresAt - b[1].expiresAt,
  );
  for (const [key] of byExpiry.slice(0, windows.size - TARGET)) {
    windows.delete(key);
  }
}

export function checkRateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;
  const hits = (windows.get(key)?.hits ?? []).filter((ts) => ts > cutoff);

  if (hits.length >= limit) {
    windows.set(key, { hits, expiresAt: hits[hits.length - 1]! + windowMs });
    return false;
  }

  hits.push(now);
  windows.set(key, { hits, expiresAt: now + windowMs });
  sinceSweep += 1;
  if (windows.size > HARD_CAP || sinceSweep >= SWEEP_EVERY) sweep(now);
  return true;
}

/**
 * How many keys are being retained. Exported so a test can assert the
 * bound rather than assume it — the defect this module had was invisible
 * to every behavioural test, because the limiting itself was correct.
 */
export function rateLimitKeyCount(): number {
  return windows.size;
}

/** The limiter is process-global; a suite has to be able to start clean. */
export function resetRateLimits(): void {
  windows.clear();
  sinceSweep = 0;
}
