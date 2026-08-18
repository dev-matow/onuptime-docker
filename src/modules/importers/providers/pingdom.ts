import type { SourceCheck, SourceExtra, SourceSnapshot } from "../model";

import {
  requireCredential,
  transportFor,
  type ProviderAdapter,
  type ProviderCapability,
  type ReadContext,
} from "./contract";
import { arr, bool, num, obj, str, strs, type Json } from "./json";

/**
 * Pingdom, through the REST API 3.1.
 *
 * The expensive one. `GET /checks` returns fourteen fields per check and
 * none of them is the configuration: no path, no keyword, no headers, no
 * port. Everything this importer needs is behind `GET /checks/{id}`, so
 * a four-hundred-check account costs four hundred and one requests. That
 * is not a shortcut anyone can take; it is what the API publishes.
 *
 * The two responses also disagree about the shape of `type`. In the list
 * it is a string, `"http"`. In the detail it is an object with one key,
 * `{"http": {...}}`, and that key is the type. This adapter reads the
 * detail's key, because that is the response the configuration comes in.
 *
 * Three Pingdom concepts have no field at all and cannot be recovered by
 * any amount of reading: there is no HTTP method (sending `postdata` is
 * what makes a check a POST), there is no request timeout, and there is
 * no accepted-status-code list. An importer that produced values for
 * them would be producing them from nowhere.
 */

const BASE = "https://api.pingdom.com/api/3.1";

const CAPABILITIES: readonly ProviderCapability[] = [
  {
    sourceType: "http",
    becomes: "http",
    note: "The scheme, host, path, port, keyword assertion and certificate expiry warning carry. Pingdom stores no HTTP method, so a check with `postdata` is a POST that cannot be expressed and is refused rather than silently issued as a GET. Request headers and basic authentication do not carry, and their values are never read.",
  },
  {
    sourceType: "httpcustom",
    becomes: null,
    note: "Not imported. The check parses a body of `identifier:value` pairs and alerts on the numbers in it, which is a metric check rather than an availability check, and Vigil has nothing that means the same thing.",
  },
  {
    sourceType: "tcp",
    becomes: "tcp",
    note: "Host and port carry. The string Pingdom sends and the string it expects in reply do not: Vigil's TCP check judges whether the connection opens.",
  },
  { sourceType: "ping", becomes: "ping", note: "Imported unchanged." },
  {
    sourceType: "udp",
    becomes: null,
    note: "Not imported. Vigil's UDP check has to send the payload the service replies to, because UDP answers nothing it was not asked, and this importer does not copy request payloads out of a monitoring account. An imported UDP monitor would send an empty datagram and report a permanent outage, so it is refused instead. Recreate it in Vigil, where the payload and the expected reply are settings on the check.",
  },
  {
    sourceType: "dns",
    becomes: null,
    note: "Not imported. Pingdom stores a nameserver and an expected IP and no record type, so Vigil's DNS check would have to be told which record to ask for and nothing in the source says. Asking for the wrong one produces a monitor that passes while the record it was watching is broken.",
  },
  {
    sourceType: "smtp",
    becomes: "smtp",
    note: "Host and port carry. Vigil reads the banner and sends EHLO in plaintext, so Pingdom's encryption setting and its expected string do not carry.",
  },
  {
    sourceType: "imap",
    becomes: "imap",
    note: "Host and port carry. Vigil reads the greeting and asks for capabilities, so Pingdom's expected string does not carry.",
  },
  {
    sourceType: "pop3",
    becomes: null,
    note: "Not imported. Vigil has no POP3 check. Watch the port with a TCP monitor if reachability is enough.",
  },
  {
    sourceType: "transaction",
    becomes: null,
    note: "Not imported. Pingdom's transaction checks live under a separate resource and are either a recorded browser session or a script of proprietary step commands. Vigil has no check type that replays a journey.",
  },
];

const MAPPED = new Map(CAPABILITIES.map((entry) => [entry.sourceType, entry]));

/**
 * The type name and its settings out of the detail response's one-key
 * object.
 */
function typeOf(check: Record<string, Json>): {
  type: string;
  settings: Record<string, Json>;
} {
  const container = obj(check.type);
  const [first] = Object.keys(container);
  if (first === undefined) {
    // A check whose type came back as a bare string, which is what the
    // list endpoint sends. Nothing to configure from, but the type is
    // still worth reporting.
    return { type: str(check.type) ?? "unknown", settings: {} };
  }
  return { type: first, settings: obj(container[first]) };
}

/**
 * The URL Pingdom would request, assembled from three fields.
 *
 * `hostname` is the host, `type.http.url` is the *path* on it, and
 * `encryption` decides the scheme. Reading `url` as a whole URL, which
 * its name invites, produces `https://example.com` for every check on a
 * host regardless of what each one actually watched.
 */
function httpUrl(
  check: Record<string, Json>,
  settings: Record<string, Json>,
): string | undefined {
  const host = str(check.hostname);
  if (host === undefined) return undefined;
  // Pingdom's spec calls this field "Connection encryption" and never
  // says it selects the scheme. Nothing else on an HTTP check could
  // choose one, and its UI labels the same setting "Encryption", so
  // https is the reading; the check's report line says the URL was
  // assembled and from what, so an operator can see the assumption
  // rather than discover it.
  const scheme = bool(settings.encryption) === true ? "https" : "http";
  const port = num(settings.port);
  const path = str(settings.url) ?? "/";
  const authority =
    port === undefined || port === 80 || port === 443
      ? host
      : `${host}:${port}`;
  return `${scheme}://${authority}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Header names out of Pingdom's `"Name:Value"` strings. */
function headerNames(settings: Record<string, Json>): string[] {
  return strs(settings.requestheaders)
    .map((entry) => entry.split(":")[0]?.trim() ?? "")
    .filter((name) => name.length > 0);
}

function toCheck(check: Record<string, Json>): SourceCheck {
  const { type, settings } = typeOf(check);
  const mapping = MAPPED.get(type);
  const sourceId = str(check.id) ?? "unknown";
  const name = str(check.name) ?? `Pingdom check ${sourceId}`;

  const common = {
    sourceId,
    name,
    sourceType: type,
    // Pingdom has no `paused` field on read: a paused check reports its
    // status as `paused`, which is the same column that says `down`.
    paused: str(check.status)?.toLowerCase() === "paused",
    // `resolution` is minutes. Every other provider here stores seconds.
    intervalSeconds:
      num(check.resolution) === undefined
        ? undefined
        : (num(check.resolution) ?? 1) * 60,
    tags: arr(check.tags)
      .map((tag) => str(obj(tag).name))
      .filter((tag): tag is string => tag !== undefined),
    regions: strs(check.probe_filters),
    retries:
      num(check.sendnotificationwhendown) === undefined
        ? undefined
        : {
            count: num(check.sendnotificationwhendown),
            note: "Pingdom counts failed checks before it notifies, and Vigil measures how long a monitor has been failing, so the count was multiplied by the check interval to produce the same wall-clock tolerance.",
          },
  };

  if (mapping === undefined || mapping.becomes === null) {
    return {
      ...common,
      kind: "unsupported",
      target: {},
      unsupportedReason:
        mapping?.note ??
        `Pingdom calls this a "${type}" check, which is not a type this adapter was written against, so nothing can be promised about it.`,
    };
  }

  const losses: string[] = [];
  const withheld: string[] = [];
  if (str(settings.username) !== undefined) {
    withheld.push("the password this check authenticates with");
  }
  const expected = str(settings.stringtoexpect);
  if (expected !== undefined && type !== "http") {
    losses.push(
      `Pingdom expected "${expected}" in the reply. Vigil's ${type} check judges whether the service answers correctly rather than comparing a string, so the expectation was not carried.`,
    );
  }
  if (str(settings.stringtosend) !== undefined) {
    losses.push(
      "The payload Pingdom sent before reading the reply was not carried: Vigil's check sends its own probe.",
    );
  }
  if (num(check.responsetime_threshold) !== undefined) {
    losses.push(
      `Pingdom treated the check as down over ${num(check.responsetime_threshold)}ms. Vigil marks a monitor degraded over its own threshold rather than down, so this monitor will not open an incident on latency alone.`,
    );
  }

  const port = num(settings.port);
  const host = str(check.hostname);

  switch (type) {
    case "http": {
      const keyword = str(settings.shouldcontain);
      const absent = str(settings.shouldnotcontain);
      const sslDays = num(settings.ssl_down_days_before);
      const names = headerNames(settings);
      losses.push(
        `The URL was assembled from the check's hostname, its port and the path Pingdom stores separately, as ${httpUrl(check, settings) ?? "(no host)"}. Pingdom keeps no whole URL and documents its encryption flag only as "connection encryption", so confirm the scheme is the one this check watched.`,
      );
      return {
        ...common,
        kind: "http",
        target: { url: httpUrl(check, settings) },
        http: {
          // Pingdom has no method field. A check with post data is a
          // POST, and saying so is what gets it refused rather than
          // imported as a GET of the same URL.
          method: str(settings.postdata) === undefined ? "GET" : "POST",
          keyword: keyword ?? absent,
          keywordAbsent: keyword === undefined && absent !== undefined,
          headerNames: names.length > 0 ? names : undefined,
          hasRequestBody: str(settings.postdata) !== undefined,
          hasBasicAuth: str(settings.username) !== undefined,
          checkCertificateExpiry:
            bool(settings.verify_certificate) !== false &&
            sslDays !== undefined &&
            sslDays > 0,
          certificateWarnDays:
            sslDays !== undefined && sslDays > 0 ? sslDays : undefined,
          otherAssertions: strs(settings.additionalurls).map(
            (extra) =>
              `Pingdom also requested ${extra} as part of this check. A Vigil monitor watches one target, so create a second monitor for it.`,
          ),
        },
        losses,
        withheld,
      };
    }
    case "ping":
      return { ...common, kind: "ping", target: { host }, losses, withheld };
    case "tcp":
      return {
        ...common,
        kind: "tcp",
        target: { host, port },
        losses,
        withheld,
      };
    default:
      return {
        ...common,
        kind: type === "smtp" ? "smtp" : "imap",
        target: { host, port },
        losses,
        withheld,
      };
  }
}

export const pingdomAdapter: ProviderAdapter = {
  id: "pingdom",
  label: "Pingdom",
  input: "api",
  docs: "https://docs.pingdom.com/api/",
  access:
    "An API token from Pingdom, Integrations, The Pingdom API, with the Read access level. Read is enough: this importer only issues GET requests.",
  credentials: [
    {
      name: "token",
      label: "API token",
      help: "Sent as a bearer token. It is used for this read and never stored.",
      secret: true,
      required: true,
    },
  ],
  capabilities: CAPABILITIES,
  limitations: [
    "Pingdom's check list carries no configuration, so this importer reads every check individually. An account with hundreds of checks takes hundreds of requests and will be rate limited on the way; the importer backs off and continues rather than failing.",
    "Pingdom stores no HTTP method. A check that sends post data is a POST, and this importer says so and refuses it rather than importing a GET of the same URL, which would watch something the check never watched.",
    "Pingdom stores no request timeout and no accepted-status-code list. Imported monitors get Vigil's default timeout and accept any 2xx or 3xx.",
    "Transaction checks live under the separate /tms/check resource and are recorded browser sessions or scripts. This adapter does not read them, and they are reported as not migrated.",
    "There is no official export of check configuration. The CSV Pingdom offers is the test result log.",
  ],
  async read(context: ReadContext): Promise<SourceSnapshot> {
    const token = requireCredential(context, "token", "The API token");
    const transport = transportFor(context, BASE, {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    });

    const listed = await transport.json<{ checks?: Json; counts?: Json }>(
      "/checks",
      { limit: 25000, include_tags: "true" },
    );
    const summaries = arr(listed.checks).map((row) => obj(row));

    const checks: SourceCheck[] = [];
    let unreadable = 0;
    for (const summary of summaries) {
      const id = str(summary.id);
      if (id === undefined) {
        unreadable += 1;
        continue;
      }
      try {
        const detail = await transport.json<{ check?: Json }>(`/checks/${id}`);
        checks.push(toCheck(obj(detail.check)));
      } catch (error) {
        // One check the API will not hand over must not cost the other
        // three hundred. The check still gets a line, and the line says
        // what happened.
        unreadable += 1;
        checks.push({
          sourceId: id,
          name: str(summary.name) ?? `Pingdom check ${id}`,
          sourceType: str(summary.type) ?? "unknown",
          kind: "unsupported",
          paused: str(summary.status)?.toLowerCase() === "paused",
          target: {},
          unsupportedReason: `Pingdom would not return this check's configuration, so nothing about it could be read: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    const extras: SourceExtra[] = [
      {
        kind: "alerting",
        sourceId: "integrations",
        label: "Integrations and alert policies",
        detail:
          "Pingdom attaches integrations and contacts to individual checks. Vigil decides who is told by notification channel and escalation policy, which belong to the organisation rather than to the monitor, so there is no per-check attachment to recreate.",
      },
      {
        kind: "script",
        sourceId: "tms",
        label: "Transaction checks",
        detail:
          "Pingdom's transaction checks are a separate resource holding either a recorded browser session or a script of proprietary step commands. This adapter does not read them, and Vigil has no check type that replays a journey. Any transaction check in this account is not migrated.",
      },
    ];

    return {
      provider: "pingdom",
      facts: [
        `Pingdom REST API 3.1, ${summaries.length} check(s) listed, ${checks.length} read individually, ${transport.requestCount} request(s).`,
        unreadable === 0
          ? "Every listed check was read."
          : `${unreadable} check(s) could not be read and are reported individually.`,
      ],
      checks,
      statusPages: [],
      extras,
    };
  },
};
