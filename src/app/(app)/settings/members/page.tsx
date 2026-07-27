import type { Metadata } from "next";
import { headers } from "next/headers";

import { ALL_MEMBERS, auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { requireOrgContext } from "@/lib/session";

import { InviteMemberDialog } from "./invite-member-dialog";
import { InvitationsList } from "./invitations-list";
import { MembersTable } from "./members-table";

export const metadata: Metadata = { title: "Members — Vigil" };

export default async function MembersPage() {
  const ctx = await requireOrgContext();
  const org = await auth.api.getFullOrganization({
    // Without an explicit limit the member join stops at 100 and the
    // table would silently omit everyone after that.
    query: { membersLimit: ALL_MEMBERS },
    headers: await headers(),
  });

  const members = (org?.members ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    userId: m.userId,
    name: m.user.name,
    email: m.user.email,
    image: m.user.image ?? null,
  }));

  const pendingInvitations = (org?.invitations ?? [])
    .filter((invitation) => invitation.status === "pending")
    .map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role ?? "viewer",
      expiresAt: invitation.expiresAt,
    }));

  const canManageMembers = hasPermission(ctx.role, {
    member: ["update", "delete"],
  });
  const canInvite = hasPermission(ctx.role, { invitation: ["create"] });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {members.length} {members.length === 1 ? "member" : "members"}
        </p>
        {canInvite && <InviteMemberDialog isOwner={ctx.role === "owner"} />}
      </div>

      <MembersTable
        members={members}
        currentUserId={ctx.userId}
        canManage={canManageMembers}
        isOwner={ctx.role === "owner"}
      />

      {pendingInvitations.length > 0 && (
        <InvitationsList
          invitations={pendingInvitations}
          canCancel={canInvite}
        />
      )}
    </div>
  );
}
