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
  // Off for the suite as a whole. An opening incident fires a
  // diagnostic burst at its monitor's target, and every suite that
  // opens one points at `*.example.com` - so left on, two thousand
  // tests would perform real DNS lookups, and the ones that assert on
  // timing would fail on a slow resolver rather than on a defect. The
  // evidence suite turns it back on per capture, with an injected
  // transport, which is the only place its behaviour is under test.
  process.env.INCIDENT_EVIDENCE_BURST = "false";
  process.env.LOG_LEVEL = "error";
  delete process.env.ANTHROPIC_API_KEY;
}
