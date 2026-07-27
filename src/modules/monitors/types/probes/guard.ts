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
