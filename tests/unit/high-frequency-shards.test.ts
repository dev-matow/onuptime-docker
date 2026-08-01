import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { HF_SHARD_COUNT } from "@/modules/monitors/highfreq/limits";
import { ALL_SHARDS, shardOf } from "@/modules/monitors/highfreq/shards";

describe("shard assignment", () => {
  it("puts a monitor on the same shard every time it is asked", () => {
    const id = randomUUID();
    expect(shardOf(id)).toBe(shardOf(id));
  });

  it("always answers with a shard that exists", () => {
    for (let n = 0; n < 500; n += 1) {
      const shard = shardOf(randomUUID());
      expect(ALL_SHARDS).toContain(shard);
    }
  });

  it("spreads ids created in the same millisecond across shards", () => {
    // uuidv7 is time-ordered, so a burst of monitors created together
    // shares a long prefix. A hash that only reads the front of the
    // string puts all of them on one shard, which means one replica
    // probes all of them and the others idle — a plausible-looking
    // implementation that silently removes the point of sharding.
    const prefix = "01997b3e-8f00-7000-8000-";
    const shards = new Set<number>();
    for (let n = 0; n < 200; n += 1) {
      shards.add(shardOf(`${prefix}${String(n).padStart(12, "0")}`));
    }
    expect(shards.size).toBe(HF_SHARD_COUNT);
  });

  it("does not collapse when the ids are all the same length", () => {
    const counts = new Array<number>(HF_SHARD_COUNT).fill(0);
    for (let n = 0; n < 4_000; n += 1) counts[shardOf(randomUUID())]! += 1;
    const expected = 4_000 / HF_SHARD_COUNT;
    for (const count of counts) {
      expect(count).toBeGreaterThan(expected * 0.5);
      expect(count).toBeLessThan(expected * 1.5);
    }
  });
});
