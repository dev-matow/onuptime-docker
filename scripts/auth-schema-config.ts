import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";

/**
 * Standalone config consumed only by `@better-auth/cli generate` to emit
 * src/db/schema/auth.ts. It deliberately avoids importing the real auth
 * config (which needs a live db client) so schema generation has no
 * runtime dependencies. Re-run after upgrading better-auth:
 *
 *   npx @better-auth/cli generate --config scripts/auth-schema-config.ts --output src/db/schema/auth.ts
 */
export const auth = betterAuth({
  database: drizzleAdapter({} as never, { provider: "pg" }),
  emailAndPassword: { enabled: true },
  plugins: [organization()],
});
