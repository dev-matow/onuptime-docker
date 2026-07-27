import tls from "node:tls";

import type { ProbeContext, ProbeResult } from "../contract";
import { DEFAULT_TLS_PORT, type TlsExpiryConfig } from "../specs/tls-expiry";
import { elapsedSince, refusesPrivate } from "./guard";

/**
 * A TLS handshake, kept for the certificate rather than the connection.
 *
 * Unlike the certificate reading folded into an `http` check — which is
 * best-effort and swallows every error, because there the request is
 * the real observation — this probe reports handshake failures. Here
 * the certificate *is* the observation, so being unable to fetch it is
 * a genuine transport failure and must not read as "no opinion".
 *
 * `rejectUnauthorized: false` is intentional: an expired or self-signed
 * certificate is precisely what an operator points this monitor at, and
 * refusing the handshake would make the monitor blind at the exact
 * moment it is supposed to speak up. The certificate is inspected, not
 * trusted, and nothing is sent over the socket.
 */
export async function tlsExpiryProbe(
  ctx: ProbeContext<TlsExpiryConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(ctx.target, ctx.allowPrivateTargets);
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_TLS_PORT;
  const startedAt = performance.now();

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const socket = tls.connect(
      {
        host: ctx.target,
        port,
        servername: ctx.target,
        timeout: ctx.timeoutMs,
        rejectUnauthorized: false,
      },
      () =>
        settle(
          certificateResult(
            socket.getPeerCertificate(),
            elapsedSince(startedAt),
          ),
        ),
    );

    socket.once("timeout", () =>
      settle({
        facts: {},
        responseTimeMs: elapsedSince(startedAt),
        statusCode: null,
        error: `TLS handshake timed out after ${ctx.timeoutMs}ms`,
      }),
    );
    socket.once("error", (error: Error) =>
      settle({
        facts: {},
        responseTimeMs: elapsedSince(startedAt),
        statusCode: null,
        error: error.message,
      }),
    );
  });
}

/**
 * Turns a peer certificate into facts. Pure, and exported, because this
 * is where every decision lives — the socket around it is plumbing.
 */
export function certificateResult(
  cert: PeerCertificateLike | null | undefined,
  responseTimeMs: number,
  nowMs: number = Date.now(),
): ProbeResult {
  if (!cert || !cert.valid_to) {
    return {
      facts: { responseTimeMs },
      responseTimeMs,
      statusCode: null,
      error: "The peer presented no certificate",
    };
  }

  const expiry = new Date(cert.valid_to).getTime();
  if (Number.isNaN(expiry)) {
    return {
      facts: { responseTimeMs },
      responseTimeMs,
      statusCode: null,
      error: `Unreadable certificate expiry: ${cert.valid_to}`,
    };
  }

  return {
    facts: {
      // Floored, so "expires in 0 days" means today rather than
      // "sometime in the next 24 hours" -- the assertion treats 0 as
      // already an outage and that has to be the honest reading.
      daysRemaining: Math.floor((expiry - nowMs) / 86_400_000),
      issuer: firstOf(cert.issuer?.O) ?? firstOf(cert.issuer?.CN),
      validTo: cert.valid_to,
      responseTimeMs,
    },
    responseTimeMs,
    statusCode: null,
    error: null,
  };
}

export interface PeerCertificateLike {
  valid_to?: string;
  // Node types these as string | string[]: a DN can legitimately repeat
  // an attribute, and a certificate with two O= components is exactly
  // the sort of thing a monitor gets pointed at.
  issuer?: { O?: string | string[]; CN?: string | string[] };
}

function firstOf(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
