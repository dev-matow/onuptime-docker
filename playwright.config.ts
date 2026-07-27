import { defineConfig, devices } from "@playwright/test";

/**
 * E2E suite drives the real app against a real Postgres. The web
 * server is expected to be started by the runner (CI builds and runs
 * `next start`; locally `npm run dev` works too).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Set E2E_SKIP_WEB_SERVER=1 when the runner already has a server up.
  ...(process.env.E2E_SKIP_WEB_SERVER
    ? {}
    : {
        webServer: {
          // CI builds first and sets E2E_WEB_COMMAND="npm run start".
          command: process.env.E2E_WEB_COMMAND ?? "npm run dev",
          // Follows E2E_BASE_URL: hardcoding :3000 here meant a server
          // on any other port could never be reused, so Playwright
          // would start a second one and then test the first.
          url: process.env.E2E_BASE_URL ?? "http://localhost:3000",
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }),
});
