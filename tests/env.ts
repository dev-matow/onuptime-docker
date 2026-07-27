/**
 * Test environment contract. Imported first by both the global setup
 * and per-file setup so `src/lib/env` validates against the TEST
 * database — never the developer's real one.
 */
export function applyTestEnv(): void {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ??
    "postgresql://postgres@localhost:5433/vigil_test";
  process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-42";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.LOG_LEVEL = "error";
  delete process.env.ANTHROPIC_API_KEY;
}
