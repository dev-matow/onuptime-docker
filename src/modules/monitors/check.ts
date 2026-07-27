import { judge, type FailureClass, type Verdict } from "./types/conditions";
import type { FactBag, MonitorRowView } from "./types/contract";
import { checkTlsExpiryDays, httpProbe } from "./types/probes/http";
import { tcpProbe } from "./types/probes/tcp";
import { findCheckType } from "./types/registry";
import { evaluateKeyword, httpSpec, type HttpConfig } from "./types/specs/http";
import type { TcpConfig } from "./types/specs/tcp";

export { checkTlsExpiryDays, evaluateKeyword };
export type { FailureClass, Verdict };

/**
 * The verdict shape the rest of the product consumes. The transport
 * fields are the ones that predate the registry and are still stored on
 * `monitor_checks`; `facts`, `verdict` and `failureClass` are what the
 * condition engine adds.
 */
export interface CheckOutcome {
  ok: boolean;
  degraded: boolean;
  statusCode: number | null;
  responseTimeMs: number | null;
  error: string | null;
  /** Days until the TLS cert expires, when an SSL check ran; else undefined. */
  tlsDaysRemaining?: number | null;
}

export interface CheckResult extends CheckOutcome {
  verdict: Verdict;
  failureClass: FailureClass;
  /** Everything the probe measured, for the ledger and the UI. */
  facts: FactBag;
  failedAssertions: string[];
}

/** Everything a probe needs, across transports. */
export interface CheckSpec {
  checkType: string;
  /** HTTP(S) URL, or — for every other type — the bare host or domain. */
  url: string;
  port: number | null;
  method: "GET" | "HEAD";
  timeoutMs: number;
  degradedThresholdMs: number;
  expectedStatusCode: number | null;
  bodyKeyword?: string | null;
  keywordAbsent?: boolean;
  tlsCheck?: boolean;
  tlsWarnDays?: number;
  /** Type-specific settings, for the types added since 1.10.0. */
  config?: unknown;
}

export interface CheckOptions {
  /** Permit private/loopback targets (development only). */
  allowPrivateTargets?: boolean;
  fetchImpl?: typeof fetch;
}

/** The legacy HTTP target shape, still used by unit tests and helpers. */
export interface CheckTarget {
  url: string;
  method: "GET" | "HEAD";
  timeoutMs: number;
  degradedThresholdMs: number;
  expectedStatusCode: number | null;
  bodyKeyword?: string | null;
  keywordAbsent?: boolean;
}

function rowView(spec: CheckSpec): MonitorRowView {
  return {
    checkType: spec.checkType,
    url: spec.url,
    port: spec.port,
    method: spec.method,
    timeoutMs: spec.timeoutMs,
    degradedThresholdMs: spec.degradedThresholdMs,
    expectedStatusCode: spec.expectedStatusCode,
    bodyKeyword: spec.bodyKeyword ?? null,
    keywordAbsent: spec.keywordAbsent ?? false,
    tlsCheck: spec.tlsCheck ?? false,
    tlsWarnDays: spec.tlsWarnDays ?? 14,
    config: spec.config ?? null,
  };
}

/**
 * The single entry point the worker and the recovery loop use.
 *
 * Dispatch, probe, judge — in that order and nowhere else. A caller
 * never sees a type-specific code path, which is what makes adding a
 * type a matter of registering one object.
 */
export async function performCheck(
  spec: CheckSpec,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const definition = findCheckType(spec.checkType);

  // An unknown type is an operator-visible configuration problem, not
  // an outage. It happens on downgrade, or when a monitor was created
  // by a build that had a type this one does not.
  if (!definition) {
    return {
      ok: false,
      degraded: false,
      statusCode: null,
      responseTimeMs: null,
      error: `Check type "${spec.checkType}" is not available in this build.`,
      verdict: "indeterminate",
      failureClass: "misconfigured",
      facts: {},
      failedAssertions: [],
    };
  }

  const config = definition.fromRow(rowView(spec));
  const result = await definition.probe({
    target: spec.url,
    port: spec.port,
    config,
    timeoutMs: spec.timeoutMs,
    allowPrivateTargets: options.allowPrivateTargets ?? false,
    fetchImpl: options.fetchImpl ?? fetch,
  });

  const verdict = judge(definition.assertions, config, result);

  return {
    ok: verdict.ok,
    degraded: verdict.degraded,
    statusCode: result.statusCode ?? null,
    responseTimeMs: result.responseTimeMs,
    error: verdict.error,
    ...(typeof result.facts.tlsDaysRemaining === "number" ||
    result.facts.tlsDaysRemaining === null
      ? { tlsDaysRemaining: result.facts.tlsDaysRemaining }
      : {}),
    verdict: verdict.verdict,
    failureClass: verdict.failureClass,
    facts: result.facts,
    failedAssertions: verdict.failedAssertions,
  };
}

function httpConfigFrom(target: CheckTarget): HttpConfig {
  return {
    method: target.method,
    expectedStatusCode: target.expectedStatusCode,
    degradedThresholdMs: target.degradedThresholdMs,
    bodyKeyword: target.bodyKeyword ?? null,
    keywordAbsent: target.keywordAbsent ?? false,
    tlsCheck: false,
    tlsWarnDays: 14,
  };
}

/**
 * One HTTP probe, judged. Kept as a named export because it is the
 * narrowest thing to test a transport against; production goes through
 * `performCheck`.
 */
export async function performHttpCheck(
  target: CheckTarget,
  options: CheckOptions = {},
): Promise<CheckOutcome> {
  const config = httpConfigFrom(target);
  const result = await httpProbe({
    target: target.url,
    port: null,
    config,
    timeoutMs: target.timeoutMs,
    allowPrivateTargets: options.allowPrivateTargets ?? false,
    fetchImpl: options.fetchImpl ?? fetch,
  });
  const verdict = judge(httpSpec.assertions, config, result);
  return {
    ok: verdict.ok,
    degraded: verdict.degraded,
    statusCode: result.statusCode ?? null,
    responseTimeMs: result.responseTimeMs,
    error: verdict.error,
  };
}

/** One TCP connect, judged. */
export async function performTcpCheck(
  target: {
    host: string;
    port: number;
    timeoutMs: number;
    degradedThresholdMs: number;
  },
  options: CheckOptions = {},
): Promise<CheckOutcome> {
  const config: TcpConfig = {
    degradedThresholdMs: target.degradedThresholdMs,
  };
  const result = await tcpProbe({
    target: target.host,
    port: target.port,
    config,
    timeoutMs: target.timeoutMs,
    allowPrivateTargets: options.allowPrivateTargets ?? false,
    fetchImpl: options.fetchImpl ?? fetch,
  });
  const verdict = judge(findCheckType("tcp")!.assertions, config, result);
  return {
    ok: verdict.ok,
    degraded: verdict.degraded,
    statusCode: null,
    responseTimeMs: result.responseTimeMs,
    error: verdict.error,
  };
}

/**
 * Status-and-latency judgment for an HTTP response, without running
 * one. Goes through the same assertions the real check uses, so it can
 * never drift from them.
 */
export function evaluateResponse(
  target: Pick<CheckTarget, "expectedStatusCode" | "degradedThresholdMs">,
  statusCode: number,
  responseTimeMs: number,
): Pick<CheckOutcome, "ok" | "degraded"> {
  const config: HttpConfig = {
    method: "HEAD",
    expectedStatusCode: target.expectedStatusCode,
    degradedThresholdMs: target.degradedThresholdMs,
    bodyKeyword: null,
    keywordAbsent: false,
    tlsCheck: false,
    tlsWarnDays: 14,
  };
  const verdict = judge(httpSpec.assertions, config, {
    facts: { statusCode, responseTimeMs },
    responseTimeMs,
    statusCode,
    error: null,
  });
  return { ok: verdict.ok, degraded: verdict.degraded };
}
