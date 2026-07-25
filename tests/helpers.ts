import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { member, organization, user } from "@/db/schema";

export interface TestActor {
  organizationId: string;
  userId: string;
}

/**
 * Inserts a throwaway user + organization + owner membership directly.
 * Every test creates its own tenant, so suites can run in parallel
 * against one database without truncation or ordering constraints.
 */
export async function createTestOrg(): Promise<TestActor> {
  const suffix = randomUUID().slice(0, 8);
  const userId = `test-user-${suffix}`;
  const organizationId = `test-org-${suffix}`;

  await db.insert(user).values({
    id: userId,
    name: `Test User ${suffix}`,
    email: `test-${suffix}@example.com`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: organizationId,
    name: `Test Org ${suffix}`,
    slug: `test-org-${suffix}`,
    createdAt: new Date(),
  });
  await db.insert(member).values({
    id: `test-member-${suffix}`,
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });

  return { organizationId, userId };
}

export { db };
