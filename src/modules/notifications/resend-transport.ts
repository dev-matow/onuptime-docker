import { logger } from "@/lib/logger";

import type { EmailMessage, EmailTransport } from "./index";

/**
 * Resend transport over its REST API — no SDK dependency for a single
 * endpoint. A future SMTP/SES transport implements the same
 * `EmailTransport` interface and is selected in ./index.ts; nothing else
 * changes. Delivery failures are logged and swallowed so a provider
 * outage never breaks incident processing.
 */
export function createResendTransport(
  apiKey: string,
  from: string,
): EmailTransport {
  return {
    async send(message: EmailMessage): Promise<void> {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: message.to,
            subject: message.subject,
            text: message.text,
            ...(message.html ? { html: message.html } : {}),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          logger.warn(
            {
              to: message.to,
              status: response.status,
              detail: detail.slice(0, 200),
            },
            "resend delivery failed",
          );
        } else {
          // The message id is the only delivery receipt an operator has —
          // without it, success is indistinguishable from a silent no-op.
          const body = (await response.json().catch(() => null)) as {
            id?: string;
          } | null;
          logger.info(
            { to: message.to, id: body?.id },
            "resend delivery accepted",
          );
        }
      } catch (error) {
        logger.warn({ to: message.to, err: error }, "resend request failed");
      }
    },
  };
}
