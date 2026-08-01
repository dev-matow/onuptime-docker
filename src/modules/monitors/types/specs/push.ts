import { z } from "zod";

import { DEFAULT_HEARTBEAT_GRACE_SECONDS, pushDescriptor } from "../catalog";
import type {
  Assertion,
  MonitorRowView,
  PassiveCheckType,
  ProbeResult,
} from "../contract";
import { monitorLabelSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * The push heartbeat: the first type Vigil does not dial.
 *
 * Everything an active type does is inverted here. There is no target
 * to reach, no timeout, no transport that can fail — the job reaches
 * *Vigil*, at `/api/push/<token>`, and what is measured is the silence
 * between arrivals. The monitor is down when a heartbeat does not come.
 *
 * That inversion is why `observe` is synchronous and performs no I/O.
 * The arrival already happened and was recorded by the endpoint; this
 * function turns "when was the last one" into facts, and the assertions
 * below turn those facts into a verdict. It is a pure function of state
 * the caller already holds, which means a passive monitor's history can
 * be re-judged against a later spec version exactly like an HTTP one.
 */

/**
 * How much entropy a token needs, and why the operator may set one.
 *
 * The token is a bearer credential: whoever holds it can tell Vigil
 * this monitor is fine. So it is generated here rather than typed —
 * asked for, an operator supplies `test123` — and it is declared in
 * `secretFields` so it never rides back to a browser with the rest of
 * the config.
 *
 * A submitted token is still accepted, because a migration has to be
 * able to carry one across: Uptime Kuma's `push_token` is embedded in
 * whatever cron, CI job or device firmware already calls it, and an
 * import that silently changed it would leave the operator with a
 * monitor that is permanently down and no idea why. The alphabet and
 * the 32-character floor are what stop that door from being a way to
 * install a guessable one.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/** 32 hex characters — 122 bits of entropy from the platform CSPRNG. */
export function newPushToken(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

export interface PushConfig {
  /** Authenticates one caller to one monitor. Never leaves the server. */
  token: string;
  /** How late a heartbeat may be before the silence counts as a failure. */
  graceSeconds: number;
  /**
   * The deadline itself. Copied off the monitor row by `fromRow`
   * because the assertion has to state what "late" was measured
   * against, and an assertion only ever sees one fact and the config.
   */
  intervalSeconds: number;
  degradedThresholdMs: number;
}

export const pushStoredSchema = z.object({
  token: z
    .string()
    .trim()
    .regex(
      TOKEN_PATTERN,
      "A push token is 32–128 characters of letters, digits, hyphen or underscore.",
    )
    // A generator, not a constant. A push monitor without a token has no
    // endpoint and can never report in, so "no token" is not a state this
    // type is allowed to be created in — and the one place that can
    // guarantee that is the schema every write goes through.
    .default(newPushToken),
  graceSeconds: z
    .number()
    .int()
    .min(0)
    .max(86_400)
    .default(DEFAULT_HEARTBEAT_GRACE_SECONDS),
});

export const pushConfigSchema: z.ZodType<PushConfig> = z.object({
  token: z.string().min(1),
  graceSeconds: z.number().int().min(0).max(86_400),
  intervalSeconds: z.number().int().min(1),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/** The moment a heartbeat stops being late and starts being absent. */
export function heartbeatDeadlineSeconds(config: PushConfig): number {
  return config.intervalSeconds + config.graceSeconds;
}

function describeSeconds(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
}

const heartbeatOverdue: Assertion<PushConfig> = {
  id: "heartbeat-overdue",
  fact: "secondsSinceHeartbeat",
  severity: "down",
  evaluate(value, config) {
    if (typeof value !== "number") return null;
    const deadline = heartbeatDeadlineSeconds(config);
    if (value <= deadline) return null;
    return (
      `No heartbeat for ${describeSeconds(value)}; ` +
      `one was due within ${describeSeconds(deadline)}`
    );
  },
};

/**
 * A job that ran and failed is down even though it checked in on time.
 *
 * Separate from lateness on purpose: the two have different causes and
 * different fixes, and an operator reading "the backup reported a
 * failure" goes to the backup's log rather than to the cron that
 * schedules it.
 */
const reportedFailure: Assertion<PushConfig> = {
  id: "reported-failure",
  fact: "reportedStatus",
  severity: "down",
  evaluate(value) {
    return value === "down"
      ? "The last heartbeat reported a failure"
      : // Anything else — "up", or null before the first arrival — says
        // nothing about failure. Absence is the other assertion's job.
        null;
  },
};

export const pushSpec: PassiveCheckType<PushConfig> = {
  descriptor: pushDescriptor,
  configSchema: pushConfigSchema,
  storedSchema: pushStoredSchema,
  secretFields: ["token"],
  targetSchema: monitorLabelSchema,
  assertions: [
    heartbeatOverdue,
    reportedFailure,
    latencyAssertion<PushConfig>("The job finished"),
  ],
  fromRow(row: MonitorRowView): PushConfig {
    const stored = pushStoredSchema.safeParse(row.config ?? {});
    return {
      // A row whose blob is unreadable gets a fresh token rather than an
      // empty one. It cannot authenticate anybody — which is right, since
      // whatever was stored is unrecoverable — and it keeps `token` a
      // string everywhere instead of a `string | null` that four call
      // sites would each have to remember to handle.
      token: stored.success ? stored.data.token : newPushToken(),
      graceSeconds: stored.success
        ? stored.data.graceSeconds
        : DEFAULT_HEARTBEAT_GRACE_SECONDS,
      intervalSeconds: row.intervalSeconds,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target) {
    return target;
  },
  observe({ config, lastHeartbeatAt, reported, since, now }): ProbeResult {
    const from = lastHeartbeatAt ?? since;
    const secondsSinceHeartbeat = Math.max(
      0,
      Math.floor((now.getTime() - from.getTime()) / 1000),
    );
    const facts = {
      heartbeatReceived: lastHeartbeatAt !== null,
      secondsSinceHeartbeat,
      reportedStatus: reported?.status ?? null,
      reportedMessage: reported?.message ?? null,
      responseTimeMs: reported?.responseTimeMs ?? null,
    };

    // Nothing has ever arrived and the first one is not late yet. This
    // is neither up nor down: nothing has failed, and nothing has
    // succeeded either. `unavailable` is the contract's word for "the
    // observation could not be made", which is exactly the case — the
    // monitor reads Pending, contributes to no uptime window, and turns
    // into a real `down` the moment the deadline passes, so a job whose
    // cron was never installed is caught rather than left green.
    if (
      lastHeartbeatAt === null &&
      secondsSinceHeartbeat <= heartbeatDeadlineSeconds(config)
    ) {
      return {
        facts,
        responseTimeMs: null,
        error: null,
        unavailable:
          "Waiting for the first heartbeat. Point your job at this monitor's push endpoint.",
      };
    }

    return {
      facts,
      // The duration the *job* reported about itself, not a round trip
      // Vigil measured. Recorded in the same column because it answers
      // the same question the response-time chart asks.
      responseTimeMs: reported?.responseTimeMs ?? null,
      error: null,
    };
  },
};
