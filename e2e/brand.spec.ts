import { expect, test } from "@playwright/test";

/**
 * The blink, tested where it runs.
 *
 * Everything else about the mark is static and checked by
 * `npm run brand:check`: the geometry, the three frames, and every
 * surface carrying the same drawing. What that cannot see is whether the
 * scheduler in the browser actually does what it says, and this is the
 * kind of code that fails silently in exactly two ways. It never blinks,
 * which nobody notices for a release. Or it ignores the reduced-motion
 * preference, which nobody notices at all, because the people it hurts
 * are not the people reviewing it.
 *
 * So both are asserted against a real page, with a MutationObserver
 * rather than by polling: a blink is 180ms, and a poll would miss it and
 * report the wrong answer confidently. That costs this file about twenty
 * seconds, which is the price of the assertion being true.
 */

/**
 * Record every frame change on the mark, from the moment the page loads.
 *
 * Attached on DOMContentLoaded, not immediately: an init script runs
 * before the document exists, so querying for the mark there finds
 * nothing, silently observes nothing, and leaves both tests below
 * passing on an empty array. The reduced-motion one did exactly that
 * before this comment was written, which is the whole reason it is here.
 */
const WATCH = `
  window.__frames = [];
  addEventListener("DOMContentLoaded", () => {
    const mark = document.querySelector("[data-mark][data-blink]");
    if (!mark) return;
    new MutationObserver(() => {
      window.__frames.push([Math.round(performance.now()), mark.dataset.mark]);
    }).observe(mark, { attributes: true, attributeFilter: ["data-mark"] });
  });
`;

// A blink lands at most maxWait + one blink after the page settles.
const LONGEST_WAIT = 15_000 + 180;

test.describe("the brand mark", () => {
  test("blinks, rarely, and only in one place on the page", async ({
    browser,
  }) => {
    const page = await browser.newPage();
    await page.addInitScript(WATCH);
    await page.goto("/sign-in");

    const marks = page.locator("[data-mark]");
    await expect(marks).toHaveCount(1);
    const mark = marks.first();

    // It is drawn, not a picture of a drawing, and every frame is
    // present so that a blink repaints rather than reflows.
    await expect(mark).toHaveAttribute("data-mark", "open");
    await expect(mark.locator("g[data-frame]")).toHaveCount(3);
    await expect(mark.locator("g[data-frame='open']")).toBeVisible();
    await expect(mark.locator("g[data-frame='half']")).toBeHidden();
    await expect(mark.locator("g[data-frame='closed']")).toBeHidden();

    await page.waitForFunction(() => window.__frames.length >= 4, undefined, {
      timeout: LONGEST_WAIT + 5_000,
    });
    const frames: [number, string][] = await page.evaluate(
      () => window.__frames,
    );

    // open -> half -> closed -> half -> open, discretely, and quickly.
    expect(frames.slice(0, 4).map(([, f]) => f)).toEqual([
      "half",
      "closed",
      "half",
      "open",
    ]);
    const blink = frames[3]![0] - frames[0]![0];
    expect(blink).toBeGreaterThanOrEqual(140);
    expect(blink).toBeLessThanOrEqual(320); // 180ms of timers, plus the tax

    // And it settles back open rather than staying mid-blink.
    await expect(mark).toHaveAttribute("data-mark", "open");
    await page.close();
  });

  test("stays open for the whole of a reduced-motion session", async ({
    browser,
  }) => {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.addInitScript(WATCH);
    await page.goto("/sign-in");

    const mark = page.locator("[data-mark]").first();
    await expect(mark).toHaveAttribute("data-mark", "open");

    // Long enough that a scheduler ignoring the preference would have
    // blinked at least once, whatever it rolled for its interval.
    await page.waitForTimeout(LONGEST_WAIT + 1_000);

    const frames: [number, string][] = await page.evaluate(
      () => window.__frames,
    );
    expect(frames).toEqual([]);
    await expect(mark).toHaveAttribute("data-mark", "open");
    await page.close();
  });
});

declare global {
  interface Window {
    __frames: [number, string][];
  }
}
