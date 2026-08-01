import { readFileSync } from "node:fs";

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

/**
 * Read as text, in both editions, because the difference lives in a
 * comment marker rather than in a value. Core is single-organization
 * because `strip-ee` deletes one line; write that line without its
 * marker — a reformat, a refactor, an autofix — and Core ships holding
 * as many client organizations as the paid edition, with a green suite,
 * a green build and no visible symptom until a stranger notices their
 * data beside someone else's.
 *
 * Edition-neutral on purpose: in Core the raise is simply absent, so
 * these assertions hold there too, and the file needs no marker of its
 * own to survive the strip.
 */
describe("the multi-organization default", () => {
  const source = readFileSync(
    new URL("../../src/lib/editions.ts", import.meta.url),
    "utf8",
  );

  it("starts false, so the stripped edition is the restricted one", () => {
    expect(source).toMatch(/^let multiOrg = false;$/m);
  });

  it("raises the flag only on a line strip-ee will delete", () => {
    const raises = source
      .split("\n")
      .filter((line) => /\bmultiOrg\s*=\s*true\b/.test(line));
    for (const line of raises)
      expect(line.trimEnd().endsWith("// @edition:ee")).toBe(true);
  });
});
