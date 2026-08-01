import { HF_SHARD_COUNT } from "./limits";

/**
 * Which shard a monitor belongs to.
 *
 * Computed from the id rather than stored, so the mapping needs no
 * column, no migration and no repair job — and so two replicas running
 * the same build cannot disagree about it, which is the property the
 * lease depends on.
 *
 * FNV-1a over the id's bytes. It is not a cryptographic hash and does
 * not need to be: the only requirement is that ids spread evenly, and
 * uuidv7 ids share a long time-ordered prefix, so the cheap alternatives
 * that people reach for first — first character, last character, string
 * length — put every monitor created in the same millisecond on the same
 * shard. FNV mixes the whole string.
 */
export function shardOf(monitorId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < monitorId.length; index += 1) {
    hash ^= monitorId.charCodeAt(index);
    // The FNV prime, as shifts and adds. `hash * 16777619` in
    // JavaScript loses the low bits to float rounding above 2^53, which
    // silently collapses the distribution this function exists to give.
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  return hash % HF_SHARD_COUNT;
}

/** Every shard id, for a replica that is trying to claim all of them. */
export const ALL_SHARDS: readonly number[] = Array.from(
  { length: HF_SHARD_COUNT },
  (_, index) => index,
);
