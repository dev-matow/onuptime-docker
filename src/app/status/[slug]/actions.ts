"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { db } from "@/db";
import {
  actionOk,
  actionError,
  toActionError,
  type ActionResult,
} from "@/lib/action-result";
import { env } from "@/lib/env";
import { checkRateLimit } from "@/lib/rate-limit";
import { renderSubscriptionConfirmEmail } from "@/modules/notifications/email-templates";
import { sendEmail } from "@/modules/notifications";
import {
  signStatusPageUnlock,
  statusPageUnlockCookie,
} from "@/modules/status-pages/access";
import {
  getStatusPageAccess,
  unlockStatusPage,
} from "@/modules/status-pages/service";
import {
  normalizeEmail,
  subscribeToStatusPage,
} from "@/modules/status-pages/subscribers";

/**
 * Verifies a status page's shared password. On success, mints an HMAC
 * unlock cookie scoped to the page and reloads; on failure, bounces back
 * with `?e=1` so the form can show an error. No session required — this
 * is the public, password-gated surface.
 */
export async function unlockStatusPageAction(
  slug: string,
  formData: FormData,
): Promise<void> {
  const password = String(formData.get("password") ?? "");
  const pageId = password ? await unlockStatusPage(db, slug, password) : null;

  if (!pageId) {
    redirect(`/status/${encodeURIComponent(slug)}?e=1`);
  }

  const store = await cookies();
  store.set(statusPageUnlockCookie(pageId), signStatusPageUnlock(pageId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: `/status/${slug}`,
    maxAge: 60 * 60 * 12,
  });
  redirect(`/status/${encodeURIComponent(slug)}`);
}

const subscribeSchema = z.object({ email: z.email().max(254) });

/**
 * Subscribes an email to a public status page (double opt-in: this only
 * records a pending row and sends the confirmation link). Public and
 * unauthenticated, so it is rate-limited per address and only serves
 * published, public pages. The response is deliberately the same whether
 * or not the address is new, so it can't be used to probe subscribers.
 */
export async function subscribeToStatusPageAction(
  slug: string,
  input: unknown,
): Promise<ActionResult> {
  try {
    const parsed = subscribeSchema.safeParse(input);
    if (!parsed.success) {
      return actionError("Enter a valid email address.");
    }
    const email = normalizeEmail(parsed.data.email);

    // Cap attempts per address so the confirmation email can't be weaponised.
    if (!checkRateLimit(`sp-subscribe:${email}`, { limit: 3, windowMs: 3_600_000 })) {
      return actionError("Too many attempts. Try again later.");
    }

    const access = await getStatusPageAccess(db, slug);
    if (!access || access.visibility !== "public") {
      // Don't reveal whether the page exists; just report generic success.
      return actionOk(undefined);
    }

    const result = await subscribeToStatusPage(db, access.id, email);
    if (!result.alreadyConfirmed) {
      const confirmUrl = `${env.APP_URL}/status/${encodeURIComponent(slug)}/confirm?token=${result.token}`;
      const page = await getStatusPageName(db, access.id);
      await sendEmail({
        to: email,
        ...renderSubscriptionConfirmEmail({ pageName: page, confirmUrl }),
      });
    }
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

async function getStatusPageName(
  database: typeof db,
  statusPageId: string,
): Promise<string> {
  const page = await database.query.statusPages.findFirst({
    where: (t, { eq }) => eq(t.id, statusPageId),
    columns: { name: true },
  });
  return page?.name ?? "status page";
}
