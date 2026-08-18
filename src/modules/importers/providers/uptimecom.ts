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
 * Uptime.com, through the v1 API.
 *
 * One clean sweep: the list operation and the detail operation reference
 * the same schema, so `GET /checks/` returns whole configurations and
 * there is nothing to follow up.
 *
 * Two fields need care and both are documented traps.
 *
 * **`msp_threshold` is overloaded.** On most types it is a response
 * timeout in seconds; on `SSL_CERT` and `WHOIS` it is the number of days
 * before expiry to warn. Carrying it as one thing would give certificate
 * monitors a 30-second timeout and HTTP monitors a 30-day one.
 *
 * **`msp_interval` has no published unit.** Uptime.com's own reference
 * states none, and the difference between 5 seconds and 5 minutes is a
 * sixtyfold change in how often a customer's endpoints are hit. So the
 * number is reported, verbatim, on every check that has one, and the
 * imported monitor takes Vigil's default interval instead. That is a
 * worse migration than guessing right and a better one than guessing
 * wrong.
 */

const BASE = "https://uptime.com/api/v1";

const CAPABILITIES: readonly ProviderCapability[] = [
  {
    sourceType: "HTTP",
    becomes: "http",
    note: "The URL, accepted status codes, plain-string content match and retry count carry. Uptime.com stores no HTTP method, so a check with a send string is a POST and is refused rather than issued as a GET. A regex or inverse-regex match does not carry: Vigil's body assertion is a substring.",
  },
  { sourceType: "ICMP", becomes: "ping", note: "Imported unchanged." },
  {
    sourceType: "TCP",
    becomes: "tcp",
    note: "Host and port carry. The string Uptime.com sends and the string it expects do not: Vigil's TCP check judges whether the connection opens.",
  },
  {
    sourceType: "UDP",
    becomes: null,
    note: "Not imported. Vigil's UDP check has to send the payload the service replies to, because UDP answers nothing it was not asked, and this importer does not copy request payloads out of a monitoring account. An imported UDP monitor would send an empty datagram and report a permanent outage, so it is refused instead. Recreate it in Vigil, where the payload and the expected reply are settings on the check.",
  },
  {
    sourceType: "DNS",
    becomes: "dns",
    note: "The record type carries, and so does a single expected value. The per-check resolver does not: Vigil resolves through the worker's own resolver, so the answer it judges is the answer your infrastructure gets.",
  },
  {
    sourceType: "SSL_CERT",
    becomes: "tls-expiry",
    note: "The host, port and the warning threshold in `msp_threshold`, which is days on this type, carry. The rest of `sslconfig`, issuer and fingerprint pinning, CRL checks and minimum TLS version, does not: Vigil's TLS check watches the expiry date.",
  },
  {
    sourceType: "WHOIS",
    becomes: "domain-expiry",
    note: "The domain and the warning threshold carry. Vigil reads registration expiry over RDAP rather than WHOIS.",
  },
  {
    sourceType: "RDAP",
    becomes: "domain-expiry",
    note: "The same check by the same protocol: Vigil reads registration expiry over RDAP.",
  },
  {
    sourceType: "SMTP",
    becomes: "smtp",
    note: "Host and port carry. Vigil reads the banner and sends EHLO in plaintext.",
  },
  {
    sourceType: "IMAP",
    becomes: "imap",
    note: "Host and port carry. Vigil reads the greeting and asks for capabilities.",
  },
  {
    sourceType: "FTP",
    becomes: "ftp",
    note: "Host and port carry. Vigil reads the banner and never signs in.",
  },
  {
    sourceType: "SSH",
    becomes: "ssh",
    note: "Host and port carry. Vigil reads the server's identification string and never authenticates.",
  },
  {
    sourceType: "SFTP",
    becomes: null,
    note: "Not imported. SFTP runs over SSH, and Vigil's SSH check reads the transport's identification string without ever opening an SFTP session, so a server whose sshd is healthy and whose SFTP subsystem is disabled would read as up. A false green is the one direction a migration must not fail in. Watch the port with a TCP monitor if reachability is enough.",
  },
  {
    sourceType: "NTP",
    becomes: "ntp",
    note: "Host and port carry. Vigil asks the server for the time and judges the offset.",
  },
  {
    sourceType: "POP",
    becomes: null,
    note: "Not imported. Vigil has no POP3 check. Watch the port with a TCP monitor if reachability is enough.",
  },
  {
    sourceType: "HEARTBEAT",
    becomes: "push",
    note: "Becomes a Vigil heartbeat monitor with a new token, so the reporting job has to be pointed at the new endpoint.",
  },
  {
    sourceType: "API",
    becomes: null,
    note: "Not imported. An API check is a script of Uptime.com's own step and assertion verbs, and folding a multi-step script into one request would watch something the check never watched.",
  },
  {
    sourceType: "TRANSACTION",
    becomes: null,
    note: "Not imported. The check replays a recorded browser journey and Vigil has no check type that does.",
  },
  {
    sourceType: "PAGESPEED",
    becomes: null,
    note: "Not imported. The check scores page performance rather than availability.",
  },
  {
    sourceType: "GROUP",
    becomes: null,
    note: "Not imported. An Uptime.com group check derives a state from other checks, and the API publishes no field naming its members, so the group would arrive empty.",
  },
  {
    sourceType: "MALWARE",
    becomes: null,
    note: "Not imported. The check scans a site for malware, which Vigil does not do.",
  },
  {
    sourceType: "BLACKLIST",
    becomes: null,
    note: "Not imported. The check watches domain blacklists, which Vigil does not read.",
  },
  {
    sourceType: "CLOUDSTATUS",
    becomes: null,
    note: "Not imported. The check watches a third party's own status page.",
  },
  {
    sourceType: "RUM2",
    becomes: null,
    note: "Not imported. Real user monitoring is a measurement of your visitors' browsers rather than a check Vigil can run.",
  },
  {
    sourceType: "WEBHOOK",
    becomes: null,
    note: "Not imported. The check waits for an inbound webhook with a payload shape Uptime.com defines; Vigil's heartbeat endpoint is a different contract, so migrating it would mean rewriting the caller anyway.",
  },
];

const MAPPED = new Map(CAPABILITIES.map((entry) => [entry.sourceType, entry]));

/**
 * Types where `msp_threshold` is days before expiry, not seconds.
 *
 * Uptime.com documents the overload for exactly these two. RDAP is not
 * one of them, and reading its threshold as days would set a certificate
 * warning from a number that may be a timeout; it is reported instead.
 * HEARTBEAT is not one of them either, which is why nothing on a
 * heartbeat reads this field.
 */
const EXPIRY_THRESHOLD_TYPES: ReadonlySet<string> = new Set([
  "SSL_CERT",
  "WHOIS",
]);

/** Header names out of Uptime.com's newline-separated header block. */
function headerNames(value: Json): string[] {
  return (str(value) ?? "")
    .split("\n")
    .map((line) => line.split(":")[0]?.trim() ?? "")
    .filter((name) => name.length > 0);
}

function toCheck(row: Record<string, Json>): SourceCheck {
  const sourceType =
    str(row.monitoring_service_type)?.toUpperCase() ??
    str(row.check_type)?.toUpperCase() ??
    "unknown";
  const mapping = MAPPED.get(sourceType);
  const sourceId = str(row.pk) ?? "unknown";
  const name =
    str(row.name) ?? str(row.msp_address) ?? `Uptime.com check ${sourceId}`;
  const address = str(row.msp_address);
  const threshold = num(row.msp_threshold);
  const interval = num(row.msp_interval);

  const common = {
    sourceId,
    name,
    sourceType,
    paused: bool(row.is_paused) === true,
    tags: strs(row.tags),
    regions: strs(row.locations),
    timeoutMs:
      threshold === undefined || EXPIRY_THRESHOLD_TYPES.has(sourceType)
        ? undefined
        : threshold * 1000,
    retries:
      num(row.msp_num_retries) === undefined
        ? undefined
        : {
            count: num(row.msp_num_retries),
            note:
              num(row.msp_sensitivity) === undefined
                ? undefined
                : `Uptime.com also required ${num(row.msp_sensitivity)} location(s) to agree before alerting. Vigil confirms by waiting rather than by quorum: a monitor has to be failing for its whole failure window before an incident opens.`,
          },
  };

  if (mapping === undefined || mapping.becomes === null) {
    return {
      ...common,
      kind: "unsupported",
      target: {},
      unsupportedReason:
        mapping?.note ??
        `Uptime.com calls this a "${sourceType}" check, which is not a type this adapter was written against, so nothing can be promised about it.`,
    };
  }

  const losses: string[] = [];
  const withheld: string[] = [];
  if (interval !== undefined) {
    losses.push(
      `Uptime.com stored an interval of ${interval} and publishes no unit for the field, so it was not carried: the difference between ${interval} seconds and ${interval} minutes is how hard this monitor hits your endpoint. Set the interval on the monitor page.`,
    );
  }
  if (str(row.msp_username) !== undefined) {
    withheld.push("the password this check authenticates with");
  }
  const matchType = str(row.msp_expect_string_type)?.toUpperCase();
  if (matchType === undefined && str(row.msp_expect_string) !== undefined) {
    losses.push(
      "The content match was not carried: Uptime.com returned an expected string without the field that says whether it is a plain substring or a regular expression, and reading a pattern as a substring would assert something this check never asserted.",
    );
  }
  if (matchType === "REGEX" || matchType === "INVERSE_REGEX") {
    losses.push(
      `The content match was a ${matchType === "REGEX" ? "regular expression" : "negated regular expression"} and Vigil's body assertion is a substring, so it was not carried. Recreate it as a keyword if a substring is enough.`,
    );
  }
  if (str(row.msp_script) !== undefined) {
    losses.push(
      "The check carried an Uptime.com script, which is a sequence of steps and assertions in their own vocabulary. Vigil's HTTP check makes one request, so the script was not carried.",
    );
  }

  const port = num(row.msp_port);

  switch (sourceType) {
    case "ICMP":
      return {
        ...common,
        kind: "ping",
        target: { host: address },
        losses,
        withheld,
      };
    case "TCP":
      return {
        ...common,
        kind: "tcp",
        target: { host: address, port },
        losses,
        withheld,
      };
    case "SMTP":
    case "IMAP":
    case "FTP":
    case "NTP":
      return {
        ...common,
        kind: sourceType.toLowerCase() as "smtp" | "imap" | "ftp" | "ntp",
        target: { host: address, port },
        losses,
        withheld,
      };
    case "SSH":
      return {
        ...common,
        kind: "ssh",
        target: { host: address, port },
        losses,
        withheld,
      };
    case "DNS": {
      const expected = str(row.msp_expect_string);
      return {
        ...common,
        kind: "dns",
        target: { host: address },
        dns: {
          recordType: str(row.msp_dns_record_type),
          expectedValues: expected === undefined ? [] : [expected],
          resolver: str(row.msp_dns_server),
        },
        losses,
        withheld,
      };
    }
    case "SSL_CERT":
      return {
        ...common,
        kind: "tls",
        target: { host: address, port },
        warnDays: threshold,
        losses: [
          ...losses,
          ...(obj(row.sslconfig) !== undefined &&
          Object.keys(obj(row.sslconfig)).length > 0
            ? [
                "The certificate check's issuer, fingerprint, CRL and minimum TLS version settings were not carried: Vigil's TLS check watches how long the certificate has left.",
              ]
            : []),
        ],
        withheld,
      };
    case "WHOIS":
      return {
        ...common,
        kind: "domain",
        target: { domain: address },
        warnDays: threshold,
        losses,
        withheld,
      };
    case "RDAP":
      return {
        ...common,
        kind: "domain",
        target: { domain: address },
        losses: [
          ...losses,
          ...(threshold === undefined
            ? []
            : [
                `Uptime.com stored a threshold of ${threshold} on this check. It documents that field as days-before-expiry on its WHOIS and certificate types and says nothing about this one, so it was not read as a warning threshold: the monitor uses Vigil's default of 30 days. Set it on the monitor page.`,
              ]),
        ],
        withheld,
      };
    case "HEARTBEAT":
      return {
        ...common,
        kind: "heartbeat",
        target: { label: name },
        // No grace period is read. `msp_threshold` is documented as a
        // response timeout on most types and as expiry days on two, and
        // nothing says what it means on a heartbeat; reading it as a
        // grace period would decide how late a job may be from a number
        // that might be a timeout.
        losses: [
          ...losses,
          "No grace period was carried: Uptime.com does not publish which field holds one for a heartbeat, so this monitor uses Vigil's default. Set it on the monitor page to match how late the job may be.",
        ],
        withheld,
      };
    default: {
      const names = headerNames(row.msp_headers);
      const hasBody = str(row.msp_send_string) !== undefined;
      const codes = (str(row.msp_status_code) ?? "")
        .split(",")
        .map((code) => code.trim())
        .filter((code) => code.length > 0);
      return {
        ...common,
        kind: "http",
        target: { url: address },
        http: {
          // Uptime.com has no method field: a non-empty send string is
          // what makes a check a POST. Saying POST is what gets it
          // refused rather than issued as a GET of the same URL.
          method: hasBody ? "POST" : "GET",
          acceptedStatus: codes.length > 0 ? codes : undefined,
          // Only an explicit STRING match is carried. Uptime.com's other
          // two modes are regular expressions, and an expectation whose
          // mode did not come back could be either; reading a pattern as
          // a substring would assert something the check never asserted.
          keyword:
            matchType === "STRING" ? str(row.msp_expect_string) : undefined,
          headerNames: names.length > 0 ? names : undefined,
          hasRequestBody: hasBody,
          hasBasicAuth: str(row.msp_username) !== undefined,
        },
        losses,
        withheld,
      };
    }
  }
}

export const uptimeComAdapter: ProviderAdapter = {
  id: "uptimecom",
  label: "Uptime.com",
  input: "api",
  docs: "https://uptime.com/api/v1/docs/",
  access:
    "An API token from Uptime.com, Settings, API. Uptime.com has no token scopes: a token inherits the role of the user who made it, so create a View Only user and use theirs. API access requires a paid plan.",
  credentials: [
    {
      name: "token",
      label: "API token",
      help: "Sent as an Authorization: Token header. It is used for this read and never stored.",
      secret: true,
      required: true,
    },
  ],
  capabilities: CAPABILITIES,
  limitations: [
    "`msp_password` is write-only in Uptime.com's own schema and never comes back, so a check behind HTTP authentication imports as an unauthenticated check.",
    "`msp_interval` has no published unit, so the interval is reported rather than carried and imported monitors take Vigil's default. This is the one field where guessing costs a sixtyfold change in how often your endpoints are hit.",
    "Uptime.com stores no HTTP method on an HTTP check. A check with a send string is a POST, which this importer names and refuses rather than issuing as a GET.",
    "Locations are display names rather than stable identifiers and are plan-dependent, so they are reported rather than mapped onto Vigil probes.",
    "Uptime.com allows 500 calls an hour and 60 a minute and publishes no rate-limit headers, so this importer backs off on the status code alone.",
    "There is no official file export of check configuration.",
  ],
  async read(context: ReadContext): Promise<SourceSnapshot> {
    const token = requireCredential(context, "token", "The API token");
    const transport = transportFor(context, BASE, {
      Authorization: `Token ${token}`,
      Accept: "application/json",
    });

    const checks: SourceCheck[] = [];
    let page = 1;
    let total: number | undefined;
    for (;;) {
      const response = await transport.json<{
        results?: Json;
        next?: Json;
        count?: Json;
      }>("/checks/", { page, page_size: 100 });
      total ??= num(response.count);
      for (const row of arr(response.results)) checks.push(toCheck(obj(row)));
      if (str(response.next) === undefined) break;
      page += 1;
    }

    const extras: SourceExtra[] = [
      {
        kind: "alerting",
        sourceId: "contact-groups",
        label: "Contact groups",
        detail:
          "Uptime.com routes alerts by contact group attached to each check. Vigil routes by notification channel and escalation policy, which belong to the organisation, so there is no per-check attachment to recreate.",
      },
      {
        kind: "status-page",
        sourceId: "status-pages",
        label: "Status pages",
        detail:
          "Uptime.com's status pages are a separate resource this adapter does not read. Create a Vigil status page and add the imported monitors to it.",
      },
    ];

    return {
      provider: "uptimecom",
      facts: [
        `Uptime.com API v1, ${checks.length} check(s) over ${page} page(s)${total === undefined ? "" : ` of ${total} reported`}, ${transport.requestCount} request(s).`,
      ],
      checks,
      statusPages: [],
      extras,
    };
  },
};
