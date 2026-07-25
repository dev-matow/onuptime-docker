import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { Logo } from "@/components/logo";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { getSession } from "@/lib/session";

import { AcceptInvitationCard } from "./accept-invitation-card";

export const metadata: Metadata = { title: "Invitation — Vigil" };

export default async function InvitationPage(
  props: PageProps<"/invitations/[id]">,
) {
  const { id } = await props.params;
  const session = await getSession();
  if (!session) redirect(`/sign-in?redirect=/invitations/${id}`);

  let invitation;
  try {
    invitation = await auth.api.getInvitation({
      headers: await headers(),
      query: { id },
    });
  } catch {
    invitation = null;
  }

  return (
    <div className="bg-muted/40 flex min-h-svh flex-col items-center justify-center gap-6 p-4">
      <Logo />
      {invitation ? (
        <AcceptInvitationCard
          invitationId={id}
          organizationName={invitation.organizationName}
          role={invitation.role}
        />
      ) : (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Invitation unavailable</CardTitle>
            <CardDescription>
              This invitation doesn&apos;t exist, has expired, or was sent to a
              different email address than the one you&apos;re signed in with.
            </CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
      )}
    </div>
  );
}
