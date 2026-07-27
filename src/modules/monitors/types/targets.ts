import { z } from "zod";

/**
 * Target validation, shared by every check type.
 *
 * Lives here rather than in `schemas.ts` so a type spec can reference a
 * target schema without importing the monitor schemas that import the
 * type specs. Isomorphic: zod only.
 */

/**
 * Hostnames a monitor may never target, regardless of environment:
 * cloud metadata endpoints are the classic SSRF jackpot. Private ranges
 * are additionally rejected at DNS-resolution time in the worker (see
 * modules/monitors/net.ts) unless ALLOW_PRIVATE_MONITOR_TARGETS is set.
 */
export const FORBIDDEN_HOSTNAMES = new Set(["metadata.google.internal"]);
export const METADATA_IP = "169.254.169.254";

/** Bare hostname — no scheme, no port. */
export const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * Public suffixes that are two labels deep, so `bbc.co.uk` is a
 * registrable domain and `co.uk` is not.
 *
 * Counting labels is not a substitute for this table in either
 * direction. Two labels rejected every `.co.uk`, `.com.au` and `.co.jp`
 * domain outright — every other check type accepts those hosts, and
 * RDAP resolves them fine through Nominet and friends. Relaxing to
 * "two or three" would be worse than the bug: `www.bbc.co.uk` would
 * pass the form, 404 at the registry, and page on a typo.
 *
 * Not the full Public Suffix List — that is a ~10k-entry file with its
 * own update cadence, and the check only needs the suffixes a customer
 * would plausibly monitor. Anything missing here fails closed, with a
 * message that says what the field wants.
 */
const TWO_LEVEL_SUFFIXES = new Set([
  // United Kingdom
  "ac.uk",
  "co.uk",
  "gov.uk",
  "ltd.uk",
  "me.uk",
  "mod.uk",
  "net.uk",
  "nhs.uk",
  "org.uk",
  "plc.uk",
  "police.uk",
  "sch.uk",
  // Australia
  "asn.au",
  "com.au",
  "edu.au",
  "gov.au",
  "id.au",
  "net.au",
  "org.au",
  // Japan
  "ac.jp",
  "ad.jp",
  "co.jp",
  "ed.jp",
  "go.jp",
  "gr.jp",
  "lg.jp",
  "ne.jp",
  "or.jp",
  // New Zealand
  "ac.nz",
  "co.nz",
  "geek.nz",
  "govt.nz",
  "health.nz",
  "iwi.nz",
  "kiwi.nz",
  "maori.nz",
  "mil.nz",
  "net.nz",
  "org.nz",
  "school.nz",
  // Brazil
  "com.br",
  "edu.br",
  "gov.br",
  "net.br",
  "org.br",
  // China / Hong Kong / Singapore / Korea
  "ac.cn",
  "com.cn",
  "edu.cn",
  "gov.cn",
  "net.cn",
  "org.cn",
  "com.hk",
  "edu.hk",
  "gov.hk",
  "idv.hk",
  "net.hk",
  "org.hk",
  "com.sg",
  "edu.sg",
  "gov.sg",
  "net.sg",
  "org.sg",
  "per.sg",
  "ac.kr",
  "co.kr",
  "go.kr",
  "ne.kr",
  "or.kr",
  "pe.kr",
  "re.kr",
  // India
  "ac.in",
  "co.in",
  "edu.in",
  "firm.in",
  "gen.in",
  "gov.in",
  "ind.in",
  "net.in",
  "org.in",
  "res.in",
  // Indonesia / Thailand
  "ac.id",
  "biz.id",
  "co.id",
  "go.id",
  "my.id",
  "net.id",
  "or.id",
  "sch.id",
  "web.id",
  "ac.th",
  "co.th",
  "go.th",
  "in.th",
  "mi.th",
  "net.th",
  "or.th",
  // South Africa / Israel / Turkey
  "ac.za",
  "co.za",
  "gov.za",
  "net.za",
  "org.za",
  "web.za",
  "ac.il",
  "co.il",
  "gov.il",
  "k12.il",
  "muni.il",
  "net.il",
  "org.il",
  "bel.tr",
  "com.tr",
  "edu.tr",
  "gov.tr",
  "k12.tr",
  "net.tr",
  "org.tr",
  // Latin America
  "com.ar",
  "edu.ar",
  "gob.ar",
  "net.ar",
  "org.ar",
  "com.mx",
  "edu.mx",
  "gob.mx",
  "net.mx",
  "org.mx",
  "com.co",
  "edu.co",
  "gov.co",
  "net.co",
  "nom.co",
  "org.co",
  // Europe
  "com.es",
  "edu.es",
  "gob.es",
  "nom.es",
  "org.es",
  "com.pl",
  "edu.pl",
  "gov.pl",
  "net.pl",
  "org.pl",
  "com.pt",
  "edu.pt",
  "gov.pt",
  "net.pt",
  "nome.pt",
  "org.pt",
  "publ.pt",
  "edu.it",
  "gov.it",
  "asso.fr",
  "com.fr",
  "gouv.fr",
  "nom.fr",
  "prd.fr",
  "tm.fr",
  "com.ua",
  "edu.ua",
  "gov.ua",
  "in.ua",
  "net.ua",
  "org.ua",
  "com.ru",
  "net.ru",
  "org.ru",
]);

/** A registrable domain: exactly one label in front of a public suffix. */
function isRegistrableDomain(value: string): boolean {
  if (!HOSTNAME_PATTERN.test(value)) return false;
  const labels = value.toLowerCase().split(".");
  const suffixLabels = TWO_LEVEL_SUFFIXES.has(labels.slice(-2).join("."))
    ? 2
    : 1;
  return labels.length === suffixLabels + 1;
}

function forbidden(value: string): boolean {
  const host = value.toLowerCase();
  return FORBIDDEN_HOSTNAMES.has(host) || value === METADATA_IP;
}

export const monitorUrlSchema = z
  .url({ protocol: /^https?$/, hostname: z.regexes.domain })
  .max(2048)
  .refine(
    (value) => {
      let hostname: string;
      try {
        hostname = new URL(value).hostname;
      } catch {
        return true; // invalid URL — let the .url() check reject it
      }
      return !forbidden(hostname);
    },
    { message: "This host cannot be monitored." },
  );

export const monitorHostnameSchema = z
  .string()
  .trim()
  .max(253)
  .refine((value) => HOSTNAME_PATTERN.test(value) && !forbidden(value), {
    message: "Enter a hostname (no scheme, no port).",
  });

export const monitorDomainSchema = z
  .string()
  .trim()
  .max(253)
  .refine((value) => isRegistrableDomain(value) && !forbidden(value), {
    message:
      "Enter a registrable domain, like example.com or bbc.co.uk — not a subdomain.",
  });
