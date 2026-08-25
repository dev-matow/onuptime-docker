import type {
  FactDescriptor,
  FactValue,
} from "@/modules/monitors/types/contract";

import type { EvidenceChange, EvidenceFacts } from "./types";

/**
 * What changed between the last check that reached the target and the
 * one that did not.
 *
 * This is the question an operator asks second, right after "what
 * broke": the same monitor was fine four minutes ago, so what is
 * different now. Answering it from two stored fact bags costs nothing
 * extra to measure - the observations were already written - and it is
 * the difference between an incident page that says "down" and one that
 * says "it answered 200 in 130ms, now it answers 503 in 12ms".
 *
 * Two rules keep the list short enough to read.
 *
 * **Timings need a threshold; everything else does not.** A status code
 * that moved from 200 to 201 matters, a record count that moved from 3
 * to 2 matters, a certificate issuer that changed matters. A response
 * time that moved from 130ms to 160ms does not - it is what a healthy
 * endpoint does all day. So durations are filtered by ratio and
 * everything else is reported on any inequality. Applying one relative
 * threshold to both, which is what the first version of this did, hid
 * the status change and published the noise.
 *
 * **Appearing and disappearing are changes.** A fact the failing check
 * did not report is usually the most informative row in the list: an
 * `http` check that stops reporting `tlsDaysRemaining` stopped
 * completing a handshake.
 */

/** How much slower a duration must be before it is worth a line. */
const SLOWER_RATIO = 2;
/** And how much faster. A collapse to near-zero is a real signal. */
const FASTER_RATIO = 0.5;
/** Below this, a ratio is arithmetic on noise. */
const MIN_DURATION_DELTA_MS = 50;

/**
 * The most rows a snapshot carries. A fact bag has a handful of keys by
 * construction, so this only ever bites for a type nobody has written
 * yet - which is exactly when an unbounded list would be discovered in
 * production.
 */
const MAX_CHANGES = 12;

function isDuration(
  key: string,
  descriptor: FactDescriptor | undefined,
): boolean {
  if (descriptor?.unit === "ms") return true;
  return /(^|[a-z])Ms$/.test(key) || key.toLowerCase().endsWith("timems");
}

function equalValues(
  a: FactValue | FactValue[] | null,
  b: FactValue | FactValue[] | null,
): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((entry, i) => entry === b[i]);
  }
  return a === b;
}

/**
 * Whether a duration moved enough to mention, and in which direction.
 *
 * Returns null when it did not, which is the common case and the reason
 * this function exists at all.
 */
function durationNote(
  before: number,
  after: number,
): "slower" | "faster" | "changed" | null {
  const delta = after - before;
  if (Math.abs(delta) < MIN_DURATION_DELTA_MS) return null;

  // Not every millisecond fact is a duration. NTP reports a clock
  // OFFSET, which is signed and routinely crosses zero, and a signed
  // ratio is meaningless there: -40ms to +5000ms gives a negative ratio
  // that matched neither threshold, so a clock leaping five seconds was
  // silently dropped from the list, and -40ms to -5000ms would have been
  // reported as "faster". A magnitude comparison answers both, and a
  // sign change is reported as a plain change because "slower" is not a
  // thing an offset does.
  if (before < 0 || after < 0) {
    return Math.sign(before) !== Math.sign(after) ||
      Math.abs(after) >= Math.abs(before) * SLOWER_RATIO ||
      Math.abs(after) <= Math.abs(before) * FASTER_RATIO
      ? "changed"
      : null;
  }

  // A `before` of zero cannot produce a ratio. Treat any move past the
  // absolute floor as a change rather than dividing by it.
  if (before === 0) return delta > 0 ? "slower" : null;
  const ratio = after / before;
  if (ratio >= SLOWER_RATIO) return "slower";
  if (ratio <= FASTER_RATIO) return "faster";
  return null;
}

/**
 * The before/after list, in a deterministic order.
 *
 * Order is the type's own declaration order first - which is the order
 * the same facts appear in everywhere else in the product - and then
 * alphabetical for anything the type did not declare. Sorting by
 * magnitude of change would be more dramatic and would make two
 * snapshots of the same outage disagree about which line comes first.
 */
export function meaningfulChanges(
  before: EvidenceFacts | null,
  after: EvidenceFacts,
  descriptors: readonly FactDescriptor[] = [],
): EvidenceChange[] {
  if (before === null) return [];

  const byKey = new Map(descriptors.map((d) => [d.key, d]));
  const declared = descriptors.map((d) => d.key);
  const extra = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !byKey.has(key))
    .sort();
  const keys = [...declared, ...extra];

  const changes: EvidenceChange[] = [];
  for (const key of keys) {
    if (changes.length >= MAX_CHANGES) break;
    const hasBefore = Object.hasOwn(before, key) && before[key] !== undefined;
    const hasAfter = Object.hasOwn(after, key) && after[key] !== undefined;
    if (!hasBefore && !hasAfter) continue;

    const descriptor = byKey.get(key);
    const label = descriptor?.label ?? key;
    const unit = descriptor?.unit;
    const from = hasBefore ? (before[key] ?? null) : null;
    const to = hasAfter ? (after[key] ?? null) : null;

    if (!hasBefore) {
      changes.push({
        key,
        label,
        ...(unit ? { unit } : {}),
        before: null,
        after: to,
        note: "appeared",
      });
      continue;
    }
    if (!hasAfter) {
      changes.push({
        key,
        label,
        ...(unit ? { unit } : {}),
        before: from,
        after: null,
        note: "disappeared",
      });
      continue;
    }
    if (equalValues(from, to)) continue;

    if (
      typeof from === "number" &&
      typeof to === "number" &&
      isDuration(key, descriptor)
    ) {
      const note = durationNote(from, to);
      if (note === null) continue;
      changes.push({
        key,
        label,
        ...(unit ? { unit } : {}),
        before: from,
        after: to,
        note,
      });
      continue;
    }

    changes.push({
      key,
      label,
      ...(unit ? { unit } : {}),
      before: from,
      after: to,
      note: "changed",
    });
  }
  return changes;
}
