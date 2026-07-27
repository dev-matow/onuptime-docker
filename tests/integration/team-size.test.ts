import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { db } from "@/db";
import { member, user } from "@/db/schema";
import { auth, getOrganizationWithAllMembers } from "@/lib/auth";

import { createTestOrg } from "../helpers";

/**
 * Team size is deliberately uncapped: Vigil Core is free, and the
 * commercial edition is licensed per company rather than per seat, so a
 * seat limit here would be an artificial one. better-auth's organization
 * plugin defaults `membershipLimit` to 100 when the option is absent,
 * which bites on two separate paths — invitations are refused past the
 * limit, and the member *list* is silently truncated to it. These tests
 * pin both above that default so a dropped option can't quietly
 * reintroduce a seat cap.
 *
 * Unlike the commercial edition's copy of this test, the organization is
 * inserted directly rather than created through `auth.api`: Core is
 * single-tenant, so `allowUserToCreateOrganization` refuses once any
 * organization exists, and the shared test database always has several.
 */

const BEYOND_DEFAULT_LIMIT = 130; // > better-auth's default of 100
/** Two owners are seeded per org below: the helper's and the sign-up's. */
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
 * on the invitation/list paths, not on inserts. */
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

    const full = await getOrganizationWithAllMembers(headers, organizationId);

    // Both owners plus everyone added — no silent truncation at 100.
    expect(full?.members).toHaveLength(BEYOND_DEFAULT_LIMIT + OWNERS);
  });

  /**
   * Characterization, not a requirement: this pins the library behaviour
   * that `getOrganizationWithAllMembers` exists to work around. If it
   * ever fails because better-auth stopped truncating, the helper can be
   * simplified — read it as a note to that future person, not as a rule.
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
   * This one does NOT currently guard `membershipLimit`: measured against
   * better-auth 1.6, removing the option leaves this passing, because the
   * invitation path does not consult it. It is kept as a product
   * assertion — inviting into a large organization must work — and
   * documented so nobody mistakes it for a regression test of the option.
   * The list test above is what fails when `membershipLimit` is dropped.
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
