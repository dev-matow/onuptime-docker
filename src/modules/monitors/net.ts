/**
 * What an address *is* — the one place in the product that decides.
 *
 * Every outbound path asks this module the same question: monitor
 * probes, every redirect hop, webhook delivery, recovery triggers, and
 * the zod schemas that validate a target before it is ever saved. A
 * range learned here is learned everywhere, which is the whole point:
 * the 1.12 tree had three separate opinions about `169.254.169.254` and
 * two of them could be walked around.
 *
 * Deliberately dependency-free — no `node:net`, no zod. The monitor and
 * recovery forms validate with the same classifier the worker enforces,
 * and a `node:` import here would drag the worker's transport into the
 * browser bundle. That is also why the IPv6 parser is written out
 * rather than delegated: `net.isIPv6` only answers "is this well
 * formed", and the encodings that matter here (`::ffff:a.b.c.d`,
 * `::ffff:c0a8:0101`, `64:ff9b::`, `2002::`) are all well formed.
 */

export type AddressClass =
  /** Globally routable unicast — the only class allowed unconditionally. */
  | "public"
  /** RFC1918, CGNAT, IPv6 ULA and site-local. Reachable only by policy. */
  | "private"
  /** 127.0.0.0/8 and ::1. Reachable only by policy. */
  | "loopback"
  /** 169.254.0.0/16 and fe80::/10. Never reachable. */
  | "link-local"
  /** Cloud instance metadata. Never reachable, in any encoding. */
  | "metadata"
  /** 0.0.0.0 and ::. Never reachable. */
  | "unspecified"
  /** Multicast, broadcast, documentation, benchmarking, future use. */
  | "reserved";

export interface ParsedAddress {
  family: 4 | 6;
  classification: AddressClass;
}

/**
 * Hostnames that are a metadata endpoint by name rather than by
 * address. Blocking the IP alone is not enough: these resolve inside
 * the instance and an operator can type them straight into a target
 * field.
 */
export const FORBIDDEN_HOSTNAMES: ReadonlySet<string> = new Set([
  "metadata.google.internal",
  "metadata.goog",
]);

/**
 * The IMDS address every major cloud shares. Exported because the
 * monitor schemas re-export it as part of their public surface; the
 * classifier below is what actually enforces it, in every encoding.
 */
export const METADATA_IP = "169.254.169.254";

/** ECS/EKS task metadata, which is a different address on the same /16. */
const METADATA_IPV4 = new Set([METADATA_IP, "169.254.170.2"]);

/**
 * Classes no policy may ever unblock. Private and loopback are absent
 * on purpose — reaching an internal runbook endpoint is a shipped
 * feature. Reaching the credential vending machine is not, and neither
 * is anything that is not a real unicast destination.
 */
const NEVER_REACHABLE: ReadonlySet<AddressClass> = new Set<AddressClass>([
  "metadata",
  "link-local",
  "unspecified",
  "reserved",
]);

/**
 * The classification of an IP literal, or null when `value` is not an
 * IP literal at all.
 *
 * Null is a third answer rather than a fallback class because the two
 * callers need opposite defaults: a *resolved* address that will not
 * parse must be refused, while a *hostname* that will not parse is the
 * ordinary case and must be resolved instead.
 */
export function classifyAddress(value: string): AddressClass | null {
  return parseAddress(value)?.classification ?? null;
}

export function parseAddress(value: string): ParsedAddress | null {
  const address = normalizeHost(value);
  const v4 = parseIPv4(address);
  if (v4) return { family: 4, classification: classifyIPv4(v4) };
  const v6 = parseIPv6(address);
  if (v6) return { family: 6, classification: classifyIPv6(v6) };
  return null;
}

/**
 * Address-level SSRF predicate: true for anything that is not a public
 * unicast destination.
 *
 * Named for what it defends rather than for what it matches — callers
 * report "resolves to a private address" — but it covers loopback,
 * link-local, metadata and reserved space too. An unparseable input is
 * refused: this is only ever asked about the output of a resolver, and
 * an address a resolver produced that this module cannot read is not
 * something to connect to.
 */
export function isPrivateAddress(address: string): boolean {
  return classifyAddress(address) !== "public";
}

/**
 * Whether a host may never be an egress target, whatever the policy.
 *
 * Takes the host as written — a hostname, a bare IPv4, or a bracketed
 * IPv6 out of `URL.hostname` — so input validation and execution-time
 * enforcement agree by construction. `[::ffff:169.254.169.254]` is the
 * form that walked around the literal string comparison this replaces.
 */
export function isForbiddenEgressHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (FORBIDDEN_HOSTNAMES.has(normalized)) return true;
  const classification = classifyAddress(normalized);
  return classification !== null && NEVER_REACHABLE.has(classification);
}

/**
 * The same question asked of a whole URL, for the schemas and services
 * that hold one. Unparseable is not forbidden — that is the URL check's
 * verdict to give, and a second opinion here would report a typo as a
 * security refusal.
 */
export function isForbiddenEgressUrl(value: string): boolean {
  try {
    return isForbiddenEgressHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** Whether policy is even allowed to permit this class. */
export function isNeverReachable(classification: AddressClass): boolean {
  return NEVER_REACHABLE.has(classification);
}

/**
 * Lower-cased, unbracketed, zone-stripped. `URL.hostname` keeps the
 * brackets on an IPv6 literal and a scope id rides along on link-local
 * addresses (`fe80::1%eth0`); both would defeat a straight comparison.
 */
export function normalizeHost(host: string): string {
  const withoutZone = host.split("%")[0] ?? "";
  const unbracketed =
    withoutZone.startsWith("[") && withoutZone.endsWith("]")
      ? withoutZone.slice(1, -1)
      : withoutZone;
  return unbracketed.toLowerCase();
}

/* ------------------------------------------------------------------ */
/* IPv4                                                                */
/* ------------------------------------------------------------------ */

/**
 * Strict dotted quad. Leading zeros are rejected rather than parsed:
 * `010.0.0.1` is octal to some resolvers and decimal to others, and a
 * classifier that guesses is a classifier that can be walked around.
 */
function parseIPv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

/**
 * The special-purpose registry (RFC 6890) rather than "RFC1918 plus the
 * ones I remembered". The three TEST-NET blocks and 198.18/15 are here
 * because they are routed somewhere unpredictable, not because they are
 * dangerous — an outbound monitor aimed at them is a mistake either
 * way, and there is no cost to saying so.
 */
function classifyIPv4(octets: number[]): AddressClass {
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  if (a === 0)
    return b === 0 && c === 0 && d === 0 ? "unspecified" : "reserved";
  if (a === 10) return "private";
  if (a === 127) return "loopback";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT
  if (a === 169 && b === 254) {
    return METADATA_IPV4.has(octets.join(".")) ? "metadata" : "link-local";
  }
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 0 && c === 0) return "reserved"; // IETF protocol
  if (a === 192 && b === 0 && c === 2) return "reserved"; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return "reserved"; // 6to4 relay
  if (a === 192 && b === 168) return "private";
  if (a === 198 && (b === 18 || b === 19)) return "reserved"; // benchmarking
  if (a === 198 && b === 51 && c === 100) return "reserved"; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return "reserved"; // TEST-NET-3
  if (a >= 224) return "reserved"; // multicast, future use, broadcast
  return "public";
}

/* ------------------------------------------------------------------ */
/* IPv6                                                                */
/* ------------------------------------------------------------------ */

/**
 * Eight hextets, or null. Handles `::` elision and a trailing dotted
 * quad, which is the whole reason this exists: every IPv6 encoding of
 * private space has to reduce to the same numbers before it can be
 * classified, and prefix-matching the printed string cannot do that.
 */
function parseIPv6(value: string): number[] | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ?? "";
  const tail = halves.length === 2 ? (halves[1] ?? "") : null;

  const leading = expandGroups(head);
  const trailing = tail === null ? [] : expandGroups(tail);
  if (leading === null || trailing === null) return null;

  if (tail === null) {
    return leading.length === 8 ? leading : null;
  }
  const gap = 8 - leading.length - trailing.length;
  // An elision has to stand for at least one hextet; `1:2:3:4:5:6:7::8`
  // is eight groups with a `::` that elides nothing, and is not an
  // address.
  if (gap < 1) return null;
  return [...leading, ...Array<number>(gap).fill(0), ...trailing];
}

function expandGroups(segment: string): number[] | null {
  if (segment.length === 0) return [];
  const tokens = segment.split(":");
  const hextets: number[] = [];
  for (const [index, token] of tokens.entries()) {
    // A dotted quad is only an address in the last position, where it
    // stands for the low two hextets.
    if (token.includes(".")) {
      if (index !== tokens.length - 1) return null;
      const octets = parseIPv4(token);
      if (!octets) return null;
      hextets.push(
        ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
        ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
      );
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
    hextets.push(Number.parseInt(token, 16));
  }
  return hextets.length > 8 ? null : hextets;
}

function classifyIPv6(hextets: number[]): AddressClass {
  const at = (index: number): number => hextets[index] ?? 0;
  const zeros = (from: number, to: number): boolean =>
    hextets.slice(from, to + 1).every((hextet) => hextet === 0);

  if (zeros(0, 7)) return "unspecified";
  if (zeros(0, 6) && at(7) === 1) return "loopback";

  // Every encoding that carries an IPv4 address inside it is classified
  // by that address. Skipping this is how `::ffff:169.254.169.254`
  // reached the metadata service through a check that only knew how to
  // read dotted quads.
  const embedded = embeddedIPv4(hextets);
  if (embedded) return classifyIPv4(embedded);

  if (at(0) === 0x2001 && at(1) === 0x0000) return "reserved"; // Teredo
  if (at(0) === 0x2001 && at(1) === 0x0db8) return "reserved"; // documentation
  if (at(0) === 0x0100 && zeros(1, 3)) return "reserved"; // discard-only
  if ((at(0) & 0xff00) === 0xff00) return "reserved"; // multicast
  if ((at(0) & 0xffc0) === 0xfe80) return "link-local";
  if ((at(0) & 0xffc0) === 0xfec0) return "private"; // site-local (deprecated)
  // fd00:ec2::254 — AWS IMDS on an IPv6-only instance. Checked before
  // the ULA prefix it sits inside, which policy is allowed to permit.
  if (at(0) === 0xfd00 && at(1) === 0x0ec2 && zeros(2, 6) && at(7) === 0x0254) {
    return "metadata";
  }
  if ((at(0) & 0xfe00) === 0xfc00) return "private"; // unique local
  return "public";
}

/** The IPv4 an address embeds, for the prefixes that embed one. */
function embeddedIPv4(hextets: number[]): number[] | null {
  const at = (index: number): number => hextets[index] ?? 0;
  const zeros = (from: number, to: number): boolean =>
    hextets.slice(from, to + 1).every((hextet) => hextet === 0);
  const split = (hextet: number): number[] => [hextet >> 8, hextet & 0xff];
  const low = (): number[] => [...split(at(6)), ...split(at(7))];

  // ::ffff:0:0/96 (mapped), ::/96 (compatible, deprecated but still
  // routed by some stacks) and ::ffff:0:0:0/96 (translated). `::` and
  // `::1` never reach here — they are classified above.
  if (zeros(0, 4) && (at(5) === 0xffff || at(5) === 0x0000)) return low();
  if (zeros(0, 3) && at(4) === 0xffff && at(5) === 0x0000) return low();
  // 64:ff9b::/96 — NAT64, an IPv4 destination wearing an IPv6 address.
  if (at(0) === 0x0064 && at(1) === 0xff9b && zeros(2, 5)) return low();
  // 2002::/16 — 6to4 carries its IPv4 in the next two hextets.
  if (at(0) === 0x2002) return [...split(at(1)), ...split(at(2))];
  return null;
}
