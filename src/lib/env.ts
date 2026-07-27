import { z } from "zod";

/**
 * Environment contract for both the Next.js server and the background worker.
 * Parsed once at module load so misconfiguration fails fast at boot,
 * not at first use. Never import this from client components.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  BETTER_AUTH_SECRET: z.string().min(32),
  /** Canonical origin of the app, e.g. https://vigil.example.com */
  APP_URL: z.url().default("http://localhost:3000"),
  /** Optional: enables AI postmortems and incident summaries. */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Optional: enables real email delivery via Resend. Log transport otherwise. */
  RESEND_API_KEY: z.string().optional(),
  /** Sender identity for notification emails (Resend must own the domain). */
  EMAIL_FROM: z.string().default("Vigil <onboarding@resend.dev>"),
  /**
   * Optional Twilio credentials. When all three are set, escalation
   * steps with an `sms` or `voice` channel deliver via Twilio; otherwise
   * those channels are inert (logged, never sent).
   */
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  /**
   * Lets monitors target private/loopback addresses. Off in production —
   * a hosted monitoring service must not probe its own network (SSRF).
   */
  ALLOW_PRIVATE_MONITOR_TARGETS: z.stringbool().default(false),
  /**
   * RDAP endpoint used by `domain-expiry` monitors. The default is the
   * IANA-backed bootstrap redirector, which forwards to the registry
   * that is authoritative for each TLD. Override it to point at your
   * own mirror, or at a registry directly in an air-gapped install.
   */
  RDAP_BASE_URL: z.url().default("https://rdap.org"),
  /**
   * Public read-only demo deployment: sign-up and every mutation are
   * disabled, and /api/demo signs visitors in as the seeded viewer.
   */
  DEMO_MODE: z.stringbool().default(false),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

export const isAiEnabled = Boolean(env.ANTHROPIC_API_KEY);

export const isEmailEnabled = Boolean(env.RESEND_API_KEY);

/** Twilio powers both SMS and voice escalation channels. */
export const isTwilioEnabled = Boolean(
  env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER,
);
