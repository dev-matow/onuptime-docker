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
 * Hyperping, through the v1 monitors API.
 *
 * The resource prefixes are per resource rather than global: monitors
 * are `/v1`, healthchecks `/v2`, incidents `/v3`. Only `/v1/monitors` is
 * read here.
 *
 * Hyperping's published examples are asymmetric in both directions: the
 * list carries `paused` and the single-monitor response carries
 * `required_keyword`, and the documentation does not say which fields
 * either omits. So this adapter lists and then re-reads each monitor and
 * merges the two, with the detail winning. It costs a request per
 * monitor against an hourly budget, and the alternative is dropping
 * every content assertion in the account without noticing.
 */

const BASE = "https://api.hyperping.io";

const CAPABILITIES: readonly ProviderCapability[] = [
  {
    sourceType: "http",
    becomes: "http",
    note: "The URL, check frequency, method, expected status expression, keyword assertion and redirect setting carry. Request headers and the request body do not: Vigil's HTTP check issues GET or HEAD with its own headers.",
  },
  {
    sourceType: "port",
    becomes: "tcp",
    note: "Host and port carry. Same check under a different name: open a TCP connection.",
  },
  { sourceType: "icmp", becomes: "ping", note: "Imported unchanged." },
  {
    sourceType: "dns",
    becomes: "dns",
    note: "The record type and the expected answer carry when Hyperping returns them. The per-monitor nameserver does not: Vigil resolves through the worker's own resolver, so the answer it judges is the answer your infrastructure gets. A monitor whose record type is missing from the response is refused rather than given one.",
  },
];

const MAPPED = new Map(CAPABILITIES.map((entry) => [entry.sourceType, entry]));

function toCheck(row: Record<string, Json>): SourceCheck {
  const sourceType = str(row.protocol)?.toLowerCase() ?? "http";
  const mapping = MAPPED.get(sourceType);
  const sourceId = str(row.uuid) ?? "unknown";
  const name = str(row.name) ?? str(row.url) ?? `Hyperping monitor ${sourceId}`;

  const common = {
    sourceId,
    name,
    sourceType,
    paused: bool(row.paused) === true,
    intervalSeconds: num(row.check_frequency),
    regions: strs(row.regions),
  };

  if (mapping === undefined || mapping.becomes === null) {
    return {
      ...common,
      kind: "unsupported",
      target: {},
      unsupportedReason:
        mapping?.note ??
        `Hyperping calls this a "${sourceType}" monitor. Hyperping's browser checks, which run a scripted journey, are not in the API's protocol list at all, so a monitor this adapter does not recognise may be one of those. Vigil has no check type that replays a journey.`,
    };
  }

  const losses: string[] = [
    // Hyperping has no timeout field anywhere in the monitor API, so
    // there is nothing to read and nothing to clamp. Said once, per
    // monitor, because an operator comparing the two screens will look
    // for it.
    "Hyperping stores no per-monitor timeout, so this monitor uses Vigil's default of 10 seconds.",
  ];
  const alertsWait = num(row.alerts_wait);
  if (alertsWait !== undefined && alertsWait > 0) {
    losses.push(
      `Hyperping waited ${alertsWait} before alerting, in a unit its API does not publish, so the delay was not converted into Vigil's failure window: guessing between seconds and minutes would be a sixty-fold error in how long an outage goes unreported. This monitor uses Vigil's default failure window; set it on the monitor page.`,
    );
  }
  const escalation = str(obj(row.escalation_policy).name);
  if (escalation !== undefined) {
    losses.push(
      `The escalation policy "${escalation}" was not carried: Vigil has its own escalation policies, and an imported monitor points at none of them until you attach one.`,
    );
  }

  const url = str(row.url);

  switch (sourceType) {
    case "icmp":
      return { ...common, kind: "ping", target: { host: url }, losses };
    case "port":
      return {
        ...common,
        kind: "tcp",
        target: { host: url, port: num(row.port) },
        losses,
      };
    case "dns": {
      const recordType = str(row.dns_record_type);
      if (recordType === undefined) {
        return {
          ...common,
          kind: "unsupported",
          target: {},
          unsupportedReason:
            "Hyperping did not return this monitor's DNS record type. Vigil's DNS check must ask for a record type, and choosing one here would mean a monitor that goes green on an A record while the MX record it was watching is broken.",
        };
      }
      const nameserver = str(row.dns_nameserver);
      return {
        ...common,
        kind: "dns",
        target: { host: url },
        dns: {
          recordType,
          expectedValues:
            str(row.dns_expected_answer) === undefined
              ? []
              : [str(row.dns_expected_answer) ?? ""],
          resolver: nameserver,
        },
        losses,
      };
    }
    default: {
      const headerNames = arr(row.request_headers)
        .map((header) => str(obj(header).name))
        .filter((header): header is string => header !== undefined);
      const status = str(row.expected_status_code);
      return {
        ...common,
        kind: "http",
        target: { url },
        http: {
          method: str(row.http_method)?.toUpperCase(),
          // Hyperping stores one expression, and "2xx" is its default.
          // Vigil's no-expectation rule is a superset of it, so only a
          // narrower expression is worth reporting.
          acceptedStatus:
            status === undefined || status.toLowerCase() === "2xx"
              ? undefined
              : [status],
          keyword: str(row.required_keyword),
          headerNames: headerNames.length > 0 ? headerNames : undefined,
          hasRequestBody: str(row.request_body) !== undefined,
          followRedirects: bool(row.follow_redirects),
        },
        losses,
      };
    }
  }
}

export const hyperpingAdapter: ProviderAdapter = {
  id: "hyperping",
  label: "Hyperping",
  input: "api",
  docs: "https://hyperping.com/docs/api/overview",
  access:
    "A read-only API key from the Hyperping project's Settings, Developers. Keys are bound to one project, so an account with several projects needs one import per project.",
  credentials: [
    {
      name: "token",
      label: "API key",
      help: "Sent as a bearer token. It is used for this read and never stored.",
      secret: true,
      required: true,
    },
  ],
  capabilities: CAPABILITIES,
  limitations: [
    "Hyperping's list and single-monitor responses each carry fields the other does not, and the documentation does not say which, so this importer reads every monitor twice: once in the list and once individually. That costs a request per monitor against Hyperping's hourly budget.",
    "Hyperping has no timeout field, no tags and no groups, so none of the three can be carried.",
    "The `alerts_wait` delay is published without a unit. This importer reports it and does not convert it, because a wrong guess is a sixty-fold error in how long an outage goes unreported.",
    "Hyperping's browser checks do not appear in the API's protocol list at all. A monitor of that kind either does not come back or comes back as a protocol this adapter reports as not migrated.",
    "There is no official export of monitor configuration.",
  ],
  async read(context: ReadContext): Promise<SourceSnapshot> {
    const token = requireCredential(context, "token", "The API key");
    const transport = transportFor(context, BASE, {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    });

    const listed = await transport.json<Json[]>("/v1/monitors");
    const summaries = (Array.isArray(listed) ? listed : []).map((row) =>
      obj(row),
    );

    const checks: SourceCheck[] = [];
    let merged = 0;
    for (const summary of summaries) {
      const uuid = str(summary.uuid);
      if (uuid === undefined) {
        checks.push(toCheck(summary));
        continue;
      }
      try {
        const detail = await transport.json<Json>(`/v1/monitors/${uuid}`);
        // The detail wins on every field it carries, and the list fills
        // the gaps: `paused` appears only in the list, `required_keyword`
        // only in the detail, and neither response is documented as
        // complete.
        checks.push(toCheck({ ...summary, ...obj(detail) }));
        merged += 1;
      } catch {
        checks.push(toCheck(summary));
      }
    }

    const extras: SourceExtra[] = [
      {
        kind: "alerting",
        sourceId: "escalation-policies",
        label: "Escalation policies",
        detail:
          "Hyperping monitors reference an escalation policy. Vigil has its own, and an imported monitor points at none of them until you attach one.",
      },
      {
        kind: "status-page",
        sourceId: "status-pages",
        label: "Status pages",
        detail:
          "Hyperping's status pages are a separate resource this adapter does not read. Create a Vigil status page and add the imported monitors to it.",
      },
    ];

    return {
      provider: "hyperping",
      facts: [
        `Hyperping API v1, ${summaries.length} monitor(s) listed, ${merged} re-read individually, ${transport.requestCount} request(s).`,
      ],
      checks,
      statusPages: [],
      extras,
    };
  },
};
