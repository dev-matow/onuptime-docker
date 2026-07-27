import { expect, test, type Page } from "@playwright/test";

/**
 * Golden-path smoke test: sign up -> create org -> create monitor ->
 * report + resolve an incident -> publish the status page and view it.
 *
 * Runs against the already-running dev server and dev database, so all
 * identifiers are timestamp-suffixed to stay unique across runs.
 */

test.describe.configure({ mode: "serial" });

const runId = Date.now();
const userName = `E2E User ${runId}`;
const userEmail = `e2e-${runId}@example.com`;
const userPassword = `e2e-pass-${runId}`;
const orgName = `E2E Org ${runId}`;
const orgSlug = `e2e-org-${runId}`;
// A second tenant, used only to prove status pages don't share a cache.
const org2Name = `E2E Second ${runId}`;
const org2Slug = `e2e-second-${runId}`;

test.describe("Vigil golden path", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // Shared page keeps the session cookie across the serial steps.
    // Wide viewport so the sidebar renders inline instead of as a sheet.
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("signs up a new user and lands on onboarding", async () => {
    await page.goto("/sign-up");

    await page.getByLabel("Name", { exact: true }).fill(userName);
    await page.getByLabel("Work email").fill(userEmail);
    await page.getByLabel("Password").fill(userPassword);
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/onboarding$/, { timeout: 15_000 });
  });

  test("creates an organization and lands on the dashboard", async () => {
    await page.getByLabel("Organization name").fill(orgName);
    // The slug auto-fills from the name until manually edited.
    await expect(page.getByLabel("Slug")).toHaveValue(orgSlug);

    await page.getByRole("button", { name: "Create organization" }).click();

    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
    await expect(page.locator("header").getByText(orgName).first()).toBeVisible(
      { timeout: 10_000 },
    );
  });

  test("creates a monitor that shows up as Pending", async () => {
    await page.goto("/monitors");

    // A fresh org shows the empty state, which renders a second
    // "Create monitor" trigger — either one opens the same dialog.
    await page.getByRole("button", { name: "Create monitor" }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name", { exact: true }).fill("E2E Monitor");
    await dialog.getByLabel("URL").fill("https://example.com");
    await dialog.getByRole("button", { name: "Create monitor" }).click();

    await expect(dialog).toBeHidden({ timeout: 10_000 });
    const row = page.getByRole("row", { name: /E2E Monitor/ });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText("Pending");
    await expect(row).toContainText("https://example.com");
  });

  test("creates a monitor of each new check type through the dialog", async () => {
    // The form renders itself from the check type registry, so this
    // walks the four types added in 1.10.0 to prove the descriptor, the
    // per-type fields and the action layer agree. A type that validates
    // in isolation but cannot be filled in is not shipped.
    const cases = [
      {
        name: "E2E ping",
        type: "Ping (ICMP)",
        label: "Hostname",
        target: "gateway.example.com",
      },
      {
        name: "E2E dns",
        type: "DNS record",
        label: "Hostname",
        target: "dns.example.com",
      },
      {
        name: "E2E tls",
        type: "TLS certificate expiry",
        label: "Hostname",
        target: "tls.example.com",
      },
      {
        name: "E2E domain",
        type: "Domain expiry",
        label: "Domain",
        target: "expiry-demo.com",
      },
    ];

    for (const { name, type, label, target } of cases) {
      await page.goto("/monitors");
      await page
        .getByRole("button", { name: "Create monitor" })
        .first()
        .click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Name", { exact: true }).fill(name);
      await dialog.getByLabel("Check type").click();
      await page.getByRole("option", { name: type }).click();
      await dialog.getByLabel(label, { exact: true }).fill(target);

      if (type === "DNS record") {
        await dialog.getByLabel("Record type").click();
        await page.getByRole("option", { name: "MX" }).click();
      }

      await dialog.getByRole("button", { name: "Create monitor" }).click();
      await expect(dialog).toBeHidden({ timeout: 10_000 });

      const created = page.getByRole("row", { name: new RegExp(name) });
      await expect(created).toBeVisible({ timeout: 10_000 });
      await expect(created).toContainText(target);
    }
  });

  test("reports an incident and posts a timeline update", async () => {
    await page.goto("/incidents");

    await page.getByRole("button", { name: "Report incident" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Title").fill("E2E incident");
    // Keep the default severity (major) untouched.
    await dialog.getByRole("button", { name: "Report incident" }).click();

    await expect(page).toHaveURL(/\/incidents\/[^/]+$/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { level: 1, name: "E2E incident" }),
    ).toBeVisible({ timeout: 10_000 });

    await page
      .getByLabel("Post an update")
      .fill("Investigating the checkout flow");
    await page.getByRole("button", { name: "Post update" }).click();

    await expect(page.getByText("Investigating the checkout flow")).toBeVisible(
      { timeout: 10_000 },
    );
  });

  test("resolves the incident and reveals the postmortem card", async () => {
    await page.getByRole("button", { name: "Resolve incident" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel("Message")
      .fill("Rolled back the deploy and verified checkout recovers.");
    await dialog.getByRole("button", { name: "Resolve incident" }).click();

    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect(page.getByText("Resolved in")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByText("resolved", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Postmortem", { exact: true }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("publishes the status page and serves it publicly", async () => {
    await page.goto("/status-page");

    // The status page slug defaults to the organization slug; read it
    // from the form so the public URL never drifts from reality.
    await expect(page.getByLabel("Slug")).toHaveValue(orgSlug);

    const publishSwitch = page.getByRole("switch", { name: "Published" });
    await expect(publishSwitch).not.toBeChecked();
    await publishSwitch.click();
    await expect(publishSwitch).toBeChecked();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Status page updated").first()).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole("checkbox", { name: "E2E Monitor" }).check();
    await page.getByRole("button", { name: "Save components" }).click();
    await expect(page.getByText("Components updated").first()).toBeVisible({
      timeout: 10_000,
    });

    await page.goto(`/status/${orgSlug}`);
    await expect(
      page.getByRole("heading", { level: 1, name: `${orgName} status` }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("E2E Monitor")).toBeVisible();

    // Reload to exercise the cached render path: `unstable_cache`
    // serializes Dates to strings, so a page with incidents must still
    // render on a cache hit (regression guard for the revive step).
    await page.reload();
    await expect(
      page.getByRole("heading", { level: 1, name: `${orgName} status` }),
    ).toBeVisible({ timeout: 10_000 });
  });

  // Two published status pages in one deployment must never share a
  // cache entry. This caught a real cross-tenant leak: the slug was
  // captured in the cached callback's closure instead of passed as an
  // argument, so Next derived an identical key for every page and the
  // first slug requested was served under all the others.
  test("serves a second organization's status page, not the first's", async () => {
    await page.goto("/onboarding?new=1");
    await page.getByLabel("Organization name").fill(org2Name);
    await expect(page.getByLabel("Slug")).toHaveValue(org2Slug);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });

    await page.goto("/monitors");
    await page.getByRole("button", { name: "Create monitor" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name", { exact: true }).fill("Second Monitor");
    await dialog.getByLabel("URL").fill("https://example.org");
    await dialog.getByRole("button", { name: "Create monitor" }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    await page.goto("/status-page");
    const publishSwitch = page.getByRole("switch", { name: "Published" });
    await publishSwitch.click();
    await expect(publishSwitch).toBeChecked();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Status page updated").first()).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole("checkbox", { name: "Second Monitor" }).check();
    await page.getByRole("button", { name: "Save components" }).click();
    await expect(page.getByText("Components updated").first()).toBeVisible({
      timeout: 10_000,
    });

    // The first page was rendered (and cached) in the previous step, so
    // a shared key would serve it here too. Each slug must show its own.
    await page.goto(`/status/${org2Slug}`);
    await expect(
      page.getByRole("heading", { level: 1, name: `${org2Name} status` }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Second Monitor")).toBeVisible();
    await expect(page.getByText("E2E Monitor")).toHaveCount(0);

    // And the original must not have been displaced by the second.
    await page.goto(`/status/${orgSlug}`);
    await expect(
      page.getByRole("heading", { level: 1, name: `${orgName} status` }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Second Monitor")).toHaveCount(0);
  });
});
