"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

export function AcceptInvitationCard({
  invitationId,
  organizationName,
  role,
}: {
  invitationId: string;
  organizationName: string;
  role: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function accept() {
    setPending(true);
    setError(null);
    const { data, error: acceptError } =
      await authClient.organization.acceptInvitation({ invitationId });

    if (acceptError || !data) {
      setError(acceptError?.message ?? "Unable to accept the invitation.");
      setPending(false);
      return;
    }
    await authClient.organization.setActive({
      organizationId: data.invitation.organizationId,
    });
    router.push("/dashboard");
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Join {organizationName}</CardTitle>
        <CardDescription>
          You&apos;ve been invited as <strong>{role}</strong>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </CardContent>
      <CardFooter>
        <Button onClick={accept} disabled={pending} className="w-full">
          {pending && <Spinner />}
          Accept invitation
        </Button>
      </CardFooter>
    </Card>
  );
}
