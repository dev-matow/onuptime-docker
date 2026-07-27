import type { CheckTypeSpec } from "../contract";
import { domainExpirySpec } from "./domain-expiry";
import { dnsSpec } from "./dns";
import { httpSpec } from "./http";
import { pingSpec } from "./ping";
import { tcpSpec } from "./tcp";
import { tlsExpirySpec } from "./tls-expiry";

/**
 * Every type's spec, keyed by id. Isomorphic — safe for the server
 * action layer, which needs the zod schemas but must not pull a
 * transport into the request path.
 */

/**
 * Erases a spec's config type.
 *
 * A registry holds specs with mutually incompatible `Config` types, and
 * TypeScript has no existential types to express "some config, used
 * consistently". The consistency is real — `fromRow` produces exactly
 * what this spec's own assertions, probe and `describeTarget` consume,
 * and nothing else ever constructs one — so the cast is sound. It is
 * confined to this one function so no call site has to repeat it.
 */
function erase<Config>(spec: CheckTypeSpec<Config>): CheckTypeSpec<unknown> {
  return spec as unknown as CheckTypeSpec<unknown>;
}

export const CHECK_TYPE_SPECS: Readonly<
  Record<string, CheckTypeSpec<unknown>>
> = {
  http: erase(httpSpec),
  tcp: erase(tcpSpec),
  ping: erase(pingSpec),
  dns: erase(dnsSpec),
  "tls-expiry": erase(tlsExpirySpec),
  "domain-expiry": erase(domainExpirySpec),
};

export function findSpec(id: string): CheckTypeSpec<unknown> | undefined {
  return Object.hasOwn(CHECK_TYPE_SPECS, id) ? CHECK_TYPE_SPECS[id] : undefined;
}

/** Throws for an unknown id — use at write time, where a bad type is a bug. */
export function requireSpec(id: string): CheckTypeSpec<unknown> {
  const spec = findSpec(id);
  if (!spec) throw new Error(`Unknown check type: ${id}`);
  return spec;
}

export {
  domainExpirySpec,
  dnsSpec,
  httpSpec,
  pingSpec,
  tcpSpec,
  tlsExpirySpec,
};
