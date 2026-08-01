import { z } from "zod";

import { DEFAULT_IMAP_PORT, imapDescriptor } from "../catalog";
import type {
  Assertion,
  CheckTypeSpec,
  FactValue,
  MonitorRowView,
} from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * The three greetings RFC 3501 §7.1 allows a server to open with.
 *
 * `OK` is the ordinary one and `PREAUTH` says the connection arrived
 * already authenticated (a local socket, a tunnel) — both mean the store
 * will talk. `BYE` is the server declining this connection before it has
 * begun: "too many connections", "shutting down", "your address is
 * blocked". That last one is the failure this type exists for, because a
 * TCP check on 143 cannot see it — the socket opens either way.
 */
export const IMAP_GREETINGS = ["OK", "PREAUTH", "BYE"] as const;
export type ImapGreeting = (typeof IMAP_GREETINGS)[number];

/**
 * The names a server must advertise for the protocol it speaks — RFC
 * 3501 §7.2.1 for rev1, RFC 9051 §7.2.2 for rev2. Held upper-cased
 * because IMAP atoms are case-insensitive and the string real servers
 * send is "IMAP4rev1".
 */
export const IMAP_REVISIONS: readonly string[] = ["IMAP4REV1", "IMAP4REV2"];

export interface ImapConfig {
  /**
   * One capability the operator requires the server to keep advertising
   * — STARTTLS, IDLE, AUTH=PLAIN. Null when they only need the store to
   * answer, which is the common case and why this is optional.
   *
   * It exists because the capability list is where an IMAP server
   * silently changes shape: a mail server that stops offering STARTTLS
   * after a config reload is still up, still greets, still answers
   * CAPABILITY, and every client that insisted on encryption has
   * stopped being able to fetch mail.
   */
  requiredCapability: string | null;
  degradedThresholdMs: number;
}

export const imapStoredSchema = z.object({
  requiredCapability: z
    .string()
    .trim()
    .max(64)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null))
    // A capability is a single IMAP atom. An operator who pastes
    // "STARTTLS IDLE" means two of them, and storing the pair as one
    // string would compare it against every entry in the list and match
    // none — a monitor that goes down and blames a capability the server
    // is, in fact, advertising.
    .refine((value) => value === null || !/\s/.test(value), {
      message: "A capability is one word, like STARTTLS.",
    }),
});

export const imapConfigSchema: z.ZodType<ImapConfig> = z.object({
  requiredCapability: z.string().max(64).nullable(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/**
 * Case-insensitive membership. IMAP atoms are compared without regard
 * to case (RFC 3501 §9), so an operator who types "starttls" and a
 * server that answers "STARTTLS" must agree.
 */
export function advertises(
  capabilities: readonly string[],
  name: string,
): boolean {
  const wanted = name.toUpperCase();
  return capabilities.some((entry) => entry.toUpperCase() === wanted);
}

/**
 * The capability fact as a list of strings, or null when the probe did
 * not get far enough to record one. Absence and emptiness are different
 * answers here — see {@link speaksImap4}.
 */
function capabilityList(
  value: FactValue | FactValue[] | undefined,
): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === "string");
}

const greeted: Assertion<ImapConfig> = {
  id: "greeting",
  fact: "greetingStatus",
  severity: "down",
  evaluate(value) {
    // No string at all means whatever answered on the port was not
    // speaking IMAP — a web server, an SSH daemon, a load balancer
    // returning its own error page. The banner fact carries the evidence.
    if (typeof value !== "string") {
      return "The greeting was not an IMAP response";
    }
    if (value === "BYE") return "The server refused the connection";
    return null;
  },
};

const acceptsCapability: Assertion<ImapConfig> = {
  id: "capability",
  fact: "capabilityAccepted",
  severity: "down",
  evaluate(value) {
    // Absent when the greeting was not OK or PREAUTH, because then
    // CAPABILITY was never sent. The greeting assertion has already
    // named that failure, and two lines for one cause is how an incident
    // stops being readable.
    if (typeof value !== "boolean") return null;
    return value ? null : "The server rejected CAPABILITY";
  },
};

const speaksImap4: Assertion<ImapConfig> = {
  id: "imap4",
  fact: "capabilities",
  severity: "down",
  evaluate(value) {
    // The probe records this list only when CAPABILITY completed with a
    // tagged OK, so absent means the command failed and `capability`
    // above is reporting it. An *empty* list is a different thing
    // entirely: the server said OK and advertised nothing, which no IMAP
    // server may do and which is what a protocol-unaware proxy in front
    // of a dead backend looks like.
    const capabilities = capabilityList(value);
    if (capabilities === null) return null;
    const speaks = IMAP_REVISIONS.some((revision) =>
      advertises(capabilities, revision),
    );
    return speaks ? null : "The server did not advertise IMAP4rev1";
  },
};

const advertisesRequired: Assertion<ImapConfig> = {
  id: "required-capability",
  fact: "capabilities",
  severity: "down",
  applies(config) {
    return config.requiredCapability !== null;
  },
  evaluate(value, config) {
    const capabilities = capabilityList(value);
    if (capabilities === null || config.requiredCapability === null) {
      return null;
    }
    return advertises(capabilities, config.requiredCapability)
      ? null
      : `The server no longer advertises ${config.requiredCapability}`;
  },
};

export const imapSpec: CheckTypeSpec<ImapConfig> = {
  descriptor: imapDescriptor,
  configSchema: imapConfigSchema,
  storedSchema: imapStoredSchema,
  // Nothing here is a credential: this type never logs in, deliberately,
  // and the reason is in `probes/imap.ts`.
  targetSchema: monitorHostnameSchema,
  assertions: [
    greeted,
    acceptsCapability,
    speaksImap4,
    advertisesRequired,
    latencyAssertion<ImapConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): ImapConfig {
    const stored = imapStoredSchema.safeParse(row.config ?? {});
    return {
      requiredCapability: stored.success
        ? stored.data.requiredCapability
        : null,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, port) {
    // The port is shown even when it is the default, for the reason SMTP
    // shows its own: 143 and 993 are different services on one host, and
    // an incident email that does not say which one was watched is an
    // email somebody has to reply to before they can act on it.
    return `${target}:${port ?? DEFAULT_IMAP_PORT}`;
  },
};
