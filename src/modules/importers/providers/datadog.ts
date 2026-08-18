import type { SourceCheck, SourceExtra, SourceSnapshot } from "../model";

import {
  requireCredential,
  transportFor,
  type ProviderAdapter,
  type ProviderCapability,
  type ReadContext,
} from "./contract";
import { arr, bool, keys, num, obj, str, strs, type Json } from "./json";

/**
 * Datadog Synthetics, through the v1 API.
 *
 * Datadog is regional and the region is the hostname: nine independent
 * sites that share no data. The site is chosen from a list rather than
 * typed, because this transport runs inside the application server.
 *
 * The list endpoint returns each test "without test steps", which for a
 * single-request API test is the whole configuration. Where a row comes
 * back without a `config.request` at all, the test is re-read through
 * its per-type endpoint, so a browser or multistep test still gets a
 * report line naming what it is rather than being skipped for want of a
 * field.
 *
 * The DNS mapping is the one worth reading twice. Datadog does not store
 * a record type on the request: the request holds the name in `host` and
 * the resolver in `dnsServer`, and the record type is the *assertion's*
 * `property`, with `recordSome` meaning "at least one record" and
 * `recordEvery` meaning "all of them". Reading `property` as a header
 * name, which is what Datadog's own Terraform provider documents it as,
 * would produce a DNS monitor asking for a record type called
 * "content-type".
 */

/** The nine Datadog sites, as hostnames. Chosen, never typed. */
const SITES: readonly { value: string; label: string }[] = [
  { value: "api.datadoghq.com", label: "US1 (datadoghq.com)" },
  { value: "api.us3.datadoghq.com", label: "US3 (us3.datadoghq.com)" },
  { value: "api.us5.datadoghq.com", label: "US5 (us5.datadoghq.com)" },
  { value: "api.datadoghq.eu", label: "EU1 (datadoghq.eu)" },
  { value: "api.ap1.datadoghq.com", label: "AP1 (ap1.datadoghq.com)" },
  { value: "api.ap2.datadoghq.com", label: "AP2 (ap2.datadoghq.com)" },
  { value: "api.uk1.datadoghq.com", label: "UK1 (uk1.datadoghq.com)" },
  { value: "api.ddog-gov.com", label: "US1-FED (ddog-gov.com)" },
  { value: "api.us2.ddog-gov.com", label: "US2-FED (us2.ddog-gov.com)" },
];

const CAPABILITIES: readonly ProviderCapability[] = [
  {
    sourceType: "api / http",
    becomes: "http",
    note: "The URL, method, timeout, frequency, retry policy and paused state carry. A `statusCode is` assertion becomes Vigil's expected status code and a `body contains` one becomes its body assertion; every other assertion, including JSONPath, JSON schema, XPath, header comparisons and response-time bounds, is reported rather than approximated. Request headers, the request body, every authentication scheme and client certificates do not carry.",
  },
  {
    sourceType: "api / ssl",
    becomes: "tls-expiry",
    note: "The host and port carry, and a `certificate moreThan N` assertion becomes the days-before-expiry warning. Datadog's TLS version and revocation assertions do not.",
  },
  {
    sourceType: "api / tcp",
    becomes: "tcp",
    note: "Host and port carry. The message Datadog sends and the reply it asserts on do not: Vigil's TCP check judges whether the connection opens.",
  },
  {
    sourceType: "api / udp",
    becomes: null,
    note: "Not imported. Vigil's UDP check has to send the payload the service replies to, because UDP answers nothing it was not asked, and this importer does not copy request payloads out of a monitoring account. An imported UDP monitor would send an empty datagram and report a permanent outage, so it is refused instead. Recreate it in Vigil, where the payload and the expected reply are settings on the check.",
  },
  {
    sourceType: "api / icmp",
    becomes: "ping",
    note: "The host carries. Datadog's packet count, loss percentage, jitter and hop assertions do not: Vigil's ping check reports the round trip and whether a reply came back.",
  },
  {
    sourceType: "api / dns",
    becomes: "dns",
    note: "The name being resolved carries, and the record type is read from the assertion's `property` because that is where Datadog keeps it. A `recordEvery` assertion, which demands that every record match, is reported rather than carried: Vigil asserts that at least one record contains the value. The resolver does not carry.",
  },
  {
    sourceType: "api / websocket",
    becomes: "websocket",
    note: "The URL carries. The message Datadog sends and the reply it asserts on do not: Vigil's WebSocket check verifies the upgrade handshake.",
  },
  {
    sourceType: "api / grpc",
    becomes: "grpc",
    note: "Imported only when the test's `callType` is a health check, in which case both sides call the standard gRPC health service and the host and port carry. A unary test calls a named method with its own payload and Vigil cannot send that, so a server that does not implement the health service would read down; those are refused, as is a test whose `callType` this adapter does not recognise.",
  },
  {
    sourceType: "api / multi",
    becomes: null,
    note: "Not imported. A multistep test chains requests and feeds values extracted from one into the next, with per-step failure rules. Folding it into a single request would watch something the test never watched.",
  },
  {
    sourceType: "browser",
    becomes: null,
    note: "Not imported. A browser test is a sequence of recorded steps whose parameters Datadog publishes as a free-form object with no schema, so there is nothing an importer can read even in principle.",
  },
  {
    sourceType: "mobile",
    becomes: null,
    note: "Not imported. The test drives a mobile application on a device Datadog hosts.",
  },
  {
    sourceType: "network",
    becomes: null,
    note: "Not imported. Vigil has no network-path check.",
  },
];

const MAPPED = new Map(CAPABILITIES.map((entry) => [entry.sourceType, entry]));

/** Datadog record types, which arrive as an assertion's `property`. */
const RECORD_ASSERTIONS: ReadonlySet<string> = new Set([
  "recordSome",
  "recordEvery",
]);

interface DatadogAssertions {
  acceptedStatus?: string[];
  keyword?: string;
  keywordAbsent?: boolean;
  recordType?: string;
  expectedValues: string[];
  certificateWarnDays?: number;
  rest: string[];
}

function readDatadogAssertions(raw: Json): DatadogAssertions {
  const parsed: DatadogAssertions = { expectedValues: [], rest: [] };
  for (const entry of arr(raw)) {
    const assertion = obj(entry);
    const type = str(assertion.type);
    const operator = str(assertion.operator);
    const property = str(assertion.property);
    const target = str(assertion.target);

    if (type === "statusCode" && operator === "is" && target !== undefined) {
      parsed.acceptedStatus = [...(parsed.acceptedStatus ?? []), target];
      continue;
    }
    if (
      type === "body" &&
      (operator === "contains" || operator === "doesNotContain") &&
      target !== undefined &&
      parsed.keyword === undefined
    ) {
      parsed.keyword = target;
      parsed.keywordAbsent = operator === "doesNotContain";
      continue;
    }
    if (
      type !== undefined &&
      RECORD_ASSERTIONS.has(type) &&
      property !== undefined
    ) {
      parsed.recordType ??= property;
      if (target !== undefined) parsed.expectedValues.push(target);
      if (type === "recordEvery") {
        parsed.rest.push(
          `Datadog required every ${property} record to match "${target ?? ""}". Vigil asserts that at least one record contains the value, so the "every" part was not carried.`,
        );
      }
      continue;
    }
    // `isInMoreThan` is the operator Datadog documents for certificate
    // expiry, and its target is a number of days. Reading `moreThan`,
    // which is the operator for a numeric comparison on something else,
    // meant no SSL test ever carried its expiry threshold.
    if (
      type === "certificate" &&
      operator === "isInMoreThan" &&
      num(assertion.target) !== undefined
    ) {
      parsed.certificateWarnDays = num(assertion.target);
      continue;
    }
    parsed.rest.push(
      `Datadog asserted ${type ?? "something"} ${operator ?? ""}${
        property === undefined ? "" : ` on "${property}"`
      }${target === undefined ? "" : ` against "${target}"`}, which Vigil has no field for. It was not carried.`,
    );
  }
  return parsed;
}

function toCheck(test: Record<string, Json>): SourceCheck {
  const type = str(test.type)?.toLowerCase() ?? "unknown";
  const subtype = str(test.subtype)?.toLowerCase();
  const sourceType = type === "api" ? `api / ${subtype ?? "unknown"}` : type;
  const mapping = MAPPED.get(sourceType);
  const sourceId = str(test.public_id) ?? "unknown";
  const name = str(test.name) ?? `Datadog test ${sourceId}`;
  const config = obj(test.config);
  const request = obj(config.request);
  const options = obj(test.options);
  const retry = obj(options.retry);

  const common = {
    sourceId,
    name,
    sourceType,
    paused: str(test.status)?.toLowerCase() === "paused",
    // `tick_every` is seconds; `retry.interval` next door is
    // milliseconds. Two units in one object.
    intervalSeconds: num(options.tick_every),
    timeoutMs:
      num(request.timeout) === undefined
        ? undefined
        : Math.round((num(request.timeout) ?? 0) * 1000),
    tags: strs(test.tags),
    regions: strs(test.locations),
    retries:
      num(retry.count) === undefined
        ? undefined
        : {
            count: num(retry.count),
            intervalSeconds:
              num(retry.interval) === undefined
                ? undefined
                : (num(retry.interval) ?? 0) / 1000,
            note:
              num(options.min_location_failed) === undefined
                ? undefined
                : `Datadog also required ${num(options.min_location_failed)} location(s) to fail before alerting. Vigil confirms by waiting rather than by quorum: a monitor has to be failing for its whole failure window before an incident opens.`,
          },
  };

  if (mapping === undefined || mapping.becomes === null) {
    return {
      ...common,
      kind: "unsupported",
      target: {},
      unsupportedReason:
        mapping?.note ??
        `Datadog calls this a "${sourceType}" test, which is not a type this adapter was written against, so nothing can be promised about it.`,
    };
  }

  const assertions = readDatadogAssertions(config.assertions);
  const losses = [...assertions.rest];
  const withheld: string[] = [];
  const authType = str(obj(request.basicAuth).type);
  if (authType !== undefined) {
    withheld.push(`the ${authType} credential this test authenticates with`);
  }
  if (obj(request.certificate).cert !== undefined) {
    withheld.push("the client certificate and key this test presents");
  }
  if (str(obj(request.proxy).url) !== undefined) {
    losses.push(
      "The outbound proxy was not carried: Vigil's checks go out from the worker, or from a remote probe you enrol, and have no per-monitor proxy.",
    );
  }
  const secureVariables = arr(config.configVariables)
    .map((entry) => obj(entry))
    .filter((entry) => bool(entry.secure) === true).length;
  if (secureVariables > 0) {
    withheld.push(
      `${secureVariables} secure variable(s), whose values Datadog omits from every read in any case`,
    );
  }
  if (obj(options.scheduling).timeframes !== undefined) {
    losses.push(
      "Datadog ran this test only inside scheduled timeframes. Vigil runs a monitor on its interval around the clock, so pause it if the window matters.",
    );
  }

  const host = str(request.host);
  const port = num(request.port);

  switch (subtype) {
    case "icmp":
      return { ...common, kind: "ping", target: { host }, losses, withheld };
    case "tcp":
      return {
        ...common,
        kind: "tcp",
        target: { host, port },
        losses,
        withheld,
      };
    case "grpc": {
      const callType = str(request.callType)?.toLowerCase();
      if (callType !== "healthcheck") {
        return {
          ...common,
          kind: "unsupported",
          target: {},
          unsupportedReason: `Datadog runs this test with a callType of "${callType ?? "(none returned)"}". Vigil's gRPC check calls the standard grpc.health.v1.Health service and nothing else, so only a health-check test is the same check on both sides; anything else would ask a question this server may not answer and report an outage that is not one.`,
        };
      }
      return {
        ...common,
        kind: "grpc",
        target: { host, port },
        losses,
        withheld,
      };
    }
    case "websocket":
      return {
        ...common,
        kind: "websocket",
        target: { url: str(request.url) },
        losses,
        withheld,
      };
    case "ssl":
      return {
        ...common,
        kind: "tls",
        target: { host, port },
        warnDays: assertions.certificateWarnDays,
        losses,
        withheld,
      };
    case "dns": {
      if (str(request.dnsServer) !== undefined) {
        losses.push(
          `The resolver ${str(request.dnsServer)} was not carried: Vigil resolves through the worker's own resolver, so the answer this monitor judges is the answer your infrastructure gets.`,
        );
      }
      return {
        ...common,
        kind: "dns",
        target: { host },
        dns: {
          recordType: assertions.recordType,
          expectedValues: assertions.expectedValues,
        },
        losses,
        withheld,
      };
    }
    default: {
      const headerNames = keys(request.headers);
      return {
        ...common,
        kind: "http",
        target: { url: str(request.url) },
        http: {
          method: str(request.method)?.toUpperCase(),
          acceptedStatus: assertions.acceptedStatus,
          keyword: assertions.keyword,
          keywordAbsent: assertions.keywordAbsent,
          headerNames: headerNames.length > 0 ? headerNames : undefined,
          hasRequestBody: str(request.body) !== undefined,
          hasBasicAuth: authType !== undefined,
          followRedirects: bool(request.follow_redirects),
        },
        losses,
        withheld,
      };
    }
  }
}

/** Which per-type endpoint holds a test's full configuration. */
function detailPath(test: Record<string, Json>): string | null {
  const id = str(test.public_id);
  if (id === undefined) return null;
  const type = str(test.type)?.toLowerCase();
  if (type === "browser") return `/api/v1/synthetics/tests/browser/${id}`;
  if (type === "mobile") return `/api/v1/synthetics/tests/mobile/${id}`;
  if (type === "api") return `/api/v1/synthetics/tests/api/${id}`;
  return null;
}

export const datadogAdapter: ProviderAdapter = {
  id: "datadog",
  label: "Datadog Synthetics",
  input: "api",
  docs: "https://docs.datadoghq.com/api/latest/synthetics/",
  access:
    "An API key and an application key from Datadog, Organization Settings. Reading requires both: the API key alone is refused. The application key must carry the `synthetics_read` permission, which the Datadog Read Only role includes.",
  credentials: [
    {
      name: "site",
      label: "Datadog site",
      help: "Datadog's sites are independent and share no data, so this decides which account is read.",
      secret: false,
      required: true,
      choices: SITES,
    },
    {
      name: "apiKey",
      label: "API key",
      help: "Sent in the DD-API-KEY header. It is used for this read and never stored.",
      secret: true,
      required: true,
    },
    {
      name: "appKey",
      label: "Application key",
      help: "Sent in the DD-APPLICATION-KEY header. Needs the synthetics_read permission.",
      secret: true,
      required: true,
    },
  ],
  capabilities: CAPABILITIES,
  limitations: [
    "Datadog's sites are wholly independent, so an account on more than one site needs one import per site.",
    "Browser test steps are published as a free-form object with no schema, so nothing about them can be read. They are reported as not migrated rather than downgraded to an HTTP request against the same URL.",
    "A secure variable's value is omitted from every read, as are basic-auth passwords, SigV4 secrets and client certificate keys. A test that authenticated will not authenticate after the migration.",
    "Datadog's alerting is an N-of-M condition across locations combined with a linked monitor. Vigil confirms by waiting rather than by quorum, so `min_location_failed` is reported and the retry count becomes a failure window.",
    "Three fields in one object use three units: `tick_every` is seconds, `retry.interval` is milliseconds and `renotify_interval` is minutes. This adapter converts each one explicitly.",
    "There is no bulk export. The Terraform snippet Datadog's UI offers is copied one test at a time, and `datadog-ci` synthetics files hold test ids and overrides rather than definitions.",
  ],
  async read(context: ReadContext): Promise<SourceSnapshot> {
    const site = requireCredential(context, "site", "The Datadog site");
    if (!SITES.some((choice) => choice.value === site)) {
      throw new Error(
        "That is not one of Datadog's published API hosts. Choose a site from the list.",
      );
    }
    const apiKey = requireCredential(context, "apiKey", "The API key");
    const appKey = requireCredential(context, "appKey", "The application key");
    const transport = transportFor(context, `https://${site}`, {
      "DD-API-KEY": apiKey,
      "DD-APPLICATION-KEY": appKey,
      Accept: "application/json",
    });

    const rows: Record<string, Json>[] = [];
    const pageSize = 100;
    let page = 0;
    for (;;) {
      const response = await transport.json<{ tests?: Json }>(
        "/api/v1/synthetics/tests",
        { page_size: pageSize, page_number: page },
      );
      const tests = arr(response.tests).map((entry) => obj(entry));
      rows.push(...tests);
      // Datadog publishes no total and no cursor, so a short page is the
      // end of the list. Page numbers start at zero.
      if (tests.length < pageSize) break;
      page += 1;
    }

    const checks: SourceCheck[] = [];
    let refetched = 0;
    for (const row of rows) {
      // The list omits steps and, for some types, the request itself.
      // A test with no request is re-read rather than reported as
      // having no target, which would blame the account for the API's
      // shape.
      const hasRequest = Object.keys(obj(obj(row.config).request)).length > 0;
      const path = detailPath(row);
      if (!hasRequest && path !== null) {
        try {
          const detail = await transport.json<Json>(path);
          checks.push(toCheck({ ...row, ...obj(detail) }));
          refetched += 1;
          continue;
        } catch {
          // Fall through to the summary, which still names the test and
          // its type.
        }
      }
      checks.push(toCheck(row));
    }

    const extras: SourceExtra[] = [
      {
        kind: "variable",
        sourceId: "global-variables",
        label: "Global and secure variables",
        detail:
          "Datadog omits a secure variable's value from every read, so no importer can copy one. Any test whose request depended on a secret imports without it.",
      },
      {
        kind: "alerting",
        sourceId: "monitors",
        label: "Linked monitors and notifications",
        detail:
          "Each Synthetic test is backed by a Datadog monitor with its own notification message and renotification schedule. Vigil routes by notification channel and escalation policy, so recreate the routing under Settings, Notifications.",
      },
      {
        kind: "region",
        sourceId: "private-locations",
        label: "Private locations",
        detail:
          "A private location runs inside your network and its secrets are shown only once, at creation. A test assigned to one may be watching a target that is not reachable from where Vigil runs; enrol a Vigil remote probe in the same network for those.",
      },
    ];

    return {
      provider: "datadog",
      facts: [
        `Datadog Synthetics API v1 at ${site}, ${rows.length} test(s) over ${page + 1} page(s), ${refetched} re-read individually, ${transport.requestCount} request(s).`,
      ],
      checks,
      statusPages: [],
      extras,
    };
  },
};
