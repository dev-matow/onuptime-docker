/**
 * The one place a secret can be removed from a string, and the last
 * line of defence before anything a check touched is written down.
 *
 * It lived under `modules/synthetics/` while journeys were the only
 * thing that held credentials at run time. Incident evidence holds them
 * too - a monitor's config secrets and the password inside a connection
 * string - and Core has incident evidence, so the module moved here
 * rather than being written a second time. A second redactor is a
 * second set of encodings to remember and one of them is always the one
 * that leaks.
 *
 * The design rule is that redaction keys on the *value*, never on the
 * name or the field. By the time a credential has been interpolated into
 * a URL, a form body or a header it has no name any more - it is bytes
 * in the middle of other bytes - and a redactor that masked
 * `config.password` would sail straight past
 * `?api_key=hunter2&page=3`. So the caller holds the set of live secret
 * values (a journey's scope, a monitor's secret fields) and everything
 * on the way out is scrubbed against it.
 *
 * Two properties matter more than tidiness here:
 *
 * **It fails closed.** {@link sealEvidence} redacts, then *re-checks*
 * its own output, and replaces the whole value with a marker if anything
 * survived. A redactor with a bug should cost an operator one unreadable
 * evidence row, not a credential in the audit log.
 *
 * **It covers the encodings the product actually produces.** A secret in
 * a query string is percent-encoded by the time it is a URL; a secret in
 * a JSON body is backslash-escaped; a secret in a Basic credential is
 * base64. Masking only the raw form would be a redactor that works in
 * the test and not in production.
 */

/** What replaces a secret. Recognisable, and not a plausible credential. */
export const SECRET_PLACEHOLDER = "[redacted]";

/** What replaces a whole value that could not be cleaned. */
export const UNSAFE_PLACEHOLDER =
  "[withheld: this value could not be safely redacted]";

/**
 * Every form of a secret this codebase can put on a wire.
 *
 * Deliberately over-broad. A form listed here that never occurs costs
 * one wasted `indexOf` per evidence string; a form omitted is a leak.
 */
function encodingsOf(secret: string): string[] {
  const forms = new Set<string>([secret]);
  const add = (candidate: string) => {
    if (candidate.length > 0 && candidate !== secret) forms.add(candidate);
  };
  try {
    add(encodeURIComponent(secret));
  } catch {
    // A lone surrogate cannot be percent-encoded. The raw form is still
    // covered, which is the form such a value would actually take.
  }
  // `application/x-www-form-urlencoded` differs from encodeURIComponent
  // by exactly one character, and it is the one most likely to appear in
  // a login body.
  try {
    add(encodeURIComponent(secret).replace(/%20/g, "+"));
  } catch {
    /* as above */
  }
  // JSON string escaping, without the surrounding quotes: what a secret
  // looks like once it is inside a request body.
  const json = JSON.stringify(secret);
  add(json.slice(1, -1));
  // Base64, for a bearer or Basic credential assembled by the operator.
  add(Buffer.from(secret, "utf8").toString("base64"));
  add(Buffer.from(secret, "utf8").toString("base64url"));
  return [...forms];
}

export interface Redactor {
  /** Masks every known secret form in a string. */
  (text: string): string;
  /** Whether any secret survives in `text`. */
  isClean(text: string): boolean;
  /** How many distinct values this redactor is holding. */
  readonly size: number;
}

/**
 * Builds a redactor over a set of secret values.
 *
 * Forms are sorted longest first so that a secret which contains another
 * secret is masked as a whole rather than shredded into a masked middle
 * and two readable ends - the readable ends being exactly the part an
 * attacker with the rest of the string would need.
 */
export function makeRedactor(secrets: Iterable<string>): Redactor {
  const forms: string[] = [];
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    forms.push(...encodingsOf(secret));
  }
  const unique = [...new Set(forms)].sort((a, b) => b.length - a.length);

  const redact = ((text: string): string => {
    if (unique.length === 0) return text;
    let out = text;
    for (const form of unique) {
      if (out.length < form.length) continue;
      // `split`/`join` rather than a RegExp: the secret is arbitrary text
      // and would have to be escaped to be a safe pattern, and an
      // escaping bug in a redactor is a leak with a stack trace.
      if (out.includes(form)) out = out.split(form).join(SECRET_PLACEHOLDER);
    }
    return out;
  }) as Redactor;

  Object.defineProperty(redact, "size", { value: unique.length });
  redact.isClean = (text: string): boolean =>
    !unique.some((form) => text.includes(form));

  return redact;
}

/** A redactor holding nothing, for a journey with no secrets. */
export const NO_SECRETS: Redactor = makeRedactor([]);

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Deep-redacts a JSON-shaped value and then proves its own work.
 *
 * Keys are redacted as well as values. A response body used as an object
 * can perfectly well have a credential as a *key* - `{"hunter2": true}`
 * is unusual and `{"sk_live_...": {...}}` is not - and a redactor that
 * only walked values would write it out.
 *
 * Anything that is not JSON-shaped (a Date, a function, a bigint) is
 * dropped rather than coerced. Evidence rows are jsonb; a value that
 * cannot round-trip through JSON was never going to survive storage, and
 * `String(value)` on an unknown object is how `[object Object]` ends up
 * in an incident timeline.
 */
export function sealEvidence(value: unknown, redact: Redactor): Json {
  const cleaned = walk(value, redact, 0);
  // The proof. Serialising once and scanning the result catches anything
  // the walk missed - a string inside a shape this function does not
  // model, a key it forgot, a future edit that adds a branch.
  const serialized = JSON.stringify(cleaned ?? null);
  if (!redact.isClean(serialized)) return UNSAFE_PLACEHOLDER;
  return cleaned ?? null;
}

const MAX_DEPTH = 12;
const MAX_KEYS = 200;

function walk(value: unknown, redact: Redactor, depth: number): Json {
  if (depth > MAX_DEPTH) return "[truncated: too deeply nested]";
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redact(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_KEYS)
      .map((entry) => walk(entry, redact, depth + 1));
  }
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    let seen = 0;
    for (const [key, entry] of Object.entries(value as object)) {
      if (seen >= MAX_KEYS) break;
      seen += 1;
      // `__proto__` as a literal key on a plain object is inert in
      // modern engines, but this object is about to be serialised and
      // parsed by something else, and that something else may not be.
      if (key === "__proto__" || key === "constructor") continue;
      out[redact(key)] = walk(entry, redact, depth + 1);
    }
    return out;
  }
  return null;
}

/**
 * A message safe to put in an incident, a notification or a log line.
 *
 * Errors are the sink people forget. A `fetch` failure quotes the URL it
 * was given, `EgressBlockedError` quotes the host, and a JSON parse
 * failure quotes the input - so the one path that is *only* taken when
 * something has gone wrong is also the one most likely to carry the
 * credential out with it.
 */
export function safeMessage(error: unknown, redact: Redactor): string {
  const raw =
    error instanceof Error
      ? error.cause instanceof Error && error.message === "fetch failed"
        ? // `fetch` wraps the real reason and reports "fetch failed",
          // which tells an operator nothing. The cause is the message.
          error.cause.message
        : error.message
      : typeof error === "string"
        ? error
        : "the step failed";
  const masked = redact(raw);
  return redact.isClean(masked) ? masked : UNSAFE_PLACEHOLDER;
}
