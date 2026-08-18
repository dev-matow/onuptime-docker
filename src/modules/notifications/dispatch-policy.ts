import type { DbClient } from "@/db";
import { logger } from "@/lib/logger";

import type { MessageSeverity } from "./events";
import type { WebhookEvent } from "./webhook";

/**
 * The seam between deciding a notification is owed and deciding where it
 * goes — or whether it goes at all.
 *
 * Modelled on `modules/incidents/hooks.ts`, deliberately and down to the
 * shape: behaviour is data in a list, an edition registers into it, and
 * what `strip-ee` removes is a registration rather than a branch. With
 * nothing registered — which is exactly what Core is — both questions
 * answer "no opinion", and `dispatchToChannels` resolves routes from the
 * channel subscriptions and enqueues them, byte for byte as it did
 * before this file existed.
 *
 * TWO QUESTIONS, and they are different questions rather than one with a
 * flag. "May anything go out about this?" is answered for a whole
 * transition and covers the responder email and the status-page audience
 * as well as the channels; "which channels?" is answered per event and
 * covers only the channels. Folding them together would have made the
 * suppression of a member email a special case of channel routing, which
 * it is not.
 *
 * A policy that throws degrades toward SENDING: not suppressed, default
 * routing. That direction is not arbitrary. The failure mode of a broken
 * routing policy should be an alert in the wrong room, never an outage
 * nobody heard about.
 */

/** Everything a policy is allowed to know about one dispatch. */
export interface DispatchSubject {
  organizationId: string;
  event: WebhookEvent;
  /** The logical cause; also the outbox key prefix. */
  causeKey: string;
  /** The monitor this is about, or null for an event about none. */
  monitorId: string | null;
  /** Check type id, for the expiry carve-out. */
  monitorType: string | null;
  /** The incident this is about, when there is one. */
  incidentId: string | null;
  /** As `eventSeverity` computes it: critical | warning | ok | info. */
  severity: MessageSeverity;
}

/** "No, and here is the sentence an operator will read." */
export interface Suppression {
  reason: string;
}

export interface RouteSelection {
  /**
   * The channels to enqueue for, in order — or null for "no opinion",
   * which falls through to the channel subscriptions.
   *
   * An empty ARRAY is not the same as null and the difference is the
   * whole point: it means a policy governs this monitor and decided
   * nothing should be sent, which is a configuration, not an absence of
   * one.
   */
  channelIds: string[] | null;
  /**
   * Called once with the number of outbox rows the selection actually
   * produced, inside the caller's transaction, so a policy can write its
   * own evidence knowing what happened rather than what it intended.
   */
  record(queued: number): Promise<void>;
}

export interface DispatchPolicy {
  name: string;
  /** May anything at all go out about this? */
  suppression?(
    db: DbClient,
    subject: DispatchSubject,
  ): Promise<Suppression | null>;
  /** Which channels should receive this event? */
  routes?(
    db: DbClient,
    subject: DispatchSubject,
  ): Promise<RouteSelection | null>;
}

const log = logger.child({ module: "dispatch-policy" });
const policies: DispatchPolicy[] = [];

export function registerDispatchPolicy(policy: DispatchPolicy): void {
  policies.push(policy);
}

/** Test seam. Registration is process-global; suites must start clean. */
export function resetDispatchPolicies(): void {
  policies.length = 0;
}

export function registeredDispatchPolicies(): readonly string[] {
  return policies.map((policy) => policy.name);
}

async function safely<T>(
  policyName: string,
  question: string,
  fallback: T,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    log.error(
      { err: error, policy: policyName, question },
      "dispatch policy threw; falling back to sending",
    );
    return fallback;
  }
}

/**
 * Question one. The first policy with an opinion wins, and there is no
 * composition rule — two policies disagreeing about whether to silence
 * an outage is a configuration nobody can predict, and "the strongest
 * wins" would let a broken one mute the product.
 */
export async function askSuppression(
  db: DbClient,
  subject: DispatchSubject,
): Promise<Suppression | null> {
  for (const policy of policies) {
    if (!policy.suppression) continue;
    const answer = await safely(policy.name, "suppression", null, () =>
      policy.suppression!(db, subject),
    );
    if (answer) return answer;
  }
  return null;
}

/** Question two, same rule. */
export async function askRoutes(
  db: DbClient,
  subject: DispatchSubject,
): Promise<RouteSelection | null> {
  for (const policy of policies) {
    if (!policy.routes) continue;
    const answer = await safely(policy.name, "routes", null, () =>
      policy.routes!(db, subject),
    );
    if (answer) return answer;
  }
  return null;
}
