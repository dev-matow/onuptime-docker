"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { removeMemberAction, updateMemberRoleAction } from "../actions";

interface MemberRow {
  id: string;
  role: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
}

/** Roles assignable from the UI; owner is only offered to owners. */
const ASSIGNABLE_ROLES = ["admin", "responder", "viewer"] as const;

export function MembersTable({
  members,
  currentUserId,
  canManage,
  isOwner,
}: {
  members: MemberRow[];
  currentUserId: string;
  canManage: boolean;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);

  const roleOptions = isOwner
    ? ["owner", ...ASSIGNABLE_ROLES]
    : [...ASSIGNABLE_ROLES];

  async function changeRole(memberId: string, role: string) {
    setBusyMemberId(memberId);
    const result = await updateMemberRoleAction({ memberId, role });
    setBusyMemberId(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Role updated");
    router.refresh();
  }

  async function remove(member: MemberRow) {
    setBusyMemberId(member.id);
    const result = await removeMemberAction(member.id);
    setBusyMemberId(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(`${member.name} removed`);
    router.refresh();
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Member</TableHead>
          <TableHead>Role</TableHead>
          <TableHead className="w-24" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => {
          const isSelf = member.userId === currentUserId;
          const editable = canManage && !isSelf && member.role !== "owner";
          return (
            <TableRow key={member.id}>
              <TableCell>
                <div className="flex items-center gap-3">
                  <Avatar className="size-8">
                    {member.image && <AvatarImage src={member.image} alt="" />}
                    <AvatarFallback>
                      {member.name.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid leading-tight">
                    <span className="font-medium">
                      {member.name}
                      {isSelf && (
                        <span className="text-muted-foreground"> (you)</span>
                      )}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {member.email}
                    </span>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                {editable ? (
                  <Select
                    value={member.role}
                    onValueChange={(role) => changeRole(member.id, role)}
                    disabled={busyMemberId === member.id}
                  >
                    <SelectTrigger
                      className="w-32"
                      aria-label={`Role for ${member.name}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {roleOptions.map((role) => (
                        <SelectItem key={role} value={role}>
                          {role}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="secondary" className="capitalize">
                    {member.role}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right">
                {editable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    disabled={busyMemberId === member.id}
                    onClick={() => remove(member)}
                  >
                    Remove
                  </Button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
