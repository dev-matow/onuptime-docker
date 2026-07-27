import { z } from "zod";

import { findSpec } from "./types/specs";
import {
  FORBIDDEN_HOSTNAMES,
  METADATA_IP,
  monitorUrlSchema,
} from "./types/targets";

export { FORBIDDEN_HOSTNAMES, METADATA_IP, monitorUrlSchema };

/**
 * Bounds on how often a monitor may be evaluated.
 *
 * Until 1.10.0 this was a fixed ladder (60/120/300/600/1800/3600) that
 * the form rendered as a dropdown. A ladder only makes sense while
 * every check is the same distance apart; once the scheduler adapts,
 * the number is a baseline the policy tightens or relaxes around, and
 * pinning it to six values means an operator cannot express the
 * baseline they actually want.
 */
/**
 * Two seconds, because two seconds is what the scheduler delivers.
 *
 * Measured rather than assumed: a monitor asking for a 1-second baseline
 * is checked every 2002ms at the median, and adding ten monitors on the
 * same baseline moves that to 2003ms — flat. The wall is pg-boss's job
 * poll, not contention, and certainly not the ledger's per-actor
 * sequence, which does not notice this rate at all.
 *
 * It was 10, which meant a number an operator could type and not
 * receive. Anything below 2 would be the same defect in the other
 * direction; going under it is a scheduler change, not a validation
 * change.
 */
export const MIN_INTERVAL_SECONDS = 2;
export const MAX_INTERVAL_SECONDS = 86_400;

/**
 * Bounds on how long a monitor must be failing before an incident
 * opens. Zero is meaningful and allowed: open on the first failed
 * check, which is exactly what the old `failureThreshold: 1` meant.
 */
export const MIN_FAILURE_WINDOW_SECONDS = 0;
export const MAX_FAILURE_WINDOW_SECONDS = 86_400;
export const DEFAULT_FAILURE_WINDOW_SECONDS = 120;

const monitorFields = {
  name: z.string().trim().min(1, "Name is required").max(100),
  /**
   * Validated against the registry rather than an enum: the set of
   * types is data now, and a stored value this build does not know must
   * remain readable rather than blowing up a column cast.
   */
  checkType: z.string().trim().min(1).max(64).default("http"),
  /** URL for http; a host or domain for every other type. Refined below. */
  url: z.string().trim().min(1).max(2048),
  /** Required by the types that declare a port; ignored by the rest. */
  port: z.number().int().min(1).max(65535).nullish(),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  intervalSeconds: z
    .number()
    .int()
    .min(MIN_INTERVAL_SECONDS)
    .max(MAX_INTERVAL_SECONDS)
    .default(60),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
  degradedThresholdMs: z.number().int().min(100).max(30_000).default(3_000),
  expectedStatusCode: z.number().int().min(100).max(599).nullish(),
  /**
   * Keyword/content assertion (http GET only): the response body must
   * contain this string — or must not, when `keywordAbsent` is true.
   * Empty resolves to null (no assertion).
   */
  bodyKeyword: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null)),
  keywordAbsent: z.boolean().default(false),
  /** Also check TLS certificate expiry (https http monitors only). */
  tlsCheck: z.boolean().default(false),
  tlsWarnDays: z.number().int().min(1).max(365).default(14),
  /** Escalation policy to run on incident open; null = notify responders. */
  /**
   * How long the monitor must be failing before an incident opens.
   * Replaces the consecutive-failure count, which stopped meaning
   * anything once intervals became adaptive.
   */
  failureWindowSeconds: z
    .number()
    .int()
    .min(MIN_FAILURE_WINDOW_SECONDS)
    .max(MAX_FAILURE_WINDOW_SECONDS)
    .default(DEFAULT_FAILURE_WINDOW_SECONDS),
  /**
   * Type-specific settings. Shape is decided by the type's own schema,
   * which is why this is `unknown` here and validated in the refinement.
   */
  config: z.unknown().nullish(),
};

type TargetShape = {
  checkType?: string;
  url?: string;
  port?: number | null;
  config?: unknown;
};

/**
 * Per-type validation, delegated to the registry.
 *
 * Everything type-specific — what a valid target looks like, whether a
 * port is required, what the config blob may contain — is answered by
 * the type, so adding a type never means editing this function.
 */
function refineTarget(data: TargetShape, ctx: z.RefinementCtx): void {
  if (data.checkType === undefined && data.url === undefined) return;

  const spec =
    data.checkType === undefined ? undefined : findSpec(data.checkType);

  if (data.checkType !== undefined && !spec) {
    ctx.addIssue({
      code: "custom",
      path: ["checkType"],
      message: `Unknown check type "${data.checkType}".`,
    });
    return;
  }
  if (!spec) return; // partial update that does not touch the type

  if (data.url !== undefined) {
    const target = spec.targetSchema.safeParse(data.url);
    if (!target.success) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message:
          target.error.issues[0]?.message ??
          `Invalid ${spec.descriptor.target.label.toLowerCase()}.`,
      });
    }
  }

  const portSpec = spec.descriptor.port;
  if (
    portSpec?.required &&
    (data.port === undefined || data.port === null) &&
    portSpec.default === null
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["port"],
      message: `A ${spec.descriptor.label} check needs a port.`,
    });
  }

  const config = spec.storedSchema.safeParse(data.config ?? {});
  if (!config.success) {
    ctx.addIssue({
      code: "custom",
      path: ["config"],
      message: config.error.issues[0]?.message ?? "Invalid settings.",
    });
  }
}

export const createMonitorSchema = z
  .object(monitorFields)
  .superRefine(refineTarget);

export const updateMonitorSchema = z
  .object(monitorFields)
  .partial()
  .superRefine(refineTarget);

export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;
export type UpdateMonitorInput = z.infer<typeof updateMonitorSchema>;
