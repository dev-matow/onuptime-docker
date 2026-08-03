import {
  httpDeliver,
  parseRecipients,
  plainTextBody,
  type ChannelProvider,
} from "./types";

/**
 * Resend as a routed channel: the organization's own API key and
 * recipients, unrelated to the instance-wide RESEND_API_KEY that mails
 * members. The outbox row id rides the Idempotency-Key header, which
 * Resend honors, so the at-least-once retry cannot become two emails.
 */
export const resendProvider: ChannelProvider = {
  id: "resend",
  label: "Resend",
  kind: "email",
  blurb: "Email through your Resend account.",
  docsUrl: "https://resend.com/docs/api-reference/emails/send-email",
  apiVersion: "API v1 (POST /emails)",
  prerequisite: "A Resend API key and a verified sending domain.",
  capabilities: {
    native: true,
    lifecycle: false,
    duplicateSuppression: true,
    receipt: true,
  },
  fields: [
    {
      key: "apiKey",
      label: "API key",
      type: "password",
      secret: true,
      required: true,
      placeholder: "re_…",
    },
    {
      key: "from",
      label: "From",
      type: "text",
      required: true,
      placeholder: "Vigil <alerts@yourdomain.com>",
      help: "Must be on a domain verified in your Resend account.",
    },
    {
      key: "to",
      label: "Recipients",
      type: "text",
      required: true,
      placeholder: "oncall@example.com, ops@example.com",
      help: "Comma-separated, up to 20.",
    },
  ],
  check(config, secrets) {
    if (!secrets.apiKey) return "An API key is required.";
    if (!config.from?.trim()) return "A from address is required.";
    if (!parseRecipients(config.to ?? "")) {
      return "Recipients must be a comma-separated list of email addresses (max 20).";
    }
    return null;
  },
  destinationSummary(config) {
    const list = parseRecipients(config.to ?? "") ?? [];
    return list.length === 1 ? (list[0] ?? "") : `${list.length} recipients`;
  },
  async deliver({ config, secrets, message, rowId, net }) {
    return httpDeliver({
      url: "https://api.resend.com/emails",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secrets.apiKey ?? ""}`,
        "idempotency-key": rowId,
      },
      body: JSON.stringify({
        from: config.from,
        to: parseRecipients(config.to ?? "") ?? [],
        subject: message.title,
        text: plainTextBody(message),
      }),
      secrets,
      net,
      messageId: (body) => {
        try {
          const parsed = JSON.parse(body) as { id?: string };
          return typeof parsed.id === "string" ? parsed.id : null;
        } catch {
          return null;
        }
      },
    });
  },
};
