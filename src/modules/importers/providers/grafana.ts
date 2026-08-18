import type { SourceCheck, SourceExtra, SourceSnapshot } from "../model";
import { hostPort } from "../rewrite";

import {
  baseUrlFor,
  requireCredential,
  transportFor,
  type ProviderAdapter,
  type ProviderCapability,
  type ReadContext,
} from "./contract";
import { arr, bool, num, obj, str, strs, type Json } from "./json";

/**
 * Grafana Cloud Synthetic Monitoring, through its v1 API.
 *
 * Grafana runs the synthetic-monitoring API in twenty-seven regions and
 * the region is part of the hostname, with no published mapping from a
 * stack's region slug to the API host. Grafana's own instruction is to
 * read the backend address off the Config page, so this adapter asks for
 * it rather than guessing, and puts it through the same egress guard the
 * monitor targets go through.
 *
 * The trap here is enum representation. The published OpenAPI declares
 * `method`, `ipVersion`, `recordType` and `protocol` as **integers**,
 * while Grafana's own Go client shows them as strings, and the Terraform
 * provider takes names. Both forms are accepted below, because an
 * importer that read only one would silently turn every GET into a
 * CONNECT, or every A record into ANY.
 *
 * `frequency` and `timeout` are milliseconds, which is a third unit
 * again from the seconds and minutes the other providers use.
 */

const CAPABILITIES: readonly ProviderCapability[] = [
  {
    sourceType: "http",
    becomes: "http",
    note: "The URL, method, frequency, timeout and accepted status codes carry. Grafana's four regular-expression assertion families, on the body and on headers, in both the matching and the not-matching direction, are reported rather than approximated: collapsing a negated regular expression into a substring assertion changes what the check means.",
  },
  {
    sourceType: "ping",
    becomes: "ping",
    note: "The host carries. The packet count, payload size and do-not-fragment flag do not.",
  },
  {
    sourceType: "tcp",
    becomes: "tcp",
    note: "Host and port carry, read out of the target string. Grafana's send and expect banners, which are base64, do not: Vigil's TCP check judges whether the connection opens.",
  },
  {
    sourceType: "dns",
    becomes: "dns",
    note: "The name and the record type carry, in either the integer or the string form Grafana uses. The nameserver, the transport and the per-section resource-record assertions do not: Vigil resolves through the worker's own resolver and asserts that a record contains a value.",
  },
  {
    sourceType: "grpc",
    becomes: "grpc",
    note: "Host, port and the TLS setting carry. Vigil calls the standard gRPC health service.",
  },
  {
    sourceType: "traceroute",
    becomes: null,
    note: "Not imported. Vigil has no traceroute check: it watches whether a service answers rather than the path taken to it.",
  },
  {
    sourceType: "scripted",
    becomes: null,
    note: "Not imported. The check is a base64 k6 script, which is arbitrary code, and downgrading it to a GET of its target would claim to watch something it never watched.",
  },
  {
    sourceType: "browser",
    becomes: null,
    note: "Not imported. The check is a base64 k6 browser script.",
  },
  {
    sourceType: "multihttp",
    becomes: null,
    note: "Not imported. The check chains requests and extracts values from one response into the next.",
  },
];

const MAPPED = new Map(CAPABILITIES.map((entry) => [entry.sourceType, entry]));

/** Grafana's HTTP methods, by the integer the protobuf assigns. */
const METHODS = [
  "GET",
  "CONNECT",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "TRACE",
  "PATCH",
] as const;

/** Grafana's DNS record types, by the integer the protobuf assigns. */
const RECORD_TYPES = [
  "ANY",
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "NS",
  "PTR",
  "SOA",
  "SRV",
  "TXT",
] as const;

/**
 * An enum that may arrive as a name or as its ordinal.
 *
 * Both forms are real: the OpenAPI document says integer and Grafana's
 * own client example says string. Reading one and not the other turns
 * every GET into a CONNECT the day the other form is served.
 */
function enumName(value: Json, names: readonly string[]): string | undefined {
  const text = str(value);
  if (text !== undefined && !/^\d+$/.test(text)) return text.toUpperCase();
  const ordinal = num(value);
  if (ordinal === undefined) return undefined;
  return names[ordinal];
}

function toCheck(row: Record<string, Json>): SourceCheck {
  const settings = obj(row.settings);
  // The nine check kinds are siblings on one object and every one of
  // them is nullable, so a response may carry all nine keys with eight
  // of them null. Picking the first key that merely *exists* would type
  // an HTTP check as `browser` on any deployment that serialises nulls,
  // which is a monitor of the wrong kind rather than a missing one. The
  // kind is the key whose value is actually an object.
  const sourceType =
    Object.keys(settings).find(
      (key) =>
        MAPPED.has(key) &&
        settings[key] !== null &&
        settings[key] !== undefined &&
        typeof settings[key] === "object",
    ) ?? "unknown";
  const mapping = MAPPED.get(sourceType);
  const sourceId = str(row.id) ?? "unknown";
  const job = str(row.job);
  const target = str(row.target);
  const name = job ?? target ?? `Grafana check ${sourceId}`;

  const common = {
    sourceId,
    name,
    sourceType,
    paused: bool(row.enabled) === false,
    // Milliseconds, unlike everyone else's seconds or minutes.
    intervalSeconds:
      num(row.frequency) === undefined
        ? undefined
        : Math.round((num(row.frequency) ?? 0) / 1000),
    timeoutMs: num(row.timeout),
    tags: arr(row.labels)
      .map((label) => {
        const entry = obj(label);
        const key = str(entry.name);
        const value = str(entry.value);
        return key === undefined ? undefined : `${key}:${value ?? ""}`;
      })
      .filter((label): label is string => label !== undefined),
    regions: arr(row.probes).map((probe) => `probe ${String(probe)}`),
  };

  if (mapping === undefined || mapping.becomes === null) {
    return {
      ...common,
      kind: "unsupported",
      target: {},
      unsupportedReason:
        mapping?.note ??
        `Grafana calls this a "${sourceType}" check, which is not a type this adapter was written against, so nothing can be promised about it.`,
    };
  }

  const losses: string[] = [];
  const withheld: string[] = [];
  const detail = obj(settings[sourceType]);

  switch (sourceType) {
    case "ping":
      return { ...common, kind: "ping", target: { host: target }, losses };
    case "tcp": {
      const endpoint = target === undefined ? null : hostPort(target);
      if (arr(detail.queryResponse).length > 0) {
        losses.push(
          "The banners Grafana sent and expected on this connection were not carried: Vigil's TCP check judges whether the connection opens.",
        );
      }
      return {
        ...common,
        kind: "tcp",
        target: { host: endpoint?.host, port: endpoint?.port ?? undefined },
        losses,
      };
    }
    case "grpc": {
      const endpoint = target === undefined ? null : hostPort(target);
      return {
        ...common,
        kind: "grpc",
        target: { host: endpoint?.host, port: endpoint?.port ?? undefined },
        losses,
      };
    }
    case "dns": {
      if (str(detail.server) !== undefined) {
        losses.push(
          `The nameserver ${str(detail.server)} was not carried: Vigil resolves through the worker's own resolver, so the answer this monitor judges is the answer your infrastructure gets.`,
        );
      }
      for (const section of [
        "validateAnswerRRS",
        "validateAuthorityRRS",
        "validateAdditionalRRS",
      ]) {
        if (Object.keys(obj(detail[section])).length > 0) {
          losses.push(
            `The regular-expression assertions on the DNS ${section.replace("validate", "").replace("RRS", "")} section were not carried: Vigil asserts that at least one record of the named type contains a value.`,
          );
        }
      }
      return {
        ...common,
        kind: "dns",
        target: { host: target },
        dns: { recordType: enumName(detail.recordType, RECORD_TYPES) },
        losses,
      };
    }
    default: {
      const headerNames = strs(detail.headers).map(
        (header) => header.split(":")[0]?.trim() ?? header,
      );
      for (const family of [
        ["failIfBodyMatchesRegexp", "the body matching a pattern"],
        ["failIfBodyNotMatchesRegexp", "the body not matching a pattern"],
        ["failIfHeaderMatchesRegexp", "a header matching a pattern"],
        ["failIfHeaderNotMatchesRegexp", "a header not matching a pattern"],
      ] as const) {
        const rules = arr(detail[family[0]]).length;
        if (rules > 0) {
          losses.push(
            `${rules} assertion(s) on ${family[1]} were not carried: Vigil's body assertion is a substring rather than a regular expression, and collapsing a negated pattern into one would change what this check means.`,
          );
        }
      }
      if (str(detail.bearerToken) !== undefined) {
        withheld.push("the bearer token this check sends");
      }
      if (str(obj(detail.basicAuth).username) !== undefined) {
        withheld.push("the password this check authenticates with");
      }
      if (str(obj(detail.oauth2Config).clientId) !== undefined) {
        withheld.push("the OAuth2 client secret this check exchanges");
      }
      if (str(detail.proxyURL) !== undefined) {
        losses.push(
          "The outbound proxy was not carried: Vigil's checks go out from the worker, or from a remote probe you enrol, and have no per-monitor proxy.",
        );
      }
      const statuses = arr(detail.validStatusCodes)
        .map((code) => num(code))
        .filter((code): code is number => code !== undefined)
        .map((code) => String(code));
      return {
        ...common,
        kind: "http",
        target: { url: target },
        http: {
          method: enumName(detail.method, METHODS),
          acceptedStatus: statuses.length > 0 ? statuses : undefined,
          headerNames: headerNames.length > 0 ? headerNames : undefined,
          hasRequestBody: str(detail.body) !== undefined,
          hasBasicAuth: str(obj(detail.basicAuth).username) !== undefined,
          followRedirects:
            bool(detail.noFollowRedirects) === undefined
              ? undefined
              : bool(detail.noFollowRedirects) === false,
        },
        losses,
        withheld,
      };
    }
  }
}

export const grafanaAdapter: ProviderAdapter = {
  id: "grafana",
  label: "Grafana Cloud Synthetic Monitoring",
  input: "api",
  docs: "https://grafana.com/docs/grafana-cloud/testing/synthetic-monitoring/api-reference/",
  access:
    "A Synthetic Monitoring access token, from Testing and synthetics, Synthetics, Config, Access tokens, Generate access token. Read the backend address off the same Config page: Grafana runs this API in twenty-seven regions and publishes no mapping from a stack to its host, so it has to be told.",
  credentials: [
    {
      name: "baseUrl",
      label: "Backend address",
      help: "From the Synthetics Config page, for example https://synthetic-monitoring-api-eu-west.grafana.net.",
      secret: false,
      required: true,
    },
    {
      name: "token",
      label: "Access token",
      help: "Sent as a bearer token. It is used for this read and never stored.",
      secret: true,
      required: true,
    },
  ],
  capabilities: CAPABILITIES,
  limitations: [
    "The backend address is per region and Grafana publishes no mapping from a stack to it, so it must be copied from the Synthetics Config page. It is validated as an https host that is not in a range this product refuses to reach.",
    "Grafana's published schema declares its enumerations as integers while its own client library shows them as strings. This adapter reads both, because reading one would turn every GET into a CONNECT the day the other form is served.",
    "The `scripted`, `browser` and `multihttp` check types are k6 scripts or chained requests. They are reported as not migrated rather than downgraded to a plain request against the same target.",
    "Grafana's HTTP assertions are four families of regular expressions, in both the matching and not-matching direction, plus per-section DNS resource-record assertions. Vigil's body assertion is a substring, so these are reported rather than approximated.",
    "Whether a read echoes back a stored bearer token, basic-auth password or OAuth2 client secret is not documented either way. This adapter never reads those fields' values in the first place.",
    "Grafana documents no rate limit for this API. This importer backs off on a 429 anyway.",
  ],
  async read(context: ReadContext): Promise<SourceSnapshot> {
    const token = requireCredential(context, "token", "The access token");
    const base = baseUrlFor(
      requireCredential(context, "baseUrl", "The backend address"),
      "The backend address",
    );
    const transport = transportFor(
      context,
      base,
      { Authorization: `Bearer ${token}`, Accept: "application/json" },
      // The backend address is typed by the operator, so every request
      // goes through the egress guard rather than straight to fetch.
      { guarded: true },
    );

    // Pagination is opt-in: without `page_size` the response is a bare
    // array of every check, which is the shape Grafana calls legacy and
    // still serves. Asked for plainly, because a tenant's whole check
    // list is small and one request cannot half-succeed.
    const rows = await transport.json<Json>("/api/v1/check");
    const list = Array.isArray(rows) ? rows : arr(obj(rows).items);
    const checks = list.map((row) => toCheck(obj(row)));

    const extras: SourceExtra[] = [
      {
        kind: "region",
        sourceId: "probes",
        label: "Probes",
        detail:
          "A Grafana check names the probes that run it by numeric id, including private probes inside your own network. Vigil checks from the worker that runs it, or from a remote probe you enrol; a check that ran only from a private probe may be watching a target Vigil cannot reach until you enrol one there.",
      },
      {
        kind: "alerting",
        sourceId: "alert-sensitivity",
        label: "Alert sensitivity and alert rules",
        detail:
          "Grafana expresses alerting as a sensitivity level that feeds Prometheus alert rules in your stack. Vigil opens an incident when a monitor has been failing for its failure window and routes by escalation policy, so the sensitivity does not transfer.",
      },
    ];

    return {
      provider: "grafana",
      facts: [
        `Grafana Synthetic Monitoring API v1 at ${base}, ${checks.length} check(s) in one request.`,
      ],
      checks,
      statusPages: [],
      extras,
    };
  },
};
