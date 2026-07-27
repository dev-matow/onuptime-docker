import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { db } from "@/db";
import { member, user } from "@/db/schema";
import { ALL_MEMBERS, auth } from "@/lib/auth";

import { createTestOrg } from "../helpers";

/**
 * Team size is deliberately uncapped: Vigil is licensed per company, not
 * per seat. better-auth's organization plugin defaults `membershipLimit`
 * to 100 when the option is absent, and the option is easy to drop.
 *
 * The organization is inserted directly rather than created through
 * `auth.api`, because this file runs in both editions: the free edition
 * refuses a second organization, and the shared test database always
 * holds several. A test that quietly depended on multi-tenancy would
 * pass here and fail the moment the edition seam stripped it.
 */

const BEYOND_DEFAULT_LIMIT = 130; // > better-auth's default of 100
/** Two owners exist per org below: the seeded one and the signed-up one. */
const OWNERS = 2;
/** better-auth's undeclared member-join fallback, measured not assumed. */
const LIBRARY_DEFAULT = 100;

/** Signs up a real user (for the session cookie) and makes them the
 * owner of a directly-inserted organization. */
async function ownerOfPopulatedOrg() {
  const { organizationId } = await createTestOrg();
  const suffix = randomUUID().slice(0, 8);

  const response = await auth.api.signUpEmail({
    body: {
      name: `Owner ${suffix}`,
      email: `owner-${suffix}@example.com`,
      password: `test-password-${suffix}`,
    },
    asResponse: true,
  });

  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-up returned no session cookie");
  // Keep only the name=value pairs; a full Set-Cookie string is not a
  // valid Cookie request header.
  const cookie = setCookie
    .split(",")
    .map((part) => part.trim().split(";")[0])
    .join("; ");

  const signedUp = await db.query.user.findFirst({
    where: (u, { eq }) => eq(u.email, `owner-${suffix}@example.com`),
    columns: { id: true },
  });
  if (!signedUp) throw new Error("sign-up did not persist a user");

  await db.insert(member).values({
    id: `owner-member-${suffix}`,
    organizationId,
    userId: signedUp.id,
    role: "owner",
    createdAt: new Date(),
  });

  return { headers: new Headers({ cookie }), organizationId, suffix };
}

/** Adds `count` members straight to the table — the guard under test is
 * on the list/invitation paths, not on inserts. */
async function fillOrganization(organizationId: string, count: number) {
  const rows = Array.from({ length: count }, (_, index) => {
    const id = `${organizationId}-u${index}`;
    return {
      user: {
        id,
        name: `Member ${index}`,
        email: `${id}@example.com`,
        emailVerified: true,
      },
      member: {
        id: `${organizationId}-m${index}`,
        organizationId,
        userId: id,
        role: "responder",
        createdAt: new Date(),
      },
    };
  });

  await db.insert(user).values(rows.map((row) => row.user));
  await db.insert(member).values(rows.map((row) => row.member));
}

describe("team size", () => {
  it("lists every member of an organization larger than 100", async () => {
    const { headers, organizationId } = await ownerOfPopulatedOrg();
    await fillOrganization(organizationId, BEYOND_DEFAULT_LIMIT);

    const full = await auth.api.getFullOrganization({
      query: { organizationId, membersLimit: ALL_MEMBERS },
      headers,
    });

    expect(full?.members).toHaveLength(BEYOND_DEFAULT_LIMIT + OWNERS);
  });

  /**
   * Characterization, not a requirement: it pins the library behaviour
   * that `ALL_MEMBERS` exists to work around, so a future better-auth
   * that stopped truncating would say so here rather than leaving a
   * workaround nobody dares remove.
   */
  it("truncates to exactly 100 when membersLimit is omitted", async () => {
    const { headers, organizationId } = await ownerOfPopulatedOrg();
    await fillOrganization(organizationId, BEYOND_DEFAULT_LIMIT);

    const full = await auth.api.getFullOrganization({
      query: { organizationId },
      headers,
    });

    expect(full?.members).toHaveLength(LIBRARY_DEFAULT);
  });

  /**
   * This does NOT guard `membershipLimit`. Measured against better-auth
   * 1.6 by removing the option and re-running: this test still passes,
   * because the invitation path never consults it. It is kept as a
   * product assertion — inviting into a large organization must work —
   * and labelled so nobody mistakes it for a regression test of the
   * option. The list test above is what fails when the option is
   * dropped, and until this comment existed the file implied otherwise.
   */
  it("still invites into an organization larger than 100", async () => {
    const { headers, organizationId, suffix } = await ownerOfPopulatedOrg();
    await fillOrganization(organizationId, BEYOND_DEFAULT_LIMIT);

    const invitation = await auth.api.createInvitation({
      body: {
        email: `invitee-${suffix}@example.com`,
        role: "responder",
        organizationId,
      },
      headers,
    });

    expect(invitation.status).toBe("pending");
  });
});
