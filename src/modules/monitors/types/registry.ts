import type {
  CheckTypeDefinition,
  ProbeContext,
  ProbeResult,
} from "./contract";
import { domainExpiryProbe } from "./probes/domain-expiry";
import { dnsProbe } from "./probes/dns";
import { httpProbe } from "./probes/http";
import { pingProbe } from "./probes/ping";
import { tcpProbe } from "./probes/tcp";
import { tlsExpiryProbe } from "./probes/tls-expiry";
import { CHECK_TYPE_SPECS } from "./specs";

/**
 * The check-type registry: every spec joined to its probe.
 *
 * Server-only — importing this pulls in `node:dns`, `node:net`,
 * `node:tls` and `node:child_process`. Anything that needs a type's
 * metadata in the browser imports `catalog.ts`; anything that needs its
 * validation imports `specs/`.
 *
 * The registry is a plain map on purpose. It is shaped for a loader —
 * a type is one self-contained object, and nothing here knows the set
 * of ids at compile time — but it does not have one. Publishing an
 * extension contract now would freeze it against six types; the
 * contract ships in 2.0 once enough first-party types have proved it.
 */
type AnyProbe = (context: ProbeContext<never>) => Promise<ProbeResult>;

const PROBES: Readonly<Record<string, AnyProbe>> = {
  http: httpProbe as AnyProbe,
  tcp: tcpProbe as AnyProbe,
  ping: pingProbe as AnyProbe,
  dns: dnsProbe as AnyProbe,
  "tls-expiry": tlsExpiryProbe as AnyProbe,
  "domain-expiry": domainExpiryProbe as AnyProbe,
};

function build(): Record<string, CheckTypeDefinition<unknown>> {
  const definitions: Record<string, CheckTypeDefinition<unknown>> = {};
  for (const [id, spec] of Object.entries(CHECK_TYPE_SPECS)) {
    const probe = PROBES[id];
    // A spec without a probe is unreachable code that would fail at the
    // worst moment — the first check of a monitor someone just created.
    if (!probe) throw new Error(`Check type "${id}" has no probe`);
    definitions[id] = {
      ...spec,
      probe: probe as CheckTypeDefinition<unknown>["probe"],
    };
  }
  return definitions;
}

export const CHECK_TYPES: Readonly<
  Record<string, CheckTypeDefinition<unknown>>
> = build();

export function findCheckType(
  id: string,
): CheckTypeDefinition<unknown> | undefined {
  return Object.hasOwn(CHECK_TYPES, id) ? CHECK_TYPES[id] : undefined;
}

export function requireCheckType(id: string): CheckTypeDefinition<unknown> {
  const definition = findCheckType(id);
  if (!definition) throw new Error(`Unknown check type: ${id}`);
  return definition;
}
