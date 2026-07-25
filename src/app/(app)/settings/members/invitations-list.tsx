"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelativeTime } from "@/lib/format";

import { cancelInvitationAction } from "../actions";

interface InvitationRow {
  id: string;
  email: string;
  role: string;
  expiresAt: Date;
}

export function InvitationsList({
  invitations,
  canCancel,
}: {
  invitations: InvitationRow[];
  canCancel: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function cancel(invitationId: string) {
    setBusyId(invitationId);
    const result = await cancelInvitationAction(invitationId);
    setBusyId(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Invitation cancelled");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pending invitations</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {invitations.map((invitation) => (
            <li
              key={invitation.id}
              className="flex items-center justify-between gap-3 py-2"
            >
              <div className="flex items-center gap-3">
                <span className="text-sm">{invitation.email}</span>
                <Badge variant="secondary" className="capitalize">
                  {invitation.role}
                </Badge>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground text-xs">
                  expires {formatRelativeTime(invitation.expiresAt)}
                </span>
                {canCancel && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyId === invitation.id}
                    onClick={() => cancel(invitation.id)}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
