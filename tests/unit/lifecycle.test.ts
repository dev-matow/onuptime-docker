import { describe, expect, it } from "vitest";

import {
  allowedTransitions,
  canTransition,
  isActiveStatus,
  type IncidentStatus,
} from "@/modules/incidents/lifecycle";

const ACTIVE: readonly IncidentStatus[] = [
  "investigating",
  "identified",
  "monitoring",
];

describe("canTransition", () => {
  it("allows free movement between any two distinct active statuses", () => {
    for (const from of ACTIVE) {
      for (const to of ACTIVE) {
        if (from === to) continue;
        expect(canTransition(from, to)).toBe(true);
      }
    }
  });

  it("allows every active status to move to resolved", () => {
    for (const from of ACTIVE) {
      expect(canTransition(from, "resolved")).toBe(true);
    }
  });

  it("treats resolved as terminal — no transition out is allowed", () => {
    for (const to of ACTIVE) {
      expect(canTransition("resolved", to)).toBe(false);
    }
  });

  it("rejects transitions from a status to itself", () => {
    expect(canTransition("investigating", "investigating")).toBe(false);
    expect(canTransition("identified", "identified")).toBe(false);
    expect(canTransition("monitoring", "monitoring")).toBe(false);
    expect(canTransition("resolved", "resolved")).toBe(false);
  });
});

describe("allowedTransitions", () => {
  it("returns every other status for an active status", () => {
    expect(allowedTransitions("investigating")).toEqual([
      "identified",
      "monitoring",
      "resolved",
    ]);
    expect(allowedTransitions("identified")).toEqual([
      "investigating",
      "monitoring",
      "resolved",
    ]);
    expect(allowedTransitions("monitoring")).toEqual([
      "investigating",
      "identified",
      "resolved",
    ]);
  });

  it("returns an empty list for resolved", () => {
    expect(allowedTransitions("resolved")).toEqual([]);
  });

  it("agrees with canTransition for every listed target", () => {
    for (const from of [...ACTIVE, "resolved" as const]) {
      for (const to of allowedTransitions(from)) {
        expect(canTransition(from, to)).toBe(true);
      }
    }
  });
});

describe("isActiveStatus", () => {
  it("returns true for the three active statuses", () => {
    expect(isActiveStatus("investigating")).toBe(true);
    expect(isActiveStatus("identified")).toBe(true);
    expect(isActiveStatus("monitoring")).toBe(true);
  });

  it("returns false for resolved", () => {
    expect(isActiveStatus("resolved")).toBe(false);
  });
});
