import { describe, expect, it } from "vitest";

import {
  canonicalize,
  factHash,
  verifyChain,
  type FactInput,
} from "@/modules/ledger/chain";
import { decodeHlc, encodeHlc, hlcToDate, nextHlc } from "@/modules/ledger/hlc";

describe("hybrid logical clock", () => {
  it("round-trips a physical time and a counter", () => {
    const hlc = encodeHlc(1_800_000_000_000, 42);
    expect(decodeHlc(hlc)).toEqual({
      physicalMs: 1_800_000_000_000,
      counter: 42,
    });
  });

  it("survives a wall-clock value past 2^53 once shifted", () => {
    // The reason this is a bigint: 1.8e12 << 16 is ~1.2e17, well past
    // Number.MAX_SAFE_INTEGER. A number here would silently lose bits.
    const hlc = encodeHlc(1_800_000_000_000, 1);
    expect(hlc > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("advances the physical part when time moves on", () => {
    const first = nextHlc(0n, 1000);
    const second = nextHlc(first, 2000);
    expect(decodeHlc(second)).toEqual({ physicalMs: 2000, counter: 0 });
    expect(second > first).toBe(true);
  });

  it("advances the counter within one millisecond", () => {
    const first = nextHlc(0n, 1000);
    const second = nextHlc(first, 1000);
    const third = nextHlc(second, 1000);
    expect(decodeHlc(third)).toEqual({ physicalMs: 1000, counter: 2 });
    expect(third > second).toBe(true);
  });

  it("never goes backwards when the host clock does", () => {
    // NTP correcting a drifted server is ordinary, and a clock that can
    // move backwards makes the chain's ordering a lie.
    const first = nextHlc(0n, 5000);
    const afterStep = nextHlc(first, 1000);
    expect(afterStep > first).toBe(true);
    expect(decodeHlc(afterStep).physicalMs).toBe(5000);
  });

  it("borrows a millisecond rather than wrapping the counter", () => {
    const saturated = encodeHlc(1000, 65_535);
    const next = nextHlc(saturated, 1000);
    expect(decodeHlc(next)).toEqual({ physicalMs: 1001, counter: 0 });
    expect(next > saturated).toBe(true);
  });

  it("reports the instant it was issued at", () => {
    expect(hlcToDate(encodeHlc(1_700_000_000_000, 3)).getTime()).toBe(
      1_700_000_000_000,
    );
  });
});

describe("canonicalize", () => {
  it("sorts keys so property order cannot change a hash", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("sorts at every depth", () => {
    expect(canonicalize({ x: { b: 1, a: 2 } })).toBe(
      canonicalize({ x: { a: 2, b: 1 } }),
    );
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("drops undefined so an absent key and an undefined one agree", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });
});

function fact(overrides: Partial<FactInput> = {}): FactInput {
  return {
    actorId: "actor-1",
    seq: 1n,
    hlc: encodeHlc(1000, 0),
    prevHash: null,
    kind: "observation",
    subject: "monitor-1",
    specVersion: 1,
    claim: { verdict: "up" },
    ...overrides,
  };
}

function chain(count: number): (FactInput & { hash: string })[] {
  const facts: (FactInput & { hash: string })[] = [];
  let prevHash: string | null = null;
  for (let i = 0; i < count; i++) {
    const input = fact({
      seq: BigInt(i + 1),
      hlc: encodeHlc(1000 + i, 0),
      prevHash,
      claim: { verdict: "up", n: i },
    });
    const hash = factHash(input);
    facts.push({ ...input, hash });
    prevHash = hash;
  }
  return facts;
}

describe("factHash", () => {
  it("is stable across runs", () => {
    expect(factHash(fact())).toBe(factHash(fact()));
  });

  it("changes when any part of the fact changes", () => {
    const base = factHash(fact());
    expect(factHash(fact({ claim: { verdict: "down" } }))).not.toBe(base);
    expect(factHash(fact({ seq: 2n }))).not.toBe(base);
    expect(factHash(fact({ specVersion: 2 }))).not.toBe(base);
    expect(factHash(fact({ prevHash: "abc" }))).not.toBe(base);
    expect(factHash(fact({ actorId: "actor-2" }))).not.toBe(base);
  });
});

describe("verifyChain", () => {
  it("accepts a well-formed chain", () => {
    expect(verifyChain(chain(5))).toEqual({ valid: true });
  });

  it("accepts an empty chain", () => {
    expect(verifyChain([])).toEqual({ valid: true });
  });

  it("catches an edited claim", () => {
    const facts = chain(4);
    facts[2] = { ...facts[2]!, claim: { verdict: "up", n: 99 } };
    expect(verifyChain(facts)).toMatchObject({
      valid: false,
      index: 2,
      reason: "content does not match its hash",
    });
  });

  it("catches a removed link", () => {
    const facts = chain(4);
    facts.splice(1, 1);
    expect(verifyChain(facts)).toMatchObject({
      valid: false,
      index: 1,
      reason: "prev_hash does not match",
    });
  });

  it("catches a clock that did not advance", () => {
    const facts = chain(3);
    const stalled = { ...facts[2]!, hlc: facts[1]!.hlc };
    facts[2] = { ...stalled, hash: factHash(stalled) };
    expect(verifyChain(facts)).toMatchObject({
      valid: false,
      reason: "clock did not advance",
    });
  });

  it("catches a gap in the sequence", () => {
    const facts = chain(3);
    const skipped = { ...facts[2]!, seq: 9n };
    facts[2] = { ...skipped, hash: factHash(skipped) };
    expect(verifyChain(facts)).toMatchObject({
      valid: false,
      reason: "sequence is not contiguous",
    });
  });
});
