import { and, count, eq, isNotNull, isNull } from "drizzle-orm";

import type { DbClient } from "@/db";
import { statusPages, statusPageSubscribers } from "@/db/schema";

import { signSubscriptionToken, verifySubscriptionToken } from "./access";

export type StatusPageSubscriber = typeof statusPageSubscribers.$inferSelect;

/** Lowercased, trimmed — the address we store and dedupe on. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface SubscribeResult {
  subscriberId: string;
  /** Signed token for the confirmation/unsubscribe links. */
  token: string;
  /** True when this address was already confirmed — skip the resend. */
  alreadyConfirmed: boolean;
}

/**
 * Records a pending subscription (or returns the existing one). The
 * caller emails the confirmation link built from the returned token.
 * Idempotent per (page, email): re-subscribing a pending address just
 * re-issues its link; an already-confirmed address is a no-op.
 */
export async function subscribeToStatusPage(
  db: DbClient,
  statusPageId: string,
  rawEmail: string,
): Promise<SubscribeResult> {
  const email = normalizeEmail(rawEmail);

  const existing = await db.query.statusPageSubscribers.findFirst({
    where: and(
      eq(statusPageSubscribers.statusPageId, statusPageId),
      eq(statusPageSubscribers.email, email),
    ),
  });
  if (existing) {
    return {
      subscriberId: existing.id,
      token: signSubscriptionToken(existing.id),
      alreadyConfirmed: existing.confirmedAt !== null,
    };
  }

  const [created] = await db
    .insert(statusPageSubscribers)
    .values({ statusPageId, email })
    .returning({ id: statusPageSubscribers.id });
  if (!created) throw new Error("subscriber insert returned no row");
  return {
    subscriberId: created.id,
    token: signSubscriptionToken(created.id),
    alreadyConfirmed: false,
  };
}

export interface SubscriptionPage {
  email: string;
  slug: string;
  pageName: string;
}

/**
 * Confirms a subscription from its signed token (idempotent). Returns the
 * subscriber's email and page for the confirmation screen, or null when
 * the token is invalid or the row is gone.
 */
export async function confirmSubscription(
  db: DbClient,
  token: string | undefined,
): Promise<SubscriptionPage | null> {
  const subscriberId = verifySubscriptionToken(token);
  if (!subscriberId) return null;

  const row = await db
    .select({
      email: statusPageSubscribers.email,
      confirmedAt: statusPageSubscribers.confirmedAt,
      slug: statusPages.slug,
      pageName: statusPages.name,
    })
    .from(statusPageSubscribers)
    .innerJoin(
      statusPages,
      eq(statusPages.id, statusPageSubscribers.statusPageId),
    )
    .where(eq(statusPageSubscribers.id, subscriberId))
    .limit(1);
  const found = row[0];
  if (!found) return null;

  if (!found.confirmedAt) {
    await db
      .update(statusPageSubscribers)
      .set({ confirmedAt: new Date() })
      .where(eq(statusPageSubscribers.id, subscriberId));
  }
  return { email: found.email, slug: found.slug, pageName: found.pageName };
}

/**
 * Removes a subscription from its signed token (idempotent). Returns the
 * page details for the confirmation screen, or null when invalid.
 */
export async function unsubscribeByToken(
  db: DbClient,
  token: string | undefined,
): Promise<SubscriptionPage | null> {
  const subscriberId = verifySubscriptionToken(token);
  if (!subscriberId) return null;

  const [deleted] = await db
    .delete(statusPageSubscribers)
    .where(eq(statusPageSubscribers.id, subscriberId))
    .returning({
      email: statusPageSubscribers.email,
      statusPageId: statusPageSubscribers.statusPageId,
    });
  if (!deleted) return null;

  const page = await db.query.statusPages.findFirst({
    where: eq(statusPages.id, deleted.statusPageId),
    columns: { slug: true, name: true },
  });
  return {
    email: deleted.email,
    slug: page?.slug ?? "",
    pageName: page?.name ?? "",
  };
}

export interface ConfirmedSubscriber {
  id: string;
  email: string;
}

/** Confirmed and pending subscriber counts for the operator's overview. */
export async function countStatusPageSubscribers(
  db: DbClient,
  statusPageId: string,
): Promise<{ confirmed: number; pending: number }> {
  const [confirmed, pending] = await Promise.all([
    db
      .select({ n: count() })
      .from(statusPageSubscribers)
      .where(
        and(
          eq(statusPageSubscribers.statusPageId, statusPageId),
          isNotNull(statusPageSubscribers.confirmedAt),
        ),
      ),
    db
      .select({ n: count() })
      .from(statusPageSubscribers)
      .where(
        and(
          eq(statusPageSubscribers.statusPageId, statusPageId),
          isNull(statusPageSubscribers.confirmedAt),
        ),
      ),
  ]);
  return { confirmed: confirmed[0]?.n ?? 0, pending: pending[0]?.n ?? 0 };
}

/** Confirmed subscribers of a page — the people an incident email pages. */
export async function listConfirmedSubscribers(
  db: DbClient,
  statusPageId: string,
): Promise<ConfirmedSubscriber[]> {
  const rows = await db
    .select({
      id: statusPageSubscribers.id,
      email: statusPageSubscribers.email,
    })
    .from(statusPageSubscribers)
    .where(
      and(
        eq(statusPageSubscribers.statusPageId, statusPageId),
        isNotNull(statusPageSubscribers.confirmedAt),
      ),
    );
  return rows;
}
