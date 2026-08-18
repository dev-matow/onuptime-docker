import { expect, test } from "@playwright/test";

import { MARK_PATH, MARK_VIEWBOX } from "@/lib/brand-mark";

/**
 * The mark, tested where it renders.
 *
 * `npm run brand:check` proves every committed surface carries the same
 * drawing. What it cannot see is what a real page serves, and the two
 * ways this fails are both silent: a component drifts from the generated
 * path and ships a slightly different logo, or the retired pixel eye's
 * blink plumbing creeps back in through an old import and starts
 * mutating attributes again. Both are asserted here against a rendered
 * page.
 *
 * The mark is still by design — the blink retired with the pixel eye on
 * 2026-08-17 — so the strongest assertion is an absence: no frame
 * groups, no blink hooks, no attribute churn to schedule around.
 */
test.describe("the brand mark", () => {
  test("is the generated blade path, drawn once, and still", async ({
    page,
  }) => {
    await page.goto("/sign-in");

    // The lockup's mark is drawn, not a picture of a drawing, and it is
    // byte-identical to the single source in src/lib/brand-mark.ts.
    const mark = page.locator(`svg[viewBox="${MARK_VIEWBOX}"]`).first();
    await expect(mark).toBeVisible();
    await expect(mark.locator("path")).toHaveAttribute("d", MARK_PATH);

    // The blink era left three named hooks; none may render again.
    await expect(page.locator("[data-blink]")).toHaveCount(0);
    await expect(page.locator("[data-mark]")).toHaveCount(0);
    await expect(page.locator("g[data-frame]")).toHaveCount(0);
  });

  test("renders identically under reduced motion", async ({ browser }) => {
    // Nothing moves, so the preference changes nothing: same path, same
    // stillness. Asserted because the old scheduler's failure mode was
    // exactly here, and silently.
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.goto("/sign-in");

    const mark = page.locator(`svg[viewBox="${MARK_VIEWBOX}"]`).first();
    await expect(mark).toBeVisible();
    await expect(mark.locator("path")).toHaveAttribute("d", MARK_PATH);
    await expect(page.locator("[data-blink]")).toHaveCount(0);
    await page.close();
  });
});
