import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

import { createResendTransport } from "./resend-transport";

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body; always sent as the fallback part. */
  text: string;
  /** Optional HTML body; providers send it as the rich part. */
  html?: string;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Default transport: structured log lines instead of real delivery.
 * Deployments set RESEND_API_KEY to swap in real email without touching
 * any call site — everything sends through `sendEmail`.
 */
const logTransport: EmailTransport = {
  async send(message) {
    logger.info(
      { to: message.to, subject: message.subject, body: message.text },
      "email (log transport)",
    );
  },
};

// Selected once at module load: Resend when configured, log otherwise.
// The app runs identically without an API key.
let transport: EmailTransport = env.RESEND_API_KEY
  ? createResendTransport(env.RESEND_API_KEY, env.EMAIL_FROM)
  : logTransport;

export function setEmailTransport(custom: EmailTransport): void {
  transport = custom;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  await transport.send(message);
}
