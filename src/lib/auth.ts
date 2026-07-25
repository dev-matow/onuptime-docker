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
