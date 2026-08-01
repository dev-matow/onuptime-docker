import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

import type { DeliveryOutcome } from "./outbox";
import { createResendTransport } from "./resend-transport";

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body; always sent as the fallback part. */
  text: string;
  /** Optional HTML body; providers send it as the rich part. */
  html?: string;
  /**
   * The outbox row's identity, passed to providers that honour an
   * `Idempotency-Key`. It is what turns at-least-once delivery into
   * at-most-one *message* when the provider cooperates.
   */
  idempotencyKey?: string;
}

/**
 * A transport reports what happened. It used to return `void`.
 *
 * That signature was the defect: the Resend transport caught its own
 * errors, logged a warning and resolved successfully, so a 500, a 429
 * and a timeout were all indistinguishable from delivery at every call
 * site. Nothing could retry what it could not see fail.
 *
 * The three outcomes are the three decisions a caller has to make, so
 * they are the three things a transport must be able to say.
 */
export interface EmailTransport {
  send(message: EmailMessage): Promise<DeliveryOutcome>;
}

/**
 * Default transport: structured log lines instead of real delivery.
 * Deployments set RESEND_API_KEY to swap in real email without touching
 * any call site.
 *
 * It reports `delivered`, which is honest for what it is — the message
 * reached the only destination this transport has. What is NOT honest is
 * letting a deployment believe it is emailing people when it is writing
 * to a log, so `emailTransportName()` exists and the notification
 * settings page shows it.
 */
const logTransport: EmailTransport = {
  async send(message) {
    logger.info(
      { to: message.to, subject: message.subject, body: message.text },
      "email (log transport)",
    );
    return { status: "delivered", providerMessageId: null };
  },
};

// Selected once at module load: Resend when configured, log otherwise.
let transport: EmailTransport = env.RESEND_API_KEY
  ? createResendTransport(env.RESEND_API_KEY, env.EMAIL_FROM)
  : logTransport;
let transportName = env.RESEND_API_KEY ? "resend" : "log";

export function setEmailTransport(
  custom: EmailTransport,
  name = "custom",
): void {
  transport = custom;
  transportName = name;
}

/**
 * Which transport is actually configured.
 *
 * A deployment with no RESEND_API_KEY silently emailed nobody and no
 * caller could tell. Naming the transport is what lets the UI say
 * "alerts are being written to the log, not sent" instead of implying a
 * delivery that is not happening.
 */
export function emailTransportName(): string {
  return transportName;
}

export async function sendEmail(
  message: EmailMessage,
): Promise<DeliveryOutcome> {
  return transport.send(message);
}
