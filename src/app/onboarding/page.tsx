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
import { requireSession } from "@/lib/session";

import { CreateOrganizationForm } from "./create-organization-form";

export const metadata: Metadata = { title: "Create organization · Vigil" };

export default async function OnboardingPage(props: PageProps<"/onboarding">) {
  const session = await requireSession();
  const searchParams = await props.searchParams;
  // `?new=1` lets an existing member create an additional organization.
  if (session.session.activeOrganizationId && !searchParams.new) {
    redirect("/dashboard");
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
