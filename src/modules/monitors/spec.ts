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
  if (!spec) return monitor.url;
  return spec.describeTarget(monitor.url, monitor.port, spec.fromRow(monitor));
}
