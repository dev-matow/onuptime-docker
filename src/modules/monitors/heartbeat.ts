import { and, eq, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { monitorHeartbeats, monitors } from "@/db/schema";
import { env } from "@/lib/env";

import type { HeartbeatReport } from "./types/contract";

/**
 * Receiving a heartbeat, and doing nothing else.
 *
 * This is the whole write that `/api/push/<token>` performs. It looks
 * thin on purpose. The endpoint is unauthenticated by construction —
 * possession of the token is the authentication — and every extra
 * consequence attached to it becomes something a leaked token can make
 * Vigil do to its own operators: write ledger rows, resolve incidents,
 * send email. So the arrival updates one row of current state, and the
 * scheduled evaluation (which is rate-governed, actor-stamped and
 * identical for every passive monitor) turns that state into an
 * observation.
 *
 * The cost is that a recovery is seen at the next evaluation rather
 * than the instant the beat lands. That is exactly how an active
 * monitor behaves, and it is the truth in any case: a job that reports
 * every five minutes cannot be known to be healthy any sooner.
 */

/**
 * Where a job sends its heartbeat.
 *
 * Built from `APP_URL` rather than from the request, because the
 * operator copies this into a crontab on another machine: a URL derived
 * from whatever host header the browser happened to use would work in
 * the browser and fail from the box that actually calls it.
 */
export function pushEndpointUrl(token: string): string {
  return new URL(`/api/push/${token}`, env.APP_URL).toString();
}

/** What a caller may say about itself, mirrored from Uptime Kuma's API. */
export interface HeartbeatArrival {
  status: "up" | "down";
  message: string | null;
  responseTimeMs: number | null;
}

export interface PushTarget {
  monitorId: string;
  organizationId: string;
  paused: boolean;
}

/**
 * The monitor a token belongs to, or null.
 *
 * Matched against the config blob through the unique partial index
 * migration 0017 creates, so this is one index lookup and cannot return
 * two rows. Filtering on `check_type` as well as on the token is not
 * redundant: the index only covers push monitors, and without the
 * predicate Postgres is free to satisfy the query by sequential scan and
 * match a `token` key that some future type happens to store too.
 */
export async function findMonitorByPushToken(
  db: DbClient,
  token: string,
): Promise<PushTarget | null> {
  if (token.length === 0) return null;
  const [row] = await db
    .select({
      monitorId: monitors.id,
      organizationId: monitors.organizationId,
      paused: monitors.paused,
    })
    .from(monitors)
    .where(
      and(
        eq(monitors.checkType, "push"),
        sql`${monitors.config} ->> 'token' = ${token}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Records an arrival, replacing whatever the previous one said. */
export async function recordHeartbeat(
  db: DbClient,
  monitorId: string,
  arrival: HeartbeatArrival,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(monitorHeartbeats)
    .values({
      monitorId,
      receivedAt: now,
      reportedStatus: arrival.status,
      message: arrival.message,
      responseTimeMs: arrival.responseTimeMs,
    })
    // Last one wins. A history of beats is what `monitor_checks` is
    // for; this table answers one question — "when did it last check
    // in" — and a second row would only ever be read to find the first.
    .onConflictDoUpdate({
      target: monitorHeartbeats.monitorId,
      set: {
        receivedAt: now,
        reportedStatus: arrival.status,
        message: arrival.message,
        responseTimeMs: arrival.responseTimeMs,
      },
    });
}

export interface StoredHeartbeat {
  receivedAt: Date;
  report: HeartbeatReport;
}

/** The last heartbeat, in the shape a passive type's `observe` reads. */
export async function lastHeartbeat(
  db: DbClient,
  monitorId: string,
): Promise<StoredHeartbeat | null> {
  const row = await db.query.monitorHeartbeats.findFirst({
    where: eq(monitorHeartbeats.monitorId, monitorId),
  });
  if (!row) return null;
  return {
    receivedAt: row.receivedAt,
    report: {
      // Stored as text so a value a later version adds is data rather
      // than a failed cast; anything that is not an explicit failure is
      // read as the caller saying it is fine, which is what a bare
      // `curl` of the endpoint means.
      status: row.reportedStatus === "down" ? "down" : "up",
      message: row.message,
      responseTimeMs: row.responseTimeMs,
    },
  };
}
