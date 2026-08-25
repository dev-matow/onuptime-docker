import type { BurstRecord, EvidenceStage, EvidenceStageVerdict } from "./types";

/**
 * Turning what was observed into a layer, without inventing one.
 *
 * Two inputs and a strict order of precedence between them. A
 * diagnostic step that re-probed a layer and watched it fail is the
 * only thing that gets to say `measured`. Failing that, the probe's own
 * error is read for the codes that name a layer on their own -
 * `ENOTFOUND` came out of a resolver, `ECONNREFUSED` came out of a
 * kernel, `CERT_HAS_EXPIRED` came out of a TLS stack - and that is
 * `reported`. Failing that, `unknown`.
 *
 * The case worth stating is the one this file refuses to guess at. A
 * bare timeout is the most common failure a monitor sees and it names
 * no layer at all: a request that took longer than ten seconds could
 * have stalled in the resolver, in the connect, in the handshake or in
 * the application, and the error text cannot tell them apart. Filing it
 * as `tcp` because most timeouts are would put a sentence on an
 * incident page that is wrong one time in three, and an operator who
 * finds that out once stops reading the field. So a timeout is
 * `unknown` unless a diagnostic step resolved it.
 */

/** Codes and phrases that identify a layer on their own. */
const DNS_TOKENS = [
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NODATA",
  "NXDOMAIN",
  "SERVFAIL",
  "getaddrinfo",
  "did not resolve",
  "DNS resolution failed",
] as const;

const TCP_TOKENS = [
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EHOSTDOWN",
  "ENETDOWN",
  "EPIPE",
  "Connection refused",
] as const;

/**
 * Deliberately specific, and it used to be the opposite.
 *
 * The bare substrings `certificate` and `handshake` were in this list,
 * which meant any failure whose text happened to contain either was
 * filed as a TLS problem: an API answering `{"error":"invalid client
 * certificate"}` is an application rejecting a credential, an LDAP bind
 * that mentions a handshake is not a TLS handshake, and a keyword
 * assertion against a page about certificates matched too. Each entry
 * here must be something only a TLS stack emits.
 */
const TLS_TOKENS = [
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_UNTRUSTED",
  "ERR_TLS",
  "ERR_SSL",
  "EPROTO",
  "wrong version number",
  "TLS handshake",
  "SSL handshake",
  "SSL routines",
  "certificate has expired",
  "certificate verify failed",
  "unable to get local issuer certificate",
  "self signed certificate",
  "The peer presented no certificate",
] as const;

/** Phrases that mean "it stopped, and nothing said where". */
const TIMEOUT_TOKENS = [
  "Timed out",
  "timed out",
  "ETIMEDOUT",
  "TimeoutError",
  "The operation was aborted",
] as const;

function contains(haystack: string, tokens: readonly string[]): string | null {
  for (const token of tokens) {
    if (haystack.includes(token)) return token;
  }
  return null;
}

export interface ObservedFailure {
  error: string | null;
  failureClass: string | null;
  statusCode: number | null;
  /** True when the check type runs a scripted browser journey. */
  browser?: boolean;
  /**
   * Whether this check type dials anything at all.
   *
   * False for a heartbeat (judged by silence), a group (derived from its
   * members) and a manual monitor (declared by an operator). Their
   * failures are `assertion` failures like any other, and without this
   * they were reported as "the target was reachable" - a claim about a
   * network round trip that never happened. Defaults to true, because
   * thirty-nine of the forty-two types do dial.
   */
  dials?: boolean;
}

/** The layer an error names on its own, or null when it names none. */
function reportedTransportStage(
  error: string,
): { stage: EvidenceStage; reason: string } | null {
  const dns = contains(error, DNS_TOKENS);
  if (dns) {
    return {
      stage: "dns",
      reason: `The resolver answered with ${dns}, so the name did not resolve.`,
    };
  }
  const tls = contains(error, TLS_TOKENS);
  if (tls) {
    return { stage: "tls", reason: `The failure names the TLS layer: ${tls}.` };
  }
  const tcp = contains(error, TCP_TOKENS);
  if (tcp) {
    return {
      stage: "tcp",
      reason: `The connection failed with ${tcp}, before any response arrived.`,
    };
  }
  return null;
}

/**
 * A normalised form of a failure, for asking "did these two fail the
 * same way".
 *
 * A code when there is one, `HTTP_<status>` when the target answered,
 * and otherwise the error text with everything variable removed:
 * digits, quoted strings, parenthesised asides and the host itself all
 * differ between two monitors that failed identically. What is left is
 * a shape, prefixed `text:` so a reader can see it is the weaker kind.
 *
 * Null when there is nothing to normalise. Null never matches null -
 * see `correlate.ts` - because "neither of them said anything" is not a
 * shared cause.
 */
export function failureSignature(
  failure: Pick<ObservedFailure, "error" | "statusCode">,
): string | null {
  const { error, statusCode } = failure;
  if (error === null || error.trim() === "") {
    return statusCode === null ? null : `HTTP_${statusCode}`;
  }

  const code = contains(error, [
    ...DNS_TOKENS,
    ...TCP_TOKENS,
    ...TLS_TOKENS,
    ...TIMEOUT_TOKENS,
  ]);
  // An error carrying a recognised code AND a status code is an
  // application failure whose transport worked; the status is the more
  // specific of the two, so it wins.
  if (statusCode !== null) return `HTTP_${statusCode}`;
  if (code) return code.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

  const shape = error
    .replace(/\d+/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 80);
  return shape === "" ? null : `text:${shape}`;
}

/**
 * The first step in the burst that failed, which is the layer the burst
 * proved. Steps run outermost-first, so the first failure is the
 * innermost layer that was still reachable.
 */
function measuredStage(
  burst: BurstRecord | null,
): { stage: EvidenceStage; reason: string } | null {
  if (!burst || burst.steps.length === 0) return null;
  for (const step of burst.steps) {
    if (step.ok) continue;
    // A step Vigil abandoned, or refused to make, is a fact about Vigil.
    // Reading it as a measurement would report "the connection failed"
    // when what happened is that the diagnostic budget ran out while the
    // connection was still being attempted.
    if (step.selfInflicted) continue;
    const detail = step.error ?? "the step failed";
    switch (step.kind) {
      case "dns":
        return {
          stage: "dns",
          reason: `Re-resolving the hostname failed: ${detail}`,
        };
      case "tcp":
        return {
          stage: "tcp",
          reason: `The hostname resolved, but connecting to the port failed: ${detail}`,
        };
      case "tls":
        return {
          stage: "tls",
          reason: `The port accepted a connection, but the TLS handshake failed: ${detail}`,
        };
      case "http":
        return {
          stage: "http",
          reason: `The connection succeeded and the HTTP request failed: ${detail}`,
        };
    }
  }
  // Every step passed. That is evidence too, and it is evidence that
  // the failure was not at any layer the burst can reach - but it is
  // NOT evidence of what the failure was, and it is not a recovery
  // either: these steps ran seconds after the observation, from one
  // vantage point, against a target that may have already come back.
  return null;
}

/** The HTTP status a burst step observed, when one did. */
function burstStatus(burst: BurstRecord | null): number | null {
  const http = burst?.steps.find((step) => step.kind === "http");
  const status = http?.detail.statusCode;
  return typeof status === "number" ? status : null;
}

export function classifyStage(
  failure: ObservedFailure,
  burst: BurstRecord | null = null,
): EvidenceStageVerdict {
  const measured = measuredStage(burst);
  if (measured) {
    return {
      stage: measured.stage,
      basis: "measured",
      reason: measured.reason,
    };
  }

  // The probe could not run at all. That is an operator problem, not a
  // layer, and calling it one would file a missing capability as an
  // outage of the target.
  if (failure.failureClass === "misconfigured") {
    return {
      stage: "unknown",
      basis: "unknown",
      reason:
        "The check could not run in this environment, so nothing was " +
        "observed about the target.",
    };
  }

  const error = failure.error ?? "";

  // A journey that failed INSIDE the page is a browser failure. One that
  // never reached the page is not, however browser-shaped the check type
  // is: `page.goto: getaddrinfo ENOTFOUND` is a resolver answer, and
  // filing it as `browser` would point an operator at their own
  // JavaScript while DNS was down. The transport tokens are read first
  // for exactly that reason, and `browser` is only claimed for a
  // declared assertion, which is the case where the page loaded and
  // something in it did not hold.
  if (failure.browser === true && failure.failureClass === "assertion") {
    // A journey's step message is the one place an `assertion` failure
    // can carry a transport error: the runner reports "the step failed"
    // whether the step could not find the host or found it and disliked
    // the page. So the transport tokens are read FIRST here, and they
    // win - including over the application branch below, which would
    // otherwise catch this by failure class and report a reachable
    // target for a name that does not resolve.
    const transport = reportedTransportStage(error);
    if (transport !== null) {
      return {
        stage: transport.stage,
        basis: "reported",
        reason: transport.reason,
      };
    }
    return {
      stage: "browser",
      basis: "assertion",
      reason:
        "A scripted browser journey reached the page and a step failed. " +
        "The failed step and its timing are recorded below.",
    };
  }

  // The target answered. Whatever else is true, the transport worked -
  // and the observation itself proves it, so this needs no burst.
  if (failure.statusCode !== null) {
    if (failure.failureClass === "assertion") {
      return {
        stage: "application",
        basis: "assertion",
        reason:
          `The target answered with HTTP ${failure.statusCode} and a ` +
          "declared assertion did not hold, so the request reached the " +
          "application.",
      };
    }
    return {
      stage: "http",
      basis: "reported",
      reason: `The target answered with HTTP ${failure.statusCode}.`,
    };
  }

  // What re-probing saw, when it saw anything. Deliberately NOT a stage:
  // a burst whose every step passed has established that the failure was
  // not at any layer it can reach, which is not the same as establishing
  // that it WAS at the last layer it touched. Reporting an all-passing
  // burst as a measured HTTP failure - which the first version of this
  // did - tells an operator the application is broken on the strength of
  // a request that succeeded.
  const status = burstStatus(burst);
  const reprobed =
    status === null
      ? ""
      : ` Re-probing reached the target seconds later and it answered with HTTP ${status}.`;

  if (failure.failureClass === "assertion") {
    // Only for a check that actually dialled something. A heartbeat
    // whose silence ran out, a group derived from its members and an
    // operator's own "this is down" are all `assertion` failures, and
    // none of them reached a target at all - "so the target was
    // reachable" would be a sentence with no observation behind it.
    if (failure.dials === false) {
      return {
        stage: "unknown",
        basis: "unknown",
        reason:
          "This monitor's state is declared or derived rather than dialled, " +
          "so there is no network layer to name." +
          reprobed,
      };
    }
    return {
      stage: "application",
      basis: "assertion",
      reason:
        "The probe measured the target and a declared assertion did not " +
        "hold, so the target was reachable." +
        reprobed,
    };
  }

  const transport = reportedTransportStage(error);
  if (transport) {
    return {
      stage: transport.stage,
      basis: "reported",
      reason: transport.reason + reprobed,
    };
  }

  const timeout = contains(error, TIMEOUT_TOKENS);
  if (timeout) {
    return {
      stage: "unknown",
      basis: "unknown",
      reason:
        "The check timed out. A timeout does not say which layer stalled, " +
        "and nothing re-probed the target in time to establish one." +
        reprobed,
    };
  }

  return {
    stage: "unknown",
    basis: "unknown",
    reason:
      (error === ""
        ? "The check failed and recorded no reason."
        : `The failure does not name a layer: ${error}`) + reprobed,
  };
}
