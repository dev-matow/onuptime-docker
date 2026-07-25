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

export function renderIncidentOpenedEmail(input: {
  monitorName: string;
  monitorUrl: string;
  failureThreshold: number;
  incidentUrl: string;
}): RenderedEmail {
  const name = escapeHtml(input.monitorName);
  const checks =
    input.failureThreshold === 1
      ? "1 check"
      : `${input.failureThreshold} checks`;
  return {
    subject: `[Vigil] ${input.monitorName} is down`,
    text: [
      `${input.monitorName} (${input.monitorUrl}) failed ${checks} and was marked down.`,
      `An incident was opened automatically: ${input.incidentUrl}`,
    ].join("\n\n"),
    html: shell(
      `<div style="font-size:18px;font-weight:600;margin-bottom:8px">${name} is down</div>
<p style="font-size:14px;line-height:1.6;color:#3f3f46;margin:0 0 20px">Failed ${checks} in a row and was marked down. An incident was opened automatically.</p>
${button(input.incidentUrl, "View incident")}`,
      "#e5484d",
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
