import type { DbClient } from "@/db";

import type { Monitor } from "./service";

/**
 * The seam between a check that produces evidence and the caller that
 * stores it.
 *
 * Two functions with a deliberately dull shape, and the shape is the
 * point. A check type may return {@link ProbeResult.evidence} that no
 * `FactBag` could hold - today a scripted synthetic's run, tomorrow
 * something else - and the layers that own database writes are the ones
 * that must persist it. Those layers are Core code: `manual-run.ts` is
 * the "check it now" button, which every edition has.
 *
 * So the branch lives here, inside a marked block, and in the free
 * edition each function collapses to `return null` and `return`. That is
 * cheaper than the alternatives and much safer than the one that looks
 * cheapest: threading a nullable id through Core code with a `let` that
 * only the commercial build assigns leaves a binding eslint's
 * `prefer-const` rejects in the edition nobody is looking at.
 */

export interface EvidenceActor {
  organizationId: string;
  userId: string | null;
}

/**
 * Claims a record for this evaluation, when the type keeps one.
 *
 * Returns null for every type that does not, which is all of them in
 * Core and thirty-eight of forty-two in the commercial build.
 */
export async function openEvidence(
  db: DbClient,
  monitor: Monitor,
  actor: EvidenceActor,
  trigger: "manual" | "recovery",
): Promise<string | null> {
  // Every other type's observation IS its record: one row in
  // `monitor_checks`, judged by the same engine, with its facts. There
  // is nothing extra to open.
  return null;
}

/** Stores what the check returned, against the record opened above. */
export async function recordEvidence(
  db: DbClient,
  runId: string | null,
  evidence: unknown,
): Promise<void> {
  if (runId === null) return;
}
