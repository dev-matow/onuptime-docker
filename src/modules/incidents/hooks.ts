import type { DbClient } from "@/db";
import { logger } from "@/lib/logger";
import type { Monitor } from "@/modules/monitors/service";

import type { Incident } from "./service";

/**
 * The seam between detecting an incident and acting on one.
 *
 * `monitor-check.ts` does not know that automatic recovery or on-call
 * ladders exist. It asks this registry exactly two questions and gets a
 * truthful answer when nothing is registered — which is what the free
 * edition is: no handlers, so "no" and "nothing", and the incident opens
 * and pages exactly as it always did.
 *
 * Modelled on the check-type registry: behaviour is data in a list, and
 * adding some touches no existing path. What `strip-ee` removes is a
 * registration, not a branch, so Core is left with a meaningful zero
 * rather than a hole where a conditional used to be.
 *
 * TWO QUESTIONS, AND DELIBERATELY NOT THREE. If a third appears, the
 * boundary is in the wrong place — say so rather than adding a method.
 * A general event bus here would stop being a seam and start being a
 * place to hide coupling.
 */

/** Everything a handler is allowed to know about a freshly opened incident. */
export interface OpenedIncident {
  db: DbClient;
  incident: Incident;
  /** The monitor row as it stands after this check. */
  monitor: Monitor;
  /** Absent when the worker has no queue; nothing can be scheduled. */
  boss?: {
    send: (name: string, data: object, options?: object) => Promise<unknown>;
  };
}

/** "Yes, hold the page" — with the deadline that makes it accountable. */
export interface AlertHold {
  /** Why nobody was paged, for the incident timeline. */
  reason: string;
  /** How long the hold may last before a human must hear about it. */
  deadlineSeconds: number;
}

export interface OpenedOutcome {
  /**
   * True when something scheduled here will reach a person, so the
   * default responder email must not also go out. False is the safe
   * answer: it means "page them the ordinary way".
   */
  pagesAHuman: boolean;
}

export interface IncidentHandler {
  name: string;
  /** May this incident's alerts be held, and for how long? */
  alertHold?(ctx: OpenedIncident): Promise<AlertHold | null>;
  /** An incident opened. Anything to schedule? */
  incidentOpened?(
    ctx: OpenedIncident & { held: AlertHold | null },
  ): Promise<OpenedOutcome>;
}

const log = logger.child({ module: "incident-hooks" });
const handlers: IncidentHandler[] = [];

export function registerIncidentHandler(handler: IncidentHandler): void {
  handlers.push(handler);
}

/** Test seam. Registration is process-global; suites must start clean. */
export function resetIncidentHandlers(): void {
  handlers.length = 0;
}

export function registeredIncidentHandlers(): readonly string[] {
  return handlers.map((h) => h.name);
}

/**
 * A handler that throws must never stop the incident opening or the page
 * going out. Automation that breaks paging is the worst thing this
 * system can do, so every failure here degrades to the edition-free
 * behaviour: no hold, no takeover, operators hear about it.
 */
async function safely<T>(
  handlerName: string,
  question: string,
  fallback: T,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    log.error(
      { err: error, handler: handlerName, question },
      "incident handler threw; falling back to paging",
    );
    return fallback;
  }
}

/**
 * Question one. The first handler that wants a hold gets it — holds do
 * not compose, and a "longest wins" rule would let a broken handler
 * silence a page for as long as it liked.
 */
export async function askAlertHold(
  ctx: OpenedIncident,
): Promise<AlertHold | null> {
  for (const handler of handlers) {
    if (!handler.alertHold) continue;
    const hold = await safely(handler.name, "alertHold", null, () =>
      handler.alertHold!(ctx),
    );
    if (hold) return hold;
  }
  return null;
}

/** Question two. Every handler is asked; any one of them may page. */
export async function askIncidentOpened(
  ctx: OpenedIncident & { held: AlertHold | null },
): Promise<OpenedOutcome> {
  let pagesAHuman = false;
  for (const handler of handlers) {
    if (!handler.incidentOpened) continue;
    const outcome = await safely(
      handler.name,
      "incidentOpened",
      { pagesAHuman: false },
      () => handler.incidentOpened!(ctx),
    );
    pagesAHuman ||= outcome.pagesAHuman;
  }
  return { pagesAHuman };
}
