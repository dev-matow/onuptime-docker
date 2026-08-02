import { MIN_INTERVAL_SECONDS } from "../schemas";
import { CHECK_TYPE_DESCRIPTORS } from "../types/catalog";

/**
 * What each check type costs to run, and how often it may be run.
 *
 * ── where this belongs, and where it is ──────────────────────────────
 *
 * These three fields are properties of a check type and belong on
 * `CheckTypeDescriptor` beside `supportsRecovery` and
 * `requiresCapability`, which answer questions of exactly the same
 * shape. They are here instead because `types/catalog.ts` is being
 * edited by several people at once while new types land, and a map
 * keyed by type id can be folded onto the descriptor in one commit
 * afterwards without any caller changing. `everyTypeHasCapabilities`
 * (tests/unit/high-frequency-capabilities.test.ts) fails the build if a
 * registered type is missing an entry, which is the property the
 * descriptor would have given for free.
 *
 * ── why a type is excluded ───────────────────────────────────────────
 *
 * Not squeamishness about load. Each excluded type has a specific
 * reason why twice a second is either impossible or actively harmful,
 * and "it would probably be fine" is not one of the reasons.
 */

/**
 * What one probe of this type consumes, in the terms that decide whether
 * it can run twice a second.
 *
 * - `cheap` — one socket, one round trip, no subprocess, and the answer
 *   comes from the operator's own infrastructure.
 * - `moderate` — a protocol handshake, a resolver, or a connection a
 *   server has to authenticate and tear down. Affordable on the ordinary
 *   plane; at 2Hz it is a load test of somebody's database.
 * - `expensive` — spawns a process, or asks a third party. Both have a
 *   floor measured in tens of milliseconds of CPU or in someone else's
 *   rate limit.
 * - `derived` — no I/O at all. There is nothing to probe faster.
 */
export type CostClass = "cheap" | "moderate" | "expensive" | "derived";

export interface HighFrequencyCapability {
  /**
   * The shortest cadence this type may be asked for, in milliseconds.
   * For a type that is not high-frequency capable this is the ordinary
   * plane's floor, so the field always answers the same question.
   */
  minimumIntervalMs: number;
  supportsHighFrequency: boolean;
  costClass: CostClass;
  /** Why not, in one sentence, shown to the operator. Null when it can. */
  excludedBecause: string | null;
}

/**
 * The floor the high-frequency plane will accept, in milliseconds.
 *
 * 500 because that is the number the plane was built to deliver and the
 * number `docs/HIGH-FREQUENCY.md` reports measurements against. It is
 * not an aspiration: a request below it is refused rather than clamped,
 * because a clamp is how a product ends up accepting a number it does
 * not honour — which is the defect this entire plane exists to stop
 * repeating.
 */
export const HF_MIN_INTERVAL_MS = 500;

/**
 * The ceiling, and it is low on purpose.
 *
 * Above two seconds the ordinary pg-boss plane already delivers the
 * cadence — that is what `MIN_INTERVAL_SECONDS = 2` was measured to
 * mean. Offering a ten-second high-frequency monitor would be a second
 * implementation of something that already works, running on a plane
 * with worse failure properties (in-memory slots, lost on restart) for
 * no gain.
 */
export const HF_MAX_INTERVAL_MS = MIN_INTERVAL_SECONDS * 1000;

const ORDINARY_FLOOR_MS = MIN_INTERVAL_SECONDS * 1000;

function capable(costClass: CostClass): HighFrequencyCapability {
  return {
    minimumIntervalMs: HF_MIN_INTERVAL_MS,
    supportsHighFrequency: true,
    costClass,
    excludedBecause: null,
  };
}

function excluded(
  costClass: CostClass,
  excludedBecause: string,
): HighFrequencyCapability {
  return {
    minimumIntervalMs: ORDINARY_FLOOR_MS,
    supportsHighFrequency: false,
    costClass,
    excludedBecause,
  };
}

/**
 * Every registered type, and what it may be asked for.
 *
 * Keyed by id and exhaustive: a type added to the catalog without an
 * entry here fails a test rather than silently inheriting a default,
 * because the safe default and the useful default point in opposite
 * directions. Defaulting to "capable" would put a `ping` monitor —
 * which spawns `/bin/ping` — on a 500ms timer; defaulting to "not
 * capable" would quietly drop a new cheap type out of the feature and
 * nobody would notice for a release.
 */
export const HIGH_FREQUENCY_CAPABILITIES: Readonly<
  Record<string, HighFrequencyCapability>
> = {
  http: capable("cheap"),
  "json-query": capable("cheap"),
  tcp: capable("cheap"),

  // A resolver is shared infrastructure with its own cache semantics.
  // Probing it twice a second measures the cache, not the zone, and
  // every answer inside the record's TTL is the same answer.
  dns: excluded("moderate", "A DNS answer inside its TTL is the same answer."),
  // Spawns a process per probe. Two thousand forks a second is a fork
  // bomb with a nice UI.
  ping: excluded("expensive", "Each probe spawns a process."),
  // A full TLS handshake for a number that changes once a day.
  "tls-expiry": excluded(
    "moderate",
    "A certificate's expiry date changes once, months from now.",
  ),
  // RDAP is somebody else's service with somebody else's rate limit,
  // and the answer changes once a year.
  "domain-expiry": excluded(
    "expensive",
    "RDAP is a third-party service, and a registration date changes once a year.",
  ),
  // Every one of these opens a connection a server has to authenticate,
  // allocate for, and tear down. At 2Hz per monitor the probe is a
  // larger load on the target than the traffic it is watching for.
  postgres: excluded(
    "moderate",
    "Each probe is a database connection the server must authenticate.",
  ),
  mysql: excluded(
    "moderate",
    "Each probe is a database connection the server must authenticate.",
  ),
  mongodb: excluded(
    "moderate",
    "Each probe is a database connection the server must authenticate.",
  ),
  redis: excluded(
    "moderate",
    "Each probe is a connection the server must allocate and tear down.",
  ),
  mqtt: excluded(
    "moderate",
    "Each probe is a broker session with a CONNECT/CONNACK exchange.",
  ),
  smtp: excluded(
    "moderate",
    "Mail servers rate-limit and blocklist by connection frequency.",
  ),
  docker: excluded(
    "moderate",
    "The Docker daemon serialises API requests behind one lock.",
  ),

  // The three kinds that are never dialled. There is no probe to run
  // faster: a heartbeat arrives when the job sends it, a group changes
  // when a member does, and a manual status changes when a person says
  // so.
  push: excluded("derived", "Nothing is dialled. The job reports in."),
  group: excluded("derived", "A group's state is derived from its members."),
  manual: excluded("derived", "A manual status changes when an operator says."),

  // ── the types added alongside this plane ───────────────────────────
  //
  // Every one of them opens an authenticated session, drives a
  // multi-step protocol exchange, spawns something, or asks a third
  // party. None of them is a candidate for 2Hz, and each is excluded on
  // its own merits rather than by a blanket default — see the top of
  // this file for why there is no default.
  rabbitmq: excluded(
    "moderate",
    "Each probe is a management-API request the broker authenticates.",
  ),
  "kafka-producer": excluded(
    "expensive",
    "Each probe produces a real message to a real topic.",
  ),
  memcached: excluded(
    "moderate",
    "Each probe is a connection the server must allocate and tear down.",
  ),
  elasticsearch: excluded(
    "moderate",
    "A cluster-health request is work the cluster does, not a ping.",
  ),
  websocket: excluded(
    "moderate",
    "Each probe is a full HTTP upgrade handshake.",
  ),
  grpc: excluded("moderate", "Each probe is an HTTP/2 connection and an RPC."),
  ldap: excluded(
    "moderate",
    "Directory servers rate-limit and lock out by bind frequency.",
  ),
  ssh: excluded(
    "expensive",
    "An SSH handshake is public-key cryptography, and servers ban by connection rate.",
  ),
  imap: excluded(
    "moderate",
    "Mail servers rate-limit and blocklist by connection frequency.",
  ),
  ftp: excluded(
    "moderate",
    "FTP opens a control connection the server authenticates.",
  ),
  snmp: excluded(
    "moderate",
    "SNMP agents are embedded devices with far less CPU than the prober.",
  ),
  "system-service": excluded(
    "expensive",
    "Each probe asks the init system, which serialises requests.",
  ),
  steam: excluded("moderate", "Game servers rate-limit query traffic."),
  gamedig: excluded("moderate", "Game servers rate-limit query traffic."),
  udp: excluded(
    "moderate",
    "A UDP probe waits out its timeout to conclude anything, so its cost is the timeout.",
  ),
  ntp: excluded(
    "moderate",
    "Public NTP pools ban clients by query rate, and the answer changes by microseconds.",
  ),
  radius: excluded(
    "moderate",
    "RADIUS servers treat request floods as an attack.",
  ),
  sqlserver: excluded(
    "moderate",
    "Each probe is a database connection the server must authenticate.",
  ),
  oracledb: excluded(
    "moderate",
    "Each probe is a database connection the server must authenticate.",
  ),
  sip: excluded(
    "moderate",
    "SIP endpoints treat OPTIONS floods as a denial-of-service attempt.",
  ),
  "tailscale-ping": excluded(
    "expensive",
    "Each probe shells out to the Tailscale client.",
  ),
  "real-browser": excluded(
    "expensive",
    "Each probe drives a browser, which costs seconds and hundreds of megabytes.",
  ),
  globalping: excluded(
    "expensive",
    "Globalping is a third-party network with its own quota.",
  ),
};

/**
 * What this build knows about a type's cadence limits.
 *
 * An unregistered id gets the conservative answer rather than an
 * exception, for the same reason `describeCheckType` invents a
 * descriptor: a monitor created by a build with an extra type must stay
 * listable and editable after a downgrade, and the honest thing to say
 * about a type this build cannot run is that it cannot run it fast.
 */
export function highFrequencyCapability(
  checkType: string,
): HighFrequencyCapability {
  return (
    HIGH_FREQUENCY_CAPABILITIES[checkType] ??
    excluded("moderate", "This check type is not available in this build.")
  );
}

export function supportsHighFrequency(checkType: string): boolean {
  return highFrequencyCapability(checkType).supportsHighFrequency;
}

/** The ids that may go on the plane, in catalog order. */
export const HIGH_FREQUENCY_TYPE_IDS: readonly string[] =
  CHECK_TYPE_DESCRIPTORS.filter((descriptor) =>
    supportsHighFrequency(descriptor.id),
  ).map((descriptor) => descriptor.id);
