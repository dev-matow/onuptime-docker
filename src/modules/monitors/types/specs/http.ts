import { z } from "zod";

import { httpDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorUrlSchema } from "../targets";
import { flatColumnsOnly } from "./shared";

export interface HttpConfig {
  method: "GET" | "HEAD";
  expectedStatusCode: number | null;
  degradedThresholdMs: number;
  bodyKeyword: string | null;
  keywordAbsent: boolean;
  /**
   * True only when the operator asked for the check AND the URL is
   * https. Folding the scheme in here is what lets the assertion be a
   * pure function of the config — assertions never see the target.
   */
  tlsCheck: boolean;
  tlsWarnDays: number;
}

export const httpConfigSchema: z.ZodType<HttpConfig> = z.object({
  method: z.enum(["GET", "HEAD"]),
  expectedStatusCode: z.number().int().min(100).max(599).nullable(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
  bodyKeyword: z.string().max(200).nullable(),
  keywordAbsent: z.boolean(),
  tlsCheck: z.boolean(),
  tlsWarnDays: z.number().int().min(1).max(365),
});

/**
 * Applies a keyword/content assertion to a body. Pure so it is unit
 * tested directly. Returns null when the assertion holds, or an error
 * string when it fails.
 */
export function evaluateKeyword(
  keyword: string,
  absent: boolean,
  body: string,
): string | null {
  const present = body.includes(keyword);
  if (absent) {
    return present ? `Body unexpectedly contains "${keyword}"` : null;
  }
  return present ? null : `Body does not contain "${keyword}"`;
}

const assertions: readonly Assertion<HttpConfig>[] = [
  {
    // Declared first, so when both the status and the keyword fail the
    // operator reads the cause rather than the symptom.
    id: "status",
    fact: "statusCode",
    severity: "down",
    evaluate(value, config) {
      if (typeof value !== "number") return "No status code in the response";
      const holds =
        config.expectedStatusCode !== null
          ? value === config.expectedStatusCode
          : value >= 200 && value <= 399;
      return holds ? null : `Unexpected status ${value}`;
    },
  },
  {
    id: "keyword",
    fact: "keywordPresent",
    severity: "down",
    // HEAD has no body to search, so the assertion cannot hold or fail.
    applies: (config) => config.bodyKeyword !== null && config.method === "GET",
    evaluate(value, config) {
      const keyword = config.bodyKeyword ?? "";
      if (config.keywordAbsent) {
        return value === true
          ? `Body unexpectedly contains "${keyword}"`
          : null;
      }
      return value === true ? null : `Body does not contain "${keyword}"`;
    },
  },
  {
    id: "latency",
    fact: "responseTimeMs",
    severity: "degraded",
    evaluate(value, config) {
      if (typeof value !== "number") return null;
      return value > config.degradedThresholdMs
        ? `Responded in ${value}ms, over the ${config.degradedThresholdMs}ms threshold`
        : null;
    },
  },
  {
    id: "tls-expiry",
    fact: "tlsDaysRemaining",
    severity: "degraded",
    applies: (config) => config.tlsCheck,
    evaluate(value, config) {
      // A failed handshake yields no number. That is an absence of
      // evidence, not evidence of an expiring certificate — the HTTP
      // request itself already decides whether the endpoint is up.
      if (typeof value !== "number") return null;
      return value < config.tlsWarnDays
        ? `TLS certificate expires in ${value} ${value === 1 ? "day" : "days"}`
        : null;
    },
  },
];

export const httpSpec: CheckTypeSpec<HttpConfig> = {
  descriptor: httpDescriptor,
  configSchema: httpConfigSchema,
  storedSchema: flatColumnsOnly,
  targetSchema: monitorUrlSchema,
  assertions,
  fromRow(row: MonitorRowView): HttpConfig {
    return {
      method: row.method,
      expectedStatusCode: row.expectedStatusCode,
      degradedThresholdMs: row.degradedThresholdMs,
      bodyKeyword: row.bodyKeyword,
      keywordAbsent: row.keywordAbsent,
      tlsCheck: row.tlsCheck && row.url.toLowerCase().startsWith("https:"),
      tlsWarnDays: row.tlsWarnDays,
    };
  },
  describeTarget(target) {
    return target;
  },
};
