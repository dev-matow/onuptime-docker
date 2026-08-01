import { env } from "@/lib/env";

import { EgressBlockedError, egressFetch } from "../../egress";
import type { ProbeContext, ProbeResult } from "../contract";
import type { RealBrowserConfig } from "../specs/real-browser";
import { elapsedSince, monitorEgress, refusesPrivate } from "./guard";

/**
 * One page load in a real browser, driven over HTTP.
 *
 * Vigil does not launch the browser and deliberately cannot: shipping
 * Chromium would add a hundred and fifty megabytes and a system-library
 * matrix to an image whose whole appeal is that it is one binary and a
 * database. Instead this speaks to a rendering service — browserless, or
 * anything that implements the same `POST /content` — which is a
 * container an operator adds when they want this feature and omits when
 * they do not.
 *
 * The rule that shapes everything below: **a failure of the renderer is
 * never an outage of the page.** A service that is missing, unreachable,
 * out of concurrency slots or rejecting Vigil's token has measured
 * nothing, so the monitor reports `misconfigured` and says what to fix.
 * Only the browser's own verdict on the page — it loaded, or it did not
 * — becomes up or down. Getting this backwards would page an on-call
 * engineer about a healthy site every time the renderer restarted.
 */

/** Cap on how much rendered HTML is read. A document this size is pathological. */
const MAX_DOCUMENT_BYTES = 2_000_000;

/**
 * How much longer than the monitor's timeout Vigil waits for the
 * service.
 *
 * The renderer is told to give up navigating at `timeoutMs`, so in a
 * healthy setup it always answers first — with a page-load failure,
 * which is a real `down`. This grace is what makes our own abort mean
 * something different: if it fires, the *service* did not answer, and
 * that is `misconfigured` rather than a verdict about the page.
 */
const SERVICE_GRACE_MS = 2_000;

export async function realBrowserProbe(
  ctx: ProbeContext<RealBrowserConfig>,
  fallbackServiceUrl: string | null = env.BROWSER_SERVICE_URL ?? null,
): Promise<ProbeResult> {
  const service = ctx.config.serviceUrl ?? fallbackServiceUrl;
  if (service === null) {
    return unavailable(
      "No headless-browser service is configured. Set BROWSER_SERVICE_URL to a browserless-compatible renderer (for example http://browserless:3000), or give this monitor its own serviceUrl.",
    );
  }
  if (!URL.canParse(service)) {
    return unavailable(
      `The configured headless-browser service is not a URL: ${service}`,
    );
  }
  if (!URL.canParse(ctx.target)) {
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: "Invalid URL",
    };
  }

  // The browser is the one that dials the target, so the egress guard
  // cannot pin the address the way it does for an ordinary HTTP check.
  // Refusing a target that resolves into private space is the half that
  // still works, and without it this type would be a hole every other
  // type closes: "fetch this URL for me" is exactly the request an SSRF
  // wants, and a rendering service will happily perform it.
  const guard = await refusesPrivate(
    new URL(ctx.target).hostname,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const endpoint = `${service.replace(/\/+$/, "")}/content`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/html",
  };
  // A header rather than the `?token=` query parameter the renderer also
  // accepts: a query string ends up in the service's access log, in
  // every proxy in between, and in `EgressBlockedError` messages.
  if (ctx.config.token !== null) {
    headers.authorization = `Bearer ${ctx.config.token}`;
  }

  const startedAt = performance.now();
  try {
    const { response } = await egressFetch(
      endpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify(renderRequest(ctx)),
        signal: AbortSignal.timeout(ctx.timeoutMs + SERVICE_GRACE_MS),
      },
      {
        ...monitorEgress(ctx),
        // A renderer that answers a POST with a redirect is not a
        // renderer. Following it would replay the request — token
        // included — somewhere nobody configured.
        maxRedirects: 0,
      },
    );

    const responseTimeMs = elapsedSince(startedAt);
    const body = await readCappedText(response, MAX_DOCUMENT_BYTES);

    if (response.status === 200) {
      const document = body.text;
      const keyword = ctx.config.bodyKeyword;
      return {
        facts: {
          // Whitespace only is nothing rendered. A browser that
          // navigated successfully and produced an empty document is a
          // white screen, which is the failure this type exists to see.
          rendered: document.trim().length > 0,
          contentBytes: body.bytes,
          ...(keyword === null
            ? {}
            : { keywordPresent: document.includes(keyword) }),
          responseTimeMs,
        },
        responseTimeMs,
        // Deliberately null. The 200 here is the *renderer* answering,
        // and putting it in the column the monitor list prints as "the
        // status code" would claim the page returned 200 — which this
        // API never tells us, and which is false every time a browser
        // renders somebody's styled 500 page.
        statusCode: null,
        error: null,
      };
    }

    return interpretServiceStatus(
      response.status,
      body.text,
      responseTimeMs,
      service,
    );
  } catch (error) {
    // Every branch here is about reaching the *renderer*, which has
    // measured nothing about the page.
    if (error instanceof EgressBlockedError) {
      return unavailable(
        `The headless-browser service at ${service} cannot be reached: ${error.message}. A renderer on a private network needs ALLOW_PRIVATE_MONITOR_TARGETS.`,
      );
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return unavailable(
        `The headless-browser service at ${service} did not answer within ${ctx.timeoutMs + SERVICE_GRACE_MS}ms.`,
      );
    }
    const message =
      error instanceof Error
        ? error.cause instanceof Error
          ? error.cause.message
          : error.message
        : "the request failed";
    return unavailable(
      `The headless-browser service at ${service} could not be reached: ${message}`,
    );
  }
}

/**
 * The render request. Exported because it is the whole of what this
 * check asks the browser to do, and the shape a service has to
 * understand is documented by it.
 */
export function renderRequest(
  ctx: Pick<ProbeContext<RealBrowserConfig>, "target" | "config" | "timeoutMs">,
): Record<string, unknown> {
  return {
    url: ctx.target,
    gotoOptions: {
      // Not `load`: a single-page app fires `load` on its empty shell,
      // and reading the DOM there would assert against the very thing
      // this type exists to see past. Waiting for the network to go
      // quiet is what puts the rendered content in the document.
      waitUntil: "networkidle2",
      timeout: ctx.timeoutMs,
    },
    ...(ctx.config.settleMs > 0 ? { waitForTimeout: ctx.config.settleMs } : {}),
  };
}

/**
 * What a non-200 from the renderer means. Pure and exported: this is the
 * decision the whole type turns on, and the transport around it is
 * plumbing.
 *
 * The split is between "the browser tried and the page failed" — which
 * is the monitored site being down — and everything else, which is this
 * install's own problem.
 */
export function interpretServiceStatus(
  status: number,
  body: string,
  responseTimeMs: number,
  service: string,
): ProbeResult {
  // 400 is how browserless reports a navigation that failed:
  // ERR_NAME_NOT_RESOLVED, ERR_CONNECTION_REFUSED, a TLS error, or a
  // navigation timeout. The browser did its job and the page did not
  // load, so this is the outage — reported as a transport failure, with
  // the browser's own words, because that is what a failed fetch is.
  if (status === 400 || status === 408) {
    return {
      facts: { responseTimeMs },
      responseTimeMs,
      statusCode: null,
      error: browserMessage(body),
    };
  }
  if (status === 401 || status === 403) {
    return unavailable(
      `The headless-browser service at ${service} rejected Vigil's credentials. Check the monitor's token.`,
      responseTimeMs,
    );
  }
  if (status === 404) {
    return unavailable(
      `${service} has no /content endpoint. Point this at a browserless-compatible renderer.`,
      responseTimeMs,
    );
  }
  if (status === 429) {
    return unavailable(
      `The headless-browser service at ${service} is out of concurrency slots. Give it more workers, or check fewer pages at once.`,
      responseTimeMs,
    );
  }
  return unavailable(
    `The headless-browser service at ${service} answered ${status}: ${browserMessage(body)}`,
    responseTimeMs,
  );
}

/** The renderer's explanation, trimmed to something an alert can carry. */
function browserMessage(body: string): string {
  const first = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined) return "The page did not load";
  return first.length > 300 ? `${first.slice(0, 300)}…` : first;
}

/** Reads up to `maxBytes` of the body as text, then stops the download. */
async function readCappedText(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", bytes: 0 };
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { text, bytes };
}

function unavailable(
  reason: string,
  responseTimeMs: number | null = null,
): ProbeResult {
  return {
    facts: responseTimeMs === null ? {} : { responseTimeMs },
    responseTimeMs,
    statusCode: null,
    error: null,
    unavailable: reason,
  };
}
