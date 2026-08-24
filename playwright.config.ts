// Specs may import product modules, and a product module reaches
// `@/lib/env`, which refuses to load without a database URL. CI exports
// the variables; a developer has them in `.env`, and without this the
// suite fails at import time with a configuration error rather than
// running. A no-op wherever the environment is already set.
import "dotenv/config";

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
          // Never in CI, and never for a release run. Reuse is a
          // convenience for a developer who already has `npm run dev`
          // up; anywhere else it means the suite silently tests
          // whatever happens to hold the port — a stale build, another
          // branch, another database — and still reports green. That
          // happened during this release: a leftover dev server on
          // :3000 answered a run whose own server was on :3210.
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          // The Better Stack stub the bridge spec starts on this port.
          // Set unconditionally: an env var pointing at a port nothing
          // listens on changes nothing for the specs that never talk to
          // Better Stack, and the one that does owns the listener. A
          // developer reusing their own dev server exports it themselves
          // (reuseExistingServer means this block's env never reaches
          // that process).
          env: {
            ...(process.env as Record<string, string>),
            VIGIL_BETTERSTACK_TEST_BASE: "http://127.0.0.1:43117",
          },
        },
      }),
});
