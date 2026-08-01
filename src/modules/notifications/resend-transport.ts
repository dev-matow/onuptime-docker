import type { EmailMessage, EmailTransport } from "./index";
import type { DeliveryOutcome } from "./outbox";

/**
 * Resend transport over its REST API — no SDK dependency for a single
 * endpoint. A future SMTP/SES transport implements the same
 * `EmailTransport` interface and is selected in ./index.ts.
 *
 * It used to catch every error, log a warning and resolve successfully.
 * That made a 500, a 429, a timeout and a genuine delivery all the same
 * thing to every caller, which is why an incident could be marked
 * notified with nobody notified. It now reports what happened and lets
 * the outbox decide what to do about it.
 */
export function createResendTransport(
  apiKey: string,
  from: string,
): EmailTransport {
  return {
    async send(message: EmailMessage): Promise<DeliveryOutcome> {
      let response: Response;
      try {
        response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            // Resend collapses repeat requests carrying the same key.
            // This is what makes the outbox's at-least-once delivery
            // produce at most one message in the case that actually
            // happens: a crash after Resend accepted but before the row
            // recorded it.
            ...(message.idempotencyKey
              ? { "idempotency-key": message.idempotencyKey }
              : {}),
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
      } catch (error) {
        // A timeout or a DNS failure says nothing about whether the
        // message was accepted, so it is retryable by definition. The
        // idempotency key is what makes that safe.
        return {
          status: "retryable",
          error: error instanceof Error ? error.message : String(error),
        };
      }

      if (response.ok) {
        // The message id is the only delivery receipt an operator has —
        // without it, success is indistinguishable from a silent no-op.
        const body = (await response.json().catch(() => null)) as {
          id?: string;
        } | null;
        return {
          status: "delivered",
          providerMessageId: body?.id ?? null,
        };
      }

      const detail = (await response.text().catch(() => "")).slice(0, 500);
      // 429 and 5xx will plausibly succeed later; a 4xx will not. The
      // split matters: retrying a rejected recipient forever hides a
      // configuration error behind a queue that never drains.
      const retryable = response.status === 429 || response.status >= 500;
      return {
        status: retryable ? "retryable" : "permanent",
        error: `resend ${response.status}: ${detail}`,
      };
    },
  };
}
