import { and, eq, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { notificationIntents } from "@/db/schema";
import { env } from "@/lib/env";

import {
  renderIncidentOpenedEmail,
  renderIncidentResolvedEmail,
} from "./email-templates";
import {
  incidentDispatch,
  type IntentDispatch,
  type WebhookIncident,
  type WebhookMonitor,
} from "./incident-payload";
import type { WebhookEvent } from "./webhook";

/**
 * Recording that a transition owes notifications, in the transaction
 * that made the transition.
 *
 * The rule this file exists to enforce is one line long: **nothing may
 * commit an incident state change and then work out who to tell.** Every
 * path did exactly that. `applyOutcome` opened an incident, committed,
 * claimed `notified_at` in a second transaction, committed again, and
 * only then resolved channel routes, fetched members, walked status
 * pages and inserted outbox rows. A process that died anywhere in that
 * tail left an incident that was open, marked notified, and silent - and
 * because the claim is exactly-once and had already been spent, no later
 * check, no repair pass and no operator action would ever page for it.
 *
 * An intent closes the window by moving the only I/O that has to be
 * atomic - one INSERT - inside the deciding transaction, and leaving
 * everything expensive (route resolution, recipient lookup, N inserts,
 * every provider call) outside it where a failure is a retry rather than
 * a rollback of the incident itself.
 *
 * Deliberately NOT here: any network call, any read of a table the
 * caller's transaction has not already touched, and any rendering that
 * could throw on operator-supplied text. This runs inside a transaction
 * holding a monitor row lock; work added here is work that lock is held
 * across.
 */

/** A member email, rendered at transition time and addressed at
 * expansion time. Recipients are current membership, deliberately: an
 * operator who joined during an outage should hear about its end. */
export interface IntentEmail {
  event: WebhookEvent;
  causeKey: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * The status-page audience. Recipients are resolved at expansion, not
 * stored: a subscriber who confirmed between the outage starting and
 * the intent expanding is a subscriber, and a page that was
 * unpublished in that window is not one.
 */
export interface IntentSubscribers {
  kind: "opened" | "updated" | "resolved";
  causeKey: string;
  incidentId: string;
  incidentTitle: string;
  /** Which monitor this incident belongs to; null for manual ones. */
  monitorId: string | null;
  source: string;
  /** The public update that prompted this, for `updated`. */
  latestUpdate?: string;
}

/** Everything one transition owes, rendered. Expansion turns this into
 * outbox rows and nothing else — it makes no decisions of its own. */
export interface DispatchIntentPayload {
  dispatches: IntentDispatch[];
  memberEmail?: IntentEmail;
  subscribers?: IntentSubscribers;
}

export type IntentRow = typeof notificationIntents.$inferSelect;

/**
 * Writes the intent. Must be called with the caller's transaction, not
 * with `db` — passing the pool would restore the exact window this
 * exists to close, silently.
 *
 * `onConflictDoNothing` on the cause key is what makes re-entry safe: a
 * transaction retried by the driver, a job pg-boss delivered twice, or
 * a repair pass finding an incident nobody acted on all record the same
 * intent once. The caller learns nothing from the return value except
 * whether it was the first, which no caller currently needs.
 */
export async function recordDispatchIntent(
  tx: DbClient,
  input: {
    organizationId: string;
    causeKey: string;
    kind: "incident" | "recovery" | "slo" | "runbook" | "task";
    incidentId?: string | null;
    payload: DispatchIntentPayload;
  },
): Promise<IntentRow | null> {
  if (
    input.payload.dispatches.length === 0 &&
    !input.payload.memberEmail &&
    !input.payload.subscribers
  ) {
    // An intent that owes nothing is a row an operator has to reason
    // about later for no reason. Callers are allowed to build one - it
    // is cheaper than making each of them ask - and this drops it.
    return null;
  }
  const [row] = await tx
    .insert(notificationIntents)
    .values({
      organizationId: input.organizationId,
      causeKey: input.causeKey,
      kind: input.kind,
      incidentId: input.incidentId ?? null,
      payload: input.payload as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: notificationIntents.causeKey })
    .returning();
  return row ?? null;
}

/* ------------------------------------------------------------------ */
/* Payload builders — one per transition the product can make          */
/* ------------------------------------------------------------------ */

/** What a monitor-opened incident owes: two channel events, the status
 * page audience, and the responder email unless an edition is paging
 * humans on its own ladder. */
export function openedIntent(input: {
  incident: WebhookIncident & { monitorId: string | null };
  monitor: WebhookMonitor & { failureWindowSeconds: number };
  monitorTarget: string;
  /**
   * True when an edition has taken over reaching a person — an on-call
   * ladder pages on its own timetable and the responder email must not
   * also go out. Default false is the safe direction: when in doubt,
   * somebody is emailed.
   */
  pagedElsewhere?: boolean;
}): DispatchIntentPayload {
  const { incident, monitor } = input;
  return {
    dispatches: [
      incidentDispatch({ event: "monitor.down", incident, monitor }),
      incidentDispatch({ event: "incident.opened", incident, monitor }),
    ],
    ...(input.pagedElsewhere
      ? {}
      : {
          memberEmail: {
            event: "incident.opened",
            causeKey: `incident:${incident.id}:opened`,
            ...renderIncidentOpenedEmail({
              monitorName: monitor.name,
              monitorUrl: input.monitorTarget,
              failureWindowSeconds: monitor.failureWindowSeconds,
              incidentUrl: `${env.APP_URL}/incidents/${incident.id}`,
            }),
          },
        }),
    subscribers: subscriberTarget(incident, "opened"),
  };
}

/** What an auto-resolved monitor incident owes. Only reached for an
 * incident somebody was actually alerted about — a quiet recovery
 * resolves quietly, and the timeline still tells the whole story. */
export function resolvedIntent(input: {
  incident: WebhookIncident & { monitorId: string | null };
  monitor: WebhookMonitor;
  monitorTarget: string;
}): DispatchIntentPayload {
  const { incident, monitor } = input;
  return {
    dispatches: [
      incidentDispatch({ event: "monitor.up", incident, monitor }),
      incidentDispatch({ event: "incident.resolved", incident, monitor }),
    ],
    memberEmail: {
      event: "incident.resolved",
      causeKey: `incident:${incident.id}:resolved`,
      ...renderIncidentResolvedEmail({
        monitorName: monitor.name,
        monitorUrl: input.monitorTarget,
        incidentUrl: `${env.APP_URL}/incidents/${incident.id}`,
      }),
    },
    subscribers: subscriberTarget(incident, "resolved"),
  };
}

/**
 * What an operator's own action owes: the channel event and, for the
 * public lifecycle events, the status page audience. No member email —
 * the people who would receive it are the people in the room who just
 * did this, and that has been true since the feature was written.
 */
export function operatorIntent(input: {
  incident: WebhookIncident & { monitorId: string | null };
  monitor?: WebhookMonitor;
  event: WebhookEvent;
  /** The timeline entry this transition wrote, for repeatable events. */
  transitionKey?: string;
  latestUpdate?: string;
}): DispatchIntentPayload {
  const kind = SUBSCRIBER_KIND[input.event];
  return {
    dispatches: [
      incidentDispatch({
        event: input.event,
        incident: input.incident,
        ...(input.monitor ? { monitor: input.monitor } : {}),
        ...(input.transitionKey ? { transitionKey: input.transitionKey } : {}),
      }),
    ],
    ...(kind
      ? {
          subscribers: {
            ...subscriberTarget(input.incident, kind, input.transitionKey),
            ...(input.latestUpdate ? { latestUpdate: input.latestUpdate } : {}),
          },
        }
      : {}),
  };
}


/** Which public lifecycle event each channel event corresponds to.
 * `null` means status-page subscribers hear nothing about it. */
const SUBSCRIBER_KIND: Partial<
  Record<WebhookEvent, "opened" | "updated" | "resolved" | null>
> = {
  "incident.opened": "opened",
  "incident.updated": "updated",
  "incident.resolved": "resolved",
};

function subscriberTarget(
  incident: WebhookIncident & { monitorId: string | null },
  kind: "opened" | "updated" | "resolved",
  transitionKey?: string,
): IntentSubscribers {
  return {
    kind,
    // Keyed on the transition for `updated`, for the same reason the
    // channel dispatch is: every update after the first is otherwise
    // the same key, and the outbox drops it.
    causeKey: transitionKey
      ? `incident:${incident.id}:subscribers:${kind}:${transitionKey}`
      : `incident:${incident.id}:subscribers:${kind}`,
    incidentId: incident.id,
    incidentTitle: incident.title,
    monitorId: incident.monitorId,
    source: incident.source,
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/**
 * Pending intents, oldest first. A plain bounded read, deliberately
 * unlocked: the lock that matters is taken per intent, inside the
 * transaction that expands it, because a lock taken here would be
 * released the instant this statement returned and would prove nothing
 * about the transaction that comes next.
 */
export function pendingIntentsSql(limit: number, organizationId?: string) {
  return sql`
    select id, attempts from ${notificationIntents}
    where state = 'pending'
      ${organizationId ? sql`and organization_id = ${organizationId}` : sql``}
    order by created_at, id
    limit ${limit}
  `;
}

/** Retention for expanded intents. Terminal only — a pending intent is
 * work still owed and is never pruned however old it is. */
export async function pruneExpandedIntents(
  db: DbClient,
  olderThan: Date,
  limit = 5_000,
): Promise<number> {
  const rows = await db
    .delete(notificationIntents)
    .where(
      and(
        eq(notificationIntents.state, "expanded"),
        sql`${notificationIntents.createdAt} < ${olderThan}`,
        sql`${notificationIntents.id} in (
          select id from ${notificationIntents}
          where state = 'expanded' and created_at < ${olderThan}
          limit ${limit}
        )`,
      ),
    )
    .returning({ id: notificationIntents.id });
  return rows.length;
}
