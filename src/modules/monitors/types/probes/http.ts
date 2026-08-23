import type { LookupFunction } from "node:net";
import tls from "node:tls";

import {
  drainBodyCapped,
  EgressBlockedError,
  egressFetch,
  type ResolvedAddress,
} from "../../egress";
import { normalizeHost } from "../../net";
import type { ProbeContext, ProbeResult } from "../contract";
import type { HttpConfig } from "../specs/http";
import { elapsedSince, monitorEgress } from "./guard";

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
 *
 * `pin` is the address the egress guard already classified for this
 * host. Passing it makes this second socket land where the first one
 * did; without it a rebinding resolver gets a free handshake against
 * whatever it points at next, which is a port scan with a certificate
 * for a result.
 */
export async function checkTlsExpiryDays(
  host: string,
  port: number,
  timeoutMs: number,
  pin: ResolvedAddress | null = null,
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
      {
        host,
        port,
        servername: host,
        timeout: timeoutMs,
        // Read the certificate whatever the trust store thinks of it.
        //
        // `tls.connect` validates by default, and a failed validation
        // aborts the handshake before `getPeerCertificate` can be asked
        // anything — so the monitor whose entire job is to warn about
        // expiry reported nothing at all for the two certificates it
        // most needs to speak up about: one that has ALREADY expired,
        // and one signed by an internal CA, which is most of them on a
        // self-hosted network.
        //
        // Nothing is sent over this socket. It connects, reads the
        // certificate the peer presented, and hangs up; there is no
        // request to misdirect and no response to trust. Whether the
        // chain validates is a separate question from when it expires,
        // and conflating them is what made the answer null.
        rejectUnauthorized: false,
        ...(pin ? { lookup: pinnedLookup(pin) } : {}),
      },
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

function pinnedLookup(pin: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pin.address, family: pin.family }]);
    } else {
      callback(null, pin.address, pin.family);
    }
  };
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

  let attempt: RequestAttempt;
  try {
    attempt = await request(ctx);
  } catch (error) {
    // Refused by policy, before a packet left. Reported blank because
    // nothing was measured — and the certificate observation below is
    // skipped with it: a host the guard refused must not be reached on
    // a second socket either.
    if (error instanceof EgressBlockedError) return blank(error.message);
    throw error;
  }

  if (config.tlsCheck) {
    // Runs even when the request failed: an expiring certificate is
    // worth recording whatever the endpoint did, and a degraded-severity
    // assertion can never overturn the request's verdict.
    attempt.result.facts.tlsDaysRemaining = await checkTlsExpiryDays(
      normalizeHost(hostname),
      urlPort ? Number(urlPort) : 443,
      ctx.timeoutMs,
      attempt.pin,
    );
  }

  return attempt.result;
}

interface RequestAttempt {
  result: ProbeResult;
  /** The address hop 0 was pinned to, for the certificate read. */
  pin: ResolvedAddress | null;
}

async function request(ctx: ProbeContext<HttpConfig>): Promise<RequestAttempt> {
  const { config } = ctx;
  const startedAt = performance.now();
  try {
    // Redirects are followed — a health endpoint behind a canonical
    // redirect is ordinary — but by the egress loop, one validated hop
    // at a time. `redirect: "follow"` handed the whole chain to the
    // transport, so a 302 into `http://169.254.169.254/` was a request
    // the guard never saw.
    const { response, decisions } = await egressFetch(
      ctx.target,
      {
        method: config.method,
        signal: AbortSignal.timeout(ctx.timeoutMs),
        headers: { "user-agent": "vigil-monitor/1.0 (+https://github.com)" },
      },
      monitorEgress(ctx),
    );

    // A keyword assertion needs the body (GET only); otherwise the body
    // is read and DISCARDED up to the same cap the keyword path has
    // always had, then the download stops.
    //
    // It used to be `arrayBuffer()`, justified as keeping keep-alive
    // sockets reusable — a premise that was never true here: the egress
    // transport runs `agent: false`, so every check opens its own socket
    // and nothing could reuse it. What the full read actually did was
    // buffer the monitored server's entire body in worker memory,
    // bounded only by bandwidth × timeout — a monitor mispointed at a
    // download URL was a per-check spike in the hundreds of megabytes.
    // The cap changes one observable: `responseTimeMs` on a body LARGER
    // than the cap now stops counting at the cap instead of at the end
    // of the download, which for a body that size is the difference
    // between measuring the endpoint and measuring its file size.
    const wantsKeyword = config.bodyKeyword !== null && config.method === "GET";
    let keywordPresent: boolean | undefined;
    if (wantsKeyword) {
      const body = await readCappedText(response, MAX_KEYWORD_BODY_BYTES).catch(
        () => "",
      );
      keywordPresent = body.includes(config.bodyKeyword!);
    } else {
      await drainBodyCapped(response, MAX_KEYWORD_BODY_BYTES);
    }

    const responseTimeMs = elapsedSince(startedAt);
    return {
      pin: decisions[0]?.pin ?? null,
      result: {
        facts: {
          statusCode: response.status,
          responseTimeMs,
          ...(keywordPresent === undefined ? {} : { keywordPresent }),
        },
        responseTimeMs,
        statusCode: response.status,
        error: null,
      },
    };
  } catch (error) {
    if (error instanceof EgressBlockedError) throw error;
    const responseTimeMs = elapsedSince(startedAt);
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return {
        pin: null,
        result: {
          facts: { responseTimeMs },
          responseTimeMs,
          statusCode: null,
          error: `Timed out after ${ctx.timeoutMs}ms`,
        },
      };
    }
    const message =
      error instanceof Error
        ? error.cause instanceof Error
          ? error.cause.message
          : error.message
        : "Request failed";
    return {
      pin: null,
      result: {
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: message,
      },
    };
  }
}

function blank(error: string): ProbeResult {
  return { facts: {}, responseTimeMs: null, statusCode: null, error };
}
