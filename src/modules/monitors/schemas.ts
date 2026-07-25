import { z } from "zod";

/**
 * Hostnames a monitor may never target, regardless of environment:
 * cloud metadata endpoints are the classic SSRF jackpot. Private ranges
 * are additionally rejected at DNS-resolution time in the worker (see
 * modules/monitors/check.ts) unless ALLOW_PRIVATE_MONITOR_TARGETS is set.
 */
const FORBIDDEN_HOSTNAMES = new Set(["metadata.google.internal"]);
const METADATA_IP = "169.254.169.254";

export const monitorUrlSchema = z
  .url({ protocol: /^https?$/, hostname: z.regexes.domain })
  .max(2048)
  .refine(
    (value) => {
      let hostname: string;
      try {
        hostname = new URL(value).hostname;
      } catch {
        return true; // invalid URL — let the .url() check reject it
      }
      return (
        !FORBIDDEN_HOSTNAMES.has(hostname.toLowerCase()) &&
        hostname !== METADATA_IP
      );
    },
    { message: "This host cannot be monitored." },
  );

export const MONITOR_INTERVALS_SECONDS = [
  60, 120, 300, 600, 1800, 3600,
] as const;

const monitorFields = {
  name: z.string().trim().min(1, "Name is required").max(100),
  url: monitorUrlSchema,
  method: z.enum(["GET", "HEAD"]).default("GET"),
  intervalSeconds: z
    .number()
    .int()
    .refine(
      (value) =>
        MONITOR_INTERVALS_SECONDS.includes(
          value as (typeof MONITOR_INTERVALS_SECONDS)[number],
        ),
      { message: "Unsupported check interval." },
    )
    .default(60),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
  degradedThresholdMs: z.number().int().min(100).max(30_000).default(3_000),
  expectedStatusCode: z.number().int().min(100).max(599).nullish(),
  /**
   * Keyword/content assertion (GET only): the response body must
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
  failureThreshold: z.number().int().min(1).max(10).default(3),
};

export const createMonitorSchema = z.object(monitorFields);

export const updateMonitorSchema = z.object(monitorFields).partial();

export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;
export type UpdateMonitorInput = z.infer<typeof updateMonitorSchema>;
