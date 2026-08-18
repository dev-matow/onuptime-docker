import type { SourceCheck, SourceExtra, SourceSnapshot } from "../model";
import { hostPort } from "../rewrite";

import {
  requireCredential,
  transportFor,
  type ProviderAdapter,
  type ProviderCapability,
  type ReadContext,
} from "./contract";
import { arr, bool, num, obj, str, strs, type Json } from "./json";

/**
 * Oh Dear, through its API.
 *
 * Oh Dear's shape is the opposite of everyone else's: a *monitor* is a
 * site, and it carries a list of *checks* that all watch that one site
 * in different ways. Uptime, certificate health, broken links,
 * lighthouse, sitemap, DNS, domain expiry, mixed content, ports. So one
 * Oh Dear monitor is one Vigil monitor plus a list of capabilities Vigil
 * either expresses elsewhere or does not have, and every enabled check
 * that did not come across gets a line saying so.
 *
 * The list response is abridged in Oh Dear's own published example: it
 * omits every `*_check_settings` object, which is where the entire
 * configuration lives. So this adapter reads each monitor individually
 * after listing, exactly as the documentation's own wording implies.
 *
 * `checks[].settings` is deliberately not read. It is declared as an
 * untyped object and the vendor's own two examples give it two
 * incompatible shapes; the top-level `*_check_settings` objects are the
 * ones with a schema.
 */

const BASE = "https://ohdear.app/api";

const CAPABILITIES: readonly ProviderCapability[] = [
  {
    sourceType: "http",
    becomes: "http",
    note: "The URL, method, timeout, content match and its inversion, accepted status codes and certificate expiry threshold carry. Request headers, the request body and the expected response headers do not: Vigil's HTTP check issues GET or HEAD with its own headers. Oh Dear runs HTTP checks every minute and stores no interval, so the imported monitor arrives on Vigil's default.",
  },
  {
    sourceType: "ping",
    becomes: "ping",
    note: "The host and the interval carry. Oh Dear's packet count, packet size and acceptable-loss threshold do not: Vigil's ping check reports the round trip and whether a reply came back.",
  },
  {
    sourceType: "tcp",
    becomes: "tcp",
    note: "The host and port carry, read out of the URL, which is where Oh Dear keeps them. The string it sends and the strings it looks for in the greeting and the reply do not: Vigil's TCP check judges whether the connection opens.",
  },
  {
    sourceType: "ai",
    becomes: null,
    note: "Not imported. The check asks a language model to judge a page, and Vigil has no check type that does.",
  },
];

const MAPPED = new Map(CAPABILITIES.map((entry) => [entry.sourceType, entry]));

/**
 * The Oh Dear checks that are capabilities rather than transports, and
 * what an operator should do about each one.
 */
const SIDE_CHECKS: Readonly<Record<string, string>> = {
  certificate_health:
    "Oh Dear was watching this site's certificate. Vigil expresses that as its own TLS expiry check rather than as a setting on an HTTP monitor, so create one for this host.",
  domain:
    "Oh Dear was watching this domain's registration. Vigil expresses that as its own domain expiry check, so create one for this domain.",
  dns: "Oh Dear was watching this domain's DNS records for changes. Vigil's DNS check asserts that a named record type resolves and optionally contains a value, which is a different question, so nothing was carried.",
  broken_links:
    "Oh Dear was crawling this site for broken links. Vigil has no crawler.",
  mixed_content:
    "Oh Dear was crawling this site for mixed content. Vigil has no crawler.",
  lighthouse:
    "Oh Dear was scoring this site with Lighthouse. Vigil measures response time rather than page quality.",
  sitemap:
    "Oh Dear was validating this site's sitemap. Vigil has no sitemap check.",
  performance:
    "Oh Dear was recording this site's performance timings. Vigil records response time on the monitor itself.",
  cron: "Oh Dear was watching a scheduled task on this site. Vigil expresses that as a heartbeat monitor, so create one and point the job at its endpoint.",
  application_health:
    "Oh Dear was reading an application health endpoint that reports its own checks. Vigil has no equivalent; watch the endpoint with an HTTP monitor and a body assertion if that is enough.",
  ports:
    "Oh Dear was scanning this host's ports and comparing them against an expected list. Vigil's TCP check watches one port, so create one monitor per port you care about.",
  dns_blocklist:
    "Oh Dear was checking this domain against DNS blocklists. Vigil does not read blocklists.",
};

function toCheck(monitor: Record<string, Json>): SourceCheck {
  const sourceType = str(monitor.type)?.toLowerCase() ?? "http";
  const mapping = MAPPED.get(sourceType);
  const sourceId = str(monitor.id) ?? "unknown";
  const url = str(monitor.url);
  const name = str(monitor.label) ?? url ?? `Oh Dear monitor ${sourceId}`;
  const uptime = obj(monitor.uptime_check_settings);
  const checks = arr(monitor.checks).map((entry) => obj(entry));
  const uptimeCheck = checks.find((entry) => str(entry.type) === "uptime");
  const group = str(monitor.group_name);

  const common = {
    sourceId,
    name,
    sourceType,
    // Oh Dear has no monitor-level pause. A monitor whose uptime check
    // is disabled is not being watched, which is what paused means.
    paused: uptimeCheck !== undefined && bool(uptimeCheck.enabled) === false,
    tags: strs(monitor.tags),
    groupPath: group === undefined ? undefined : [group],
    regions:
      str(uptime.location) === undefined ? [] : [str(uptime.location) ?? ""],
    retries:
      num(uptime.failed_notification_threshold) === undefined
        ? undefined
        : {
            count: num(uptime.failed_notification_threshold),
            note: "Oh Dear counts failed checks before notifying and Vigil measures how long a monitor has been failing, so the count was multiplied by the check interval to produce the same wall-clock tolerance.",
          },
  };

  if (mapping === undefined || mapping.becomes === null) {
    return {
      ...common,
      kind: "unsupported",
      target: {},
      unsupportedReason:
        mapping?.note ??
        `Oh Dear calls this a "${sourceType}" monitor, which is not a type this adapter was written against, so nothing can be promised about it.`,
    };
  }

  // Every other check on this site, named individually. An operator
  // turning Oh Dear off needs to know the broken-link crawler is not
  // coming with them.
  const losses: string[] = [];
  for (const check of checks) {
    const type = str(check.type);
    if (type === undefined || type === "uptime") continue;
    if (bool(check.enabled) === false) continue;
    const advice = SIDE_CHECKS[type];
    losses.push(
      advice ??
        `Oh Dear also ran a "${type}" check on this site, and Vigil has nothing that means the same thing.`,
    );
  }

  switch (sourceType) {
    case "ping":
      return {
        ...common,
        kind: "ping",
        target: { host: url },
        intervalSeconds: num(uptime.interval_in_seconds),
        timeoutMs:
          num(uptime.timeout_in_seconds) === undefined
            ? undefined
            : (num(uptime.timeout_in_seconds) ?? 0) * 1000,
        losses,
      };
    case "tcp": {
      const endpoint = url === undefined ? null : hostPort(url);
      return {
        ...common,
        kind: "tcp",
        target: { host: endpoint?.host, port: endpoint?.port ?? undefined },
        timeoutMs: num(uptime.timeout_in_ms),
        losses,
      };
    }
    default: {
      const headerNames = arr(uptime.http_client_headers)
        .map((header) => str(obj(header).name))
        .filter((header): header is string => header !== undefined);
      // Oh Dear's accepted codes are globs: `["2*"]` is its default and
      // means the same as Vigil having no expectation, so only an
      // explicit code is worth carrying.
      const globs = strs(uptime.valid_status_codes);
      const explicit = globs.filter((code) => /^\d{3}$/.test(code));
      const wildcards = globs.filter((code) => !/^\d{3}$/.test(code));
      if (wildcards.length > 0 && wildcards.join(",") !== "2*") {
        losses.push(
          `Oh Dear accepted the status patterns ${wildcards.join(", ")}. Vigil holds one expected code, or none, in which case any 2xx or 3xx passes, so the patterns were not carried.`,
        );
      }
      const expectedHeaders = arr(uptime.expected_response_headers).length;
      if (expectedHeaders > 0) {
        losses.push(
          `Oh Dear asserted on ${expectedHeaders} response header(s). Vigil's HTTP check asserts on the status code, the body and the certificate, so the header assertions were not carried.`,
        );
      }
      const certificate = num(
        obj(monitor.certificate_health_check_settings)
          .expires_soon_threshold_in_days,
      );
      return {
        ...common,
        kind: "http",
        target: { url },
        timeoutMs:
          num(uptime.timeout) === undefined
            ? undefined
            : (num(uptime.timeout) ?? 0) * 1000,
        http: {
          method: str(uptime.http_verb)?.toUpperCase(),
          acceptedStatus: explicit.length > 0 ? explicit : undefined,
          keyword: str(uptime.look_for_string) ?? str(uptime.absent_string),
          keywordAbsent:
            str(uptime.look_for_string) === undefined &&
            str(uptime.absent_string) !== undefined,
          headerNames: headerNames.length > 0 ? headerNames : undefined,
          hasRequestBody:
            str(uptime.raw_payload) !== undefined ||
            arr(uptime.payload).length > 0,
          checkCertificateExpiry: certificate !== undefined,
          certificateWarnDays: certificate,
        },
        losses: [
          ...losses,
          "Oh Dear runs an HTTP check every minute and stores no interval, so this monitor arrives on Vigil's default of 60 seconds.",
        ],
      };
    }
  }
}

export const ohDearAdapter: ProviderAdapter = {
  id: "ohdear",
  label: "Oh Dear",
  input: "api",
  docs: "https://ohdear.app/docs/integrations/the-oh-dear-api",
  access:
    "An API token from Oh Dear, your profile, API tokens. Oh Dear scopes tokens by resource rather than by verb, so a token that can read your monitors can also write them; create one for this migration and revoke it afterwards. This importer only issues GET requests.",
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
    "Oh Dear's list response omits every settings object, so this importer reads each monitor individually.",
    "An Oh Dear monitor is a site carrying up to fourteen kinds of check. Only the uptime check becomes a Vigil monitor; every other enabled check is named on that monitor's report line with what to do instead.",
    "Oh Dear has no HTTP authentication fields at all: the documented route is a hand-encoded Authorization header, which this importer will not read or copy.",
    "HTTP checks run every minute and store no interval, so imported monitors take Vigil's default of 60 seconds.",
    "Oh Dear documents no rate limit for the monitors endpoint. This importer backs off on a 429 anyway.",
    "There is no official file export. Oh Dear's CLI can print monitors as JSON, which is the same data over the same API.",
  ],
  async read(context: ReadContext): Promise<SourceSnapshot> {
    const token = requireCredential(context, "token", "The API token");
    const transport = transportFor(context, BASE, {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    });

    const summaries: Record<string, Json>[] = [];
    let page = 1;
    for (;;) {
      const response = await transport.json<{ data?: Json; meta?: Json }>(
        "/monitors",
        { "page[number]": page, "page[size]": 200 },
      );
      for (const row of arr(response.data)) summaries.push(obj(row));
      const meta = obj(response.meta);
      const lastPage = num(meta.last_page) ?? 1;
      if (page >= lastPage) break;
      page += 1;
    }

    const checks: SourceCheck[] = [];
    for (const summary of summaries) {
      const id = str(summary.id);
      if (id === undefined) {
        checks.push(toCheck(summary));
        continue;
      }
      try {
        const detail = await transport.json<{ data?: Json }>(`/monitors/${id}`);
        checks.push(toCheck({ ...summary, ...obj(detail.data) }));
      } catch {
        // The summary alone still names the monitor and its type, which
        // is enough for a report line that says what was lost.
        checks.push(toCheck(summary));
      }
    }

    const extras: SourceExtra[] = [
      {
        kind: "alerting",
        sourceId: "notification-destinations",
        label: "Notification destinations",
        detail:
          "Oh Dear routes alerts by destination configured on the team. Vigil routes by notification channel and escalation policy, so recreate the channels under Settings, Notifications.",
      },
      {
        kind: "maintenance",
        sourceId: "maintenance-periods",
        label: "Maintenance periods",
        detail:
          "Not carried. Vigil has maintenance windows of its own, but this importer does not create them: the schedules do not translate field for field, and a window imported approximately is a window that silences the wrong hours. Recreate them under Settings, Maintenance.",
      },
    ];

    return {
      provider: "ohdear",
      facts: [
        `Oh Dear API, ${summaries.length} monitor(s) over ${page} page(s), each re-read individually, ${transport.requestCount} request(s).`,
      ],
      checks,
      statusPages: [],
      extras,
    };
  },
};
