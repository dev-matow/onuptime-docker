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
   * The three halves of the outbound egress policy (see
   * `modules/monitors/egress.ts`). Each says whether that channel may
   * reach private and loopback space. None of them can reach cloud
   * metadata, link-local, unspecified or reserved space — that floor is
   * not configurable, in any encoding, on any channel.
   *
   * Monitors deny by default: a hosted monitoring service must not be
   * usable as a probe of its own network (SSRF).
   */
  ALLOW_PRIVATE_MONITOR_TARGETS: z.stringbool().default(false),
  /**
   * Webhooks allow by default. A self-hosted install routinely posts to
   * a receiver on the same private network, and that has worked since
   * 1.0 — denying it here would be a silent breaking change dressed up
   * as a security fix. Set false on a hosted deployment where the
   * webhook URL is attacker-supplied.
   */
  ALLOW_PRIVATE_WEBHOOK_TARGETS: z.stringbool().default(true),
  /**
   * Recovery allows by default, and this one is the feature rather than
   * a concession: a recovery action exists to reach a restart hook
   * inside your own network. Documented in SECURITY.md.
   */
  ALLOW_PRIVATE_RECOVERY_TARGETS: z.stringbool().default(true),
  /**
   * RDAP endpoint used by `domain-expiry` monitors. The default is the
   * IANA-backed bootstrap redirector, which forwards to the registry
   * that is authoritative for each TLD. Override it to point at your
   * own mirror, or at a registry directly in an air-gapped install.
   */
  RDAP_BASE_URL: z.url().default("https://rdap.org"),
  /**
   * Rendering service used by `real-browser` monitors, when a monitor
   * does not name one of its own.
   *
   * Optional and undefined by default, because Vigil ships no browser:
   * Chromium is a hundred and fifty megabytes and a pile of system
   * libraries, and putting it in the base image would tax every install
   * for a feature most of them never enable. Point this at a
   * browserless-compatible renderer — `http://browserless:3000` beside
   * the worker in Compose — and `real-browser` monitors work with no
   * per-monitor setting at all. Without it they report `misconfigured`
   * and say so, which is the honest answer and never a false outage.
   */
  BROWSER_SERVICE_URL: z.url({ protocol: /^https?$/ }).optional(),
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
