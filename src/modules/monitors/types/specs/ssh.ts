import { z } from "zod";

import { DEFAULT_SSH_PORT, sshDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * What an SSH monitor observes, and what it deliberately does not.
 *
 * The identification string (RFC 4253 §4.2) is the first thing an SSH
 * server sends, unprompted, before any key exchange. It is enough to
 * prove the daemon is answering rather than merely holding the port, and
 * it is what every uptime tool checks — so this type reads it and stops.
 *
 * Nothing authenticates. An SSH check that logged in would need a key or
 * a password stored on the monitoring host, would appear in the
 * directory's auth log as a successful login every interval, and would
 * make the monitoring server a credentialed foothold on every machine it
 * watches. The banner answers the question anyway: sshd writes it after
 * it has forked and accepted the connection, so a daemon that is out of
 * file descriptors, wedged, or has stopped listening does not produce
 * one.
 */

export interface SshConfig {
  /**
   * Substring the banner must contain. Null asserts only that something
   * answering SSH is there — the common case, because a host that stops
   * answering is the outage whatever version it used to run.
   *
   * With a value it becomes a version assertion: `OpenSSH_9` catches the
   * rollback that put the old build back, and `Debian` catches the
   * failover that quietly moved the service to a different image.
   */
  expectedBanner: string | null;
  degradedThresholdMs: number;
}

export const sshStoredSchema = z.object({
  expectedBanner: z
    .string()
    .trim()
    // 255 because that is the whole identification string, CRLF included
    // (RFC 4253 §4.2). A longer expectation could never match anything.
    .max(255)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

export const sshConfigSchema: z.ZodType<SshConfig> = z.object({
  expectedBanner: z.string().max(255).nullable(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

const identified: Assertion<SshConfig> = {
  id: "identification",
  fact: "identified",
  severity: "down",
  evaluate(value) {
    // The socket opened, so something is listening — it just never
    // identified itself as SSH. A statement about what is on the port,
    // not about the network, which is why it is judged here rather than
    // returned as a transport failure. In practice it is a TCP proxy
    // that accepts on behalf of a daemon that is no longer behind it.
    return value === true
      ? null
      : "The server sent no SSH identification string";
  },
};

const matchesExpected: Assertion<SshConfig> = {
  id: "expected-banner",
  fact: "banner",
  severity: "down",
  applies: (config) => config.expectedBanner !== null,
  evaluate(value, config) {
    const expected = config.expectedBanner ?? "";
    // Absent when nothing identified itself, which the assertion above
    // already reports. Quoting both sides so a version that differs by
    // one character is visible rather than merely puzzling.
    if (typeof value !== "string") return null;
    return value.includes(expected)
      ? null
      : `The banner is "${value}", which does not contain "${expected}"`;
  },
};

export const sshSpec: CheckTypeSpec<SshConfig> = {
  descriptor: sshDescriptor,
  configSchema: sshConfigSchema,
  storedSchema: sshStoredSchema,
  // No secrets, and that is the type's whole design: this check never
  // authenticates, so there is no key and no password for a monitor to
  // hold. See the note at the top of this file.
  targetSchema: monitorHostnameSchema,
  assertions: [
    identified,
    matchesExpected,
    latencyAssertion<SshConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): SshConfig {
    const stored = sshStoredSchema.safeParse(row.config ?? {});
    return {
      expectedBanner: stored.success ? stored.data.expectedBanner : null,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, port) {
    // The port is shown even when it is 22: a bastion on 2222 and a
    // container's forwarded 22 are different services on one host, and
    // an alert that omits which one was watched gets replied to.
    return `${target}:${port ?? DEFAULT_SSH_PORT}`;
  },
};
