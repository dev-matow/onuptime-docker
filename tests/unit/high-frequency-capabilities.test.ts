import { describe, expect, it } from "vitest";

import {
  highFrequencyCapability,
  HIGH_FREQUENCY_CAPABILITIES,
  HIGH_FREQUENCY_TYPE_IDS,
  HF_MAX_INTERVAL_MS,
  HF_MIN_INTERVAL_MS,
} from "@/modules/monitors/highfreq/capabilities";
import { MIN_INTERVAL_SECONDS } from "@/modules/monitors/schemas";
import { CHECK_TYPE_DESCRIPTORS } from "@/modules/monitors/types/catalog";

describe("high-frequency capability metadata", () => {
  it("answers for every check type the registry knows about", () => {
    const missing = CHECK_TYPE_DESCRIPTORS.filter(
      (descriptor) => !(descriptor.id in HIGH_FREQUENCY_CAPABILITIES),
    ).map((descriptor) => descriptor.id);

    // This is the assertion that makes the map safe to keep outside the
    // descriptor. When it fails, the fix is one entry in
    // `highfreq/capabilities.ts` saying whether the new type may run at
    // 500ms and, if not, why not in one sentence.
    expect(missing).toEqual([]);
  });

  it("names a reason for every type it refuses", () => {
    for (const [id, capability] of Object.entries(
      HIGH_FREQUENCY_CAPABILITIES,
    )) {
      if (capability.supportsHighFrequency) continue;
      expect(capability.excludedBecause, id).toBeTruthy();
      expect(capability.excludedBecause!.length, id).toBeGreaterThan(20);
    }
  });

  it("does not let a refused type claim the sub-second floor", () => {
    for (const [id, capability] of Object.entries(
      HIGH_FREQUENCY_CAPABILITIES,
    )) {
      if (capability.supportsHighFrequency) {
        expect(capability.minimumIntervalMs, id).toBe(HF_MIN_INTERVAL_MS);
      } else {
        expect(capability.minimumIntervalMs, id).toBe(
          MIN_INTERVAL_SECONDS * 1000,
        );
      }
    }
  });

  it("admits only the three cheap probing types", () => {
    expect([...HIGH_FREQUENCY_TYPE_IDS].sort()).toEqual([
      "http",
      "json-query",
      "tcp",
    ]);
  });

  it("treats a check type this build has never heard of as too expensive", () => {
    const capability = highFrequencyCapability("something-from-the-future");
    expect(capability.supportsHighFrequency).toBe(false);
    expect(capability.excludedBecause).toContain("not available in this build");
  });

  it("stops where the ordinary scheduler already delivers the cadence", () => {
    expect(HF_MAX_INTERVAL_MS).toBe(MIN_INTERVAL_SECONDS * 1000);
    expect(HF_MIN_INTERVAL_MS).toBeLessThan(HF_MAX_INTERVAL_MS);
  });
});
