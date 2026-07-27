import type { CheckSpec } from "./check";
import type { Monitor } from "./service";
import { findSpec } from "./types/specs";

/**
 * The one place a monitor row becomes a probe spec.
 *
 * It exists because there used to be two. `worker/jobs/monitor-check.ts`
 * built one that included `tlsCheck`/`tlsWarnDays`; the recovery loop's
 * verification probe in `worker/jobs/recovery.ts` built one that did
 * not. So recovery verified a *different monitor* than the one that had
 * failed — and specifically a laxer one, which is the direction that
 * makes a fix look successful when it was not.
 *
 * Two hand-maintained copies of the same mapping drift the moment a
 * field is added to one. Adding a seventh check type would have created
 * the third copy.
 */
export function toCheckSpec(monitor: Monitor): CheckSpec {
  return {
    checkType: monitor.checkType,
    url: monitor.url,
    port: monitor.port,
    method: monitor.method,
    timeoutMs: monitor.timeoutMs,
    degradedThresholdMs: monitor.degradedThresholdMs,
    expectedStatusCode: monitor.expectedStatusCode,
    bodyKeyword: monitor.bodyKeyword,
    keywordAbsent: monitor.keywordAbsent,
    tlsCheck: monitor.tlsCheck,
    tlsWarnDays: monitor.tlsWarnDays,
    config: monitor.config,
  };
}

/**
 * How to describe this monitor's target to a human.
 *
 * Goes through the type rather than printing `monitor.url`, because a
 * type is the only thing that knows whether its target is safe to show
 * verbatim. The url is already embedded in incident emails and webhook
 * payloads, so the day a target can carry a credential, redaction has
 * to have a home — and it has to be this one.
 */
export function describeMonitorTarget(monitor: Monitor): string {
  const spec = findSpec(monitor.checkType);
  if (!spec) return redactTargetCredentials(monitor.url);
  return spec.describeTarget(monitor.url, monitor.port, spec.fromRow(monitor));
}

/**
 * Strips `user:password@` out of a target.
 *
 * A second, narrower guard than `describeMonitorTarget`, and deliberately
 * not folded into it. This one needs nothing but the string, so it works
 * where the full monitor row is not in hand — the webhook payload carries
 * a trimmed monitor — and it cannot fail open when a check type is
 * missing from the build, which is exactly when the other one falls back
 * to returning the raw target.
 *
 * A target could not carry a credential until `postgres` shipped, and the
 * first thing it did was put a password into every incident email and
 * webhook body. Anything that sends a target outward goes through one of
 * these two.
 */
export function redactTargetCredentials(target: string): string {
  const scheme = target.indexOf("://");
  if (scheme === -1) return target;
  const start = scheme + 3;
  // Only the authority can hold userinfo. Searching the whole string
  // instead ate everything before an @ in a path — `/a@b` is a perfectly
  // ordinary URL and the first version of this function destroyed it.
  const authorityEnd = target.slice(start).search(/[/?#]/);
  const end = authorityEnd === -1 ? target.length : start + authorityEnd;
  const at = target.lastIndexOf("@", end - 1);
  if (at === -1 || at < start) return target;
  return target.slice(0, start) + target.slice(at + 1);
}
