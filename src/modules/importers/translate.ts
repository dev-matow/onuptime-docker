import { DNS_RECORD_TYPES } from "@/modules/monitors/types/catalog";
import {
  MAX_FAILURE_WINDOW_SECONDS,
  MAX_INTERVAL_SECONDS,
  MIN_FAILURE_WINDOW_SECONDS,
  MIN_INTERVAL_SECONDS,
} from "@/modules/monitors/schemas";

import type { SourceCheck, SourceCheckKind } from "./model";
import { clamp, hostOf, stripUrlCredentials, vigilJsonPath } from "./rewrite";

/**
 * Capability mapping: one `SourceCheck` as Vigil's create input, plus
 * everything worth saying about the journey.
 *
 * This is the only place in the migration feature that knows both what a
 * competitor stores and what Vigil can hold, and it is deliberately the
 * only one. An adapter that reached for `checkType: "http"` directly
 * would be deciding, alone and untested, what a POST with three headers
 * and a JSON assertion becomes; fourteen adapters doing that is fourteen
 * different answers, and the wrong ones are invisible because the
 * monitor they produce looks fine.
 *
 * Two rules run through every branch:
 *
 * 1. **Never invent an equivalence.** A POST is not a GET with the body
 *    left off. A list of three accepted status codes is not the first
 *    one. Where Vigil cannot express what the source meant, the value is
 *    dropped and the drop is reported, or the row is refused outright
 *    when what is left would watch a different thing.
 * 2. **Nothing disappears quietly.** Everything that does not survive
 *    the trip leaves either a `note` (it imported, and it means
 *    something else) or a `refusal` (it did not import, and here is
 *    why). Both end up on the report.
 *
 * Pure and free of `node:` imports so the whole mapping can be exercised
 * without a database, which is what makes the edge cases affordable to
 * test: the interesting rows are the ones that never reach Postgres.
 */

/** Vigil's create input before validation. */
type RawInput = Record<string, unknown>;

export interface Build {
  input: RawInput;
  /** What changed on the way across. Empty means a clean import. */
  notes: string[];
  /** Why this check cannot become a monitor. Empty means it can. */
  refusals: string[];
}

export type Translation =
  | { outcome: "build"; build: Build }
  /** Vigil has no check that means this, so no row is even attempted. */
  | { outcome: "unsupported"; detail: string };

/** Vigil's name column stops at 100 characters. */
const MAX_NAME_LENGTH = 100;
const MAX_KEYWORD_LENGTH = 200;
const MAX_DNS_EXPECTED_LENGTH = 255;

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;

const MIN_WARN_DAYS = 1;
const MAX_WARN_DAYS = 365;

const MAX_GRACE_SECONDS = 86_400;

/** Which Vigil check type each source kind becomes. */
const CHECK_TYPE_BY_KIND: Readonly<Record<SourceCheckKind, string | null>> = {
  http: "http",
  json: "json-query",
  ping: "ping",
  tcp: "tcp",
  udp: null,
  dns: "dns",
  tls: "tls-expiry",
  domain: "domain-expiry",
  smtp: "smtp",
  imap: "imap",
  ftp: "ftp",
  ssh: "ssh",
  ntp: "ntp",
  websocket: "websocket",
  grpc: "grpc",
  heartbeat: "push",
  group: "group",
  unsupported: null,
};

/**
 * Why a kind Vigil *has* a check type for is still refused.
 *
 * `udp` is the only entry, and it is here rather than repeated in five
 * adapters because the reason is a property of Vigil's UDP check rather
 * than of any one vendor. Its descriptor says it outright: "UDP answers
 * nothing it was not asked, so the check needs a payload the service
 * will reply to." This importer does not carry request payloads, by
 * design, so an imported UDP monitor would send an empty datagram, wait,
 * hear nothing, and report an outage that is not one, every interval,
 * forever. A monitor that is permanently and wrongly down is worse than
 * no monitor: it is the thing that teaches an operator to ignore the
 * product.
 */
const REFUSED_KINDS: Partial<Record<SourceCheckKind, string>> = {
  udp: "Not imported. Vigil's UDP check has to send the payload the service replies to, because UDP answers nothing it was not asked, and this importer does not copy request payloads out of a monitoring account. An imported UDP monitor would send an empty datagram and report a permanent outage. Recreate it in Vigil, where the payload and the expected reply are settings on the check.",
};

/**
 * Ports where the protocol begins with a TLS handshake.
 *
 * Vigil's SMTP, IMAP and FTP probes are plaintext throughout and say so
 * in their own files: 465, 993 and 990 "expect a TLS handshake before a
 * single byte" of the protocol, so the probe never gets a greeting. A
 * monitor imported onto one of them reads down forever. It is refused
 * rather than imported, and the report says which port and why.
 */
const IMPLICIT_TLS_PORTS: Readonly<Record<string, readonly number[]>> = {
  smtp: [465],
  imap: [993],
  ftp: [990],
};

function nameFor(check: SourceCheck, notes: string[]): string {
  const name =
    check.name.trim().length > 0 ? check.name.trim() : check.sourceId;
  if (name.length <= MAX_NAME_LENGTH) return name;
  const cut = name.slice(0, MAX_NAME_LENGTH).trimEnd();
  notes.push(
    `The name was cut to "${cut}": Vigil's name column stops at ${MAX_NAME_LENGTH} characters.`,
  );
  return cut;
}

const DEFAULT_INTERVAL_SECONDS = 60;

/**
 * The interval, clamped, or the default when the source did not state
 * one.
 *
 * Non-positive is **not** clamped up to Vigil's two-second floor, and
 * that distinction is the whole reason this reads the way it does.
 * StatusCake publishes `check_rate: 0` as a value a check can hold, and
 * several of these APIs return a zero for a field they never set.
 * Clamping that to the floor would take a check that ran every five
 * minutes and point it at the customer's production endpoint thirty
 * times a second, which is a migration causing the outage it was meant
 * to watch for. So a non-positive interval is treated as "not stated",
 * gets Vigil's default, and is reported: the operator did choose a
 * schedule, and this is not reproducing it.
 */
function intervalFor(check: SourceCheck, notes: string[]): number {
  const requested = check.intervalSeconds;
  if (requested === undefined) return DEFAULT_INTERVAL_SECONDS;
  if (requested <= 0) {
    notes.push(
      `The source stored an interval of ${requested}, which is not a schedule this importer can read, so the monitor arrives on Vigil's default of ${DEFAULT_INTERVAL_SECONDS}s. Set it on the monitor page.`,
    );
    return DEFAULT_INTERVAL_SECONDS;
  }
  const applied = clamp(
    Math.round(requested),
    MIN_INTERVAL_SECONDS,
    MAX_INTERVAL_SECONDS,
  );
  if (applied !== requested) {
    notes.push(
      `Interval ${requested}s clamped to ${applied}s, Vigil's bound. Check the schedule if the difference matters.`,
    );
  }
  return applied;
}

function timeoutFor(check: SourceCheck, notes: string[]): number {
  if (check.timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  const requested = Math.round(check.timeoutMs);
  // Zero or negative is the source never having stored one rather than a
  // zero-second timeout, and nothing is lost by falling back to Vigil's
  // default, so nothing is reported.
  if (requested <= 0) return DEFAULT_TIMEOUT_MS;
  const applied = clamp(requested, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  if (applied !== requested) {
    notes.push(
      `Timeout ${requested}ms clamped to ${applied}ms, Vigil's bound.`,
    );
  }
  return applied;
}

/**
 * A retry policy as Vigil's failure window.
 *
 * The competitors count failures and space them by a retry interval;
 * Vigil asks how long the monitor has been failing. The product of the
 * two is the same wall-clock tolerance, which is the thing the operator
 * actually chose. A count with no interval is spaced by the check's own
 * interval, because that is what "confirm on the next N checks" means.
 */
function failureWindowFor(
  check: SourceCheck,
  intervalSeconds: number,
  notes: string[],
): number | undefined {
  const retries = check.retries;
  if (retries?.note !== undefined) notes.push(retries.note);
  if (retries?.windowSeconds !== undefined) {
    return clamp(
      Math.round(retries.windowSeconds),
      MIN_FAILURE_WINDOW_SECONDS,
      MAX_FAILURE_WINDOW_SECONDS,
    );
  }
  if (retries?.count === undefined) return undefined;
  const spacing = retries.intervalSeconds ?? intervalSeconds;
  return clamp(
    Math.round(retries.count * spacing),
    MIN_FAILURE_WINDOW_SECONDS,
    MAX_FAILURE_WINDOW_SECONDS,
  );
}

function warnDaysFor(
  requested: number | undefined,
  notes: string[],
): number | undefined {
  if (requested === undefined) return undefined;
  const applied = clamp(Math.round(requested), MIN_WARN_DAYS, MAX_WARN_DAYS);
  if (applied !== requested) {
    notes.push(
      `Certificate warning threshold ${requested} day(s) clamped to ${applied}, Vigil's bound.`,
    );
  }
  return applied;
}

/**
 * The one status expectation Vigil holds, from whatever the source
 * stored.
 *
 * Vigil's "no expectation" means any 2xx or 3xx passes, which is why a
 * single explicit code is the only expression that carries exactly. An
 * adapter should leave `acceptedStatus` unset when the check simply uses
 * the provider's default, so that the common case produces no note and
 * the report keeps its signal.
 */
function expectedStatusFrom(
  accepted: readonly string[] | undefined,
  notes: string[],
): number | undefined {
  if (accepted === undefined || accepted.length === 0) return undefined;
  const codes = accepted.map((code) => code.trim()).filter((c) => c.length > 0);
  if (codes.length === 0) return undefined;
  if (codes.length === 1 && /^\d{3}$/.test(codes[0] ?? "")) {
    return Number(codes[0]);
  }
  notes.push(
    `The accepted status codes ${codes.join(", ")} cannot be expressed: Vigil holds one expected code, or none, in which case any 2xx or 3xx passes. This monitor now accepts any 2xx or 3xx, so it will not alert on a code the source treated as a failure inside that range.`,
  );
  return undefined;
}

/** Everything the source did to an HTTP request that Vigil cannot. */
function noteHttpLosses(check: SourceCheck, notes: string[]): void {
  const http = check.http;
  if (http === undefined) return;
  if (http.headerNames !== undefined && http.headerNames.length > 0) {
    notes.push(
      `Custom request header(s) ${http.headerNames.join(", ")} not carried: Vigil's HTTP check sends its own headers only. Their values were never read from the source. If the endpoint needs one to answer, this monitor will report an outage that is not one.`,
    );
  }
  if (http.hasRequestBody === true) {
    notes.push(
      "The request body was not carried: Vigil's HTTP check issues GET and HEAD, neither of which has one.",
    );
  }
  if (http.hasBasicAuth === true) {
    notes.push(
      "HTTP authentication was not carried: Vigil's HTTP check has no credential field, and this importer does not read credentials out of a source system. An endpoint behind authentication will answer 401 here, so point the monitor at an unauthenticated health endpoint instead.",
    );
  }
  if (http.followRedirects === false) {
    notes.push(
      "The source did not follow redirects and Vigil does, one validated hop at a time. A monitor the source failed on a 301 will pass here if the destination answers.",
    );
  }
  for (const assertion of http.otherAssertions ?? []) {
    notes.push(`Assertion not carried: ${assertion}`);
  }
}

/** The URL Vigil should store, with any inline credential removed. */
function urlFor(
  check: SourceCheck,
  notes: string[],
  refusals: string[],
): string {
  const raw = check.target.url ?? "";
  if (raw.trim().length === 0) {
    refusals.push(
      "The source record carries no URL, so there is nothing for Vigil to request.",
    );
    return "";
  }
  const { url, hadCredentials } = stripUrlCredentials(raw);
  if (hadCredentials) {
    notes.push(
      "Credentials embedded in the URL were removed before storing it: Vigil's HTTP probe does not send them, and keeping them would put a password on the monitor page and in every incident notification. The value was not read.",
    );
  }
  return url;
}

/**
 * The bare hostname Vigil's non-URL types target.
 *
 * Several of these APIs keep a hostname in the same column as a URL, so
 * a customer who typed `https://gateway.example.com` into a ping check
 * gets it back verbatim. Reading the host out of that is not inventing
 * anything, it is the same host; refusing the row instead would lose a
 * monitor to a scheme nobody meant to store.
 */
function hostFor(check: SourceCheck, refusals: string[]): string {
  const raw = (check.target.host ?? "").trim();
  if (raw.length === 0) {
    refusals.push(
      "The source record carries no hostname, which is what Vigil's check of this kind targets.",
    );
    return "";
  }
  return raw.includes("://") ? (hostOf(raw) ?? raw) : raw;
}

/**
 * One source check as Vigil's create input.
 *
 * Exported so every branch can be exercised without a database. The rows
 * that never reach one are the rows worth testing.
 */
export function translateCheck(check: SourceCheck): Translation {
  if (check.kind === "unsupported") {
    return {
      outcome: "unsupported",
      detail:
        check.unsupportedReason ??
        `The source calls this a "${check.sourceType}" check and the adapter offered no reason it cannot be imported, which is itself the defect. Treat this monitor as not migrated.`,
    };
  }

  const checkType = CHECK_TYPE_BY_KIND[check.kind];
  if (checkType === null) {
    return {
      outcome: "unsupported",
      detail:
        REFUSED_KINDS[check.kind] ??
        `The source calls this a "${check.sourceType}" check and Vigil has no check type that means the same thing.`,
    };
  }

  const notes: string[] = [];
  const refusals: string[] = [];
  const intervalSeconds = intervalFor(check, notes);
  const failureWindowSeconds = failureWindowFor(check, intervalSeconds, notes);

  const input: RawInput = {
    name: nameFor(check, notes),
    checkType,
    intervalSeconds,
    timeoutMs: timeoutFor(check, notes),
  };
  if (failureWindowSeconds !== undefined) {
    input.failureWindowSeconds = failureWindowSeconds;
  }

  switch (check.kind) {
    case "http": {
      input.url = urlFor(check, notes, refusals);
      const method = (check.http?.method ?? "GET").toUpperCase();
      if (method === "GET" || method === "HEAD") {
        input.method = method;
      } else {
        refusals.push(
          `The source sends ${method}. Vigil's HTTP check issues GET or HEAD, so an imported monitor would request something the source never requested. Recreate it as a GET against an endpoint that answers one, or keep the ${method} check where it is.`,
        );
      }
      const expected = expectedStatusFrom(check.http?.acceptedStatus, notes);
      if (expected !== undefined) input.expectedStatusCode = expected;

      const keyword = check.http?.keyword;
      if (keyword !== undefined && keyword.length > 0) {
        if (keyword.length > MAX_KEYWORD_LENGTH) {
          notes.push(
            `The body assertion was not carried: it is ${keyword.length} characters and Vigil stores ${MAX_KEYWORD_LENGTH}. Truncating it would assert something the source never asserted, so this monitor watches availability only.`,
          );
        } else if (method === "HEAD") {
          notes.push(
            "The body assertion was not carried: the source asks for HEAD, which returns no body for Vigil to search.",
          );
        } else {
          input.bodyKeyword = keyword;
          input.keywordAbsent = check.http?.keywordAbsent === true;
        }
      }

      if (check.http?.checkCertificateExpiry === true) {
        input.tlsCheck = true;
        const warnDays = warnDaysFor(check.http.certificateWarnDays, notes);
        if (warnDays !== undefined) input.tlsWarnDays = warnDays;
      }
      noteHttpLosses(check, notes);
      break;
    }

    case "json": {
      input.url = urlFor(check, notes, refusals);
      const operator = check.http?.jsonOperator;
      if (operator !== undefined && operator !== "==" && operator !== "eq") {
        refusals.push(
          `The source compares the JSON value with "${operator}". Vigil's JSON check asserts equality and nothing else, so the comparison cannot be carried.`,
        );
      }
      const sourcePath = check.http?.jsonPath ?? "";
      const path = vigilJsonPath(sourcePath);
      if (path === null) {
        refusals.push(
          `The JSON path "${sourcePath}" cannot be rewritten as Vigil's dotted path. A wildcard, a filter or a recursive descent has no single location to read, and choosing one would assert something the source never asserted.`,
        );
      } else {
        if (path !== sourcePath.trim()) {
          notes.push(
            `JSON path rewritten from "${sourcePath}" to "${path}", Vigil's dotted form.`,
          );
        }
        input.config = {
          jsonPath: path,
          expectedValue: check.http?.jsonExpectedValue ?? "",
        };
      }
      noteHttpLosses(check, notes);
      break;
    }

    case "ping": {
      input.url = hostFor(check, refusals);
      break;
    }

    case "tcp":
    case "udp": {
      input.url = hostFor(check, refusals);
      if (check.target.port === undefined) {
        refusals.push(
          `A Vigil ${check.kind === "tcp" ? "TCP" : "UDP"} check needs a port and the source record carries none.`,
        );
      } else {
        input.port = check.target.port;
      }
      break;
    }

    case "smtp":
    case "imap":
    case "ftp":
    case "ssh":
    case "ntp":
    case "grpc": {
      input.url = hostFor(check, refusals);
      const port = check.target.port;
      if (port !== undefined) input.port = port;
      const implicitTls = IMPLICIT_TLS_PORTS[check.kind] ?? [];
      if (port !== undefined && implicitTls.includes(port)) {
        refusals.push(
          `The source watches port ${port}, which expects a TLS handshake before a single byte of ${check.kind.toUpperCase()}. Vigil's ${check.kind} check speaks plaintext and never issues STARTTLS, so an imported monitor would never be greeted and would report an outage that is not one, every interval. Watch the certificate with a TLS expiry monitor, or the port with a TCP monitor.`,
        );
      }
      break;
    }

    case "dns": {
      input.url = hostFor(check, refusals);
      const recordType = (check.dns?.recordType ?? "A").toUpperCase();
      const known: readonly string[] = DNS_RECORD_TYPES;
      if (!known.includes(recordType)) {
        refusals.push(
          `The source resolves ${recordType} records and Vigil resolves ${known.join(", ")}. Asking for a different record type would answer a different question.`,
        );
        break;
      }
      const expected = check.dns?.expectedValues ?? [];
      let expectedValue: string | null = null;
      if (expected.length === 1 && (expected[0] ?? "").length > 0) {
        const only = expected[0] ?? "";
        if (only.length > MAX_DNS_EXPECTED_LENGTH) {
          notes.push(
            `The expected DNS value was not carried: it is longer than the ${MAX_DNS_EXPECTED_LENGTH} characters Vigil stores. The monitor asserts that the name resolves at all.`,
          );
        } else {
          expectedValue = only;
        }
      } else if (expected.length > 1) {
        notes.push(
          `The source expected ${expected.length} values and Vigil asserts that at least one record contains one value. Carrying the first would assert less than the source did, so none was carried: this monitor asserts that the name resolves at all.`,
        );
      }
      if (check.dns?.resolver !== undefined) {
        notes.push(
          `The per-check resolver ${check.dns.resolver} was not carried: Vigil resolves through the worker's own resolver, so the answer this monitor judges is the answer your infrastructure gets.`,
        );
      }
      input.config = { recordType, expectedValue };
      break;
    }

    case "tls": {
      input.url = hostFor(check, refusals);
      if (check.target.port !== undefined) input.port = check.target.port;
      const warnDays = warnDaysFor(check.warnDays, notes);
      if (warnDays !== undefined) input.config = { warnDays };
      break;
    }

    case "domain": {
      const domain = (check.target.domain ?? "").trim();
      if (domain.length === 0) {
        refusals.push(
          "The source record carries no registrable domain, which is what Vigil's domain expiry check targets.",
        );
      }
      input.url = domain;
      const warnDays = warnDaysFor(check.warnDays, notes);
      if (warnDays !== undefined) input.config = { warnDays };
      break;
    }

    case "websocket": {
      input.url = urlFor(check, notes, refusals);
      break;
    }

    case "heartbeat": {
      // Nothing is dialled, so the target is a label: what the job is,
      // not where it is.
      input.url = check.target.label ?? check.name;
      const period = check.heartbeat?.periodSeconds;
      if (period !== undefined) {
        const applied = clamp(
          Math.round(period),
          MIN_INTERVAL_SECONDS,
          MAX_INTERVAL_SECONDS,
        );
        if (applied !== period) {
          notes.push(
            `The expected period ${period}s was clamped to ${applied}s, Vigil's bound.`,
          );
        }
        input.intervalSeconds = applied;
      }
      const grace = check.heartbeat?.graceSeconds;
      if (grace !== undefined) {
        input.config = {
          graceSeconds: clamp(Math.round(grace), 0, MAX_GRACE_SECONDS),
        };
      }
      if (check.heartbeat?.cron !== undefined) {
        notes.push(
          `The cron expression "${check.heartbeat.cron}" was not carried: Vigil expects a heartbeat every interval plus a grace period rather than at the times a cron names, so a job that runs on weekdays only will read as overdue at the weekend. Set the interval to the longest gap between runs.`,
        );
      }
      notes.push(
        "A new push token was generated, because a token is what authenticates one caller to one monitor and the source's token belongs to the source. Point the job at the endpoint on the monitor page.",
      );
      break;
    }

    case "group": {
      input.url = check.target.label ?? check.name;
      break;
    }
  }

  for (const loss of check.losses ?? []) notes.push(loss);
  for (const withheld of check.withheld ?? []) {
    notes.push(
      `Not read from the source, and therefore not carried: ${withheld}. This importer does not copy credentials out of a monitoring account.`,
    );
  }
  if (check.regions !== undefined && check.regions.length > 0) {
    notes.push(
      `The source ran this from ${check.regions.join(", ")}. Vigil checks from the worker that runs it, or from a remote probe you enrol; region names do not transfer, so assign a probe if you need the check to run from somewhere specific.`,
    );
  }

  return { outcome: "build", build: { input, notes, refusals } };
}
