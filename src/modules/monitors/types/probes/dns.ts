import { Resolver } from "node:dns/promises";

import type { ProbeContext, ProbeResult } from "../contract";
import type { DnsConfig } from "../specs/dns";
import { elapsedSince } from "./guard";

/**
 * A DNS record check.
 *
 * No private-address guard here, deliberately: this probe never
 * connects to what it resolves. Refusing to *look up* an internal name
 * would break the legitimate case (watching that an internal CNAME
 * still exists) while preventing nothing — the answer never becomes a
 * request.
 *
 * Uses `Resolver` rather than `dns.lookup` so the query actually goes to
 * a nameserver. `lookup` consults `/etc/hosts` and the OS cache, which
 * would make a DNS monitor report on the worker's own resolver state
 * instead of on DNS.
 */

/**
 * The slice of `Resolver` this probe uses. Injectable so the probe's
 * behaviour — how each record type is flattened, which failures are
 * answers and which are transport errors — is testable offline.
 */
export interface DnsResolver {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveCname(name: string): Promise<string[]>;
  resolveNs(name: string): Promise<string[]>;
  resolveMx(name: string): Promise<{ priority: number; exchange: string }[]>;
  resolveTxt(name: string): Promise<string[][]>;
}

export type DnsResolverFactory = (timeoutMs: number) => DnsResolver;

const systemResolver: DnsResolverFactory = (timeoutMs) =>
  new Resolver({ timeout: timeoutMs, tries: 1 });

export async function dnsProbe(
  ctx: ProbeContext<DnsConfig>,
  createResolver: DnsResolverFactory = systemResolver,
): Promise<ProbeResult> {
  const resolver = createResolver(ctx.timeoutMs);
  const startedAt = performance.now();

  try {
    const records = await resolve(resolver, ctx.target, ctx.config.recordType);
    const responseTimeMs = elapsedSince(startedAt);
    return {
      facts: {
        records,
        recordCount: records.length,
        responseTimeMs,
      },
      responseTimeMs,
      statusCode: null,
      error: null,
    };
  } catch (error) {
    const responseTimeMs = elapsedSince(startedAt);
    const code = (error as NodeJS.ErrnoException).code;

    // NODATA and NOTFOUND are answers, not failures: the nameserver
    // replied and said "nothing here". That is exactly what the
    // `resolves` assertion is for, so record zero records and let the
    // type's own judgment produce the message.
    if (code === "ENODATA" || code === "ENOTFOUND") {
      return {
        facts: { records: [], recordCount: 0, responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: null,
      };
    }

    return {
      facts: {},
      responseTimeMs,
      statusCode: null,
      error: describeDnsError(code, error),
    };
  }
}

export async function resolve(
  resolver: DnsResolver,
  name: string,
  recordType: DnsConfig["recordType"],
): Promise<string[]> {
  switch (recordType) {
    case "A":
      return resolver.resolve4(name);
    case "AAAA":
      return resolver.resolve6(name);
    case "CNAME":
      return resolver.resolveCname(name);
    case "NS":
      return resolver.resolveNs(name);
    case "MX":
      return (await resolver.resolveMx(name))
        .sort((a, b) => a.priority - b.priority)
        .map((record) => `${record.priority} ${record.exchange}`);
    case "TXT":
      // A TXT record arrives as chunks that must be concatenated —
      // long values (SPF, DKIM) are split at 255 bytes on the wire.
      return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""));
  }
}

export function describeDnsError(
  code: string | undefined,
  error: unknown,
): string {
  switch (code) {
    case "ETIMEOUT":
    case "ETIMEDOUT":
      return "The nameserver did not answer in time";
    case "ESERVFAIL":
      return "The nameserver returned SERVFAIL";
    case "ECONNREFUSED":
      return "The nameserver refused the query";
    case "EREFUSED":
      return "The nameserver refused to answer";
    default:
      return error instanceof Error ? error.message : "DNS lookup failed";
  }
}
