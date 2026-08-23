import type { CheckSpec } from "./check";
import type { Monitor } from "./service";
import { SECRET_MASK } from "./types/config";
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
    subject: {
      monitorId: monitor.id,
      organizationId: monitor.organizationId,
      name: monitor.name,
      // The instant this evaluation was DUE, not the instant it is
      // running. A type that deduplicates its own work keys on this, and
      // the tick, the sub-minute follow-up and a queue replay after a
      // rolling restart agree about it while disagreeing about every
      // wall clock reading. Null on a monitor that has never been
      // scheduled, which reads as "nothing scheduled this".
      scheduledFor: monitor.nextEvaluationAt,
      trigger: "schedule",
      actorUserId: null,
      // Minted by the worker before it evaluates, when the type keeps a
      // record of its own. Null here because this function maps a row,
      // and nothing about a row says which attempt is running.
      runId: null,
    },
    checkType: monitor.checkType,
    url: monitor.url,
    port: monitor.port,
    method: monitor.method,
    intervalSeconds: monitor.intervalSeconds,
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
  const parts = splitTarget(target);
  if (parts === null || parts.userinfo === "") return target;
  return parts.scheme + parts.rest;
}

/**
 * A target split at its userinfo, or `null` when it has no scheme.
 *
 * One parser behind all three of the functions below, because they have
 * to agree about where the credential is. They did not, once: the
 * display path stripped `user:pass@` by searching the whole string and
 * ate everything before the `@` in a path, while the edit path used a
 * different rule and disagreed about which characters ended the
 * authority. Two rules for "where does the secret live" is one rule too
 * many.
 */
interface SplitTarget {
  /** Everything up to and including `://`. */
  scheme: string;
  /** The userinfo without its trailing `@`; empty when there is none. */
  userinfo: string;
  /** Host, port, path, query — everything after the userinfo. */
  rest: string;
}

function splitTarget(target: string): SplitTarget | null {
  const scheme = target.indexOf("://");
  if (scheme === -1) return null;
  const start = scheme + 3;
  // Only the authority can hold userinfo. Searching the whole string
  // instead ate everything before an @ in a path — `/a@b` is a perfectly
  // ordinary URL and the first version of this function destroyed it.
  const authorityEnd = target.slice(start).search(/[/?#]/);
  const end = authorityEnd === -1 ? target.length : start + authorityEnd;
  const at = target.lastIndexOf("@", end - 1);
  if (at === -1 || at < start) {
    return {
      scheme: target.slice(0, start),
      userinfo: "",
      rest: target.slice(start),
    };
  }
  return {
    scheme: target.slice(0, start),
    userinfo: target.slice(start, at),
    rest: target.slice(at + 1),
  };
}

/**
 * The target as an edit form may receive it: structure intact, password
 * replaced by {@link SECRET_MASK}.
 *
 * The display paths strip the whole `user:pass@`, which is right for a
 * label and wrong for a form — an operator who opens the edit dialog to
 * change the port would save the target back with its username gone.
 * So this keeps everything that is not the secret, and the secret comes
 * back out of the database in {@link restoreTargetSecret} when the form
 * echoes the mask untouched.
 *
 * This is the same contract `redactConfig` has with `mergeConfig`, for
 * the same reason: the browser is never given the credential, so the
 * browser cannot be asked to send it back.
 */
export function maskTargetSecret(target: string): string {
  const parts = splitTarget(target);
  if (parts === null || parts.userinfo === "") return target;
  const colon = parts.userinfo.indexOf(":");
  // A bare username is not a credential, and masking it would hide a
  // thing the operator has to be able to read to edit.
  if (colon === -1) return target;
  const user = parts.userinfo.slice(0, colon);
  return `${parts.scheme}${user}:${SECRET_MASK}@${parts.rest}`;
}

/**
 * Puts the stored password back into a target whose password is the
 * mask.
 *
 * `stored` is the target currently on the row. When the submitted target
 * carries the sentinel the operator did not retype the secret, so the
 * stored one stands — including when they changed the host, the port or
 * the database around it, which is the whole point of masking rather
 * than hiding.
 *
 * When there is nothing stored to restore, the sentinel is dropped
 * rather than written. `SECRET_MASK` must never reach a transport: that
 * is the invariant the constant exists to hold.
 */
export function restoreTargetSecret(
  next: string,
  stored: string | null,
): string {
  const parts = splitTarget(next);
  if (parts === null || parts.userinfo === "") return next;
  const colon = parts.userinfo.indexOf(":");
  if (colon === -1) return next;
  if (parts.userinfo.slice(colon + 1) !== SECRET_MASK) return next;

  const user = parts.userinfo.slice(0, colon);
  const storedParts = stored === null ? null : splitTarget(stored);
  const storedColon = storedParts ? storedParts.userinfo.indexOf(":") : -1;
  const secret =
    storedParts !== null && storedColon !== -1
      ? storedParts.userinfo.slice(storedColon + 1)
      : "";
  if (secret === "") return `${parts.scheme}${user}@${parts.rest}`;
  return `${parts.scheme}${user}:${secret}@${parts.rest}`;
}
