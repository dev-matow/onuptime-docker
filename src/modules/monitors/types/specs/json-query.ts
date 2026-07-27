import { z } from "zod";

import { jsonQueryDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorUrlSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * Descriptor for the JSON query type. Every other descriptor lives in
 * `catalog.ts` and this one belongs there too — it is here only so this
 * type could be written without contending for that file.
 */

/**
 * The defaults a missing or unreadable config blob falls back to.
 *
 * They have to describe a check that can actually pass. `{}` must parse —
 * the conformance suite requires it, and a downgrade can leave a shape
 * this build does not recognise — and a default expectation that could
 * never hold would turn an unreadable blob into a permanent false
 * outage. `status` equals `ok` is the health-endpoint convention this
 * type exists for, so it is the one default that is both valid and true.
 */
const DEFAULT_JSON_PATH = "status";
const DEFAULT_EXPECTED_VALUE = "ok";

export interface JsonQueryConfig {
  /** Dotted path into the body: `status`, `db.connected`, `checks[0].name`. */
  jsonPath: string;
  /**
   * Compared as a string against the resolved value stringified.
   *
   * The operator types this into a text field, so `true`, `1` and `ok`
   * all work with no type picker and no "is this a number or a string?"
   * question in front of someone who just wants to watch a health
   * endpoint. The price is that `1` and `"1"` are indistinguishable —
   * which nobody monitoring `{"status":"ok"}` will ever notice, and a
   * type selector would be a second thing to get wrong.
   */
  expectedValue: string;
  degradedThresholdMs: number;
}

export const jsonQueryStoredSchema = z.object({
  jsonPath: z.string().trim().min(1).max(200).default(DEFAULT_JSON_PATH),
  expectedValue: z.string().trim().max(200).default(DEFAULT_EXPECTED_VALUE),
});

export const jsonQueryConfigSchema: z.ZodType<JsonQueryConfig> = z.object({
  jsonPath: z.string().min(1).max(200),
  expectedValue: z.string().max(200),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/**
 * Declared before the two assertions below it, so the first failing
 * message an operator reads is the cause rather than a consequence: a
 * body that is not JSON has no path to find and no value to compare.
 */
const validJson: Assertion<JsonQueryConfig> = {
  id: "json-valid",
  fact: "jsonValid",
  severity: "down",
  evaluate(value) {
    if (value !== false) return null;
    return "The response body is not valid JSON";
  },
};

/**
 * A missing path is its own failure, distinct from a mismatch.
 *
 * The two have completely different fixes — one is a typo in the monitor,
 * the other is the outage the monitor was created to catch — and an
 * operator who reads "expected ok, got undefined" goes looking at the
 * endpoint instead of at the path they typed.
 */
const pathFound: Assertion<JsonQueryConfig> = {
  id: "path-found",
  fact: "pathFound",
  severity: "down",
  evaluate(value, config) {
    if (value !== false) return null;
    return `The response has no value at "${config.jsonPath}"`;
  },
};

/**
 * Reads `actualValue` rather than the `matches` boolean because the
 * message has to quote what was actually there — a verdict of "did not
 * match" that withholds the value it saw sends the operator to the
 * endpoint with curl to find out. Both sides are quoted so a trailing
 * space or an empty string is visible rather than merely puzzling.
 */
const matchesExpected: Assertion<JsonQueryConfig> = {
  id: "value-matches",
  fact: "actualValue",
  severity: "down",
  evaluate(value, config) {
    // Null or absent means the body did not parse or the path was not
    // there; both are already reported above, and repeating them here
    // would bury the cause under a symptom.
    if (typeof value !== "string") return null;
    return value === config.expectedValue
      ? null
      : `Expected "${config.expectedValue}" at "${config.jsonPath}", got "${value}"`;
  },
};

export const jsonQuerySpec: CheckTypeSpec<JsonQueryConfig> = {
  descriptor: jsonQueryDescriptor,
  configSchema: jsonQueryConfigSchema,
  storedSchema: jsonQueryStoredSchema,
  targetSchema: monitorUrlSchema,
  assertions: [
    validJson,
    pathFound,
    matchesExpected,
    latencyAssertion<JsonQueryConfig>(),
  ],
  fromRow(row: MonitorRowView): JsonQueryConfig {
    const stored = jsonQueryStoredSchema.safeParse(row.config ?? {});
    return {
      jsonPath: stored.success ? stored.data.jsonPath : DEFAULT_JSON_PATH,
      expectedValue: stored.success
        ? stored.data.expectedValue
        : DEFAULT_EXPECTED_VALUE,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, _port, config) {
    // The path is what distinguishes two monitors on the same URL, so it
    // belongs in the line an incident email shows.
    return `${target} (${config.jsonPath})`;
  },
};
