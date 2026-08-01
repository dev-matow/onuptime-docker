import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins/organization";
import { asc, eq } from "drizzle-orm";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { MULTI_ORG, mayCreateOrganization } from "@/lib/editions";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ac, roles } from "@/lib/permissions";
import { sendEmail } from "@/modules/notifications";
import {
  renderPasswordResetEmail,
  renderPasswordResetNoAccountEmail,
} from "@/modules/notifications/email-templates";
import type { DeliveryOutcome } from "@/modules/notifications/outbox";

/**
 * Pass this to every `getFullOrganization` call that renders members.
 *
 * There are two separate caps in better-auth's organization plugin, and
 * lifting one does not lift the other: `membershipLimit` (below) governs
 * the join's *user* lookup and the add/accept guards, while the member
 * join itself falls back to 100 unless the caller supplies `membersLimit`.
 * A page that omits it shows 100 members out of however many exist, with
 * nothing on screen to say the list was cut short.
 */
export const ALL_MEMBERS = Number.MAX_SAFE_INTEGER;

/** How long a reset link stays usable. better-auth's own default, stated. */
const RESET_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * Password routes a read-only demo must not expose.
 *
 * `/api/demo` signs every visitor in as the seeded viewer using the
 * password published on our own sales pages. One visitor changing it —
 * by reset or by change — takes the demo down for everybody else, and
 * nothing in the product would say why. Sign-up is already disabled in
 * demo mode for the same reason; these are the rest of the doors.
 */
const DEMO_BLOCKED_PASSWORD_PATHS = new Set([
  "/request-password-reset",
  "/reset-password",
  "/change-password",
  "/set-password",
]);

/**
 * What the transport said about a reset email, parked per request.
 *
 * better-auth invokes `sendResetPassword` through
 * `runInBackgroundOrAwait`, which awaits it and then swallows whatever
 * it threw into a log line; the endpoint returns 200 regardless. So
 * throwing is necessary but not sufficient — on its own it leaves the
 * UI telling somebody to check an inbox nothing was sent to. The
 * outcome is left here and collected by the `after` hook below, the
 * last point that can still change the response.
 *
 * Keyed on the request object better-auth threads through both, so
 * concurrent resets cannot read each other's outcome, and weak so a
 * request that never reaches the hook takes its entry with it.
 */
const resetEmailOutcomes = new WeakMap<Request, DeliveryOutcome>();

async function deliverResetEmail(
  to: string,
  rendered: { subject: string; text: string; html: string },
): Promise<DeliveryOutcome> {
  return sendEmail({
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });
}

export const auth = betterAuth({
  appName: "Vigil",
  baseURL: env.APP_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    // Read-only demo deployments accept only the seeded accounts.
    disableSignUp: env.DEMO_MODE,
    resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_SECONDS,
    /**
     * People reset a password when they suspect the account is no
     * longer only theirs. Leaving the sessions that suspicion is about
     * signed in would defeat the whole exercise.
     *
     * The rows go immediately; a browser holding one does not. The
     * cookie cache below is trusted for its `maxAge` without a session
     * lookup, so an already-open session survives up to five more
     * minutes. Both screens that offer a password change say so rather
     * than promising an eviction that has not happened yet.
     */
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }, request) => {
      const outcome = await deliverResetEmail(
        user.email,
        renderPasswordResetEmail({
          resetUrl: url,
          expiresInMinutes: RESET_TOKEN_TTL_SECONDS / 60,
        }),
      );
      if (request) resetEmailOutcomes.set(request, outcome);
      if (outcome.status === "delivered") return;
      // Thrown as well as parked: a caller reaching this through
      // `auth.api` has no request to park it on, and a silent failure
      // there would be the same lie one layer down.
      throw new Error(`reset email not sent: ${outcome.error}`);
    },
  },
  session: {
    // Cuts a session-table read per request; better-auth refreshes the
    // cookie when the session (e.g. active organization) changes.
    cookieCache: { enabled: true, maxAge: 300 },
  },
  rateLimit: {
    enabled: true,
    /**
     * `/reset-password` is the one credential-setting route better-auth
     * leaves on the global default (10s / 100), because its own special
     * rules name `/sign-in`, `/sign-up`, `/change-password` and
     * `/request-password-reset` and stop there. 100 attempts every ten
     * seconds is a shape meant for reads, not for a route that sets a
     * password. The GET callback the email link actually points at is
     * left alone deliberately — it consumes nothing, and mail scanners
     * and prefetching clients hit it before the human does.
     */
    customRules: {
      "/reset-password": { window: 60, max: 5 },
    },
  },
  trustedOrigins: [env.APP_URL],
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!env.DEMO_MODE) return;
      if (!DEMO_BLOCKED_PASSWORD_PATHS.has(ctx.path)) return;
      throw new APIError("FORBIDDEN", {
        message: "Password changes are disabled in the live demo.",
        code: "DEMO_MODE",
      });
    }),
    /**
     * Makes `/request-password-reset` tell the truth about delivery,
     * and keeps its answer the same for an address that exists and one
     * that does not.
     *
     * Both halves are the same mechanism. better-auth returns early for
     * an unknown address without calling `sendResetPassword`, so the
     * absence of a parked outcome *is* how this hook knows the account
     * was not found — no second lookup, nothing to drift. It then sends
     * the address its own explanation, which means every request makes
     * exactly one send attempt and reports exactly one outcome. Skip
     * that send and a broken mail provider becomes an account oracle:
     * known addresses error, unknown ones succeed.
     */
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/request-password-reset") return;
      // The endpoint itself failed — a rejected `redirectTo`, most
      // likely. There is no delivery to be honest about.
      if (isAPIError(ctx.context.returned)) return;

      const request: Request | undefined = ctx.request;
      // The HTTP route is the only way the product reaches this
      // endpoint, and the only caller that carries a request to
      // correlate the send with. A direct `auth.api` call — no request,
      // nothing to key on — gets better-auth's behaviour unchanged
      // rather than a guess about which branch it took.
      if (!request) return;

      let outcome = resetEmailOutcomes.get(request);
      resetEmailOutcomes.delete(request);

      if (!outcome) {
        const address: unknown = ctx.body?.email;
        if (typeof address !== "string") return;
        outcome = await deliverResetEmail(
          address,
          renderPasswordResetNoAccountEmail({ appUrl: env.APP_URL }),
        );
      }

      if (outcome.status === "delivered") return;
      // The provider's own words go to the log, never to the browser:
      // they carry recipient and account detail, and the person at the
      // form can act on none of it.
      logger.error(
        { outcome: outcome.status, err: outcome.error },
        "password reset email was not sent",
      );
      throw new APIError("BAD_GATEWAY", {
        message:
          "Vigil could not send the reset email, so none was sent. The reason is in the server log — tell whoever runs this install, then try again.",
        code: "RESET_EMAIL_NOT_SENT",
      });
    }),
  },
  databaseHooks: {
    session: {
      create: {
        // New sessions land in the user's oldest organization so the
        // dashboard never renders without a tenant context.
        before: async (session) => {
          const membership = await db.query.member.findFirst({
            where: eq(schema.member.userId, session.userId),
            orderBy: [asc(schema.member.createdAt)],
            columns: { organizationId: true },
          });
          return {
            data: {
              ...session,
              activeOrganizationId: membership?.organizationId ?? null,
            },
          };
        },
      },
    },
  },
  plugins: [
    organization({
      ac,
      roles,
      creatorRole: "owner",
      /**
       * No seat cap. Vigil is bought once per company, not per user, so a
       * limit here would be an artificial one — and better-auth's default
       * is 100, which bites twice: `createInvitation` refuses beyond it,
       * and `getFullOrganization`/`listMembers` silently *truncate* the
       * member list to it (the Members page would show 100 of 200 with no
       * indication). Both read this option as a plain number, so a
       * function form would not lift the truncation.
       */
      membershipLimit: Number.MAX_SAFE_INTEGER,
      allowUserToCreateOrganization: async () =>
        mayCreateOrganization({
          demoMode: env.DEMO_MODE,
          multiOrg: MULTI_ORG,
          hasAnyOrganization: Boolean(
            await db.query.organization.findFirst({ columns: { id: true } }),
          ),
        }),
      sendInvitationEmail: async ({ email, organization: org, id }) => {
        await sendEmail({
          to: email,
          subject: `You've been invited to ${org.name} on Vigil`,
          text: `Accept the invitation: ${env.APP_URL}/invitations/${id}`,
        });
      },
    }),
    // Must stay last: rewrites Set-Cookie for Next.js server actions.
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
