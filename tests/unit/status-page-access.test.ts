import { describe, expect, it } from "vitest";

import {
  hashStatusPagePassword,
  signStatusPageUnlock,
  signSubscriptionToken,
  statusPageUnlockCookie,
  verifyStatusPagePassword,
  verifyStatusPageUnlock,
  verifySubscriptionToken,
} from "@/modules/status-pages/access";

describe("status page password hashing", () => {
  it("verifies the correct password and rejects wrong ones", () => {
    const hash = hashStatusPagePassword("hunter2");
    expect(verifyStatusPagePassword("hunter2", hash)).toBe(true);
    expect(verifyStatusPagePassword("Hunter2", hash)).toBe(false);
    expect(verifyStatusPagePassword("", hash)).toBe(false);
  });

  it("salts — the same password hashes differently each time", () => {
    expect(hashStatusPagePassword("x")).not.toBe(hashStatusPagePassword("x"));
  });

  it("rejects against a null or malformed hash", () => {
    expect(verifyStatusPagePassword("x", null)).toBe(false);
    expect(verifyStatusPagePassword("x", "not-a-hash")).toBe(false);
  });
});

describe("status page unlock token", () => {
  it("round-trips for the right page id and rejects others", () => {
    const token = signStatusPageUnlock("page-1");
    expect(verifyStatusPageUnlock("page-1", token)).toBe(true);
    expect(verifyStatusPageUnlock("page-2", token)).toBe(false);
    expect(verifyStatusPageUnlock("page-1", undefined)).toBe(false);
    expect(verifyStatusPageUnlock("page-1", "short")).toBe(false);
  });

  it("scopes the cookie name to the page", () => {
    expect(statusPageUnlockCookie("abc")).toBe("sp_unlock_abc");
  });
});

describe("subscription token", () => {
  it("round-trips the subscriber id", () => {
    const id = "0192f000-1111-2222-3333-444455556666";
    const token = signSubscriptionToken(id);
    expect(verifySubscriptionToken(token)).toBe(id);
  });

  it("rejects a tampered id, bad signature, or missing token", () => {
    const id = "sub-1";
    const token = signSubscriptionToken(id);
    const [, sig] = token.split(".");
    // Swap the id but keep the signature — must not verify.
    expect(verifySubscriptionToken(`sub-2.${sig}`)).toBeNull();
    expect(verifySubscriptionToken("sub-1.deadbeef")).toBeNull();
    expect(verifySubscriptionToken("no-dot")).toBeNull();
    expect(verifySubscriptionToken(undefined)).toBeNull();
  });

  it("does not collide with the unlock token scheme", () => {
    // An unlock token is a bare HMAC (no id prefix) — never a valid sub token.
    expect(verifySubscriptionToken(signStatusPageUnlock("page-1"))).toBeNull();
  });
});
