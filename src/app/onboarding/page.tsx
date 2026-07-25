import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Logo } from "@/components/logo";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { db } from "@/db";
import { requireSession } from "@/lib/session";

import { CreateOrganizationForm } from "./create-organization-form";

export const metadata: Metadata = { title: "Create organization — Vigil" };

export default async function OnboardingPage() {
  const session = await requireSession();
  if (session.session.activeOrganizationId) {
    redirect("/dashboard");
  }

  // Core runs one organization per install. If it already exists, this
  // account was created without an invitation and has nowhere to go.
  const existing = await db.query.organization.findFirst({
    columns: { name: true },
  });
  if (existing) {
    return (
      <div className="bg-muted/40 flex min-h-svh flex-col items-center justify-center gap-6 p-4">
        <Logo />
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>This install is already set up</CardTitle>
            <CardDescription>
              {existing.name} is already running on this Vigil. Ask an
              administrator to invite you — you&apos;ll get an email with a link
              that adds you to the team.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="bg-muted/40 flex min-h-svh flex-col items-center justify-center gap-6 p-4">
      <Logo />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create your organization</CardTitle>
          <CardDescription>
            Monitors, incidents and your status page live inside an
            organization. You can invite your team afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateOrganizationForm />
        </CardContent>
      </Card>
    </div>
  );
}
