import tls from "node:tls";

import type { ProbeContext, ProbeResult } from "../contract";
import type { HttpConfig } from "../specs/http";
import { elapsedSince, refusesPrivate } from "./guard";

/**
 * Cap on how much of a response body we read for a keyword assertion.
 * Bounds worker memory against a hostile or huge response; a health
 * endpoint's keyword appears far inside this window.
 */
const MAX_KEYWORD_BODY_BYTES = 1_000_000;

/** Reads up to `maxBytes` of the body as text, then stops the download. */
async function readCappedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
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
  return text;
}

/**
 * Days until the peer's TLS certificate expires, or null if the
 * handshake failed or the cert had no expiry. Best-effort — never
 * throws, because for an `http` monitor the certificate is an extra
 * observation and its absence must not fail the request.
 */
export async function checkTlsExpiryDays(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let settled = false;
    const settle = (value: number | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = tls.connect(
      { host, port, servername: host, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) return settle(null);
        const expiry = new Date(cert.valid_to).getTime();
        if (Number.isNaN(expiry)) return settle(null);
        settle(Math.floor((expiry - Date.now()) / 86_400_000));
      },
    );
    socket.once("timeout", () => settle(null));
    socket.once("error", () => settle(null));
  });
}

export async function httpProbe(
  ctx: ProbeContext<HttpConfig>,
): Promise<ProbeResult> {
  const { config } = ctx;
  let hostname: string;
  let urlPort: string;
  try {
    ({ hostname, port: urlPort } = new URL(ctx.target));
  } catch {
    return blank("Invalid URL");
  }

  const guard = await refusesPrivate(hostname, ctx.allowPrivateTargets);
  if (guard) return blank(guard);

  const result = await request(ctx);

  if (config.tlsCheck) {
    // Runs even when the request failed: an expiring certificate is
    // worth recording whatever the endpoint did, and a degraded-severity
    // assertion can never overturn the request's verdict.
    result.facts.tlsDaysRemaining = await checkTlsExpiryDays(
      hostname,
      urlPort ? Number(urlPort) : 443,
      ctx.timeoutMs,
    );
  }

  return result;
}

async function request(ctx: ProbeContext<HttpConfig>): Promise<ProbeResult> {
  const { config } = ctx;
  const startedAt = performance.now();
  try {
    const response = await ctx.fetchImpl(ctx.target, {
      method: config.method,
      redirect: "follow",
      signal: AbortSignal.timeout(ctx.timeoutMs),
      headers: { "user-agent": "vigil-monitor/1.0 (+https://github.com)" },
    });

    // A keyword assertion needs the body (GET only); otherwise drain and
    // discard so keep-alive sockets are reusable.
    const wantsKeyword = config.bodyKeyword !== null && config.method === "GET";
    let keywordPresent: boolean | undefined;
    if (wantsKeyword) {
      const body = await readCappedText(response, MAX_KEYWORD_BODY_BYTES).catch(
        () => "",
      );
      keywordPresent = body.includes(config.bodyKeyword!);
    } else {
      await response.arrayBuffer().catch(() => undefined);
    }

    const responseTimeMs = elapsedSince(startedAt);
    return {
      facts: {
        statusCode: response.status,
        responseTimeMs,
        ...(keywordPresent === undefined ? {} : { keywordPresent }),
      },
      responseTimeMs,
      statusCode: response.status,
      error: null,
    };
  } catch (error) {
    const responseTimeMs = elapsedSince(startedAt);
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return {
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: `Timed out after ${ctx.timeoutMs}ms`,
      };
    }
    const message =
      error instanceof Error
        ? error.cause instanceof Error
          ? error.cause.message
          : error.message
        : "Request failed";
    return {
      facts: { responseTimeMs },
      responseTimeMs,
      statusCode: null,
      error: message,
    };
  }
}

function blank(error: string): ProbeResult {
  return { facts: {}, responseTimeMs: null, statusCode: null, error };
}
