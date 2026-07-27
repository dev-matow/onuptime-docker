import { describe, expect, it } from "vitest";

import { mayCreateOrganization } from "@/lib/editions";

/**
 * The single-organization rule is the one edition difference `strip-ee`
 * cannot produce by deleting code, so it is tested as a pure decision
 * rather than through whichever edition happens to be running. Both
 * columns are asserted from both editions: a test that only exercises
 * the build it ships in proves the smaller half of the difference.
 */
describe("mayCreateOrganization", () => {
  it("lets the commercial edition hold many organizations", () => {
    expect(
      mayCreateOrganization({
        demoMode: false,
        multiOrg: true,
        hasAnyOrganization: true,
      }),
    ).toBe(true);
  });

  it("lets the free edition create its first organization", () => {
    expect(
      mayCreateOrganization({
        demoMode: false,
        multiOrg: false,
        hasAnyOrganization: false,
      }),
    ).toBe(true);
  });

  it("refuses a second organization in the free edition", () => {
    expect(
      mayCreateOrganization({
        demoMode: false,
        multiOrg: false,
        hasAnyOrganization: true,
      }),
    ).toBe(false);
  });

  it("refuses in demo mode regardless of edition", () => {
    for (const multiOrg of [true, false]) {
      expect(
        mayCreateOrganization({
          demoMode: true,
          multiOrg,
          hasAnyOrganization: false,
        }),
      ).toBe(false);
    }
  });
});
