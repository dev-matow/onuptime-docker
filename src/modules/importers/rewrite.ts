/**
 * Rewriting a source system's strings into the forms Vigil's schemas
 * accept.
 *
 * Every function here is pure, isomorphic and returns null rather than
 * an approximation. That is the rule the whole migration feature rests
 * on: a value that cannot be expressed is refused and reported, never
 * narrowed into something the operator did not write. A JSONPath with a
 * wildcard in it does not become "the first match", and a slug of two
 * characters does not become a padded one.
 *
 * These started inside the Uptime Kuma importer and moved out when the
 * hosted providers arrived, because every one of them has a slug, a
 * path or a URL with a credential in it.
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Vigil's dotted path from a JSONPath expression, or null when the
 * expression is richer than a fixed location.
 *
 * A wildcard or a filter cannot be narrowed into a single path without
 * choosing a meaning the operator did not write, so it is refused.
 */
const DOTTED_PATH =
  /^[A-Za-z0-9_-]+(?:\[\d+\])*(?:\.[A-Za-z0-9_-]+(?:\[\d+\])*)*$/;

export function vigilJsonPath(sourcePath: string): string | null {
  let path = sourcePath.trim();
  if (path.startsWith("$.")) path = path.slice(2);
  else if (path === "$") return null;
  return DOTTED_PATH.test(path) ? path : null;
}

/** A slug Vigil's status page rules accept, derived from the source's. */
export function vigilStatusPageSlug(sourceSlug: string): string | null {
  const slug = sourceSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return slug.length >= 3 ? slug : null;
}

/**
 * A URL with any inline credentials removed, and whether there were
 * any.
 *
 * `https://ops:hunter2@example.com/health` is a perfectly ordinary thing
 * to find in a competitor's check list, and Vigil's HTTP probe does not
 * send the userinfo section, so keeping it would store a password in a
 * column that renders on the monitor page and in every incident email
 * for no benefit at all. The caller reports the removal without ever
 * seeing what was removed.
 */
export function stripUrlCredentials(value: string): {
  url: string;
  hadCredentials: boolean;
} {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { url: value.trim(), hadCredentials: false };
  }
  const hadCredentials = url.username !== "" || url.password !== "";
  if (!hadCredentials) return { url: url.toString(), hadCredentials: false };
  url.username = "";
  url.password = "";
  return { url: url.toString(), hadCredentials: true };
}

/** The hostname of a URL, or null when the string is not one. */
export function hostOf(value: string): string | null {
  try {
    const host = new URL(value.trim()).hostname.replace(/^\[|\]$/g, "");
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/**
 * A bare `host:port`, which is how several providers store a TCP
 * target. Not a URL: there is no scheme, so one is lent for the parse
 * and thrown away.
 */
export function hostPort(
  value: string,
  fallbackPort: number | null = null,
): { host: string; port: number | null } | null {
  const raw = value.trim();
  if (raw.length === 0) return null;
  const withScheme = raw.includes("://") ? raw : `tcp://${raw}`;
  try {
    const url = new URL(withScheme);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host.length === 0) return null;
    return { host, port: url.port === "" ? fallbackPort : Number(url.port) };
  } catch {
    return null;
  }
}
