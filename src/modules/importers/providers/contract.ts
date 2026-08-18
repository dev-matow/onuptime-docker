import { isForbiddenEgressHost } from "@/modules/monitors/net";

import type { SourceSnapshot } from "../model";
import { ProviderTransport, type TransportOptions } from "../transport";

/**
 * What a provider adapter is, and what it is not allowed to be.
 *
 * An adapter reads one vendor's API and returns a `SourceSnapshot`. It
 * does not decide what imports, it does not touch the database, and it
 * does not own a `fetch`. Everything it knows that is worth publishing,
 * which vendor doc it was written against, what permission the token
 * needs, which of the vendor's check types becomes which Vigil type, is
 * **data on the adapter** rather than prose in a document, because a
 * page maintained by hand is a page that goes stale the first time an
 * adapter changes and nobody remembers it exists. `docs/MIGRATION.md` is
 * generated from these fields and a test fails when the file drifts.
 *
 * The honesty rule is in `capabilities`: every source type an adapter
 * can encounter has a row, and a row whose `becomes` is null is a type
 * that does not migrate. An adapter may not quietly turn a browser
 * journey into an HTTP check to make its table look complete.
 */

export interface CredentialField {
  /** Form field name, and the key in `ReadContext.credentials`. */
  name: string;
  label: string;
  help: string;
  /**
   * Rendered as a password field, never echoed back to the browser and
   * never written to a report. Everything an adapter needs to
   * authenticate is secret; a field that is not is something else, like
   * an account id or a region.
   */
  secret: boolean;
  required: boolean;
  /**
   * A fixed set of choices, for the regional providers.
   *
   * A choice rather than a free-text host, because this transport runs
   * inside the application server with no egress guard in front of it.
   * See `baseUrlFor` for the one exception and what guards it.
   */
  choices?: readonly { value: string; label: string }[];
}

export interface ProviderCapability {
  /** What the vendor calls it, verbatim. */
  sourceType: string;
  /** The Vigil check type it becomes, or null when none does. */
  becomes: string | null;
  /** What changes on the way across, or why nothing can. Never empty. */
  note: string;
}

export interface ReadContext {
  /** Field name to value, as the operator typed them. Never stored. */
  credentials: Readonly<Record<string, string>>;
  /** Injected in tests so a read needs no network. */
  transport?: TransportOptions;
}

export interface ProviderAdapter {
  /** Stable id. Appears in URLs, reports and the docs table. */
  id: string;
  label: string;
  /** How the customer's data gets here. */
  input: "api";
  /** The vendor documentation this adapter was written against. */
  docs: string;
  /**
   * What the operator must create in the vendor's console, including the
   * exact scope or permission. Rendered on the import page, because
   * "invalid token" is a useless error when the real problem is that the
   * key was made read-only for the wrong resource.
   */
  access: string;
  credentials: readonly CredentialField[];
  capabilities: readonly ProviderCapability[];
  /** True of the whole provider, not of one check type. */
  limitations: readonly string[];
  read(context: ReadContext): Promise<SourceSnapshot>;
}

/** A required credential, or a refusal an operator can act on. */
export function requireCredential(
  context: ReadContext,
  name: string,
  label: string,
): string {
  const value = (context.credentials[name] ?? "").trim();
  if (value.length === 0) {
    throw new Error(`${label} is required to read this account.`);
  }
  return value;
}

/**
 * A base URL for a provider the customer may self-host.
 *
 * Two of the supported sources run on the customer's own hardware, so
 * the host cannot come from a fixed list. It is still not free: it must
 * be https, it must be a name rather than an address, and it must not
 * resolve to one of the classes `isForbiddenEgressHost` refuses, which
 * is the same predicate the monitor egress guard applies. That stops the
 * import form from being a way to make the application server issue
 * requests to a link-local metadata service.
 *
 * This is a check on the *name* only, and a name that is public when it
 * is typed can be private the next time DNS is asked. It is the early,
 * legible refusal; the boundary is `guarded: true` on the transport,
 * which resolves the name, refuses the never-reachable classes and pins
 * the socket to the address it approved. Both, because an operator who
 * pastes a loopback URL should be told so by the form rather than by a
 * request that was silently refused three layers down.
 */
export function baseUrlFor(value: string, label: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `${label} must be a full URL, like https://checks.example.com.`,
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `${label} must be https. A token sent over http is a token in the clear.`,
    );
  }
  if (isForbiddenEgressHost(url.hostname)) {
    throw new Error(`${label} names a host that cannot be reached from here.`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * The transport an adapter reads through, with its options threaded.
 *
 * `guarded` is for the adapters whose host came from the operator rather
 * than from a constant in their own file. It is not the default: sending
 * every vendor API call through a resolver-and-pin guard would buy
 * nothing for a hostname this repository ships, and would make an
 * outbound call to Datadog depend on this installation's private-network
 * policy.
 */
export function transportFor(
  context: ReadContext,
  base: string,
  headers: Readonly<Record<string, string>>,
  options: { guarded?: boolean } = {},
): ProviderTransport {
  return new ProviderTransport(base, headers, {
    ...options,
    ...(context.transport ?? {}),
  });
}
