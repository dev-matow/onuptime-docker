import { z } from "zod";

import { realBrowserDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorUrlSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * A page as a visitor's browser actually renders it.
 *
 * The `http` type fetches bytes. That is the right check for an API and
 * the wrong one for an application whose entire content arrives from
 * JavaScript: the shell of a single-page app answers 200 with an empty
 * `<div id="root">` whether the API behind it is healthy or on fire, and
 * a keyword assertion against that HTML can only ever match the shell.
 * This type runs the page in a real browser and asserts on the DOM
 * afterwards, which is the only way to catch the failure that matters to
 * the person looking at the screen.
 *
 * It cannot be done in-process. A browser is a hundred and fifty
 * megabytes of binary plus a pile of system libraries, and bundling one
 * would tax every install — including the ones that never enable this —
 * with a dependency they cannot opt out of. So the browser is a service
 * Vigil talks to over HTTP, named by `BROWSER_SERVICE_URL` or by the
 * monitor's own `serviceUrl`, and when there is none the monitor reads
 * `misconfigured` and says what is missing. Never `down`: an operator
 * who has not set up a renderer does not have an outage.
 *
 * See `docs/CHECKS-SIP-TAILSCALE-BROWSER-GLOBALPING.md` for what the
 * service has to implement, and what this cannot do.
 */

export interface RealBrowserConfig {
  /**
   * The renderer for this monitor, or null to use `BROWSER_SERVICE_URL`.
   *
   * Per-monitor because one install can legitimately have two: a
   * shared pool for most pages and a dedicated instance for the one
   * application that needs a long-lived session or a different region.
   */
  serviceUrl: string | null;
  /** Bearer token the renderer requires, if it requires one. */
  token: string | null;
  /**
   * Milliseconds to leave the page open after it has loaded, before the
   * DOM is read.
   *
   * Zero by default because the renderer already waits for the network
   * to go quiet. It is worth setting for an app that fetches its content
   * on a timer after first paint — without it the keyword assertion
   * races the application and fails intermittently, which is worse than
   * failing consistently.
   */
  settleMs: number;
  /** From the shared column: the text the rendered DOM must contain. */
  bodyKeyword: string | null;
  keywordAbsent: boolean;
  degradedThresholdMs: number;
}

/**
 * Where the renderer lives. Not `monitorUrlSchema`: that one demands a
 * public-looking hostname, and the overwhelmingly common answer here is
 * `http://browserless:3000` — a service name on a Compose network, with
 * no dot in it. What matters about this value is that it is an http(s)
 * origin; whether it may be reached is the egress guard's decision at
 * execution time, not a question a hostname pattern can answer.
 */
const serviceUrlSchema = z
  .string()
  .trim()
  .max(512)
  .refine(
    (value) => {
      if (!URL.canParse(value)) return false;
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    },
    { message: "Enter the renderer's base URL, e.g. http://browserless:3000" },
  );

export const realBrowserStoredSchema = z.object({
  serviceUrl: serviceUrlSchema
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null)),
  // Not trimmed, for the reason the Redis password is not: leading and
  // trailing space are legal in a token, and eating them turns a working
  // credential into a 401 with no visible cause.
  token: z
    .string()
    .max(512)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null)),
  settleMs: z.number().int().min(0).max(10_000).default(0),
});

export const realBrowserConfigSchema: z.ZodType<RealBrowserConfig> = z.object({
  serviceUrl: z.string().max(512).nullable(),
  token: z.string().max(512).nullable(),
  settleMs: z.number().int().min(0).max(10_000),
  bodyKeyword: z.string().max(200).nullable(),
  keywordAbsent: z.boolean(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/**
 * Declared first: a browser that produced nothing has no DOM for the
 * keyword assertion to search, and two messages for one cause is how an
 * incident stops being readable.
 */
const renderedSomething: Assertion<RealBrowserConfig> = {
  id: "rendered",
  fact: "rendered",
  severity: "down",
  evaluate(value) {
    if (value !== false) return null;
    // The renderer said the navigation succeeded and handed back an
    // empty document. That is a page that loaded and showed nothing —
    // a white screen — which is exactly the outage this type exists to
    // see and the one `http` reports as a healthy 200.
    return "The browser loaded the page and it rendered nothing";
  },
};

const keywordHolds: Assertion<RealBrowserConfig> = {
  id: "keyword",
  fact: "keywordPresent",
  severity: "down",
  applies: (config) => config.bodyKeyword !== null,
  evaluate(value, config) {
    const keyword = config.bodyKeyword ?? "";
    if (config.keywordAbsent) {
      return value === true ? `The rendered page contains "${keyword}"` : null;
    }
    return value === true
      ? null
      : `The rendered page does not contain "${keyword}"`;
  },
};

export const realBrowserSpec: CheckTypeSpec<RealBrowserConfig> = {
  descriptor: realBrowserDescriptor,
  configSchema: realBrowserConfigSchema,
  storedSchema: realBrowserStoredSchema,
  secretFields: ["token"],
  targetSchema: monitorUrlSchema,
  assertions: [
    renderedSomething,
    keywordHolds,
    latencyAssertion<RealBrowserConfig>("Rendered"),
  ],
  fromRow(row: MonitorRowView): RealBrowserConfig {
    const stored = realBrowserStoredSchema.safeParse(row.config ?? {});
    return {
      serviceUrl: stored.success ? stored.data.serviceUrl : null,
      token: stored.success ? stored.data.token : null,
      settleMs: stored.success ? stored.data.settleMs : 0,
      bodyKeyword: row.bodyKeyword,
      keywordAbsent: row.keywordAbsent,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target) {
    // The page, and only the page. The renderer's URL can carry a token
    // in its query string, and this string is printed in incident
    // emails, webhook bodies and public status pages.
    return target;
  },
};
