import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db";
import { session } from "@/db/schema";
import { auth } from "@/lib/auth";
import {
  sendEmail,
  setEmailTransport,
  type EmailMessage,
} from "@/modules/notifications";
import type { DeliveryOutcome } from "@/modules/notifications/outbox";

/**
 * The reset flow, driven through `auth.handler` rather than `auth.api`.
 *
 * The handler is the HTTP router, and the router is where better-auth's
 * rate limiter lives — an `auth.api` call skips it entirely. Two of the
 * properties under test here (the limiter, and the delivery outcome
 * `src/lib/auth.ts` correlates by request object) only exist on that
 * path, so testing the other one would prove nothing about the product.
 */

const APP_URL = "http://localhost:3000";
const DELIVERED: DeliveryOutcome = {
  status: "delivered",
  providerMessageId: "test",
};

let sent: EmailMessage[] = [];
let outcome: DeliveryOutcome = DELIVERED;

beforeEach(() => {
  sent = [];
  outcome = DELIVERED;
  setEmailTransport(
    {
      async send(message) {
        sent.push(message);
        return outcome;
      },
    },
    "test",
  );
});

afterAll(() => {
  // Restores nothing real — the log transport is what a test process
  // starts with — but leaves the module as it was found.
  setEmailTransport(
    {
      async send() {
        return DELIVERED;
      },
    },
    "log",
  );
});

/**
 * Each caller gets its own address, because the rate limiter buckets by
 * IP and path and better-auth falls back to 127.0.0.1 for every request
 * that carries no forwarded address. Sharing one would make each test
 * depend on how many requests the tests before it happened to make.
 */
function post(path: string, body: unknown, ip: string): Promise<Response> {
  return auth.handler(
    new Request(`${APP_URL}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: APP_URL,
        "x-forwarded-for": ip,
      },
      body: JSON.stringify(body),
    }),
  );
}

interface Account {
  userId: string;
  email: string;
  password: string;
  cookie: string;
}

async function createAccount(): Promise<Account> {
  const suffix = randomUUID().slice(0, 8);
  const email = `reset-${suffix}@example.com`;
  const password = `initial-password-${suffix}`;

  const response = await auth.api.signUpEmail({
    body: { name: `Reset ${suffix}`, email, password },
    asResponse: true,
  });
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-up returned no session cookie");

  const created = await db.query.user.findFirst({
    where: (u, { eq: is }) => is(u.email, email),
    columns: { id: true },
  });
  if (!created) throw new Error("sign-up did not persist a user");

  return {
    userId: created.id,
    email,
    password,
    // Keep only the name=value pairs; a full Set-Cookie string is not a
    // valid Cookie request header.
    cookie: setCookie
      .split(",")
      .map((part) => part.trim().split(";")[0])
      .join("; "),
  };
}

/** The reset token, read back out of the email that carried it. */
function tokenFromLastEmail(): string {
  const message = sent.at(-1);
  if (!message) throw new Error("no email was sent");
  const match = /\/api\/auth\/reset-password\/([^?\s]+)\?/.exec(message.text);
  if (!match?.[1]) throw new Error(`no reset link in: ${message.text}`);
  return match[1];
}

function requestReset(email: string, ip: string): Promise<Response> {
  return post(
    "/request-password-reset",
    { email, redirectTo: "/reset-password" },
    ip,
  );
}

describe("requesting a password reset", () => {
  it("emails a link that sets a new password and revokes the old sessions", async () => {
    const account = await createAccount();
    const newPassword = `replacement-password-${randomUUID().slice(0, 8)}`;

    expect((await requestReset(account.email, "203.0.113.1")).status).toBe(200);
    expect(sent.at(-1)?.to).toBe(account.email);

    const token = tokenFromLastEmail();
    const reset = await post(
      "/reset-password",
      { token, newPassword },
      "203.0.113.1",
    );
    expect(reset.status).toBe(200);

    // Read before signing in again, which would create a session of its
    // own and make the assertion say nothing.
    const survivors = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, account.userId));
    expect(survivors).toHaveLength(0);

    await expect(
      auth.api.signInEmail({
        body: { email: account.email, password: newPassword },
      }),
    ).resolves.toBeTruthy();

    await expect(
      auth.api.signInEmail({
        body: { email: account.email, password: account.password },
      }),
    ).rejects.toThrow();
  });

  /**
   * Characterization, not a requirement. `session.cookieCache` is on, so
   * `getSession` trusts a signed cookie for up to its `maxAge` (300s)
   * without looking the session up — which means the revocation above is
   * immediate in the database and up to five minutes late in a browser
   * that already holds a cookie. The reset screen says exactly that; if
   * better-auth ever revalidates here, the screen should stop saying it.
   */
  it("still honours a cookie issued before the reset until the cache expires", async () => {
    const account = await createAccount();
    await requestReset(account.email, "203.0.113.12");
    await post(
      "/reset-password",
      { token: tokenFromLastEmail(), newPassword: "cache-window-password" },
      "203.0.113.12",
    );

    const cached = await auth.api.getSession({
      headers: new Headers({ cookie: account.cookie }),
    });
    expect(cached?.user.id).toBe(account.userId);

    const revalidated = await auth.api.getSession({
      headers: new Headers({ cookie: account.cookie }),
      query: { disableCookieCache: true },
    });
    expect(revalidated).toBeNull();
  });

  it("validates the token before the browser ever shows the form", async () => {
    const account = await createAccount();
    await requestReset(account.email, "203.0.113.2");
    const token = tokenFromLastEmail();

    const callback = await auth.handler(
      new Request(
        `${APP_URL}/api/auth/reset-password/${token}?callbackURL=%2Freset-password`,
        { headers: { "x-forwarded-for": "203.0.113.2" } },
      ),
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(
      `${APP_URL}/reset-password?token=${token}`,
    );
  });

  it("sends a link that cannot be used twice", async () => {
    const account = await createAccount();
    await requestReset(account.email, "203.0.113.3");
    const token = tokenFromLastEmail();

    const first = await post(
      "/reset-password",
      { token, newPassword: "first-replacement-pw" },
      "203.0.113.3",
    );
    expect(first.status).toBe(200);

    const second = await post(
      "/reset-password",
      { token, newPassword: "second-replacement-pw" },
      "203.0.113.3",
    );
    expect(second.status).toBe(400);
  });

  it("answers a known and an unknown address identically", async () => {
    const account = await createAccount();

    const known = await requestReset(account.email, "203.0.113.4");
    const unknown = await requestReset(
      `nobody-${randomUUID().slice(0, 8)}@example.com`,
      "203.0.113.5",
    );

    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
  });

  it("emails an address that has no account rather than sending nothing", async () => {
    const stranger = `nobody-${randomUUID().slice(0, 8)}@example.com`;

    const response = await requestReset(stranger, "203.0.113.6");

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(stranger);
    expect(sent[0]?.text).toContain("no account uses it");
    // The whole point of sending it: nothing in the message is a reset
    // link, so the address learns nothing about anyone else's account.
    expect(sent[0]?.text).not.toContain("/api/auth/reset-password/");
  });
});

describe("a reset email the transport could not send", () => {
  it("reports the failure instead of claiming an email was sent", async () => {
    const account = await createAccount();
    outcome = { status: "retryable", error: "provider returned 503" };

    const response = await requestReset(account.email, "203.0.113.7");

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("could not send the reset email");
  });

  /**
   * The reason `renderPasswordResetNoAccountEmail` exists. If the
   * unknown-address branch skipped the send, it would keep answering
   * 200 while a broken provider turned every known address into a 502 —
   * and the difference between the two is an account oracle that opens
   * exactly when nobody is watching the mail queue.
   */
  it("fails the same way for an address that has no account", async () => {
    const account = await createAccount();
    outcome = { status: "permanent", error: "recipient rejected" };

    const known = await requestReset(account.email, "203.0.113.8");
    const unknown = await requestReset(
      `nobody-${randomUUID().slice(0, 8)}@example.com`,
      "203.0.113.9",
    );

    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
  });
});

describe("rate limiting", () => {
  /**
   * Characterization of better-auth's own special rule for
   * `/request-password-reset`: three requests per IP per 60 seconds.
   * Pinned here because nothing in `src/lib/auth.ts` sets it — dropping
   * `rateLimit.enabled` would leave the endpoint an open mailer, and
   * this is the test that would say so.
   */
  it("stops a fourth reset request from the same address within the window", async () => {
    const account = await createAccount();
    const ip = "203.0.113.10";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await requestReset(account.email, ip)).status).toBe(200);
    }

    expect((await requestReset(account.email, ip)).status).toBe(429);
  });

  /**
   * `/reset-password` is not covered by better-auth's special rules and
   * would otherwise inherit the global 100-per-10-seconds default, which
   * is a read's allowance on a route that sets a credential.
   * `rateLimit.customRules` in `src/lib/auth.ts` is what this pins.
   */
  it("stops a sixth token attempt from the same address within the window", async () => {
    const ip = "203.0.113.11";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await post(
        "/reset-password",
        { token: `made-up-${attempt}`, newPassword: "irrelevant-password" },
        ip,
      );
      expect(response.status).toBe(400);
    }

    const blocked = await post(
      "/reset-password",
      { token: "made-up-6", newPassword: "irrelevant-password" },
      ip,
    );
    expect(blocked.status).toBe(429);
  });
});

describe("the email transport contract", () => {
  it("reports what the transport said rather than assuming delivery", async () => {
    outcome = { status: "permanent", error: "domain not verified" };

    await expect(
      sendEmail({ to: "someone@example.com", subject: "x", text: "y" }),
    ).resolves.toEqual({ status: "permanent", error: "domain not verified" });
  });

  /**
   * The plain-text part is a genuine fallback, not a stripped copy, so a
   * link present in one and missing from the other is a real failure —
   * and the reset email is the one message in the product that is
   * useless without its link.
   */
  it("carries the reset link in both parts of the message", async () => {
    const account = await createAccount();
    await requestReset(account.email, "203.0.113.13");

    const message = sent.at(-1);
    const link = tokenFromLastEmail();
    expect(message?.text).toContain(link);
    expect(message?.html).toContain(link);
    expect(message?.subject).toBe("Reset your Vigil password");
  });
});
