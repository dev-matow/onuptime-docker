"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";

import { db } from "@/db";
import { user } from "@/db/schema";
import {
  actionOk,
  actionError,
  toActionError,
  type ActionResult,
} from "@/lib/action-result";
import { auth } from "@/lib/auth";
import { assertNotDemo } from "@/lib/demo";
import { ROLE_NAMES } from "@/lib/permissions";
import { requireOrgContext } from "@/lib/session";
import { writeAudit } from "@/modules/audit";

/**
 * Membership changes go through auth.api so the organization plugin
 * enforces its own permission rules (e.g. only owners assign owner);
 * these wrappers add input validation and the audit trail.
 */

const inviteSchema = z.object({
  email: z.email("Enter a valid email"),
  role: z.enum(ROLE_NAMES),
});

export async function inviteMemberAction(
  input: unknown,
): Promise<ActionResult> {
  try {
    assertNotDemo();
    const ctx = await requireOrgContext();
    const parsed = inviteSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }

    const invitation = await auth.api.createInvitation({
      headers: await headers(),
      body: {
        email: parsed.data.email,
        role: parsed.data.role,
        organizationId: ctx.organizationId,
      },
    });

    await writeAudit(db, {
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: "member.invited",
      targetType: "invitation",
      targetId: invitation.id,
      metadata: { email: parsed.data.email, role: parsed.data.role },
    });
    revalidatePath("/settings/members");
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

export async function cancelInvitationAction(
  invitationId: string,
): Promise<ActionResult> {
  try {
    assertNotDemo();
    const ctx = await requireOrgContext();
    await auth.api.cancelInvitation({
      headers: await headers(),
      body: { invitationId },
    });

    await writeAudit(db, {
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: "invitation.cancelled",
      targetType: "invitation",
      targetId: invitationId,
    });
    revalidatePath("/settings/members");
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

const roleChangeSchema = z.object({
  memberId: z.string().min(1),
  role: z.enum(ROLE_NAMES),
});

export async function updateMemberRoleAction(
  input: unknown,
): Promise<ActionResult> {
  try {
    assertNotDemo();
    const ctx = await requireOrgContext();
    const parsed = roleChangeSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }

    await auth.api.updateMemberRole({
      headers: await headers(),
      body: {
        memberId: parsed.data.memberId,
        role: parsed.data.role,
        organizationId: ctx.organizationId,
      },
    });

    await writeAudit(db, {
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: "member.role_changed",
      targetType: "member",
      targetId: parsed.data.memberId,
      metadata: { role: parsed.data.role },
    });
    revalidatePath("/settings/members");
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

export async function removeMemberAction(
  memberId: string,
): Promise<ActionResult> {
  try {
    assertNotDemo();
    const ctx = await requireOrgContext();
    await auth.api.removeMember({
      headers: await headers(),
      body: {
        memberIdOrEmail: memberId,
        organizationId: ctx.organizationId,
      },
    });

    await writeAudit(db, {
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: "member.removed",
      targetType: "member",
      targetId: memberId,
    });
    revalidatePath("/settings/members");
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

const orgNameSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
});

export async function updateOrganizationAction(
  input: unknown,
): Promise<ActionResult> {
  try {
    assertNotDemo();
    const ctx = await requireOrgContext();
    const parsed = orgNameSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }

    await auth.api.updateOrganization({
      headers: await headers(),
      body: {
        organizationId: ctx.organizationId,
        data: { name: parsed.data.name },
      },
    });

    await writeAudit(db, {
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: "organization.updated",
      targetType: "organization",
      targetId: ctx.organizationId,
      metadata: { name: parsed.data.name },
    });
    revalidatePath("/settings");
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

const profileSchema = z.object({
  phone: z.string().trim().max(20),
});

export async function updateProfileAction(
  input: unknown,
): Promise<ActionResult> {
  try {
    assertNotDemo();
    const ctx = await requireOrgContext();
    const parsed = profileSchema.safeParse(input);
    if (!parsed.success) {
      return actionError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    // Store E.164 so Twilio can dial/text it directly; empty clears it.
    const normalized = parsed.data.phone.replace(/[\s()-]/g, "");
    const phone = normalized === "" ? null : normalized;
    if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) {
      return actionError(
        "Enter a phone number in international format, e.g. +15551234567.",
      );
    }

    await db.update(user).set({ phone }).where(eq(user.id, ctx.userId));
    await writeAudit(db, {
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      action: "profile.updated",
      targetType: "user",
      targetId: ctx.userId,
      metadata: { phone: phone ? "set" : "cleared" },
    });
    revalidatePath("/settings");
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteOrganizationAction(): Promise<ActionResult> {
  try {
    assertNotDemo();
    const ctx = await requireOrgContext();
    await auth.api.deleteOrganization({
      headers: await headers(),
      body: { organizationId: ctx.organizationId },
    });
    // No audit write: the organization (and its audit log) is gone.
    return actionOk(undefined);
  } catch (error) {
    return toActionError(error);
  }
}
