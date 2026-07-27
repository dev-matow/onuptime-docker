import os from "node:os";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { monitors } from "@/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { askAlertHold, askIncidentOpened } from "@/modules/incidents/hooks";
import {
  claimIncidentNotification,
  openMonitorIncident,
  recordSystemEvent,
  resolveMonitorIncidents,
  type Incident,
} from "@/modules/incidents/service";
import { ensureActor } from "@/modules/ledger/service";
import { performCheck } from "@/modules/monitors/check";
import { recordCheckOutcome, type Monitor } from "@/modules/monitors/service";
import { toCheckSpec } from "@/modules/monitors/spec";
import {
  notifyIncidentOpened,
  notifyIncidentResolved,
} from "@/modules/notifications/incident-emails";
import { notifyStatusPageSubscribers } from "@/modules/notifications/subscriber-emails";
import { sendIncidentWebhook } from "@/modules/notifications/webhook-service";

import { QUEUES, type MonitorCheckJob } from "../queues";

const log = logger.child({ job: "monitor-check" });

export interface MonitorCheckDeps {
  boss?: {
    send: (name: string, data: object, options?: object) => Promise<unknown>;
  };
  fetchImpl?: typeof fetch;
  allowPrivateTargets?: boolean;
  /** Overrides the ledger identity this replica writes under. */
  actorId?: string;
}

interface Enqueuer {
  send: (name: string, data: object, options?: object) => Promise<unknown>;
}

/**
 * This replica's ledger identity. One actor per worker process, so each
 * replica keeps its own chain and its own sequence — which is exactly
 * why the chains are per-actor: adding a replica adds a chain instead
 * of adding contention to one.
 */
function workerActorId(): Promise<string> {
  const name =
    process.env.VIGIL_ACTOR_NAME ?? process.env.HOSTNAME ?? os.hostname();
  return ensureActor(db, "worker", name);
}

/**
 * Renders a hold deadline for the incident timeline. Operators read this
 * line while an outage is open, so the deadline is stated in the entry
 * rather than left implicit in whatever scheduled it — a hold with no
 * visible expiry is indistinguishable from silence.
 */
function describeDelay(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  return `${Math.round(minutes / 60)} hours`;
}

/** The cron tick's period. pg-boss's cron floor is 60s by construction. */
const TICK_PERIOD_MS = 60_000;

/**
 * The sub-minute path.
 *
 * The scheduling policy can ask for the next evaluation sooner than the
 * next tick — that is the whole point of tightening on a suspicious
 * monitor. pg-boss's cron cannot fire faster than once a minute, so
 * when the policy asks for sooner, the check enqueues its own
 * follow-up. The queue's `stately` policy with the monitor id as
 * singleton key means this can never race the tick into a double probe:
 * whichever arrives second is dropped.
 *
 * The floor this delivers is pg-boss's job poll interval — a couple of
 * seconds — which is comfortably below the shortest interval an operator
 * can configure, so a 10s monitor really is checked every 10s. Going
 * faster than that is the 2.0 scheduler's job.
 */
async function scheduleFastFollowUp(
  monitor: Monitor,
  boss: Enqueuer | undefined,
): Promise<void> {
  if (!boss || monitor.paused || monitor.nextEvaluationAt === null) return;
  if (monitor.nextEvaluationAt.getTime() - Date.now() >= TICK_PERIOD_MS) return;

  await boss.send(
    QUEUES.monitorCheck,
    { monitorId: monitor.id } satisfies MonitorCheckJob,
    { singletonKey: monitor.id, startAfter: monitor.nextEvaluationAt },
  );
}

/**
 * Webhooks, subscribers and the human page for a newly opened monitor
 * incident. Callers must hold the `notifiedAt` claim
 * (claimIncidentNotification) so this fires exactly once per incident.
 *
 * `pagedElsewhere` is how an edition takes over reaching a person — an
 * on-call ladder scheduled by an incident handler pages on its own
 * timetable, and the responder email must not also go out. Default false
 * is the safe direction: when in doubt, someone is emailed.
 */
export async function sendOpenedNotifications(
  incident: Incident,
  monitor: Monitor,
  pagedElsewhere = false,
): Promise<void> {
  await sendIncidentWebhook(db, { event: "monitor.down", incident, monitor });
  await sendIncidentWebhook(db, {
    event: "incident.opened",
    incident,
    monitor,
  });
  await notifyStatusPageSubscribers(db, { incident, kind: "opened" });
  if (!pagedElsewhere) {
    await notifyIncidentOpened(db, incident, monitor);
  }
}

/**
 * Runs one monitor's probe and applies the consequences: persist the
 * check, advance monitor state, open or resolve incidents, and notify.
 *
 * What happens *beyond* notifying is not this function's business. It
 * asks the incident-handler registry two questions and acts on the
 * answers; whether an edition holds the page while it tries a restart,
 * or routes it up an on-call ladder, is that edition's registration.
 *
 * Never throws for per-monitor problems — the next tick re-enqueues, so
 * a retry here would only double-probe a struggling target. Handlers
 * cannot break that either: the registry swallows their failures.
 */
export async function runMonitorCheck(
  monitorId: string,
  deps: MonitorCheckDeps = {},
): Promise<void> {
  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, monitorId),
  });
  if (!monitor || monitor.paused) return;

  const outcome = await performCheck(toCheckSpec(monitor), {
    allowPrivateTargets:
      deps.allowPrivateTargets ?? env.ALLOW_PRIVATE_MONITOR_TARGETS,
    fetchImpl: deps.fetchImpl,
  });

  const { monitor: updated, reconciliation } = await recordCheckOutcome(
    db,
    monitor,
    outcome,
    { actorId: deps.actorId ?? (await workerActorId()) },
  );

  log.debug(
    {
      monitorId,
      verdict: outcome.verdict,
      statusCode: outcome.statusCode,
      responseTimeMs: outcome.responseTimeMs,
      status: updated.currentStatus,
    },
    "check completed",
  );

  // Level-triggered: act on what is true now, not on what just changed.
  // `openMonitorIncident` returns null when one is already open and
  // `resolveMonitorIncidents` returns nothing when there is none, so
  // running these every check converges rather than duplicating — and a
  // monitor that somehow ended up down with no incident repairs itself
  // instead of staying wrong until someone notices.
  if (reconciliation.openIncident) {
    const incident = await openMonitorIncident(
      db,
      updated,
      outcome.error ?? "check failed",
    );
    if (incident) {
      log.warn({ monitorId, incidentId: incident.id }, "incident opened");

      const ctx = {
        db,
        incident,
        monitor: updated,
        boss: deps.boss,
      };

      // Two questions, and this file asks nothing else. With no handler
      // registered — the free edition — the answers are "no hold" and
      // "nothing scheduled", and the incident pages exactly as it would
      // have before any of this existed.
      const held = await askAlertHold(ctx);
      const scheduled = await askIncidentOpened({ ...ctx, held });

      if (held) {
        await recordSystemEvent(
          db,
          incident.id,
          `${held.reason} Operators will be alerted no later than ` +
            `${describeDelay(held.deadlineSeconds)} from now.`,
        );
      } else {
        await claimIncidentNotification(db, incident.id);
        await sendOpenedNotifications(incident, updated, scheduled.pagesAHuman);
      }

      log.info(
        {
          monitorId,
          incidentId: incident.id,
          held: Boolean(held),
          pagesAHuman: scheduled.pagesAHuman,
        },
        "incident handlers answered",
      );
    }
  } else if (reconciliation.resolveIncidents) {
    const resolved = await resolveMonitorIncidents(db, updated);
    for (const incident of resolved) {
      log.info(
        { monitorId, incidentId: incident.id },
        "incident auto-resolved",
      );
      // An incident nobody was alerted about (quiet recovery) resolves
      // quietly too — the timeline and recovery record still tell all.
      if (!incident.notifiedAt) continue;
      await notifyIncidentResolved(db, incident, updated);
      await sendIncidentWebhook(db, {
        event: "monitor.up",
        incident,
        monitor: updated,
      });
      await sendIncidentWebhook(db, {
        event: "incident.resolved",
        incident,
        monitor: updated,
      });
      await notifyStatusPageSubscribers(db, { incident, kind: "resolved" });
    }
  }

  await scheduleFastFollowUp(updated, deps.boss);
}
