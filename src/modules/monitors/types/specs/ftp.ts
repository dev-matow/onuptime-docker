import { z } from "zod";

import { DEFAULT_FTP_PORT, ftpDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * The reply codes this type has an opinion about (RFC 959 §4.2.2).
 *
 * Everything else the server says is recorded as a fact and judged by
 * the assertions below, never turned into a transport error: a server
 * that answers 530 is a server that is running, and an operator whose
 * credentials expired must not be told their file server is unreachable.
 */
export const SERVICE_READY = 220;
export const LOGGED_IN = 230;
export const NEED_PASSWORD = 331;

export interface FtpConfig {
  /**
   * The account the check logs in as, or null to stop after the
   * feature list. Optional because the greeting and a command answered
   * are already more than a TCP check can see, and because plenty of
   * FTP servers worth watching accept no login this monitor could hold.
   */
  username: string | null;
  /**
   * Sent as PASS after USER. **In the clear** — FTP has no other way,
   * and this type never issues AUTH TLS (see `probes/ftp.ts`). The
   * credential is stored like any other monitor setting and travels the
   * network unencrypted, so it belongs to an account that can list a
   * directory and nothing else.
   */
  password: string | null;
  degradedThresholdMs: number;
}

/**
 * Anything that would let a stored credential become an FTP command.
 *
 * USER and PASS are written onto a line-oriented protocol verbatim, so a
 * CR or LF inside either value does not corrupt the check — it appends a
 * command of the operator's choosing to the session. Refused at the
 * schema, which is the only place that sees the value before the socket
 * does.
 */
const COMMAND_INJECTION = /[\r\n\0]/;

export const ftpStoredSchema = z
  .object({
    username: z
      .string()
      .trim()
      .max(128)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null))
      .refine((value) => value === null || !COMMAND_INJECTION.test(value), {
        message: "Remove line breaks from the username.",
      }),
    // Not trimmed, unlike the user name: leading and trailing space are
    // legal in an FTP password, and eating them turns a working
    // credential into a 530 with no visible cause.
    password: z
      .string()
      .max(255)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null))
      .refine((value) => value === null || !COMMAND_INJECTION.test(value), {
        message: "Remove line breaks from the password.",
      }),
  })
  // PASS only means anything after USER (RFC 959 §4.1.1), so a password
  // with no user name would never be sent. Refused here, where the
  // operator is standing, rather than dropped at connect time — a
  // silently unsent password comes back as "530 Login incorrect", which
  // sends the search in entirely the wrong direction.
  .refine((config) => config.username !== null || config.password === null, {
    message: "A password needs a username.",
    path: ["password"],
  });

export const ftpConfigSchema: z.ZodType<FtpConfig> = z.object({
  username: z.string().max(128).nullable(),
  password: z.string().max(255).nullable(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

const greeted: Assertion<FtpConfig> = {
  id: "greeting",
  fact: "greetingCode",
  severity: "down",
  evaluate(value) {
    // 421 is the one worth naming: "service not available, closing
    // control connection" is what a server at its connection limit
    // answers, and it accepts the socket first — so a TCP check on 21
    // reports that server as healthy for as long as it refuses every
    // real client.
    if (typeof value !== "number") return "The greeting was not an FTP reply";
    return value === SERVICE_READY ? null : `Unexpected greeting ${value}`;
  },
};

const answersCommands: Assertion<FtpConfig> = {
  id: "answers-commands",
  fact: "featCode",
  severity: "down",
  evaluate(value) {
    // Absent when the greeting was not 220 and FEAT was therefore never
    // sent; the greeting assertion has already named that.
    if (value === undefined) return null;
    // A code — any code — means the server took a command and replied to
    // it. 500 and 502 are the honest answers of a server that predates
    // RFC 2389 and they are not failures. `null` is: something printed a
    // 220 banner and then stopped speaking FTP, which is what a proxy in
    // front of a dead backend does and what this assertion is for.
    return typeof value === "number"
      ? null
      : "The server stopped speaking FTP after its banner";
  },
};

const loggedIn: Assertion<FtpConfig> = {
  id: "login",
  fact: "loginCode",
  severity: "down",
  applies(config) {
    return config.username !== null;
  },
  evaluate(value) {
    // Absent when the conversation ended before USER — the greeting or
    // the `answers-commands` assertion owns that failure.
    if (value === undefined) return null;
    // Present but not a code: the server took the login command and
    // answered with something that is not FTP. Reported here rather than
    // left to skip, because a login that silently stops being verified
    // is the failure this assertion exists to catch.
    if (typeof value !== "number") {
      return "The server stopped speaking FTP during login";
    }
    if (value === LOGGED_IN) return null;
    if (value === NEED_PASSWORD) {
      return "The server asked for a password and none is configured";
    }
    return `The server refused the login: reply ${value}`;
  },
};

export const ftpSpec: CheckTypeSpec<FtpConfig> = {
  descriptor: ftpDescriptor,
  configSchema: ftpConfigSchema,
  storedSchema: ftpStoredSchema,
  secretFields: ["password"],
  targetSchema: monitorHostnameSchema,
  assertions: [
    greeted,
    answersCommands,
    loggedIn,
    latencyAssertion<FtpConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): FtpConfig {
    const stored = ftpStoredSchema.safeParse(row.config ?? {});
    return {
      username: stored.success ? stored.data.username : null,
      password: stored.success ? stored.data.password : null,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, port) {
    // Host and port, and never the account. This string is what an
    // incident email, a webhook body and a public status page print, and
    // the config handed to this function carries an FTP password.
    return `${target}:${port ?? DEFAULT_FTP_PORT}`;
  },
};
