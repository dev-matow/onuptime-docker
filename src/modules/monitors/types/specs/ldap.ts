import { z } from "zod";

import { DEFAULT_LDAP_PORT, ldapDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

export interface LdapConfig {
  /**
   * The DN to bind as. Null binds anonymously (RFC 4513 §5.1.1: an empty
   * name and an empty password), which is what a directory publishing a
   * public tree answers — and the only thing a check can do against one
   * with no service account to spare.
   */
  bindDn: string | null;
  /**
   * The simple-bind password.
   *
   * Null *with* a DN is the "unauthenticated bind" of RFC 4513 §5.1.2,
   * which servers are told to refuse — and it is deliberately
   * representable, because that is the shape an imported monitor arrives
   * in: an export masks the credential, the importer strips the mask
   * rather than writing it, and it names the field in
   * `secretsToReenter`. A schema that refused it would make the importer
   * drop the whole monitor instead, which trades a check that fails
   * loudly for one that does not exist.
   */
  bindPassword: string | null;
  degradedThresholdMs: number;
}

export const ldapStoredSchema = z
  .object({
    bindDn: z
      .string()
      .trim()
      .max(512)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null)),
    // Not trimmed, unlike the DN: leading and trailing space are legal
    // in a directory password, and eating them turns a working
    // credential into `invalidCredentials` with nothing to point at.
    bindPassword: z
      .string()
      .max(512)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null)),
  })
  // A password with no DN has nothing to authenticate: RFC 4511 §4.2
  // carries the credential *for* a name, so the directory would compare
  // it against an anonymous bind and answer success — a monitor that
  // reports green while the credential it was given is being ignored.
  // Refused here, where the operator is standing and the fix is one
  // field away, rather than at bind time where the answer is a lie.
  //
  // The mirror image — a DN with no password — is allowed on purpose:
  // see `bindPassword` above. It is what an import produces, and the
  // directory's own `invalidCredentials` is a better report of it than a
  // monitor that failed to be created.
  .refine((config) => config.bindPassword === null || config.bindDn !== null, {
    message: "A bind password needs a bind DN.",
    path: ["bindDn"],
  });

export const ldapConfigSchema: z.ZodType<LdapConfig> = z.object({
  bindDn: z.string().max(512).nullable(),
  bindPassword: z.string().max(512).nullable(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

/**
 * The bind result codes (RFC 4511 §4.1.9 and Appendix A).
 *
 * Only the ones a *bind* can produce are here. The table exists to turn
 * a number in an incident email into something an operator can act on,
 * and padding it with `sizeLimitExceeded` or `notAllowedOnRDN` — which
 * answer searches and modifications, neither of which this check
 * performs — would be padding it with codes nobody will ever read.
 * Anything outside it is reported as its number rather than guessed at.
 *
 * Every one of these, `success` included, is the directory *answering*:
 * it is running, listening and speaking LDAP. So a refusal is recorded
 * as a fact and judged by an assertion, never returned as a transport
 * error — an operator whose service account expired still needs to know
 * the directory is up, and "wrong password" must never be
 * indistinguishable from "unreachable".
 */
export const LDAP_RESULT_MESSAGES: Readonly<Record<number, string>> = {
  0: "Bind accepted",
  1: "The server hit an internal error",
  2: "The server rejected the request as malformed",
  7: "The server does not support simple authentication",
  8: "The server requires a stronger authentication method",
  13: "The server requires TLS before it will accept a bind",
  14: "The server is midway through a SASL bind",
  32: "No such object — the bind DN does not exist",
  34: "The bind DN is not valid DN syntax",
  48: "The server will not accept this kind of authentication",
  49: "Invalid credentials",
  50: "Insufficient access rights",
  51: "The server is busy",
  52: "The server is unavailable",
  53: "The server is unwilling to perform the bind",
  80: "The server reported an unspecified error",
};

export function ldapResultMessage(code: number): string {
  return LDAP_RESULT_MESSAGES[code] ?? `Unrecognised result code ${code}`;
}

/** A bind that succeeded. Exported so the probe and its tests agree. */
export const LDAP_SUCCESS = 0;

const answered: Assertion<LdapConfig> = {
  id: "bind-response",
  fact: "bindResponse",
  severity: "down",
  evaluate(value) {
    // The socket opened, so something is listening — it just never
    // answered as a directory. That is a statement about what is on the
    // port rather than about the network, which is why it is judged
    // here instead of being reported as a transport failure. The usual
    // cause is 636 in the port field: LDAPS expects a TLS handshake
    // before a single BER byte, so it reads the bind request as a
    // ClientHello and says nothing back.
    return value === true ? null : "The server sent no LDAP bind response";
  },
};

const accepted: Assertion<LdapConfig> = {
  id: "bind-accepted",
  fact: "resultCode",
  severity: "down",
  evaluate(value) {
    // Absent when no bind response arrived, which the assertion above
    // already reports — there is no result code here to have an opinion
    // about, and two lines for one cause is how an incident stops being
    // readable.
    if (typeof value !== "number") return null;
    return value === LDAP_SUCCESS
      ? null
      : `The directory refused the bind: ${ldapResultMessage(value)}`;
  },
};

export const ldapSpec: CheckTypeSpec<LdapConfig> = {
  descriptor: ldapDescriptor,
  configSchema: ldapConfigSchema,
  storedSchema: ldapStoredSchema,
  secretFields: ["bindPassword"],
  targetSchema: monitorHostnameSchema,
  assertions: [answered, accepted, latencyAssertion<LdapConfig>("Bound")],
  fromRow(row: MonitorRowView): LdapConfig {
    const stored = ldapStoredSchema.safeParse(row.config ?? {});
    return {
      bindDn: stored.success ? stored.data.bindDn : null,
      bindPassword: stored.success ? stored.data.bindPassword : null,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, port) {
    // Host and port, and nothing from the config: this string is printed
    // in incident emails, webhook bodies and on public status pages, and
    // the config it is handed carries a directory password. The bind DN
    // is not a secret but it is an identity — naming the service account
    // Vigil authenticates with on a public status page is an invitation.
    //
    // The port is shown even when it is the default, because 389 and
    // 3268 are different services on the same Active Directory host and
    // an alert that omits which one was watched gets replied to.
    return `${target}:${port ?? DEFAULT_LDAP_PORT}`;
  },
};
