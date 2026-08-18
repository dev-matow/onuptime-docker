import type { SourceCheck, SourceExtra, SourceSnapshot } from "../model";
import { hostOf, hostPort } from "../rewrite";

import {
  requireCredential,
  transportFor,
  type ProviderAdapter,
  type ProviderCapability,
  type ReadContext,
} from "./contract";
import { bool, keys, num, obj, str, strs, type Json } from "./json";

/**
 * updown.io, through its unversioned JSON API.
 *
 * The cheapest read of any provider here: `GET /api/checks` returns
 * every check with its whole configuration, there is no pagination and
 * there is no detail endpoint to follow. One request is the account.
 *
 * `string_match` is the field to be careful with. updown overloads one
 * column: a value of three digits between 100 and 599 is an expected
 * *status code*, and anything else is a body assertion. Reading it as
 * one or the other unconditionally gets half of an account's checks
 * wrong, so the shape decides, exactly as updown documents.
 *
 * Pulse checks are updown's heartbeats, and they carry a limitation
 * nothing can work around: the ingest URL is redacted from every GET, by
 * design. The monitor migrates, its endpoint cannot, and the job that
 * calls it has to be re-pointed by hand. That sentence is on every pulse
 * check's report line rather than in a footnote.
 */

const BASE = "https://updown.io/api";

const CAPABILITIES: readonly ProviderCapability[] = [
  {
    sourceType: "https",
    becomes: "http",
    note: "The URL, period, expected status code or body assertion and paused state carry. Custom headers and the request body do not: Vigil's HTTP check issues GET or HEAD with its own headers.",
  },
  {
    sourceType: "http",
    becomes: "http",
    note: "The same as an https check, over plain HTTP. Vigil stores the scheme the URL carries and does not upgrade it.",
  },
  {
    sourceType: "icmp",
    becomes: "ping",
    note: "The host carries. updown stores the target in the same `url` column as an HTTP check, so a scheme is stripped when one is present.",
  },
  {
    sourceType: "tcp",
    becomes: "tcp",
    note: "Host and port carry, read out of the `url` column. A check whose target carries no port is refused rather than given one.",
  },
  {
    sourceType: "tcps",
    becomes: "tcp",
    note: "Host and port carry. Vigil's TCP check opens a connection and does not negotiate TLS, so a check that was watching the handshake should be recreated as a TLS expiry monitor.",
  },
  {
    sourceType: "pulse",
    becomes: "push",
    note: "The expected period carries. updown redacts the pulse ingest URL from every read, by design, so the imported monitor gets a new token and the job that reports in must be pointed at it.",
  },
];

const MAPPED = new Map(CAPABILITIES.map((entry) => [entry.sourceType, entry]));

/** Whether `string_match` is holding a status code rather than a keyword. */
function isStatusCode(value: string): boolean {
  if (!/^\d{3}$/.test(value)) return false;
  const code = Number(value);
  return code >= 100 && code <= 599;
}

function toCheck(row: Record<string, Json>): SourceCheck {
  const sourceType = str(row.type)?.toLowerCase() ?? "unknown";
  const mapping = MAPPED.get(sourceType);
  const sourceId = str(row.token) ?? "unknown";
  const url = str(row.url);
  const name = str(row.alias) ?? url ?? `updown check ${sourceId}`;

  const common = {
    sourceId,
    name,
    sourceType,
    paused: bool(row.enabled) === false,
    intervalSeconds: num(row.period),
  };

  if (mapping === undefined || mapping.becomes === null) {
    return {
      ...common,
      kind: "unsupported",
      target: {},
      unsupportedReason:
        mapping?.note ??
        `updown calls this a "${sourceType}" check, which is not a type this adapter was written against, so nothing can be promised about it.`,
    };
  }

  const losses: string[] = [];
  const disabled = strs(row.disabled_locations);
  if (disabled.length > 0) {
    losses.push(
      `updown ran this check from every location except ${disabled.join(", ")}. Vigil checks from the worker that runs it, or from a remote probe you enrol, so the exclusion has nothing to apply to.`,
    );
  }
  if (str(row.mute_until) !== undefined) {
    losses.push(
      "The check was muted in updown. Vigil has no mute: pause the monitor, or leave it running and let its notification channel decide.",
    );
  }
  const apdex = num(row.apdex_t);
  if (apdex !== undefined) {
    losses.push(
      `updown scored this check against an Apdex threshold of ${apdex}s. Vigil marks a monitor degraded over its own response-time threshold instead, which is set per monitor and defaults to 3000ms.`,
    );
  }

  switch (sourceType) {
    case "icmp":
      return {
        ...common,
        kind: "ping",
        target: { host: url === undefined ? undefined : (hostOf(url) ?? url) },
        losses,
      };
    case "tcp":
    case "tcps": {
      const endpoint = url === undefined ? null : hostPort(url);
      return {
        ...common,
        kind: "tcp",
        target: {
          host: endpoint?.host,
          port: endpoint?.port ?? undefined,
        },
        losses,
      };
    }
    case "pulse":
      return {
        ...common,
        kind: "heartbeat",
        target: { label: name },
        heartbeat: { periodSeconds: num(row.period) },
        losses: [
          ...losses,
          "updown redacts a pulse check's ingest URL from every read, by design, so this monitor could not be given the endpoint the job already calls. Point the job at the endpoint on the Vigil monitor page.",
        ],
      };
    default: {
      const match = str(row.string_match);
      const verb = str(row.http_verb)?.toUpperCase();
      const headers = keys(row.custom_headers);
      return {
        ...common,
        kind: "http",
        target: { url },
        http: {
          // updown's default is the literal "GET/HEAD", which means it
          // may use either. Vigil has to pick one, and GET is the one
          // that can carry a body assertion.
          method: verb === undefined || verb === "GET/HEAD" ? "GET" : verb,
          acceptedStatus:
            match !== undefined && isStatusCode(match) ? [match] : undefined,
          keyword:
            match !== undefined && !isStatusCode(match) ? match : undefined,
          headerNames: headers.length > 0 ? headers : undefined,
          hasRequestBody: str(row.http_body) !== undefined,
        },
        losses,
      };
    }
  }
}

export const updownAdapter: ProviderAdapter = {
  id: "updown",
  label: "updown.io",
  input: "api",
  docs: "https://updown.io/api",
  access:
    "An API key from updown.io, Settings, API. A read-only key is enough and is the right choice: it works with every GET this importer issues. Note that a read-only key also strips credentials out of any check URL that carries them, which is a feature here.",
  credentials: [
    {
      name: "apiKey",
      label: "API key",
      help: "Sent in the X-API-KEY header. It is used for this read and never stored.",
      secret: true,
      required: true,
    },
  ],
  capabilities: CAPABILITIES,
  limitations: [
    "updown has no per-check timeout and no configurable retry policy, so imported monitors get Vigil's default timeout and its default failure window.",
    "A pulse check's ingest URL is redacted from every read, so a migrated heartbeat gets a new Vigil token and the reporting job has to be pointed at it.",
    "updown has no tags and no groups, so there is no structure to carry.",
    "Certificate and domain expiry are reported results rather than settings. updown warns on a fixed schedule set for the whole account, and there is nothing per check to import; create Vigil TLS expiry and domain expiry monitors if you relied on those warnings.",
    "updown documents no rate limit. This importer backs off on a 429 anyway.",
    "There is no official export of check configuration.",
  ],
  async read(context: ReadContext): Promise<SourceSnapshot> {
    const apiKey = requireCredential(context, "apiKey", "The API key");
    const transport = transportFor(context, BASE, {
      "X-API-KEY": apiKey,
      Accept: "application/json",
    });

    const rows = await transport.json<Json[]>("/checks");
    const checks = (Array.isArray(rows) ? rows : []).map((row) =>
      toCheck(obj(row)),
    );

    const extras: SourceExtra[] = [
      {
        kind: "alerting",
        sourceId: "recipients",
        label: "Alert recipients",
        detail:
          "updown attaches recipients to each check as opaque references. Vigil routes alerts by notification channel and escalation policy, which belong to the organisation rather than to the monitor, so there is no per-check attachment to recreate.",
      },
      {
        kind: "status-page",
        sourceId: "published-checks",
        label: "Published checks",
        detail:
          "updown publishes a check by setting `published` on it, and its status page is a property of the account. Vigil's status pages are their own records: create one and add the imported monitors to it.",
      },
    ];

    return {
      provider: "updown",
      facts: [`updown.io API, ${checks.length} check(s) in one request.`],
      checks,
      statusPages: [],
      extras,
    };
  },
};
