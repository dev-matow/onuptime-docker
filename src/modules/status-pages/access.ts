import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import { env } from "@/lib/env";

/**
 * Password protection for status pages, kept pure so it is unit-tested
 * without a database. Passwords are scrypt-hashed (`salt:hash` hex);
 * a successful entry is remembered with an HMAC unlock token that only
 * the server can mint, scoped to the page id.
 */

const KEY_LEN = 64;

export function hashStatusPagePassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyStatusPagePassword(
  password: string,
  stored: string | null,
): boolean {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  let actual: Buffer;
  try {
    actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Cookie name for a page's unlock token. */
export function statusPageUnlockCookie(pageId: string): string {
  return `sp_unlock_${pageId}`;
}

/** Server-minted proof that the password was entered correctly. */
export function signStatusPageUnlock(pageId: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(pageId)
    .digest("hex");
}

export function verifyStatusPageUnlock(
  pageId: string,
  token: string | undefined,
): boolean {
  if (!token) return false;
  const expected = signStatusPageUnlock(pageId);
  if (expected.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

/**
 * Subscription links carry a self-authenticating token: the subscriber id
 * plus an HMAC of it. The server can confirm/unsubscribe from the token
 * alone — no guessable ids in URLs, and no extra table of secrets.
 */
function subscriptionHmac(subscriberId: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(`subscribe:${subscriberId}`)
    .digest("hex");
}

export function signSubscriptionToken(subscriberId: string): string {
  return `${subscriberId}.${subscriptionHmac(subscriberId)}`;
}

/** Returns the subscriber id iff the token's signature is valid. */
export function verifySubscriptionToken(
  token: string | undefined,
): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const subscriberId = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = subscriptionHmac(subscriberId);
  if (expected.length !== signature.length) return null;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    ? subscriberId
    : null;
}
