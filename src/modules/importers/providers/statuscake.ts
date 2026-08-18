import type { SourceCheck, SourceExtra, SourceSnapshot } from "../model";

import {
  requireCredential,
  transportFor,
  type ProviderAdapter,
  type ProviderCapability,
  type ReadContext,
} from "./contract";
import {
  arr,
  bool,
  keys,
  nested,
  num,
  obj,
  str,
  strs,
  type Json,
} from "./json";

/**
 * StatusCake, through the v1 API.
 *
 * Like Pingdom, the list is a summary and the configuration is behind a
 * per-test GET, so the read costs a request per check.
 *
 * The dangerous field in this API is `status_codes`. Every other
 * provider here stores the codes a check *accepts*; StatusCake stores
 * the codes that **trigger an alert**. Mapping it onto Vigil's
 * `expectedStatusCode` would produce a monitor that is down exactly when
 * the source said it was up. So it is never mapped: it is reported, in
 * its own words, and the imported monitor accepts any 2xx or 3xx.
 *
 * `custom_header` is a JSON document inside a JSON string, which is why
 * `nested()` exists. A malformed one costs the header names on one
 * check, not the import.
 */

const BASE = "https://api.statuscake.com/v1";

const CAPABILITIES: readonly ProviderCapability[] = [
  {
    sourceType: "HTTP",
    becomes: "http",
    note: "The URL, interval, timeout, keyword assertion and its inversion, redirect setting and paused state carry, as a GET. A test with a POST body is refused rather than issued as a GET.",
  },
  {
    sourceType: "HEAD",
    becomes: "http",
    note: "The same, issued as a HEAD. StatusCake expresses the verb as the test type rather than as a field.",
  },
  { sourceType: "TCP", becomes: "tcp", note: "Host and port carry." },
  { sourceType: "PING", becomes: "ping", note: "Imported unchanged." },
  {
    sourceType: "SMTP",
    becomes: "smtp",
    note: "Host and port carry. Vigil reads the banner and sends EHLO in plaintext.",
  },
  {
    sourceType: "SSH",
    becomes: "ssh",
    note: "Host and port carry. Vigil reads the server's identification string and never authenticates.",
  },
  {
    sourceType: "DNS",
    becomes: null,
    note: "Not imported. StatusCake compares the answer against a list of IP addresses in `dns_ips` and stores no record type, so Vigil's DNS check would have to be told which record to ask for and nothing in the source says which. A monitor asking for the wrong record passes while the record it watched is broken.",
  },
];

const MAPPED = new Map(CAPABILITIES.map((entry) => [entry.sourceType, entry]));

function toCheck(test: Record<string, Json>): SourceCheck {
  const sourceType = str(test.test_type)?.toUpperCase() ?? "unknown";
  const mapping = MAPPED.get(sourceType);
  const sourceId = str(test.id) ?? "unknown";
  const name = str(test.name) ?? `StatusCake test ${sourceId}`;
  const timeoutSeconds = num(test.timeout);

  const common = {
    sourceId,
    name,
    sourceType,
    paused: bool(test.paused) === true,
    intervalSeconds: num(test.check_rate),
    timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
    tags: strs(test.tags),
    regions: arr(test.servers)
      .map((server) => str(obj(server).region_code) ?? str(obj(server).region))
      .filter((region): region is string => region !== undefined),
  };

  if (mapping === undefined || mapping.becomes === null) {
    return {
      ...common,
      kind: "unsupported",
      target: {},
      unsupportedReason:
        mapping?.note ??
        `StatusCake calls this a "${sourceType}" test, which is not a type this adapter was written against, so nothing can be promised about it.`,
    };
  }

  const losses: string[] = [];
  const withheld: string[] = [];
  const alertOn = strs(test.status_codes);
  if (alertOn.length > 0) {
    losses.push(
      `StatusCake alerted on the status codes ${alertOn.join(", ")}, which is the opposite of an accepted-codes list: it names the answers that mean trouble. Vigil holds one expected code, and reading an alert-on list as an accept list would make this monitor red exactly when StatusCake said it was green, so nothing was carried and the monitor accepts any 2xx or 3xx.`,
    );
  }
  if (bool(test.enable_ssl_alert) === true) {
    losses.push(
      "StatusCake was watching this test's certificate. Certificate monitoring lives in a separate StatusCake resource this adapter does not read, and Vigil expresses it as its own TLS expiry check, so create one for this host if you relied on the warning.",
    );
  }
  if (str(test.final_endpoint) !== undefined) {
    losses.push(
      `StatusCake required the redirect chain to end at ${str(test.final_endpoint)}. Vigil follows redirects one validated hop at a time and judges the final response, so it does not assert where the chain stops.`,
    );
  }
  if (str(test.user_agent) !== undefined) {
    losses.push(
      "The custom user agent was not carried: Vigil's HTTP check sends its own.",
    );
  }
  if (num(test.confirmation) !== undefined) {
    losses.push(
      `StatusCake confirmed a failure from ${num(test.confirmation)} more servers before alerting. Vigil confirms by waiting: a monitor has to be failing for its whole failure window before an incident opens.`,
    );
  }
  if (str(test.basic_username) !== undefined) {
    withheld.push("the password this test authenticates with");
  }

  const headers = keys(nested(test.custom_header));
  const url = str(test.website_url);
  const port = num(test.port);
  const hasBody =
    str(test.post_body) !== undefined || str(test.post_raw) !== undefined;

  switch (sourceType) {
    case "PING":
      return {
        ...common,
        kind: "ping",
        target: { host: url },
        losses,
        withheld,
      };
    case "TCP":
      return {
        ...common,
        kind: "tcp",
        target: { host: url, port },
        losses,
        withheld,
      };
    case "SMTP":
      return {
        ...common,
        kind: "smtp",
        target: { host: url, port },
        losses,
        withheld,
      };
    case "SSH":
      return {
        ...common,
        kind: "ssh",
        target: { host: url, port },
        losses,
        withheld,
      };
    default: {
      const keyword = str(test.find_string);
      return {
        ...common,
        kind: "http",
        target: { url },
        http: {
          // StatusCake has no method field: HEAD is a test type, and a
          // test with a body is a POST. Saying POST is what gets it
          // refused rather than quietly issued as a GET.
          method: hasBody ? "POST" : sourceType === "HEAD" ? "HEAD" : "GET",
          keyword,
          keywordAbsent: bool(test.do_not_find) === true,
          headerNames: headers.length > 0 ? headers : undefined,
          hasRequestBody: hasBody,
          hasBasicAuth: str(test.basic_username) !== undefined,
          followRedirects: bool(test.follow_redirects),
        },
        losses,
        withheld,
      };
    }
  }
}

export const statusCakeAdapter: ProviderAdapter = {
  id: "statuscake",
  label: "StatusCake",
  input: "api",
  docs: "https://developers.statuscake.com/api/",
  access:
    "An API token from StatusCake, Account, Manage API. StatusCake publishes no read-only scope, so the token you paste can also write; create one for this migration and revoke it afterwards. This importer only issues GET requests.",
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
    "StatusCake's uptime list carries no configuration, so this importer reads every test individually. Unsubscribed accounts are limited to 60 requests a minute and every account to five a second; the importer backs off and continues.",
    "`status_codes` names the codes that trigger an alert rather than the codes that pass. It is reported on every test that sets one and never mapped onto Vigil's expected status code.",
    "StatusCake never returns `basic_username` or `basic_password` on read, so a test behind HTTP authentication imports as an unauthenticated check.",
    "Certificate monitoring and heartbeat checks are separate StatusCake resources (/ssl and /heartbeat) that this adapter does not read. They are reported as not migrated rather than silently dropped.",
    "There is no official file export of test configuration.",
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
      const response = await transport.json<{ data?: Json; metadata?: Json }>(
        "/uptime",
        { page, limit: 100, nouptime: 1 },
      );
      for (const row of arr(response.data)) summaries.push(obj(row));
      const meta = obj(response.metadata);
      const pageCount = num(meta.page_count) ?? 1;
      if (page >= pageCount) break;
      page += 1;
    }

    const checks: SourceCheck[] = [];
    let unreadable = 0;
    for (const summary of summaries) {
      const id = str(summary.id);
      if (id === undefined) {
        unreadable += 1;
        continue;
      }
      try {
        const detail = await transport.json<{ data?: Json }>(`/uptime/${id}`);
        checks.push(toCheck({ id, ...obj(detail.data) }));
      } catch (error) {
        unreadable += 1;
        checks.push({
          sourceId: id,
          name: str(summary.name) ?? `StatusCake test ${id}`,
          sourceType: str(summary.test_type) ?? "unknown",
          kind: "unsupported",
          paused: bool(summary.paused) === true,
          target: {},
          unsupportedReason: `StatusCake would not return this test's configuration, so nothing about it could be read: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    const extras: SourceExtra[] = [
      {
        kind: "account",
        sourceId: "ssl-and-heartbeat",
        label: "SSL and heartbeat checks",
        detail:
          "StatusCake keeps certificate monitoring and heartbeat checks in separate resources from uptime tests, and this adapter reads only the uptime tests. Any SSL or heartbeat check in this account is not migrated: recreate them as Vigil TLS expiry and heartbeat monitors.",
      },
      {
        kind: "alerting",
        sourceId: "contact-groups",
        label: "Contact groups",
        detail:
          "StatusCake routes alerts by contact group attached to each test. Vigil routes by notification channel and escalation policy, which belong to the organisation, so there is no per-test attachment to recreate.",
      },
    ];

    return {
      provider: "statuscake",
      facts: [
        `StatusCake API v1, ${summaries.length} uptime test(s) listed, ${checks.length} read individually, ${transport.requestCount} request(s).`,
        unreadable === 0
          ? "Every listed test was read."
          : `${unreadable} test(s) could not be read and are reported individually.`,
      ],
      checks,
      statusPages: [],
      extras,
    };
  },
};
