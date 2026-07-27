import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins/organization";
import { asc, eq } from "drizzle-orm";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { MULTI_ORG, mayCreateOrganization } from "@/lib/editions";
import { env } from "@/lib/env";
import { ac, roles } from "@/lib/permissions";
import { sendEmail } from "@/modules/notifications";

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
