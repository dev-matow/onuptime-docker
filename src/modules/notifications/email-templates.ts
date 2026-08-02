/**
 * Notification email templates. Each returns a subject plus matching
 * HTML and plain-text bodies (the text is a genuine fallback, not a
 * stripped copy). Styles are inline because email clients ignore
 * <style> blocks. Values are HTML-escaped — monitor names are
 * user-supplied.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const TEAM_FOOTER =
  "You receive these because you are an owner, admin or responder in this organization.";

function shell(body: string, accent: string, footer = TEAM_FOOTER): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;padding:24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden">
<tr><td style="height:4px;background:${accent}"></td></tr>
<tr><td style="padding:28px 32px">
<div style="font-weight:600;font-size:15px;letter-spacing:-0.01em;color:#18181b;margin-bottom:20px">Vigil</div>
${body}
</td></tr></table>
<div style="color:#a1a1aa;font-size:12px;margin-top:16px">${footer}</div>
</td></tr></table></body></html>`;
}

function button(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:500;padding:10px 18px;border-radius:8px">${label}</a>`;
}

/**
 * How long a monitor had been failing, in words. Replaces the old
 * "failed 3 checks" phrasing, which stopped being meaningful once the
 * interval between those checks became adaptive, three failures could
 * be three seconds or half an hour and the reader had no way to tell.
 */
export function describeFailureWindow(seconds: number): string {
  // Reads as a clause after "has been failing" *and* after "had been
  // failing", because it is used in both — the second of which goes on
  // the public status page. "had been failing on its first failed
  // check" is not a sentence, and migration 0010 gives a window of 0 to
  // every 1.9.x monitor that had `failureThreshold: 1`, so it would
  // have been the most common phrasing in the product.
  if (seconds <= 0) return "from its first failed check";
  if (seconds < 60) {
    return `for ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return `for ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const hours = Math.round(seconds / 3600);
  return `for ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function renderIncidentOpenedEmail(input: {
  monitorName: string;
  monitorUrl: string;
  failureWindowSeconds: number;
  incidentUrl: string;
}): RenderedEmail {
  const name = escapeHtml(input.monitorName);
  const window = describeFailureWindow(input.failureWindowSeconds);
  return {
    subject: `[Vigil] ${input.monitorName} is down`,
    text: [
      `${input.monitorName} (${input.monitorUrl}) has been failing ${window} and was marked down.`,
      `An incident was opened automatically: ${input.incidentUrl}`,
    ].join("\n\n"),
    html: shell(
      `<div style="font-size:18px;font-weight:600;margin-bottom:8px">${name} is down</div>
<p style="font-size:14px;line-height:1.6;color:#3f3f46;margin:0 0 20px">Failing ${escapeHtml(window)} and marked down. An incident was opened automatically.</p>
${button(input.incidentUrl, "View incident")}`,
      "#e5484d",
    ),
  };
}

/** Double opt-in email sent when someone subscribes to a status page. */
export function renderSubscriptionConfirmEmail(input: {
  pageName: string;
  confirmUrl: string;
}): RenderedEmail {
  const name = escapeHtml(input.pageName);
  return {
    subject: `Confirm your subscription to ${input.pageName}`,
    text: [
      `Confirm that you want status updates for ${input.pageName}.`,
      `Confirm here: ${input.confirmUrl}`,
      `If you didn't request this, ignore this email. Nothing was subscribed.`,
    ].join("\n\n"),
    html: shell(
      `<div style="font-size:18px;font-weight:600;margin-bottom:8px">Confirm your subscription</div>
<p style="font-size:14px;line-height:1.6;color:#3f3f46;margin:0 0 20px">Confirm that you want incident and recovery updates for <strong>${name}</strong>.</p>
${button(input.confirmUrl, "Confirm subscription")}`,
      "#18181b",
      `You received this because this address was entered on ${name}'s status page. If that wasn't you, no action is needed.`,
    ),
  };
}

/**
 * The reset link, sent by better-auth's `sendResetPassword` hook.
 *
 * The hook is the only place the token is ever held, which is why this
 * takes a finished URL rather than a token: nothing else in the product
 * should be in a position to build one.
 */
export function renderPasswordResetEmail(input: {
  resetUrl: string;
  expiresInMinutes: number;
}): RenderedEmail {
  const expiry = `${input.expiresInMinutes} ${input.expiresInMinutes === 1 ? "minute" : "minutes"}`;
  return {
    subject: "Reset your Vigil password",
    text: [
      "Someone asked to reset the password for this address on Vigil.",
      `Set a new password: ${input.resetUrl}`,
      `The link works once and expires in ${expiry}.`,
      "If that wasn't you, ignore this email. Your password has not changed and nobody can change it without this link.",
    ].join("\n\n"),
    html: shell(
      `<div style="font-size:18px;font-weight:600;margin-bottom:8px">Reset your password</div>
<p style="font-size:14px;line-height:1.6;color:#3f3f46;margin:0 0 20px">Someone asked to reset the password for this address. The link works once and expires in ${escapeHtml(expiry)}.</p>
${button(input.resetUrl, "Set a new password")}`,
      "#18181b",
      "If that wasn't you, ignore this email. Your password has not changed and nobody can change it without this link.",
    ),
  };
}

/**
 * Sent when a reset is requested for an address that has no account.
 *
 * It exists so that the *request* behaves identically either way. Skipping
 * the send for an unknown address is what turns a delivery failure into an
 * account oracle: the moment the mail provider breaks, a known address
 * returns an error and an unknown one returns success, and an attacker
 * reads the difference. One address, one send attempt, one outcome — in
 * both branches — and there is nothing to read.
 *
 * It also answers the question the reader actually has, which is why the
 * link they were waiting for never arrived.
 */
export function renderPasswordResetNoAccountEmail(input: {
  appUrl: string;
}): RenderedEmail {
  return {
    subject: "Reset your Vigil password",
    text: [
      "Someone asked to reset the password for this address on Vigil, but no account uses it.",
      `If you have an account, it is registered under a different address: ${input.appUrl}`,
      "If that wasn't you, ignore this email. Nothing was created and nothing was changed.",
    ].join("\n\n"),
    html: shell(
      `<div style="font-size:18px;font-weight:600;margin-bottom:8px">No account uses this address</div>
<p style="font-size:14px;line-height:1.6;color:#3f3f46;margin:0 0 20px">Someone asked to reset a Vigil password for this address, but no account is registered to it. If you have one, it is under a different address.</p>
${button(input.appUrl, "Go to Vigil")}`,
      "#18181b",
      "If that wasn't you, ignore this email. Nothing was created and nothing was changed.",
    ),
  };
}

const SUBSCRIBER_ACCENT = {
  opened: "#e5484d",
  updated: "#f5a623",
  resolved: "#30b566",
} as const;

const SUBSCRIBER_VERB = {
  opened: "opened",
  updated: "updated",
  resolved: "resolved",
} as const;

/** Incident notification sent to confirmed status-page subscribers. */
export function renderSubscriberIncidentEmail(input: {
  pageName: string;
  incidentTitle: string;
  kind: "opened" | "updated" | "resolved";
  statusUrl: string;
  unsubscribeUrl: string;
  latestUpdate?: string;
}): RenderedEmail {
  const title = escapeHtml(input.incidentTitle);
  const page = escapeHtml(input.pageName);
  const verb = SUBSCRIBER_VERB[input.kind];
  const update = input.latestUpdate?.trim();
  return {
    subject: `[${input.pageName}] Incident ${verb}: ${input.incidentTitle}`,
    text: [
      `An incident on ${input.pageName} was ${verb}: ${input.incidentTitle}`,
      ...(update ? [update] : []),
      `Live status: ${input.statusUrl}`,
      `Unsubscribe: ${input.unsubscribeUrl}`,
    ].join("\n\n"),
    html: shell(
      `<div style="font-size:18px;font-weight:600;margin-bottom:8px">Incident ${verb}</div>
<p style="font-size:14px;line-height:1.6;color:#3f3f46;margin:0 0 8px"><strong>${title}</strong> on ${page}.</p>
${update ? `<p style="font-size:14px;line-height:1.6;color:#3f3f46;margin:0 0 20px">${escapeHtml(update)}</p>` : `<div style="margin-bottom:20px"></div>`}
${button(input.statusUrl, "View status page")}`,
      SUBSCRIBER_ACCENT[input.kind],
      `You subscribed to updates for ${page}. <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#71717a">Unsubscribe</a>.`,
    ),
  };
}

export function renderIncidentResolvedEmail(input: {
  monitorName: string;
  monitorUrl: string;
  incidentUrl: string;
}): RenderedEmail {
  const name = escapeHtml(input.monitorName);
  return {
    subject: `[Vigil] ${input.monitorName} recovered`,
    text: [
      `${input.monitorName} (${input.monitorUrl}) is responding again.`,
      `The incident was resolved automatically: ${input.incidentUrl}`,
    ].join("\n\n"),
    html: shell(
      `<div style="font-size:18px;font-weight:600;margin-bottom:8px">${name} recovered</div>
<p style="font-size:14px;line-height:1.6;color:#3f3f46;margin:0 0 20px">It is responding again and the incident was resolved automatically.</p>
${button(input.incidentUrl, "View incident")}`,
      "#30b566",
    ),
  };
}
