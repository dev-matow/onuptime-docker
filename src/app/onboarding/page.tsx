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
    <div className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden bg-background px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--primary)_12%,transparent),transparent_68%)]"
      />
      <div className="relative flex w-full max-w-md flex-col items-center gap-8">
        <Logo />
      <Card className="border-border/80 w-full shadow-[0_12px_32px_rgba(16,24,40,0.08)]">
        <CardHeader className="gap-1.5 px-6 pt-1">
          <CardTitle className="text-xl">Create your organization</CardTitle>
          <CardDescription>
            Monitors, incidents and your status page live inside an
            organization. You can invite your team afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-1">
          <CreateOrganizationForm />
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
