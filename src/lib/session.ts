import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { auth } from "@/lib/auth";
import { assertNotDemo } from "@/lib/demo";
import { AuthorizationError } from "@/lib/errors";
import { type Permission, type RoleName, roles } from "@/lib/permissions";

/** Deduplicated per request — layouts and pages can both call this. */
export const getSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

/** Redirects to sign-in when unauthenticated. For pages and layouts. */
export async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
}

export interface OrgContext {
  userId: string;
  organizationId: string;
  role: RoleName;
}

/**
 * Tenant guard: authenticated + active organization + membership role.
 * Every dashboard page and server action resolves its tenant through
 * this, so an organizationId can never leak in from client input.
 */
export const requireOrgContext = cache(async (): Promise<OrgContext> => {
  const session = await requireSession();
  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) redirect("/onboarding");

  const member = await auth.api.getActiveMember({
    headers: await headers(),
  });
  if (!member || member.organizationId !== organizationId) {
    redirect("/onboarding");
  }

  return {
    userId: session.user.id,
    organizationId,
    role: member.role as RoleName,
  };
});

/**
 * Role check against the statically defined role → permission matrix.
 * No extra round trip: the membership row was already loaded by
 * requireOrgContext and the matrix lives in code (src/lib/permissions).
 */
export function assertPermission(role: RoleName, permission: Permission): void {
  const definition = roles[role];
  if (!definition) throw new AuthorizationError();
  const result = definition.authorize(
    permission as Parameters<(typeof roles)["owner"]["authorize"]>[0],
  );
  if (!result.success) throw new AuthorizationError();
}

/**
 * Guard for mutating server actions: authenticated + tenant + role
 * permission, and rejected outright on read-only demo deployments.
 */
export async function requirePermission(
  permission: Permission,
): Promise<OrgContext> {
  assertNotDemo();
  const ctx = await requireOrgContext();
  assertPermission(ctx.role, permission);
  return ctx;
}
