import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins/organization";
import { asc, eq } from "drizzle-orm";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { env } from "@/lib/env";
import { ac, roles } from "@/lib/permissions";
import { sendEmail } from "@/modules/notifications";

/**
 * There are two separate caps in better-auth's organization plugin, and
 * lifting one does not lift the other: `membershipLimit` (below) governs
 * the join's *user* lookup, while the member join itself falls back to
 * 100 unless the caller supplies `membersLimit`. Measured against
 * better-auth 1.6: a 132-member organization comes back with exactly 100
 * members and nothing on screen to say the list was cut short.
 */
export const ALL_MEMBERS = Number.MAX_SAFE_INTEGER;

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
  },
  session: {
    // Cuts a session-table read per request; better-auth refreshes the
    // cookie when the session (e.g. active organization) changes.
    cookieCache: { enabled: true, maxAge: 300 },
  },
  rateLimit: {
    enabled: true,
  },
  trustedOrigins: [env.APP_URL],
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
       * No seat cap. Vigil is free here and bought once per company in the
       * commercial edition — never per user — so a limit would be an
       * artificial one, and better-auth's default is 100.
       *
       * What that default actually breaks, measured against better-auth
       * 1.6 rather than assumed: the *user* lookup inside the member join.
       * Without this option a 132-member organization throws "User not
       * found for member" instead of returning a short list. It reads as a
       * plain number, so a function form would not lift it.
       *
       * It does NOT gate `createInvitation` in this version — inviting
       * past 100 succeeds with or without it. And it does not lift the
       * separate `membersLimit` truncation; see ALL_MEMBERS above.
       */
      membershipLimit: Number.MAX_SAFE_INTEGER,
      // Vigil Core is single-tenant: the first sign-up creates the one
      // organization for this install, and everyone else joins it by
      // invitation. (Running many client organizations side by side is
      // what the commercial edition adds.)
      allowUserToCreateOrganization: async () => {
        if (env.DEMO_MODE) return false;
        const existing = await db.query.organization.findFirst({
          columns: { id: true },
        });
        return !existing;
      },
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

/**
 * The only way this codebase reads an organization's member list.
 *
 * `membersLimit` is easy to forget and impossible to notice when it is
 * missing — the page renders 100 rows and looks correct. Keeping the one
 * call behind a function means there is a single place to get it wrong
 * and a single place for a test to hold it right.
 */
export function getOrganizationWithAllMembers(
  headers: Headers,
  organizationId?: string,
) {
  return auth.api.getFullOrganization({
    headers,
    query: {
      membersLimit: ALL_MEMBERS,
      ...(organizationId && { organizationId }),
    },
  });
}
