/**
 * The migration model: what every source system is reduced to before
 * Vigil is asked to hold any of it.
 *
 * A provider adapter's whole job is to produce a `SourceSnapshot`. It
 * does not know what a Vigil monitor looks like, it does not open a
 * transaction, and it never decides whether something can be imported.
 * `translate.ts` answers the second question and `engine.ts` the third,
 * which is what keeps fourteen adapters from each inventing their own
 * idea of what a clamped interval or a refused row means.
 *
 * ── secrets ──────────────────────────────────────────────────────────
 *
 * **There is nowhere in this model to put a secret, and that is the
 * design.** No field holds a password, a bearer token, a header value or
 * an API key, so an adapter cannot leak one into a preview, a report, a
 * log line or a fixture by forgetting to redact it: there is no field to
 * forget. What the model carries instead is the *shape* of what was
 * there, which is what an operator actually needs.
 *
 *   `headerNames: ["Authorization", "X-Api-Key"]`   names, never values
 *   `hasBasicAuth: true`                            a fact, not a credential
 *   `withheld: ["the bearer token this check sends"]`
 *
 * The alternative, a `secrets: Record<string, string>` that everything
 * downstream promises to mask, is one forgotten `JSON.stringify` away
 * from putting a customer's production API key in an import report they
 * paste into a support ticket. Vigil's own check types do store
 * credentials, and they store them behind `secretFields` on the spec,
 * which is a different problem with a different answer: those values are
 * typed in by the operator, not copied out of a third party by a
 * machine.
 *
 * The consequence is real and worth stating plainly: a check whose only
 * meaning is its credential cannot be migrated in full, and the report
 * says so on that check's own line rather than producing a monitor that
 * authenticates with nothing.
 */

import type { SourceKind } from "./report";

/**
 * What the source system is watching, in terms Vigil can reason about.
 *
 * This is not the provider's own type name, which is kept verbatim in
 * `sourceType` and quoted in reports. It is the adapter's judgement
 * about which Vigil check, if any, means the same thing. `unsupported`
 * is a first-class answer and requires a reason: an adapter that cannot
 * decide must say so rather than guess, because a monitor built from a
 * guess looks right and nobody checks it again.
 */
export type SourceCheckKind =
  | "http"
  | "json"
  | "ping"
  | "tcp"
  | "udp"
  | "dns"
  | "tls"
  | "domain"
  | "smtp"
  | "imap"
  | "ftp"
  | "ssh"
  | "ntp"
  | "websocket"
  | "grpc"
  | "heartbeat"
  | "group"
  | "unsupported";

export interface SourceTarget {
  /** Full URL including scheme, for the kinds that request one. */
  url?: string;
  /** Bare hostname, for the kinds that dial one. */
  host?: string;
  port?: number;
  /** Registrable domain, for registration expiry. */
  domain?: string;
  /** A name for the kinds nothing dials: heartbeats and groups. */
  label?: string;
}

/**
 * What the source asked of an HTTP endpoint.
 *
 * Every field is optional because every provider answers a different
 * subset, and an adapter that fills in a default it did not read is
 * inventing an equivalence. Absent means "the source did not say",
 * which the translator treats differently from "the source said no".
 */
export interface SourceHttpRequest {
  /** Verbatim, uppercased. Vigil sends GET or HEAD and nothing else. */
  method?: string;
  /**
   * Verbatim status expressions: `"200"`, `"2xx"`, `"200-299"`, `"any"`.
   * Strings rather than numbers because the providers disagree about the
   * shape and the translator has to be able to say what it could not
   * express.
   */
  acceptedStatus?: readonly string[];
  /** Body assertion. `keywordAbsent` inverts it. */
  keyword?: string;
  keywordAbsent?: boolean;
  /** Header NAMES only. See the module comment. */
  headerNames?: readonly string[];
  hasRequestBody?: boolean;
  hasBasicAuth?: boolean;
  followRedirects?: boolean;
  /** A JSON body assertion, in the provider's own path syntax. */
  jsonPath?: string;
  jsonOperator?: string;
  jsonExpectedValue?: string;
  /** Certificate expiry watched as part of the request. */
  checkCertificateExpiry?: boolean;
  certificateWarnDays?: number;
  /**
   * Assertions the source made that are none of the above, already
   * worded for a report line. One string per assertion.
   */
  otherAssertions?: readonly string[];
}

export interface SourceDnsQuery {
  /** Verbatim: `"A"`, `"CNAME"`, `"SOA"`, `"PTR"`. */
  recordType?: string;
  /** Values the source expected the answer to contain. */
  expectedValues?: readonly string[];
  /** A resolver the source asked instead of the system one. */
  resolver?: string;
}

export interface SourceHeartbeat {
  /** How often the job is expected to report in. */
  periodSeconds?: number;
  /** How late it may be before the silence is a failure. */
  graceSeconds?: number;
  /** A cron expression the source scheduled it by. */
  cron?: string;
}

/**
 * How long the source tolerated failure before it alerted.
 *
 * Two shapes, because the providers use both. Most count failures and
 * space them by a retry interval; a few store the tolerance directly as
 * a duration, which is what Vigil's failure window already is. When
 * `windowSeconds` is set it wins, because it is the same measurement
 * rather than a reconstruction of it.
 */
export interface SourceRetryPolicy {
  count?: number;
  intervalSeconds?: number;
  /** The tolerance as a duration, when the source stored one. */
  windowSeconds?: number;
  /** Wording for anything about the policy Vigil cannot express. */
  note?: string;
}

export interface SourceCheck {
  /** Identity within the source system. Stable across reads. */
  sourceId: string;
  name: string;
  /** The provider's own type name, quoted in reports. Never invented. */
  sourceType: string;
  kind: SourceCheckKind;
  /** Required when `kind` is `"unsupported"`, ignored otherwise. */
  unsupportedReason?: string;
  paused: boolean;
  target: SourceTarget;
  intervalSeconds?: number;
  timeoutMs?: number;
  retries?: SourceRetryPolicy;
  http?: SourceHttpRequest;
  dns?: SourceDnsQuery;
  heartbeat?: SourceHeartbeat;
  /** Certificate expiry warning threshold, for `tls` and `domain`. */
  warnDays?: number;
  /**
   * The folder or group path this check sat in, outermost first.
   *
   * A path rather than an id because the providers disagree about
   * whether groups are rows, strings or folders, and the engine creates
   * one Vigil group monitor per distinct path segment chain.
   */
  groupPath?: readonly string[];
  /** Vigil has no monitor tags. Carried so the report can name them. */
  tags?: readonly string[];
  /** Probe locations the source ran this from. */
  regions?: readonly string[];
  /**
   * Capabilities the source used that Vigil cannot express, each already
   * a complete sentence. These become report lines whether or not the
   * check imports.
   */
  losses?: readonly string[];
  /**
   * Fields the adapter deliberately did not read because their value is
   * a secret, each a noun phrase: "the bearer token this check sends".
   */
  withheld?: readonly string[];
}

export interface SourceStatusPage {
  sourceId: string;
  name: string;
  /** The provider's slug or subdomain, or null when it has none. */
  slug: string | null;
  published: boolean;
  /** `sourceId`s of the checks published on it, in the source's order. */
  checkIds: readonly string[];
  losses?: readonly string[];
}

/**
 * A record that is not a check and never becomes one.
 *
 * Alert policies, integrations, probe locations, browser scripts, teams.
 * None of them import; all of them get a line, because the operator is
 * about to turn the old system off and the thing that hurts is the
 * capability nobody mentioned.
 */
export interface SourceExtra {
  kind: Exclude<SourceKind, "monitor" | "group">;
  sourceId: string;
  label: string;
  detail: string;
}

/** Everything one adapter read, and nothing about how it read it. */
export interface SourceSnapshot {
  /** The adapter id, e.g. `"pingdom"`. */
  provider: string;
  /**
   * Facts about the read itself, rendered above the report: which API
   * version answered, how many pages were fetched, which account.
   * Never a credential, and never anything derived from one.
   */
  facts: readonly string[];
  checks: readonly SourceCheck[];
  statusPages: readonly SourceStatusPage[];
  extras: readonly SourceExtra[];
}
