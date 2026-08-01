import { env } from "@/lib/env";

import { EgressBlockedError, egressFetch } from "../../egress";
import type { ProbeContext, ProbeResult } from "../contract";
import type { DomainExpiryConfig } from "../specs/domain-expiry";
import { elapsedSince, monitorEgress } from "./guard";

/**
 * Domain registration expiry over RDAP.
 *
 * RDAP is WHOIS with a JSON schema and a TLS transport (RFC 9083), so
 * this needs nothing but an HTTP client — no WHOIS client, no port 43,
 * no new dependency. The bootstrap host redirects to whichever registry
 * is authoritative for the TLD, so this check follows redirects by
 * design; that is the one thing it cannot work without.
 *
 * Which is exactly why it goes through the egress loop rather than
 * `redirect: "follow"`. `RDAP_BASE_URL` is operator-configurable and
 * the chain after it is chosen by a third party, so "follow whatever
 * rdap.org says" was an unauthenticated redirect into an unvalidated
 * host on a timer. Each hop is now classified before it is issued.
 */
const MAX_RDAP_BYTES = 512 * 1024;

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}

interface RdapEntity {
  roles?: string[];
  vcardArray?: unknown;
}

interface RdapResponse {
  events?: RdapEvent[];
  entities?: RdapEntity[];
}

export async function domainExpiryProbe(
  ctx: ProbeContext<DomainExpiryConfig>,
): Promise<ProbeResult> {
  const url = `${env.RDAP_BASE_URL.replace(/\/+$/, "")}/domain/${encodeURIComponent(ctx.target)}`;
  const startedAt = performance.now();

  let response: Response;
  let finalUrl: string;
  try {
    ({ response, finalUrl } = await egressFetch(
      url,
      {
        method: "GET",
        signal: AbortSignal.timeout(ctx.timeoutMs),
        headers: {
          accept: "application/rdap+json, application/json",
          "user-agent": "vigil-monitor/1.0 (+https://github.com)",
        },
      },
      monitorEgress(ctx),
    ));
  } catch (error) {
    const responseTimeMs = elapsedSince(startedAt);
    // A refused hop is Vigil failing to find out, not bad news about
    // the domain — the same bucket as a rate-limited registry, and for
    // the same reason: judging it `down` pins the monitor red on
    // evidence nobody has.
    if (error instanceof EgressBlockedError) {
      return unavailable(error.message, responseTimeMs);
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return unavailable(
        `RDAP lookup timed out after ${ctx.timeoutMs}ms`,
        responseTimeMs,
      );
    }
    const message =
      error instanceof Error
        ? (error.cause instanceof Error ? error.cause : error).message
        : "RDAP lookup failed";
    return unavailable(message, responseTimeMs);
  }

  const responseTimeMs = elapsedSince(startedAt);

  // A 404 only means "no such domain" if a *registry* said it.
  //
  // `RDAP_BASE_URL` is a bootstrap redirector. Asked for a TLD it has no
  // entry for — .de, .io, .ch, .at, .jp, .nz, .ru among others — it
  // answers 404 itself rather than redirecting anywhere. Keying on the
  // status code alone turned every domain under those TLDs into a
  // permanent false outage: down, incident, page, red public page, and
  // unresolvable, because closing an incident needs a positive
  // observation and this branch can never produce one.
  //
  // So discriminate on who answered. `response.url` is the *final* URL
  // after redirects; a different host means the bootstrap routed us to a
  // registry and that registry disclaimed the domain. The same host
  // means nobody was ever asked.
  if (response.status === 404) {
    return answeredByRegistry(finalUrl)
      ? transportFailure(
          "The registry has no record of this domain",
          responseTimeMs,
        )
      : unavailable(
          "No RDAP service is published for this domain's TLD",
          responseTimeMs,
        );
  }
  if (!response.ok) {
    return unavailable(
      `RDAP lookup returned ${response.status}`,
      responseTimeMs,
    );
  }

  // Caught, not left to reject: `readCapped` uses try/finally, and it
  // sits outside the try block above, so a rejection escapes
  // `performCheck` and `runMonitorCheck` too. No row gets written,
  // `nextEvaluationAt` never advances, and the monitor is re-enqueued
  // every tick forever with no observation to show for it. An ordinary
  // slow ccTLD registry triggers it: the timeout fires *during* the
  // body read, after the branch above that handles timeouts.
  //
  // Reported as its own failure rather than falling through to the
  // JSON parse — the body was not malformed, it was never finished
  // arriving, and an operator chasing this deserves to know which.
  const text = await readCapped(response, MAX_RDAP_BYTES).catch(() => null);
  if (text === null) {
    return unavailable(
      "RDAP response could not be read in full",
      responseTimeMs,
    );
  }

  // Parsed defensively, not cast. `JSON.parse` returns `any`, so a
  // registry answering `null` — or with `events` as an object rather
  // than an array — throws inside the helpers below, out of
  // `performCheck` and out of `runMonitorCheck`, before any row is
  // written. The monitor would then never advance `nextEvaluationAt`
  // and would be re-enqueued every tick forever with nothing to show
  // for it. Optional chaining does not guard a wrong type.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unavailable("RDAP returned malformed JSON", responseTimeMs);
  }
  if (parsed === null || typeof parsed !== "object") {
    return unavailable("RDAP returned an unexpected shape", responseTimeMs);
  }
  const payload = parsed as RdapResponse;

  const expiresAt = findExpiration(payload);
  if (expiresAt === null) {
    // Some ccTLD registries omit the expiration event entirely. That is
    // a gap in what the registry publishes, not a fact about the domain
    // — and reporting it `down` would pin the monitor red permanently,
    // since resolution needs a positive observation this branch can
    // never produce.
    return unavailable(
      "This registry does not publish an expiry date over RDAP",
      responseTimeMs,
    );
  }

  return {
    facts: {
      daysRemaining: Math.floor(
        (expiresAt.getTime() - Date.now()) / 86_400_000,
      ),
      expiresAt: expiresAt.toISOString(),
      registrar: findRegistrar(payload),
      responseTimeMs,
    },
    responseTimeMs,
    statusCode: response.status,
    error: null,
  };
}

function findExpiration(payload: RdapResponse): Date | null {
  // `Array.isArray`, not optional chaining: `?.` guards absence, not a
  // wrong type, and a registry sending `events` as an object is a quirk
  // away rather than a hostile act.
  if (!Array.isArray(payload.events)) return null;
  const event = payload.events.find(
    (candidate) => candidate?.eventAction === "expiration",
  );
  if (typeof event?.eventDate !== "string") return null;
  const parsed = new Date(event.eventDate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The registrar's name, dug out of the jCard in the registrar entity.
 * jCard (RFC 7095) is an array of `[name, params, type, value]` tuples;
 * we want the `fn` (formatted name) one. Best-effort — a missing
 * registrar is cosmetic and never changes the verdict.
 */
function findRegistrar(payload: RdapResponse): string | null {
  if (!Array.isArray(payload.entities)) return null;
  const entity = payload.entities.find((candidate) =>
    Array.isArray(candidate?.roles)
      ? candidate.roles.includes("registrar")
      : false,
  );
  const vcard = entity?.vcardArray;
  if (!Array.isArray(vcard) || !Array.isArray(vcard[1])) return null;
  for (const entry of vcard[1] as unknown[]) {
    if (
      Array.isArray(entry) &&
      entry[0] === "fn" &&
      typeof entry[3] === "string"
    ) {
      return entry[3];
    }
  }
  return null;
}

async function readCapped(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/**
 * Whether an authoritative registry answered, rather than the bootstrap.
 *
 * `finalUrl` is where the last validated hop was issued — the egress
 * loop's own record of the chain, which is more trustworthy here than
 * `Response.url`: a `Response` constructed by hand (tests, some
 * polyfills) leaves that empty, and the loop falls back to the request
 * URL, which is the bootstrap, i.e. the conservative answer.
 *
 * Known trade-off: an operator who points `RDAP_BASE_URL` straight at a
 * registry instead of a bootstrap gets same-host on a genuine NXDOMAIN
 * and so loses the lapsed-registration catch. That fails toward "I do
 * not know" rather than toward a false page, which is the direction this
 * check has to fail in — and `README.md` says the variable wants a
 * bootstrap service.
 */
function answeredByRegistry(finalUrl: string): boolean {
  try {
    const finalHost = new URL(finalUrl).host;
    const bootstrapHost = new URL(env.RDAP_BASE_URL).host;
    return finalHost !== bootstrapHost;
  } catch {
    return false;
  }
}

/**
 * The domain really is not registered.
 *
 * Reserved for a 404 that a registry answered — the one thing this check
 * exists to catch, since a lapsed registration reads exactly this way.
 * Judged `down`, and it should be.
 */
function transportFailure(error: string, responseTimeMs: number): ProbeResult {
  return { facts: { responseTimeMs }, responseTimeMs, statusCode: null, error };
}

/**
 * Vigil could not find out — which is not the same as bad news about
 * the domain, and must not be judged `down`.
 *
 * Every other failure path lands here: an rdap.org rate-limit, a slow
 * registry, a body that stopped arriving, a ccTLD that does not publish
 * expiry over RDAP at all. Treating those as `down` pages on-call,
 * reddens a public status page and permanently lowers published uptime
 * for a domain that is fine — and in the no-expiry case it pins the
 * monitor red *forever*, because resolution needs a positive
 * observation that branch can never produce.
 *
 * Two functions rather than a boolean argument, so a future branch has
 * to choose which of the two things it means.
 */
function unavailable(reason: string, responseTimeMs: number): ProbeResult {
  return {
    facts: { responseTimeMs },
    responseTimeMs,
    statusCode: null,
    error: null,
    unavailable: reason,
  };
}
