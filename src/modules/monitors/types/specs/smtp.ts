import { z } from "zod";

import { DEFAULT_SMTP_PORT, smtpDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { flatColumnsOnly, latencyAssertion } from "./shared";

/** "Service ready" — the only greeting that means the server will talk. */
export const SERVICE_READY = 220;

/** The reply to an accepted EHLO. */
export const EHLO_OK = 250;

export interface SmtpConfig {
  degradedThresholdMs: number;
}

export const smtpConfigSchema: z.ZodType<SmtpConfig> = z.object({
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

const greeted: Assertion<SmtpConfig> = {
  id: "greeting",
  fact: "greetingCode",
  severity: "down",
  evaluate(value) {
    // A code that is not 220 is the server declining to serve this
    // connection — 421 is "shutting down", or "too many connections from
    // you" — and no code at all means whatever answered was not speaking
    // SMTP. Both are outages to anyone trying to deliver mail.
    if (typeof value !== "number") return "The greeting was not an SMTP reply";
    return value === SERVICE_READY ? null : `Unexpected greeting ${value}`;
  },
};

const acceptsEhlo: Assertion<SmtpConfig> = {
  id: "ehlo",
  fact: "ehloAccepted",
  severity: "down",
  evaluate(value) {
    // Absent when the greeting was not 220, because then EHLO was never
    // sent. The greeting assertion has already named that failure, and
    // two lines for one cause is how an incident stops being readable.
    if (typeof value !== "boolean") return null;
    return value ? null : "The server rejected EHLO";
  },
};

export const smtpSpec: CheckTypeSpec<SmtpConfig> = {
  descriptor: smtpDescriptor,
  configSchema: smtpConfigSchema,
  storedSchema: flatColumnsOnly,
  targetSchema: monitorHostnameSchema,
  assertions: [greeted, acceptsEhlo, latencyAssertion<SmtpConfig>("Greeted")],
  fromRow(row: MonitorRowView): SmtpConfig {
    return { degradedThresholdMs: row.degradedThresholdMs };
  },
  describeTarget(target, port) {
    // The port is worth showing even when it is the default: 25 and 587
    // are different services on the same host, and an incident email
    // that omits which one was watched is an email that gets replied to.
    return `${target}:${port ?? DEFAULT_SMTP_PORT}`;
  },
};
