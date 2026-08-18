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
 * Better Stack (formerly Better Uptime), through the v2 Uptime API.
 *
 * A JSON:API-shaped list where everything lives under
 * `data[].attributes`, paginated by `pagination.next` being null.
 *
 * Two traps in this API are worth naming here because both fail
 * silently rather than loudly.
 *
 * **`request_timeout` changes unit with the monitor type.** It is
 * milliseconds for `ping`, `tcp`, `udp`, `smtp`, `pop`, `imap` and
 * `dns`, and seconds for everything else. Reading it as one unit gives
 * every network monitor a timeout a thousand times wrong, in the
 * direction that makes checks pass when they should fail.
 *
 * **The keyword inversion is encoded in the type, not a flag.**
 * `keyword` and `keyword_absence` are two entries in `monitor_type`, so
 * a type map that folds both to "HTTP with a keyword" quietly turns
 * "this text must be absent" into "this text must be present".
 */

const BASE = "https://uptime.betterstack.com/api/v2";

/** Types whose `request_timeout` is milliseconds rather than seconds. */
const MILLISECOND_TIMEOUT_TYPES: ReadonlySet<string> = new Set([
  "ping",
  "tcp",
  "udp",
  "smtp",
  "pop",
  "imap",
  "dns",
]);

const CAPABILITIES: readonly ProviderCapability[] = [
  {
    sourceType: "status",
    becomes: "http",
    note: "The URL, method, interval, timeout, redirect setting, certificate and domain expiry thresholds and confirmation period carry. Better Stack checks for a 2XX status and Vigil, with no expected code set, also passes a 3XX, so the report says so on every monitor of this type. Request headers, request body and basic authentication do not carry.",
  },
  {
    sourceType: "expected_status_code",
    becomes: "http",
    note: "The same, plus `expected_status_codes`. Vigil holds one expected code, so a monitor listing several is imported accepting any 2xx or 3xx and the report names the codes it could not express.",
  },
  {
    sourceType: "keyword",
    becomes: "http",
    note: "The same, plus `required_keyword` as Vigil's body assertion.",
  },
  {
    sourceType: "keyword_absence",
    becomes: "http",
    note: "The same, with the assertion inverted: Better Stack expresses absence as a separate monitor type and Vigil as the keywordAbsent flag.",
  },
  { sourceType: "ping", becomes: "ping", note: "Imported unchanged." },
  {
    sourceType: "tcp",
    becomes: "tcp",
    note: "Host and port carry. Same check under a different name: open a TCP connection.",
  },
  {
    sourceType: "udp",
    becomes: null,
    note: "Not imported. Vigil's UDP check has to send the payload the service replies to, because UDP answers nothing it was not asked, and this importer does not copy request payloads out of a monitoring account. An imported UDP monitor would send an empty datagram and report a permanent outage, so it is refused instead. Recreate it in Vigil, where the payload and the expected reply are settings on the check.",
  },
  {
    sourceType: "smtp",
    becomes: "smtp",
    note: "Host and port carry. Vigil reads the banner and sends EHLO in plaintext.",
  },
  {
    sourceType: "imap",
    becomes: "imap",
    note: "Host and port carry. Vigil reads the greeting and asks for the server's capabilities.",
  },
  {
    sourceType: "pop",
    becomes: null,
    note: "Not imported. Vigil has no POP3 check, and neither its IMAP nor its SMTP check speaks the protocol. Watch the port with a TCP monitor if reachability is enough.",
  },
  {
    sourceType: "dns",
    becomes: null,
    note: "Not imported. Better Stack stores the nameserver in `url` and the domain in `request_body`, and stores neither a record type nor an expected answer. Vigil's DNS check must ask for a record type, so importing one would mean choosing a record the operator never chose: a monitor asking for A when the alert was about MX goes green while the mail is down.",
  },
  {
    sourceType: "playwright",
    becomes: null,
    note: "Not imported. The check is a Playwright script that Better Stack runs in a browser, and Vigil has no check type that executes a scripted journey.",
  },
];

const MAPPED = new Map(CAPABILITIES.map((entry) => [entry.sourceType, entry]));

function timeoutMsFrom(type: string, value: Json): number | undefined {
  const raw = num(value);
  if (raw === undefined || raw <= 0) return undefined;
  return MILLISECOND_TIMEOUT_TYPES.has(type) ? raw : raw * 1000;
}

/**
 * The status codes Better Stack accepted, unless it accepted whatever
 * its type already means.
 *
 * An empty array is what every monitor that is not
 * `expected_status_code` carries, and it means "the type decides", not
 * "no code is acceptable".
 */
function acceptedStatusFrom(value: Json): string[] | undefined {
  const codes = arr(value)
    .map((code) => num(code))
    .filter((code): code is number => code !== undefined)
    .map((code) => String(code));
  return codes.length > 0 ? codes : undefined;
}

function toCheck(
  row: Record<string, Json>,
  groupNames: ReadonlyMap<string, string>,
): SourceCheck {
  const attributes = obj(row.attributes);
  const sourceType = str(attributes.monitor_type) ?? "unknown";
  const mapping = MAPPED.get(sourceType);
  const sourceId = str(row.id) ?? "unknown";
  const name =
    str(attributes.pronounceable_name) ??
    str(attributes.url) ??
    `Better Stack monitor ${sourceId}`;
  const groupId = str(attributes.monitor_group_id);
  const groupName = groupId === undefined ? undefined : groupNames.get(groupId);

  const common = {
    sourceId,
    name,
    sourceType,
    paused: str(attributes.paused_at) !== undefined,
    intervalSeconds: num(attributes.check_frequency),
    timeoutMs: timeoutMsFrom(sourceType, attributes.request_timeout),
    regions: strs(attributes.regions),
    groupPath: groupName === undefined ? undefined : [groupName],
    retries:
      num(attributes.confirmation_period) === undefined
        ? undefined
        : {
            windowSeconds: num(attributes.confirmation_period),
            note:
              num(attributes.recovery_period) === undefined
                ? undefined
                : `Better Stack waited ${num(attributes.recovery_period)}s of recovery before resolving an incident. Vigil resolves on the first passing check, so an incident here closes sooner.`,
          },
  };

  if (mapping === undefined || mapping.becomes === null) {
    return {
      ...common,
      kind: "unsupported",
      target: {},
      unsupportedReason:
        mapping?.note ??
        `Better Stack calls this a "${sourceType}" monitor, which is not a type this adapter was written against, so nothing can be promised about it.`,
    };
  }

  const losses: string[] = [];
  const withheld: string[] = [];
  if (str(attributes.auth_username) !== undefined) {
    withheld.push("the password this monitor authenticates with");
  }
  if (bool(attributes.verify_ssl) === false) {
    losses.push(
      "Better Stack was told not to verify the certificate. Vigil always verifies, so a monitor on a self-signed or expired certificate will read as down here.",
    );
  }
  if (str(attributes.proxy_host) !== undefined) {
    losses.push(
      "The outbound proxy was not carried: Vigil's checks go out from the worker, or from a remote probe you enrol, and have no per-monitor proxy.",
    );
  }
  const maintenanceDays = strs(attributes.maintenance_days);
  if (maintenanceDays.length > 0) {
    losses.push(
      `A maintenance window on ${maintenanceDays.join(", ")} was not carried. Vigil has maintenance windows of its own, but this importer does not create them: the schedules do not translate field for field, and a window imported approximately is a window that silences the wrong hours. Recreate it under Settings, Maintenance.`,
    );
  }
  const domainExpiration = num(attributes.domain_expiration);
  if (domainExpiration !== undefined) {
    losses.push(
      `Better Stack also warned ${domainExpiration} day(s) before the domain registration expired. Vigil expresses that as its own domain-expiry check rather than a flag on an HTTP monitor, and this importer will not invent a second monitor.`,
    );
  }

  const headerNames = arr(attributes.request_headers)
    .map((header) => str(obj(header).name))
    .filter((header): header is string => header !== undefined);

  const url = str(attributes.url);
  const port = num(attributes.port);

  switch (sourceType) {
    case "ping":
      return {
        ...common,
        kind: "ping",
        target: { host: url },
        losses,
        withheld,
      };
    case "tcp":
      return {
        ...common,
        kind: "tcp",
        target: { host: url, port },
        losses,
        withheld,
      };
    case "smtp":
    case "imap":
      return {
        ...common,
        kind: sourceType,
        target: { host: url, port },
        losses,
        withheld,
      };
    default: {
      const keyword = str(attributes.required_keyword);
      return {
        ...common,
        kind: "http",
        target: { url },
        http: {
          method: str(attributes.http_method)?.toUpperCase(),
          // Better Stack documents the other three HTTP types as
          // checking "for a 2XX HTTP status code". Vigil holds one code
          // or none, and none also passes a 3XX, so `2xx` is handed to
          // the translator precisely so it reports the widening rather
          // than letting a monitor quietly stop alerting on a redirect
          // the source called a failure.
          acceptedStatus:
            sourceType === "expected_status_code"
              ? acceptedStatusFrom(attributes.expected_status_codes)
              : ["2xx"],
          keyword:
            sourceType === "keyword" || sourceType === "keyword_absence"
              ? keyword
              : undefined,
          keywordAbsent: sourceType === "keyword_absence",
          headerNames: headerNames.length > 0 ? headerNames : undefined,
          hasRequestBody: str(attributes.request_body) !== undefined,
          hasBasicAuth: str(attributes.auth_username) !== undefined,
          followRedirects: bool(attributes.follow_redirects),
          checkCertificateExpiry: num(attributes.ssl_expiration) !== undefined,
          certificateWarnDays: num(attributes.ssl_expiration),
        },
        losses,
        withheld,
      };
    }
  }
}

export const betterStackAdapter: ProviderAdapter = {
  id: "betterstack",
  label: "Better Stack (Better Uptime)",
  input: "api",
  docs: "https://betterstack.com/docs/uptime/api/list-all-existing-monitors/",
  access:
    "An Uptime API token from Better Stack, API tokens. Better Stack publishes no read-only scope, so the token you paste can also write; create one for this migration and revoke it afterwards. This importer only issues GET requests.",
  credentials: [
    {
      name: "token",
      label: "Uptime API token",
      help: "Sent as a bearer token. It is used for this read and never stored.",
      secret: true,
      required: true,
    },
  ],
  capabilities: CAPABILITIES,
  limitations: [
    "Better Stack's monitor responses do not include `auth_password`, so a monitor behind HTTP authentication imports as an unauthenticated check.",
    "Better Stack documents no rate limit for the Uptime API. This importer backs off on a 429 anyway, honouring Retry-After when one is sent.",
    "Status pages, escalation policies and on-call calendars are separate resources this adapter reports rather than imports.",
    "There is no official file export of monitor configuration. The vendor Terraform provider provisions monitors and documents no import.",
  ],
  async read(context: ReadContext): Promise<SourceSnapshot> {
    const token = requireCredential(context, "token", "The Uptime API token");
    const transport = transportFor(context, BASE, {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    });

    const groupNames = new Map<string, string>();
    try {
      const response = await transport.json<{ data?: Json }>(
        "/monitor-groups",
        {
          per_page: 250,
        },
      );
      for (const entry of arr(response.data)) {
        const group = obj(entry);
        const id = str(group.id);
        const name = str(obj(group.attributes).name);
        if (id !== undefined && name !== undefined) groupNames.set(id, name);
      }
    } catch {
      // A read that cannot see groups still reads monitors. The folder
      // is lost, not the migration.
    }

    const checks: SourceCheck[] = [];
    let page = 1;
    for (;;) {
      const response = await transport.json<{
        data?: Json;
        pagination?: Json;
      }>("/monitors", { page, per_page: 250 });
      for (const row of arr(response.data)) {
        checks.push(toCheck(obj(row), groupNames));
      }
      const next = str(obj(response.pagination).next);
      if (next === undefined) break;
      page += 1;
    }

    const extras: SourceExtra[] = [
      {
        kind: "status-page",
        sourceId: "status-pages",
        label: "Status pages",
        detail:
          "Better Stack's status pages are a separate resource with their own sections, custom domains and subscriber lists, and this adapter does not read them. Create a Vigil status page and add the imported monitors to it.",
      },
      {
        kind: "alerting",
        sourceId: "policies",
        label: "Escalation policies and on-call calendars",
        detail:
          "Monitors reference a `policy_id`. Vigil has its own escalation policies and on-call rotations, and an imported monitor points at none of them, so it notifies responders until you attach one.",
      },
    ];

    return {
      provider: "betterstack",
      facts: [
        `Better Stack Uptime API v2, ${checks.length} monitor(s) over ${page} page(s), ${transport.requestCount} request(s).`,
        `${groupNames.size} monitor group(s) read.`,
      ],
      checks,
      statusPages: [],
      extras,
    };
  },
};
