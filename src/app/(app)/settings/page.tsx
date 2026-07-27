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
import { hasPermission } from "@/lib/permissions";
import { requireOrgContext } from "@/lib/session";

import { DangerZone } from "./danger-zone";
import { OrganizationForm } from "./organization-form";
import { ProfileForm } from "./profile-form";

export const metadata: Metadata = { title: "Settings — Vigil" };

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
