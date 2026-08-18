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
 * Checkly, through its v1 API.
 *
 * `GET /v1/checks` returns the same object the single-check endpoint
 * does, so one paginated sweep is the account.
 *
 * It is read with `applyGroupSettings=true`, which matters more than it
 * looks. A Checkly check inside a group inherits the group's base URL,
 * headers, assertions and basic auth, and without that parameter the
 * check comes back with a relative URL and no assertions at all. An
 * importer that omitted it would produce monitors pointing at nothing
 * and never notice.
 *
 * Assertions are `{source, comparison, property, target}`. Two of the
 * fourteen comparisons map onto something Vigil holds: a status code
 * equality and a text-body containment. Everything else, JSONPath
 * assertions, header comparisons, regular expressions, response-time
 * bounds, is reported in Checkly's own vocabulary rather than
 * approximated, because an assertion that half-carries is an alert rule
 * that fires on something else.
 */

const BASE = "https://api.checklyhq.com";

const CAPABILITIES: readonly ProviderCapability[] = [
  {
    sourceType: "API",
    becomes: "http",
    note: "The URL, method, frequency, response-time limit, retry strategy and paused state carry, and group settings are resolved before reading so a check inside a group arrives with the group's base URL. A `STATUS_CODE EQUALS` assertion becomes Vigil's expected status code and a `TEXT_BODY CONTAINS` one becomes its body assertion; every other assertion is reported. Request headers, query parameters, the request body, basic auth and setup or teardown scripts do not carry.",
  },
  {
    sourceType: "URL",
    becomes: "http",
    note: "The same, for Checkly's simpler URL monitor.",
  },
  { sourceType: "ICMP", becomes: "ping", note: "Imported unchanged." },
  {
    sourceType: "TCP",
    becomes: "tcp",
    note: "Host and port carry. The data Checkly sends and the response it asserts on do not: Vigil's TCP check judges whether the connection opens.",
  },
  {
    sourceType: "DNS",
    becomes: "dns",
    note: "The queried name and the record type carry when Vigil resolves that type. The nameserver, the transport and Checkly's assertion vocabulary do not: Vigil resolves through the worker's own resolver and asserts that a record contains a value.",
  },
  {
    sourceType: "SSL",
    becomes: "tls-expiry",
    note: "The host and the days-before-expiry threshold carry. Checkly's security baseline, which grades protocol versions and ciphers, does not: Vigil's TLS check watches the expiry date.",
  },
  {
    sourceType: "GRPC",
    becomes: "grpc",
    note: "Imported only when Checkly's `grpcConfig.mode` is HEALTH, in which case both sides call the standard gRPC health service and the host, port and TLS setting carry. A check in BEHAVIOR mode calls a named method with a payload of its own; Vigil sends the health service instead, so a server that does not implement it would read down. Those are refused rather than imported.",
  },
  {
    sourceType: "HEARTBEAT",
    becomes: "push",
    note: "The period and grace period carry, converted from Checkly's unit fields. A new token is generated, so the reporting job has to be pointed at the new endpoint.",
  },
  {
    sourceType: "BROWSER",
    becomes: null,
    note: "Not imported. The check is a Playwright script and carries no request object at all: there is no URL, method or assertion to map, and Vigil has no check type that replays a journey.",
  },
  {
    sourceType: "MULTI_STEP",
    becomes: null,
    note: "Not imported. The check is a script that chains requests and feeds values from one into the next. Folding it into a single request would watch something the check never watched.",
  },
  {
    sourceType: "PLAYWRIGHT",
    becomes: null,
    note: "Not imported. The check runs a Playwright test suite by command line.",
  },
  {
    sourceType: "AGENTIC",
    becomes: null,
    note: "Not imported. Checkly publishes no schema for this type beyond the generic one, so nothing can be promised about it.",
  },
  {
    sourceType: "TRACEROUTE",
    becomes: null,
    note: "Not imported. Vigil has no traceroute check: it watches whether a service answers rather than the path taken to it.",
  },
];

const MAPPED = new Map(CAPABILITIES.map((entry) => [entry.sourceType, entry]));

/** Checkly's period units as seconds. */
const UNIT_SECONDS: Readonly<Record<string, number>> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86_400,
};

/**
 * The interval in seconds, from the two fields Checkly splits it across.
 *
 * `frequency` is minutes. `0` means the check runs sub-minute and
 * `frequencyOffset` alone decides how often, in seconds; Checkly
 * documents that only in its own Terraform provider, and the values it
 * allows there are 10, 20 and 30. A zero offset is Checkly's "disabled",
 * which is not an interval, so it is left unset for the translator to
 * report.
 */
function intervalSecondsFrom(row: Record<string, Json>): number | undefined {
  const frequency = num(row.frequency);
  if (frequency === undefined) return undefined;
  if (frequency > 0) return frequency * 60;
  const offset = num(row.frequencyOffset);
  return offset !== undefined && offset > 0 ? offset : undefined;
}

function seconds(value: Json, unit: Json): number | undefined {
  const amount = num(value);
  if (amount === undefined) return undefined;
  const multiplier = UNIT_SECONDS[str(unit)?.toLowerCase() ?? "seconds"] ?? 1;
  return amount * multiplier;
}

interface Assertions {
  acceptedStatus?: string[];
  keyword?: string;
  keywordAbsent?: boolean;
  rest: string[];
}

/** The two assertion shapes Vigil holds, and a sentence for the rest. */
function readChecklyAssertions(raw: Json): Assertions {
  const parsed: Assertions = { rest: [] };
  for (const entry of arr(raw)) {
    const assertion = obj(entry);
    const source = str(assertion.source)?.toUpperCase();
    const comparison = str(assertion.comparison)?.toUpperCase();
    const target = str(assertion.target);
    const property = str(assertion.property);
    const regex = str(assertion.regex);

    if (
      source === "STATUS_CODE" &&
      comparison === "EQUALS" &&
      target !== undefined &&
      regex === undefined
    ) {
      parsed.acceptedStatus = [...(parsed.acceptedStatus ?? []), target];
      continue;
    }
    if (
      source === "TEXT_BODY" &&
      (comparison === "CONTAINS" || comparison === "NOT_CONTAINS") &&
      target !== undefined &&
      regex === undefined &&
      parsed.keyword === undefined
    ) {
      parsed.keyword = target;
      parsed.keywordAbsent = comparison === "NOT_CONTAINS";
      continue;
    }
    parsed.rest.push(
      `Checkly asserted ${source ?? "something"} ${comparison ?? ""}${
        property === undefined ? "" : ` on "${property}"`
      }${target === undefined ? "" : ` against "${target}"`}, which Vigil has no field for. It was not carried.`,
    );
  }
  return parsed;
}

function toCheck(row: Record<string, Json>): SourceCheck {
  const sourceType = str(row.checkType)?.toUpperCase() ?? "unknown";
  const mapping = MAPPED.get(sourceType);
  const sourceId = str(row.id) ?? "unknown";
  const name = str(row.name) ?? `Checkly check ${sourceId}`;
  const request = obj(row.request);
  const retry = obj(row.retryStrategy);

  const common = {
    sourceId,
    name,
    sourceType,
    paused: bool(row.activated) === false,
    // Checkly's frequency is minutes, and 0 means "sub-minute, see
    // frequencyOffset", which is seconds. Reading only the minutes would
    // turn a check running every ten seconds into one running every
    // sixty without saying so.
    intervalSeconds: intervalSecondsFrom(row),
    // Checkly calls this "the response time where a check should be
    // considered failing" rather than a socket timeout. Vigil aborts at
    // its timeout, so the verdict is the same and the mechanism is not;
    // the note below says so on every check that sets one.
    timeoutMs: num(row.maxResponseTime),
    tags: strs(row.tags),
    regions: [...strs(row.locations), ...strs(row.privateLocations)],
    retries:
      num(retry.maxRetries) === undefined
        ? undefined
        : {
            count: num(retry.maxRetries),
            intervalSeconds: num(retry.baseBackoffSeconds),
          },
  };

  if (mapping === undefined || mapping.becomes === null) {
    return {
      ...common,
      kind: "unsupported",
      target: {},
      unsupportedReason:
        mapping?.note ??
        `Checkly calls this a "${sourceType}" check, which is not a type this adapter was written against, so nothing can be promised about it.`,
    };
  }

  const losses: string[] = [];
  const withheld: string[] = [];
  if (num(row.maxResponseTime) !== undefined) {
    losses.push(
      `Checkly failed this check above ${num(row.maxResponseTime)}ms by measuring the response and judging it. Vigil enforces the same number as a request timeout, so the verdict matches but the request is abandoned rather than measured.`,
    );
  }
  if (num(row.degradedResponseTime) !== undefined) {
    losses.push(
      `Checkly marked this check degraded above ${num(row.degradedResponseTime)}ms. Vigil has its own degraded threshold, which defaults to 3000ms and was not overwritten: set it on the monitor page if the source's number matters.`,
    );
  }
  if (str(obj(request.basicAuth).username) !== undefined) {
    withheld.push("the password this check authenticates with");
  }
  if (
    num(row.setupSnippetId) !== undefined ||
    str(row.localSetupScript) !== undefined
  ) {
    losses.push(
      "The check ran a setup script before its request, which could sign it or fetch a token. Vigil's HTTP check has no such hook, so a request that depended on it will not authenticate here.",
    );
  }
  if (bool(row.shouldFail) === true) {
    losses.push(
      "Checkly inverted this check's verdict: it passed when the request failed. Vigil has no inversion, so the imported monitor means the opposite of what the source did. Delete it unless you meant to watch availability.",
    );
  }
  if (bool(row.muted) === true) {
    losses.push(
      "The check was muted in Checkly. Vigil has no mute: pause the monitor, or leave it running and let its notification channel decide.",
    );
  }
  const secretVariables = arr(row.environmentVariables)
    .map((entry) => obj(entry))
    .filter((entry) => bool(entry.secret) === true).length;
  if (secretVariables > 0) {
    withheld.push(
      `${secretVariables} secret environment variable(s), whose values Checkly returns as null in any case`,
    );
  }

  const port = num(request.port);
  const hostname = str(request.hostname);

  switch (sourceType) {
    case "ICMP":
      return {
        ...common,
        kind: "ping",
        target: { host: hostname ?? str(request.url) },
        losses,
        withheld,
      };
    case "TCP":
      return {
        ...common,
        kind: "tcp",
        target: { host: hostname, port },
        losses,
        withheld,
      };
    case "GRPC": {
      const mode = str(obj(request.grpcConfig).mode)?.toUpperCase();
      if (mode !== "HEALTH") {
        return {
          ...common,
          kind: "unsupported",
          target: {},
          unsupportedReason: `Checkly runs this check in ${mode ?? "an unstated"} mode, calling a named method with its own payload. Vigil's gRPC check calls the standard grpc.health.v1.Health service and nothing else, so an imported monitor would ask a question this server may not answer and report an outage that is not one. Only a check in HEALTH mode is the same check on both sides.`,
        };
      }
      return {
        ...common,
        kind: "grpc",
        target: { host: hostname, port },
        losses,
        withheld,
      };
    }
    case "DNS": {
      const dns = obj(request);
      if (str(dns.nameServer) !== undefined) {
        losses.push(
          `The nameserver ${str(dns.nameServer)} was not carried: Vigil resolves through the worker's own resolver, so the answer this monitor judges is the answer your infrastructure gets.`,
        );
      }
      return {
        ...common,
        kind: "dns",
        target: { host: str(dns.query) },
        dns: { recordType: str(dns.recordType) },
        losses: [
          ...losses,
          "Checkly's DNS assertions were not carried: Vigil asserts that a record of the named type resolves and optionally contains a value.",
        ],
        withheld,
      };
    }
    case "SSL": {
      // Not `request.url` and not `request.hostname`: an SSL monitor's
      // target is nested one level down, and reading the flat fields
      // gave every certificate check no host at all.
      const sslConfig = obj(request.sslConfig);
      if (Object.keys(obj(sslConfig.securityBaseline)).length > 0) {
        losses.push(
          "Checkly graded this certificate's protocol versions and ciphers against a security baseline, with a severity per property. Vigil's TLS check watches how long the certificate has left, so the baseline was not carried.",
        );
      }
      return {
        ...common,
        kind: "tls",
        target: {
          host: str(sslConfig.hostname),
          port: num(sslConfig.port) ?? 443,
        },
        warnDays: num(sslConfig.alertDaysBeforeExpiry),
        losses,
        withheld,
      };
    }
    case "HEARTBEAT": {
      const heartbeat = obj(row.heartbeat);
      return {
        ...common,
        kind: "heartbeat",
        target: { label: name },
        heartbeat: {
          periodSeconds: seconds(heartbeat.period, heartbeat.periodUnit),
          graceSeconds: seconds(heartbeat.grace, heartbeat.graceUnit),
        },
        losses,
        withheld,
      };
    }
    default: {
      const assertions = readChecklyAssertions(request.assertions);
      const headerNames = arr(request.headers)
        .map((header) => str(obj(header).key))
        .filter((header): header is string => header !== undefined);
      const queryNames = arr(request.queryParameters).length;
      if (queryNames > 0) {
        losses.push(
          `${queryNames} query parameter(s) were configured separately from the URL. They were not carried: put them in the URL on the monitor page if the endpoint needs them.`,
        );
      }
      const certificates = obj(obj(row.alertSettings).sslCertificates);
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
          hasBasicAuth: str(obj(request.basicAuth).username) !== undefined,
          followRedirects: bool(request.followRedirects),
          checkCertificateExpiry: bool(certificates.enabled) === true,
          certificateWarnDays: num(certificates.alertThreshold),
          otherAssertions: assertions.rest,
        },
        losses,
        withheld,
      };
    }
  }
}

export const checklyAdapter: ProviderAdapter = {
  id: "checkly",
  label: "Checkly",
  input: "api",
  docs: "https://www.checklyhq.com/docs/api-reference/overview/",
  access:
    "An API key from Checkly, User Settings, API Keys. A user key on any plan is enough; a read-only service key needs the Enterprise plan. If your account id is shown in Checkly's API examples, paste it too, so the read is scoped to the right account.",
  credentials: [
    {
      name: "token",
      label: "API key",
      help: "Sent as a bearer token. It is used for this read and never stored.",
      secret: true,
      required: true,
    },
    {
      name: "accountId",
      label: "Account id",
      help: "Optional. Sent as the X-Checkly-Account header when your key spans several accounts.",
      secret: false,
      required: false,
    },
  ],
  capabilities: CAPABILITIES,
  limitations: [
    "Checks are read with group settings applied, so a check inside a group arrives with the group's base URL and headers resolved rather than with a relative URL.",
    "Checkly returns a secret environment variable's value as null, so any check whose request depends on one imports without it.",
    "Setup and teardown scripts, snippets and browser scripts are arbitrary code. A check that signed its own request in a setup script will not authenticate after the migration.",
    "Checkly has a third state, degraded, expressed as `degradedResponseTime` and as per-property severities on an SSL check. Vigil also has degraded but derives it from its own response-time threshold, so the source's thresholds are reported rather than carried.",
    "There is no read-only export. Checkly's CLI import writes TypeScript constructs and binds the resources to a CLI project, which is a different operation from reading an account.",
  ],
  async read(context: ReadContext): Promise<SourceSnapshot> {
    const token = requireCredential(context, "token", "The API key");
    const accountId = (context.credentials.accountId ?? "").trim();
    const transport = transportFor(context, BASE, {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(accountId.length > 0 ? { "X-Checkly-Account": accountId } : {}),
    });

    const groupNames = new Map<string, string>();
    try {
      const groups = await transport.json<Json[]>("/v1/check-groups", {
        limit: 100,
      });
      for (const entry of Array.isArray(groups) ? groups : []) {
        const group = obj(entry);
        const id = str(group.id);
        const name = str(group.name);
        if (id !== undefined && name !== undefined) groupNames.set(id, name);
      }
    } catch {
      // Groups are a folder, not the migration.
    }

    const checks: SourceCheck[] = [];
    const pageSize = 100;
    let page = 1;
    for (;;) {
      const rows = await transport.json<Json[]>("/v1/checks", {
        limit: pageSize,
        page,
        applyGroupSettings: "true",
      });
      const list = Array.isArray(rows) ? rows : [];
      for (const row of list) {
        const record = obj(row);
        const check = toCheck(record);
        const groupName = groupNames.get(str(record.groupId) ?? "");
        checks.push(
          groupName === undefined
            ? check
            : { ...check, groupPath: [groupName] },
        );
      }
      // Checkly returns a bare array with no total, so a short page is
      // the end of the list.
      if (list.length < pageSize) break;
      page += 1;
    }

    const extras: SourceExtra[] = [
      {
        kind: "variable",
        sourceId: "environment-variables",
        label: "Environment variables",
        detail:
          "Checkly returns a secret variable's value as null, so no importer can copy one. Any check whose request depended on a secret imports without it.",
      },
      {
        kind: "alerting",
        sourceId: "alert-channels",
        label: "Alert channels",
        detail:
          "Checkly types an alert channel's configuration as a bare object with no published per-type schema, and channels are attached to individual checks. Vigil routes by notification channel and escalation policy, which belong to the organisation, so recreate the channels under Settings, Notifications.",
      },
      {
        kind: "region",
        sourceId: "private-locations",
        label: "Private locations",
        detail:
          "A private location is a Checkly agent inside your network, and a check assigned to one may be watching a target that is not reachable from where Vigil runs. Enrol a Vigil remote probe in the same network for those.",
      },
    ];

    return {
      provider: "checkly",
      facts: [
        `Checkly API v1, ${checks.length} check(s) over ${page} page(s), read with group settings applied, ${transport.requestCount} request(s).`,
        `${groupNames.size} check group(s) read.`,
      ],
      checks,
      statusPages: [],
      extras,
    };
  },
};
