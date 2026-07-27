/**
 * Hybrid logical clocks.
 *
 * One bigint: wall-clock milliseconds in the high bits, a counter in the
 * low 16. Physical time makes it readable and roughly comparable to real
 * timestamps; the counter makes it strictly monotonic per actor even
 * when several facts land in the same millisecond or the wall clock
 * steps backwards.
 *
 * Why bother while there is one writer: ordering by `serial` or by
 * `now()` assumes there is one writer. The second one — a second worker
 * replica, an edge probe, a heartbeat sender — arrives with facts that
 * are late, out of order, or concurrent, and at that point every
 * historical row and every query that reads one has to be migrated.
 * This is one column and forty lines.
 */

const COUNTER_BITS = 16n;
const COUNTER_MASK = (1n << COUNTER_BITS) - 1n;
const MAX_COUNTER = Number(COUNTER_MASK);

export function encodeHlc(physicalMs: number, counter: number): bigint {
  if (physicalMs < 0 || counter < 0 || counter > MAX_COUNTER) {
    throw new RangeError(`Cannot encode HLC (${physicalMs}, ${counter})`);
  }
  return (BigInt(Math.trunc(physicalMs)) << COUNTER_BITS) | BigInt(counter);
}

export function decodeHlc(hlc: bigint): {
  physicalMs: number;
  counter: number;
} {
  return {
    physicalMs: Number(hlc >> COUNTER_BITS),
    counter: Number(hlc & COUNTER_MASK),
  };
}

/**
 * The next clock value for an actor that last issued `previous`.
 *
 * Never goes backwards, even if the host clock does — a clock that can
 * move backwards makes the chain's ordering a lie, and NTP correcting a
 * drifted server is an ordinary event, not an exotic one.
 */
export function nextHlc(previous: bigint, nowMs: number): bigint {
  const prior = decodeHlc(previous);
  const physicalMs = Math.max(prior.physicalMs, Math.trunc(nowMs));

  if (physicalMs > prior.physicalMs) return encodeHlc(physicalMs, 0);

  // Same millisecond (or the clock went backwards): advance the
  // counter. Exhausting 65,536 facts inside one millisecond from one
  // actor is not reachable here, but silently wrapping would be a
  // duplicate clock value, so borrow a millisecond from the future.
  if (prior.counter >= MAX_COUNTER) return encodeHlc(physicalMs + 1, 0);
  return encodeHlc(physicalMs, prior.counter + 1);
}

/** Wall-clock instant an HLC was issued at. Lossy by design — the
 * counter is ordering, not time. */
export function hlcToDate(hlc: bigint): Date {
  return new Date(decodeHlc(hlc).physicalMs);
}
