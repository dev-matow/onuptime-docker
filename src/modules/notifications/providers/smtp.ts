import { redactErrorText, parseRecipients, plainTextBody } from "./types";
import type { ChannelProvider } from "./types";
import { smtpSend, SmtpError } from "./smtp-client";

/**
 * SMTP - the operator's own mail server or relay. The one provider that
 * is not an HTTP POST, so it carries its own client (smtp-client.ts)
 * with the same egress address rules and the same outcome contract.
 */
export const smtpProvider: ChannelProvider = {
  id: "smtp",
  label: "SMTP",
  kind: "email",
  blurb: "Email through your own SMTP server or relay.",
  docsUrl: "/docs/notifications.html",
  apiVersion: "ESMTP (RFC 5321), STARTTLS or implicit TLS",
  prerequisite:
    "An SMTP server or relay that accepts your credentials over TLS.",
  capabilities: {
    native: true,
    lifecycle: false,
    // False, and the distinction is the point of the flag. The
    // `Message-ID` is the outbox row id, so a RECEIVING client can
    // collapse the copy - but no relay deduplicates on it, and this
    // flag means "the provider collapses it", which SMTP does not.
    // Claiming otherwise put a "Collapses retries" badge next to a
    // field the operator was filling in.
    duplicateSuppression: false,
    receipt: true,
  },
  fields: [
    {
      key: "host",
      label: "Host",
      type: "text",
      required: true,
      placeholder: "smtp.example.com",
    },
    {
      key: "port",
      label: "Port",
      type: "text",
      required: true,
      placeholder: "587",
    },
    {
      key: "security",
      label: "Security",
      type: "select",
      required: true,
      options: [
        { value: "starttls", label: "STARTTLS (port 587)" },
        { value: "tls", label: "TLS (port 465)" },
        { value: "none", label: "None (port 25, no authentication)" },
      ],
      help: "Certificates are always verified. Authentication requires STARTTLS or TLS.",
    },
    {
      key: "username",
      label: "Username",
      type: "text",
      placeholder: "optional",
    },
    {
      key: "password",
      label: "Password",
      type: "password",
      secret: true,
      placeholder: "optional",
    },
    {
      key: "from",
      label: "From",
      type: "text",
      required: true,
      placeholder: "Vigil <alerts@example.com>",
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
    if (!config.host?.trim()) return "A host is required.";
    const port = Number(config.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return "The port must be a number between 1 and 65535.";
    }
    if (!["none", "starttls", "tls"].includes(config.security ?? "")) {
      return "Pick a security mode.";
    }
    if ((config.username || secrets.password) && config.security === "none") {
      return "Authentication needs STARTTLS or TLS; credentials are never sent unencrypted.";
    }
    if (config.username && !secrets.password) {
      return "A username needs a password.";
    }
    if (!config.from?.trim()) return "A from address is required.";
    // The from address is the one header-bound field a caller types
    // freely (recipients go through parseRecipients, the subject through
    // encodeSubject, both of which reject control characters). A CR or LF
    // here would inject a second header - a hidden Bcc, an extra RCPT -
    // that no ledger or audit row would show, so it is refused at the
    // gate as well as stripped in the client.
    if (/[\r\n]/.test(config.from)) {
      return "The from address cannot contain line breaks.";
    }
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
    try {
      const { reply } = await smtpSend(
        {
          host: config.host ?? "",
          port: Number(config.port),
          security: config.security as "none" | "starttls" | "tls",
          username: config.username || undefined,
          password: secrets.password || undefined,
          timeoutMs: net.timeoutMs,
          lookup: net.lookup,
        },
        {
          from: config.from ?? "",
          to: parseRecipients(config.to ?? "") ?? [],
          subject: message.title,
          text: plainTextBody(message),
          messageId: rowId,
        },
      );
      return { status: "delivered", providerMessageId: reply.slice(0, 200) };
    } catch (error) {
      const permanent = error instanceof SmtpError && error.permanent;
      const detail = redactErrorText(
        error instanceof Error ? error.message : "SMTP delivery failed",
        secrets,
      );
      return permanent
        ? { status: "permanent", error: detail }
        : { status: "retryable", error: detail };
    }
  },
};
