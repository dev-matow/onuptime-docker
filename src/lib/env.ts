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

  /* ---- Notification delivery ----------------------------------------
   *
   * Five dials, all validated, all with defaults that are the shipped
   * behaviour. They exist because the right value depends on the
   * installation - a single-tenant box paging one team and an agency
   * fanning out to forty clients want different numbers - and because
   * a limit nobody can see or change is indistinguishable from a bug
   * when it bites. Every one of them is published in
   * `docs/NOTIFICATIONS.md` with what happens at the edges.
   */

  /**
   * How long a message stays worth delivering.
   *
   * The OUTER bound, stamped onto each row at enqueue so a running
   * queue keeps the deadline it was accepted under - changing this
   * does not retroactively expire or extend work already in flight.
   *
   * Six hours by default, and the reason is the product rather than
   * the machine: an alert is perishable. A monitor-down page that
   * arrives six hours late is not a late alert, it is a false one -
   * the outage it describes is over, and it competes for attention
   * with whatever is happening now. Installations that would rather
   * have the message eventually than not at all can raise it; the
   * ceiling is seventy-two hours because past that the message is
   * archaeology.
   */
  NOTIFICATION_RETRY_HORIZON_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(72)
    .default(6),
  /**
   * How many times one message may be attempted.
   *
   * The INNER bound, and it binds first when a provider fails fast:
   * twenty attempts on the published backoff is about five hours, so a
   * provider that refuses instantly exhausts its tries before the
   * horizon, while a provider that is simply unreachable runs out of
   * time first. Two controls, two different failure shapes, and the
   * terminal state says which one was hit - `dead_letter` for attempts,
   * `expired` for time.
   */
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(20),
  /**
   * How many messages one drain tick may take.
   *
   * Bounded rather than "everything due" because an unbounded drain
   * after a long outage is the second outage. Raising it does not
   * raise throughput on its own - the concurrency below and the
   * per-channel limit still apply - it raises how much work one tick
   * may consider, which is what matters when the queue is deep.
   */
  NOTIFICATION_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(5_000)
    .default(250),
  /**
   * How many deliveries are in flight at once.
   *
   * Tied to the database connection pool, not to throughput. Each
   * delivery takes a connection several times - claim, load the
   * channel, record the outcome - and the pool is shared with the web
   * application. The default is derived from the pool size rather than
   * typed as a constant (see `notification-delivery.ts`), and this
   * override exists for an operator who has measured their own pool.
   * Raising it past the pool is how a large fan-out becomes a slow
   * dashboard.
   */
  NOTIFICATION_DELIVERY_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .optional(),
  /**
   * How long finished deliveries and their attempt evidence are kept.
   *
   * Only terminal rows are ever removed, and never anything still
   * queued or in flight - see `pruneNotificationHistory`. Thirty days
   * is long enough to answer "was I paged about that incident last
   * month" and short enough that a busy installation's ledger reaches
   * a steady size. The attempt rows go with their delivery by cascade,
   * in the same statement.
   */
  NOTIFICATION_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3_650)
    .default(30),
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
