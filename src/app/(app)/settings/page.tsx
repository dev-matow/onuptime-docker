import type { Metadata } from "next";
import { eq } from "drizzle-orm";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { db } from "@/db";
import { organization, user } from "@/db/schema";
import { env } from "@/lib/env";
import { hasPermission } from "@/lib/permissions";
import { requireOrgContext } from "@/lib/session";

import { DangerZone } from "./danger-zone";
import { OrganizationForm } from "./organization-form";
import { PasswordForm } from "./password-form";
import { ProfileForm } from "./profile-form";

export const metadata: Metadata = { title: "Settings · Vigil" };

export default async function GeneralSettingsPage() {
  const ctx = await requireOrgContext();
  const [org, profile] = await Promise.all([
    db.query.organization.findFirst({
      where: eq(organization.id, ctx.organizationId),
      columns: { name: true, slug: true },
    }),
    db.query.user.findFirst({
      where: eq(user.id, ctx.userId),
      columns: { phone: true },
    }),
  ]);

  const canEdit = hasPermission(ctx.role, { organization: ["update"] });
  const canDelete = hasPermission(ctx.role, { organization: ["delete"] });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Your profile</CardTitle>
          <CardDescription>
            Contact details used to page you during incidents.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm phone={profile?.phone ?? ""} />
        </CardContent>
      </Card>

      {/* Hidden on the demo, where every visitor shares one seeded
          account and `src/lib/auth.ts` refuses the route outright. */}
      {!env.DEMO_MODE && (
        <Card>
          <CardHeader>
            <CardTitle>Password</CardTitle>
            <CardDescription>
              Changing it here signs out every other session.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PasswordForm />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Organization</CardTitle>
          <CardDescription>
            Slug: <code className="font-mono text-xs">{org?.slug}</code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OrganizationForm name={org?.name ?? ""} canEdit={canEdit} />
        </CardContent>
      </Card>

      {canDelete && <DangerZone organizationName={org?.name ?? ""} />}
    </div>
  );
}
