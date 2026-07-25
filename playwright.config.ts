import { defineConfig, devices } from "@playwright/test";

/**
 * E2E suite drives the real app against a real Postgres. The web
 * server is expected to be started by the runner (CI builds and runs
 * `next start`; locally `npm run dev` works too).
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Set E2E_SKIP_WEB_SERVER=1 when you already have a server running
  // (e.g. a production build on a non-default port).
  ...(process.env.E2E_SKIP_WEB_SERVER
    ? {}
    : {
        webServer: {
          // CI builds first and sets E2E_WEB_COMMAND="npm run start".
          command: process.env.E2E_WEB_COMMAND ?? "npm run dev",
          // Probe the same origin the tests use, so a server on an
          // alternate port is actually detected and reused.
          url: baseURL,
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }),
});
