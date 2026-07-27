import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { member, organization, user } from "@/db/schema";
import type { CheckResult } from "@/modules/monitors/check";

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

/**
 * A judged check result, as `performCheck` would return one.
 *
 * Tests construct these by hand to drive `recordCheckOutcome` without a
 * transport. Keeping the builder here rather than in each suite means
 * the day a field is added to `CheckResult` there is one place to add
 * it, instead of six copies that quietly disagree.
 */
export function checkResult(overrides: Partial<CheckResult> = {}): CheckResult {
  const base: CheckResult = {
    ok: true,
    degraded: false,
    statusCode: 200,
    responseTimeMs: 100,
    error: null,
    verdict: "up",
    failureClass: null,
    facts: { statusCode: 200, responseTimeMs: 100 },
    failedAssertions: [],
  };
  return { ...base, ...overrides };
}

/** A passing check. */
export function okResult(responseTimeMs = 100): CheckResult {
  return checkResult({
    responseTimeMs,
    facts: { statusCode: 200, responseTimeMs },
  });
}

/** A check that reached the target and disliked the answer. */
export function failResult(): CheckResult {
  return checkResult({
    ok: false,
    verdict: "down",
    failureClass: "assertion",
    statusCode: 503,
    responseTimeMs: 250,
    error: "Unexpected status 503",
    facts: { statusCode: 503, responseTimeMs: 250 },
    failedAssertions: ["status"],
  });
}

/** A check that could not run here at all. */
export function indeterminateResult(error: string): CheckResult {
  return checkResult({
    ok: false,
    verdict: "indeterminate",
    failureClass: "misconfigured",
    statusCode: null,
    responseTimeMs: null,
    error,
    facts: {},
  });
}
