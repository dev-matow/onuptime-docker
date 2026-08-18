import { and, eq, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { notificationIntents } from "@/db/schema";
import { logger } from "@/lib/logger";

import { dispatchToChannels } from "./channel-service";
import { askSuppression } from "./dispatch-policy";
import { eventSeverity } from "./events";
import { enqueueMemberEmails } from "./incident-emails";
import {
  pendingIntentsSql,
  type DispatchIntentPayload,
  type IntentRow,
} from "./intents";
import { enqueueSubscriberEmails } from "./subscriber-emails";
import type { WebhookEvent } from "./webhook";

const log = logger.child({ module: "intent-expansion" });

/**
 * Turning a committed intent into outbox rows.
 *
 * Everything expensive about a notification lives here — resolving
 * channel routes, listing members, walking status pages, inserting a row
 * per recipient — and none of it is inside the transaction that changed
 * the incident. That is the whole trade: the deciding transaction writes
 * one row and commits; this runs afterwards, can fail, and is simply
 * retried.
 *
 * Expansion is idempotent because every row it writes carries a key
 * derived from the cause, and the outbox's unique index is the arbiter.
 * Re-expanding after a crash inserts whatever is missing and nothing
 * else, at any point in the sequence — so a worker killed after
 * enqueueing the channels but before the emails loses the emails for as
 * long as it takes another worker to notice the intent is still pending,
 * and loses them permanently never.
 */

/**
 * How many failed expansions retire an intent.
 *
 * An expansion touches nothing but this database, so a failure is a bug,
 * a schema problem or an outage — never a provider. Ten is generous for
 * the outage case and short enough that a genuinely poisoned payload
 * stops being retried every minute forever, which is the failure mode
 * that turned one bad row into a permanently red queue in 1.18.0.
 */
const MAX_EXPANSION_ATTEMPTS = 10;

/** Default sweep size. Each intent is a handful of statements, and the
 * tick that runs it also has a delivery batch to get to. */
const EXPANSION_BATCH = 50;

export interface ExpansionResult {
  /** Intents turned into outbox rows this pass. */
  expanded: number;
  /** Outbox rows created. Zero with a non-zero `expanded` is normal —
   * an organization with no channels, no responders and no subscribers
   * owes real notifications to nobody. */
  queued: number;
  /** Intents that failed this pass and will be retried. */
  retried: number;
  /** Intents retired after `MAX_EXPANSION_ATTEMPTS`. Never normal. */
  failed: number;
}

/**
 * Expands one intent's payload inside the caller's transaction.
 *
 * Order is channels, then the responder page, then the public audience,
 * and it is the order the rows are delivered in for as long as nothing
 * fails: they are inserted with the same `next_attempt_at`, and the fair
 * ranking breaks that tie on `id`, which `uuidv7()` makes monotonic. It
 * is a tendency, not a guarantee — a retry reorders it, and nothing in
 * the product depends on the order, because every message states its own
 * event rather than implying it from what arrived before.
 */
async function expandPayload(
  tx: DbClient,
  organizationId: string,
  incidentId: string | null,
  payload: DispatchIntentPayload,
): Promise<number> {
  let queued = 0;
  for (const dispatch of payload.dispatches) {
    queued += await dispatchToChannels(tx, {
      organizationId,
      event: dispatch.event as WebhookEvent,
      causeKey: dispatch.causeKey,
      subject: dispatch.subject,
      detail: dispatch.detail,
      ...(dispatch.url ? { url: dispatch.url } : {}),
      data: dispatch.data,
      monitorType: dispatch.monitorType ?? null,
      monitorId: dispatch.monitorId ?? null,
      incidentId,
    });
  }

  // The two audiences `dispatchToChannels` cannot speak for.
  //
  // Channel routing is a per-channel decision and lives in that
  // function; the responder email and the status-page audience are
  // neither channels nor routable, so a policy that silences an outage
  // has to be asked about them separately or it silences a third of the
  // notification and looks like it worked. The question is the same one,
  // asked with this audience's own event.
  const subjectMonitor = payload.dispatches.find(
    (dispatch) => dispatch.monitorId,
  );
  const monitorId =
    subjectMonitor?.monitorId ?? payload.subscribers?.monitorId ?? null;
  const monitorType = subjectMonitor?.monitorType ?? null;

  if (payload.memberEmail) {
    const suppressed = await askSuppression(tx, {
      organizationId,
      event: payload.memberEmail.event,
      causeKey: payload.memberEmail.causeKey,
      monitorId,
      monitorType,
      incidentId,
      severity: eventSeverity(payload.memberEmail.event),
    });
    if (!suppressed) {
      queued += await enqueueMemberEmails(
        tx,
        organizationId,
        payload.memberEmail,
      );
    }
  }

  if (payload.subscribers) {
    const event = SUBSCRIBER_EVENT[payload.subscribers.kind];
    const suppressed = await askSuppression(tx, {
      organizationId,
      event,
      causeKey: payload.subscribers.causeKey,
      monitorId,
      monitorType,
      incidentId,
      severity: eventSeverity(event),
    });
    if (!suppressed) {
      queued += await enqueueSubscriberEmails(
        tx,
        organizationId,
        payload.subscribers,
      );
    }
  }
  return queued;
}

/** The public lifecycle event each subscriber mailing corresponds to.
 * Held here rather than on the payload because it is the same mapping
 * `intents.ts` inverted to build it, and two copies would drift. */
const SUBSCRIBER_EVENT: Record<
  "opened" | "updated" | "resolved",
  WebhookEvent
> = {
  opened: "incident.opened",
  updated: "incident.updated",
  resolved: "incident.resolved",
};

/**
 * One intent, in one transaction: lock it, write its rows, mark it
 * expanded. All three or none.
 *
 * The lock is `FOR UPDATE SKIP LOCKED` and the state is re-checked under
 * it, so two workers reaching the same intent do not both expand it and
 * neither waits out the other's transaction. A crash anywhere inside
 * rolls the whole thing back and leaves the intent pending, which is the
 * correct state for it: nothing was queued, so nothing is owed twice.
 */
async function expandOne(
  db: DbClient,
  intentId: string,
): Promise<{ expanded: boolean; queued: number }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(notificationIntents)
      .where(
        and(
          eq(notificationIntents.id, intentId),
          eq(notificationIntents.state, "pending"),
        ),
      )
      .for("update", { skipLocked: true });
    if (!row) return { expanded: false, queued: 0 };

    const queued = await expandPayload(
      tx,
      row.organizationId,
      row.incidentId,
      row.payload as unknown as DispatchIntentPayload,
    );

    await tx
      .update(notificationIntents)
      .set({
        state: "expanded",
        // The database's clock, like every other timestamp in this
        // subsystem: a worker whose clock is behind must not be able to
        // stamp an expansion before the transition that caused it.
        expandedAt: sql`now()`,
        lastError: null,
      })
      .where(
        and(
          eq(notificationIntents.id, row.id),
          eq(notificationIntents.state, "pending"),
        ),
      );
    return { expanded: true, queued };
  });
}

/**
 * Records a failed expansion in its own transaction, because the one it
 * failed in has already rolled back.
 *
 * The attempt is counted HERE rather than at the claim — the opposite of
 * the outbox rule, and for the opposite reason. An outbox attempt may
 * have reached a provider before the worker died, so it has to be spent
 * before anyone knows. An expansion that died committed nothing at all,
 * so charging it would retire an intent that never got a chance.
 */
async function recordExpansionFailure(
  db: DbClient,
  row: Pick<IntentRow, "id" | "attempts">,
  error: unknown,
): Promise<"retried" | "failed"> {
  const attempts = row.attempts + 1;
  const retire = attempts >= MAX_EXPANSION_ATTEMPTS;
  const message = error instanceof Error ? error.message : String(error);
  await db
    .update(notificationIntents)
    .set({
      attempts,
      lastError: message.slice(0, 2_000),
      ...(retire ? { state: "failed" as const } : {}),
    })
    .where(eq(notificationIntents.id, row.id));
  return retire ? "failed" : "retried";
}

/**
 * The sweep. Called by the delivery tick and, scoped to one
 * organization, inline right after a transition commits so an alert
 * leaves within a second instead of on the next minute.
 *
 * Never throws: one poisoned intent must not stop the others, and this
 * runs on a path that must not be able to fail a server action.
 */
export async function expandPendingIntents(
  db: DbClient,
  options: { organizationId?: string; limit?: number } = {},
): Promise<ExpansionResult> {
  const result: ExpansionResult = {
    expanded: 0,
    queued: 0,
    retried: 0,
    failed: 0,
  };
  let due: { id: string; attempts: number }[];
  try {
    const rows = await db.execute<{ id: string; attempts: number }>(
      pendingIntentsSql(
        options.limit ?? EXPANSION_BATCH,
        options.organizationId,
      ),
    );
    due = rows.rows;
  } catch (error) {
    log.error({ err: error }, "could not read pending dispatch intents");
    return result;
  }

  for (const intent of due) {
    try {
      const outcome = await expandOne(db, intent.id);
      if (outcome.expanded) {
        result.expanded++;
        result.queued += outcome.queued;
      }
    } catch (error) {
      log.error(
        { err: error, intentId: intent.id },
        "dispatch intent expansion failed",
      );
      try {
        const outcome = await recordExpansionFailure(db, intent, error);
        result[outcome]++;
        if (outcome === "failed") {
          log.error(
            { intentId: intent.id },
            "dispatch intent retired unexpanded; notifications for it were never queued",
          );
        }
      } catch (bookkeeping) {
        // The database is refusing writes. Nothing is lost - the intent
        // is still pending and the next tick tries again.
        log.error(
          { err: bookkeeping, intentId: intent.id },
          "could not record an expansion failure",
        );
      }
    }
  }
  return result;
}
