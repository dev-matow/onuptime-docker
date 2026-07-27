import dns from "node:dns/promises";

import { isPrivateAddress } from "../../net";

/**
 * The SSRF posture every connecting probe shares: a domain-validated
 * target can still resolve to 10.0.0.1, so resolve first and refuse.
 *
 * Known limit, unchanged from 1.9.x: the subsequent connection
 * re-resolves, so a rebinding DNS server could flip records between the
 * two lookups. Closing it means pinning the resolved IP through the
 * transport, which is a 2.0 change (it also removes the second
 * `getaddrinfo` that caps throughput).
 */
export async function refusesPrivate(
  host: string,
  allow: boolean | undefined,
): Promise<string | null> {
  if (allow) return null;
  try {
    const addresses = await dns.lookup(host, { all: true });
    if (addresses.some(({ address }) => isPrivateAddress(address))) {
      return "Target resolves to a private address";
    }
  } catch {
    return "DNS resolution failed";
  }
  return null;
}

/** Milliseconds since `startedAt`, rounded — every probe reports this. */
export function elapsedSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/**
 * The message to report for a failed connection.
 *
 * When every address of a multi-homed host fails, Node raises an
 * `AggregateError` whose own `message` is the EMPTY STRING, with the real
 * reasons in `.errors`. `judge` tests `if (result.error)`, so an empty
 * string is falsy — the probe reports no transport failure and the check
 * is judged on its assertions instead. Depending on the type that means
 * a dead server filed as an assertion failure, or, for a type whose
 * assertions all skip on missing facts, filed as UP.
 *
 * Every serious mail host and database endpoint has multiple A records,
 * so this is the common path rather than an edge case. Two probes hit it
 * independently on the day this codebase grew a driver-based check.
 */
export function connectionErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const message = connectionErrorMessage(inner, "");
      if (message) return message;
    }
    return error.message || fallback;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
