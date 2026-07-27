import { createHash } from "node:crypto";

/**
 * Per-actor hash chains.
 *
 * Per-actor, not one global chain, and that is the whole design
 * decision. A global chain needs a serialisation point — every writer
 * queueing behind one lock — which is exactly what edge autonomy
 * forbids. Git made the same call: objects are content-addressed, refs
 * impose order.
 *
 * This is tamper-*evidence*, not tamper-proofing. A signature proves an
 * actor said something, never that reality matched. `signatures[]` is a
 * collection precisely so an independent counter-signer can later raise
 * a claim from "Vigil says" to "two parties who do not trust each other
 * agree".
 */

export interface FactInput {
  actorId: string;
  seq: bigint;
  hlc: bigint;
  /** Head of the actor's chain before this fact; null for the first. */
  prevHash: string | null;
  /** What kind of fact this is: `observation` or `decision`. */
  kind: "observation" | "decision";
  /** What the fact is about — a monitor id, an incident id. */
  subject: string;
  /** The spec version the fact was produced under, when it has one. */
  specVersion: number | null;
  /** The fact's content: measured facts, or an intent and its outcome. */
  claim: unknown;
}

/**
 * Deterministic JSON: object keys sorted at every depth.
 *
 * Without this the hash depends on property insertion order, so the
 * same fact hashes differently depending on which code path built it,
 * and the chain becomes unverifiable by anything but the exact build
 * that wrote it.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
  return `{${entries.join(",")}}`;
}

export function factHash(input: FactInput): string {
  return createHash("sha256")
    .update(
      canonicalize({
        actorId: input.actorId,
        seq: input.seq.toString(),
        hlc: input.hlc.toString(),
        prevHash: input.prevHash,
        kind: input.kind,
        subject: input.subject,
        specVersion: input.specVersion,
        claim: input.claim,
      }),
    )
    .digest("hex");
}

/**
 * Recomputes a chain and reports the first link that does not hold.
 *
 * There is no verification *infrastructure* yet — no key rotation, no
 * trust roots, no CLI — and deliberately so: write the fields, and
 * build the verifier when somebody actually verifies. This function is
 * the seam that makes that later work additive, and the CI test that
 * proves the chain the worker writes is well-formed.
 */
export function verifyChain(
  facts: readonly (FactInput & { hash: string })[],
): { valid: true } | { valid: false; index: number; reason: string } {
  let expectedPrev: string | null = null;
  let expectedSeq: bigint | null = null;
  let previousHlc: bigint | null = null;

  for (const [index, fact] of facts.entries()) {
    if (expectedPrev !== null && fact.prevHash !== expectedPrev) {
      return { valid: false, index, reason: "prev_hash does not match" };
    }
    if (expectedSeq !== null && fact.seq !== expectedSeq) {
      return { valid: false, index, reason: "sequence is not contiguous" };
    }
    if (previousHlc !== null && fact.hlc <= previousHlc) {
      return { valid: false, index, reason: "clock did not advance" };
    }
    if (factHash(fact) !== fact.hash) {
      return { valid: false, index, reason: "content does not match its hash" };
    }
    expectedPrev = fact.hash;
    expectedSeq = fact.seq + 1n;
    previousHlc = fact.hlc;
  }

  return { valid: true };
}
