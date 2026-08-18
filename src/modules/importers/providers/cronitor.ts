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
 * Cronitor, through the monitors API.
 *
 * Cronitor stores its expectations as free text. There are no
 * `expected_status_code` or `keyword` fields: there is an `assertions`
 * array holding strings like `response.code = 200` and
 * `response.body contains "ok"`, in a grammar Cronitor documents by
 * example rather than by specification.
 *
 * So this adapter parses the three forms it can recognise exactly, and
 * carries every other assertion into the report as the string Cronitor
 * stored. That split is the whole design: `response.code = 200` has one
 * unambiguous reading and becomes Vigil's expected status code, while
 * `metric.duration < 15min` is a claim about how long a job takes that
 * Vigil has no field for, and inventing one would be worse than saying
 * so.
 *
 * The version header matters more than it looks. Cronitor defaults an
 * unversioned request to `2020-10-01`, where a monitor's schedule is a
 * single `schedule` string; the current version replaced it with a
 * `schedules` array. This adapter pins the current version and reads
 * both shapes, because a monitor with two schedules would otherwise
 * arrive with one of them silently missing.
 */

const BASE = "https://cronitor.io/api";
const API_VERSION = "2025-11-28";

const CAPABILITIES: readonly ProviderCapability[] = [
  {
    sourceType: "check (http)",
    becomes: "http",
    note: "The URL, method, timeout, redirect setting and group carry. `response.code` and `response.body` assertions become Vigil's expected status code and body assertion; every other assertion is reported in Cronitor's own words rather than approximated. Request headers, cookies and the request body do not carry.",
  },
  {
    sourceType: "job",
    becomes: "push",
    note: "A scheduled job becomes a Vigil heartbeat monitor with its grace period. The schedule does not carry: Vigil expects a heartbeat every interval plus a grace period rather than at the times a cron expression names. A new token is generated and the job has to be pointed at it.",
  },
  { sourceType: "heartbeat", becomes: "push", note: "The same as a job." },
  {
    sourceType: "check (browser)",
    becomes: null,
    note: "Not imported. The check drives a browser, and Vigil has no check type that replays a journey.",
  },
  {
    sourceType: "check (tcp or udp)",
    becomes: null,
    note: "Not imported. Cronitor's platform field says the check speaks TCP or UDP, but the request object it documents holds only a `url`, with no published encoding for a host and a port. Splitting one on a guess produces a monitor dialling a port nobody chose.",
  },
  {
    sourceType: "site",
    becomes: "http",
    note: "Imported as an availability check on its URL, with the same assertion handling as an HTTP check.",
  },
];

/** `response.code = 200`, and the two other forms worth recognising. */
interface ParsedAssertions {
  acceptedStatus?: string[];
  keyword?: string;
  keywordAbsent?: boolean;
  certificateWarnDays?: number;
  /** Everything else, in Cronitor's own words. */
  rest: string[];
}

const QUOTED = /^"(.*)"$|^'(.*)'$/;

function unquote(value: string): string {
  const match = QUOTED.exec(value.trim());
  return (match?.[1] ?? match?.[2] ?? value).trim();
}

function parseAssertions(assertions: readonly string[]): ParsedAssertions {
  const parsed: ParsedAssertions = { rest: [] };
  for (const raw of assertions) {
    const assertion = raw.trim();
    const code = /^response\.code\s*(=|==)\s*(\d{3})$/.exec(assertion);
    if (code !== null) {
      parsed.acceptedStatus = [...(parsed.acceptedStatus ?? []), code[2] ?? ""];
      continue;
    }
    const body = /^response\.body\s+(not\s+contains|contains)\s+(.+)$/i.exec(
      assertion,
    );
    if (body !== null && parsed.keyword === undefined) {
      parsed.keyword = unquote(body[2] ?? "");
      parsed.keywordAbsent = (body[1] ?? "").toLowerCase().startsWith("not");
      continue;
    }
    const cert = /^ssl_certificate\.expires_in\s*>\s*(\d+)\s*days?$/i.exec(
      assertion,
    );
    if (cert !== null) {
      parsed.certificateWarnDays = Number(cert[1]);
      continue;
    }
    parsed.rest.push(
      `Cronitor asserted \`${assertion}\`, which Vigil has no field for. It was not carried.`,
    );
  }
  return parsed;
}

/** Every schedule the monitor carries, in either version's shape. */
function schedulesOf(row: Record<string, Json>): string[] {
  const single = str(row.schedule);
  const many = strs(row.schedules);
  return single === undefined ? many : [single, ...many];
}

function toCheck(row: Record<string, Json>): SourceCheck {
  const type = str(row.type)?.toLowerCase() ?? "unknown";
  const platform = str(row.platform)?.toLowerCase();
  const sourceId = str(row.key) ?? "unknown";
  const name = str(row.name) ?? sourceId;
  const group = str(row.group);
  const request = obj(row.request);

  const common = {
    sourceId,
    name,
    sourceType: platform === undefined ? type : `${type} (${platform})`,
    paused: bool(row.paused) === true,
    groupPath: group === undefined ? undefined : [group],
    regions: strs(row.regions).concat(strs(request.regions)),
  };

  if (type === "job" || type === "heartbeat") {
    const schedules = schedulesOf(row);
    return {
      ...common,
      kind: "heartbeat",
      target: { label: name },
      heartbeat: {
        graceSeconds: num(row.grace_seconds),
        cron: schedules.length > 0 ? schedules.join(", ") : undefined,
      },
      losses:
        schedules.length > 1
          ? [
              `Cronitor ran this on ${schedules.length} schedules. Vigil expects a heartbeat every interval plus a grace period, so set the interval to the longest gap between runs.`,
            ]
          : [],
    };
  }

  if (type !== "check" && type !== "site") {
    return {
      ...common,
      kind: "unsupported",
      target: {},
      unsupportedReason: `Cronitor calls this a "${type}" monitor, which is not a type this adapter was written against, so nothing can be promised about it.`,
    };
  }

  if (platform === "browser") {
    return {
      ...common,
      kind: "unsupported",
      target: {},
      unsupportedReason:
        "The check drives a browser, and Vigil has no check type that replays a journey. Watch the same endpoint with an HTTP monitor if availability is enough.",
    };
  }
  if (platform === "tcp" || platform === "udp") {
    return {
      ...common,
      kind: "unsupported",
      target: {},
      unsupportedReason: `Cronitor says this check speaks ${platform.toUpperCase()}, and the request object it publishes holds only a URL with no documented way to read a host and a port out of it. Splitting one on a guess produces a monitor dialling a port nobody chose.`,
    };
  }

  const assertions = parseAssertions(strs(row.assertions));
  const timeoutSeconds = num(request.timeout_seconds);
  const headerNames = keys(request.headers);
  const losses = [...assertions.rest];
  if (keys(request.cookies).length > 0) {
    losses.push(
      "The cookies Cronitor sent with the request were not carried: Vigil's HTTP check sends its own headers and no cookie jar.",
    );
  }
  if (bool(request.verify_ssl) === false) {
    losses.push(
      "Cronitor was told not to verify the certificate. Vigil always verifies, so a monitor on a self-signed or expired certificate will read as down here.",
    );
  }

  return {
    ...common,
    kind: "http",
    target: { url: str(request.url) },
    intervalSeconds: undefined,
    timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
    retries:
      num(row.failure_tolerance) === undefined
        ? undefined
        : {
            count: num(row.failure_tolerance),
            note: "Cronitor counts failures before alerting and Vigil measures how long a monitor has been failing, so the count was multiplied by the check interval to produce the same wall-clock tolerance.",
          },
    http: {
      method: str(request.method)?.toUpperCase(),
      acceptedStatus: assertions.acceptedStatus,
      keyword: assertions.keyword,
      keywordAbsent: assertions.keywordAbsent,
      headerNames: headerNames.length > 0 ? headerNames : undefined,
      hasRequestBody: str(request.body) !== undefined,
      followRedirects: bool(request.follow_redirects),
      checkCertificateExpiry: assertions.certificateWarnDays !== undefined,
      certificateWarnDays: assertions.certificateWarnDays,
    },
    losses: [
      ...losses,
      "Cronitor schedules a check by expression rather than by interval, so this monitor arrives on Vigil's default interval of 60 seconds. Set it on the monitor page if the check ran more or less often than that.",
    ],
  };
}

export const cronitorAdapter: ProviderAdapter = {
  id: "cronitor",
  label: "Cronitor",
  input: "api",
  docs: "https://cronitor.io/docs/monitors-api",
  access:
    "An API key with the `monitor:read` scope, from Cronitor's API keys page. A telemetry key will not work: it carries only `monitor:telemetry` and cannot read configuration.",
  credentials: [
    {
      name: "apiKey",
      label: "API key",
      help: "Sent as the HTTP basic auth username, which is how Cronitor authenticates. It is used for this read and never stored.",
      secret: true,
      required: true,
    },
  ],
  capabilities: CAPABILITIES,
  limitations: [
    "Cronitor stores expectations as assertion strings in a grammar it documents by example. This importer recognises `response.code`, `response.body contains` and `ssl_certificate.expires_in` exactly, and reports every other assertion in Cronitor's own words rather than approximating it.",
    "A check's schedule is an expression rather than an interval, and the three dialects Cronitor accepts share one field with nothing to say which is in use. Imported HTTP monitors arrive on Vigil's default interval.",
    "Tags cannot be read back: Cronitor exposes them as a list filter and returns no tags field and no tag endpoint.",
    "Cronitor's `disabled` flag is a capacity artifact rather than operator intent, so only `paused` is read as a paused monitor.",
    "Cronitor does publish a real export, `GET /api/monitors?format=yaml` and `cronitor monitor export`, which is worth keeping as your own backup. This importer reads the JSON API instead, because it needs the same fields and one code path.",
  ],
  async read(context: ReadContext): Promise<SourceSnapshot> {
    const apiKey = requireCredential(context, "apiKey", "The API key");
    const transport = transportFor(context, BASE, {
      // Cronitor takes the key as the basic-auth username with no
      // password, which is unusual enough to be worth stating.
      Authorization: `Basic ${btoa(`${apiKey}:`)}`,
      "Cronitor-Version": API_VERSION,
      Accept: "application/json",
    });

    const checks: SourceCheck[] = [];
    const pageSize = 100;
    let page = 1;
    for (;;) {
      const response = await transport.json<{ monitors?: Json }>("/monitors", {
        page,
        pageSize,
      });
      const rows = arr(response.monitors);
      for (const row of rows) checks.push(toCheck(obj(row)));
      // Cronitor publishes no total, so the end of the list is a short
      // page. Its own client library terminates the same way.
      if (rows.length < pageSize) break;
      page += 1;
    }

    const extras: SourceExtra[] = [
      {
        kind: "tag",
        sourceId: "tags",
        label: "Tags",
        detail:
          "Cronitor exposes tags as a list filter and returns no tags field on a monitor and no endpoint that enumerates them, so no importer can read which tags a monitor carried. Vigil has no monitor tags in any case.",
      },
      {
        kind: "alerting",
        sourceId: "notify",
        label: "Notification lists",
        detail:
          "Cronitor attaches notification lists to individual monitors. Vigil routes by notification channel and escalation policy, which belong to the organisation, so there is no per-monitor attachment to recreate.",
      },
    ];

    return {
      provider: "cronitor",
      facts: [
        `Cronitor monitors API, version ${API_VERSION}, ${checks.length} monitor(s) over ${page} page(s), ${transport.requestCount} request(s).`,
      ],
      checks,
      statusPages: [],
      extras,
    };
  },
};
