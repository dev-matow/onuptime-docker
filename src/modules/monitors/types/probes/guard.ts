import dns from "node:dns/promises";

import {
  egressBlockReason,
  egressPolicyFor,
  type EgressFetchOptions,
} from "../../egress";
import {
  classifyAddress,
  isForbiddenEgressHost,
  normalizeHost,
} from "../../net";
import type { ProbeContext } from "../contract";

/**
 * The egress options an HTTP-speaking probe runs under: the monitor
 * channel's policy, with the check's own `allowPrivateTargets` as the
 * override, and the context's transport so an injected `fetchImpl`
 * still reaches the wire.
 */
export function monitorEgress(
  ctx: Pick<
    ProbeContext<unknown>,
    "allowPrivateTargets" | "fetchImpl" | "lookup"
  >,
): EgressFetchOptions {
  return {
    policy: egressPolicyFor("monitor", ctx.allowPrivateTargets),
    fetchImpl: ctx.fetchImpl,
    lookup: ctx.lookup,
  };
}

/**
 * The SSRF posture shared by the probes that open their own sockets —
 * tcp, tls, smtp, the database drivers, ping, docker. A
 * domain-validated target can still resolve to 10.0.0.1, so resolve
 * first and refuse.
 *
 * The HTTP-family probes do **not** use this: they go through
 * `modules/monitors/egress.ts`, which validates every redirect hop and
 * then connects to the address it validated. This function cannot do
 * the second half. Its ten callers each dial on their own socket —
 * `net.connect`, `tls.connect`, a Postgres client, a Mongo client — and
 * every one of those performs a lookup this function never saw. It is
 * therefore the one place a rebinding DNS server still has a window;
 * the residual is written down in SECURITY.md rather than papered over,
 * because closing it means a pinned address threaded through ten
 * call sites and several third-party clients.
 *
 * That asymmetry is also why an unresolvable name is refused here while
 * the egress module lets it through: there, no address means no
 * connection; here, our resolver failing says nothing about what the
 * driver's will do.
 *
 * `allow` widens private and loopback space only. A metadata or
 * link-local target is refused whatever the setting says — the point of
 * `ALLOW_PRIVATE_MONITOR_TARGETS` is to monitor your own LAN in
 * development, never to read the instance's credentials.
 */
export async function refusesPrivate(
  host: string,
  allow: boolean | undefined,
  /**
   * How the hostname becomes addresses. Injectable for the same reason
   * the transport is: this resolves before every socket these probes
   * open, so without it a probe test that never intends to touch the
   * network still performs a real lookup — and a suite of two thousand
   * such tests fails in a different test each run whenever a resolver
   * is slow. Unset in production; the system resolver is the right one.
   */
  lookup: ProbeContext<unknown>["lookup"] = undefined,
): Promise<string | null> {
  const hostname = normalizeHost(host);
  if (isForbiddenEgressHost(hostname)) {
    return egressBlockReason(classifyAddress(hostname) ?? "metadata");
  }
  if (allow) return null;
  try {
    const addresses = await (lookup
      ? lookup(hostname)
      : dns.lookup(hostname, { all: true }));
    for (const { address } of addresses) {
      const classification = classifyAddress(address) ?? "reserved";
      if (classification !== "public") {
        return egressBlockReason(classification);
      }
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
