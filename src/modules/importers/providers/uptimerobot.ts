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
 * UptimeRobot, through the v3 REST API.
 *
 * The cheapest of the supported providers to read: `GET /monitors`
 * returns the same object the single-monitor endpoint does, so one
 * cursor sweep is the whole account and a thousand monitors cost five
 * requests rather than a thousand and one.
 *
 * Two decisions in here are worth defending because both look like
 * missing features until you read why.
 *
 * **DNS monitors are not imported.** UptimeRobot keeps the expected
 * answers in `config.dnsRecords`, keyed by record type, which maps onto
 * Vigil's DNS check exactly. What it does not publish is which field
 * holds the *name being resolved*: the v3 schema describes `url` on a
 * DNS monitor as the DNS server. A Vigil DNS monitor built on that
 * reading would resolve the resolver, go green, and watch nothing. So
 * the type is reported unsupported with that sentence, which is a worse
 * migration and an honest one.
 *
 * **API monitors keep their assertions as prose.** `config.apiAssertions`
 * is `{property, comparison, target}`, and the syntax of `property` is
 * not published. Reading it as a JSON path would be a guess that
 * silently changes what the check asserts, so the assertions are carried
 * into the report as text and the monitor arrives watching availability.
 */

const BASE = "https://api.uptimerobot.com/v3";

/** Every type v3 stores, and what this adapter does with it. */
const CAPABILITIES = [
  {
    sourceType: "HTTP",
    becomes: "http",
    note: "URL, interval, timeout, method, accepted status codes, redirect setting and certificate expiry warning carry. Headers, request body and authentication do not: Vigil's HTTP check sends GET or HEAD with its own headers.",
  },
  {
    sourceType: "KEYWORD",
    becomes: "http",
    note: "The same as an HTTP monitor, plus the keyword and its inversion: `ALERT_NOT_EXISTS` becomes Vigil's keywordAbsent. Case sensitivity does not carry; Vigil's body assertion is always case sensitive.",
  },
  { sourceType: "PING", becomes: "ping", note: "Imported unchanged." },
  {
    sourceType: "PORT",
    becomes: "tcp",
    note: "Host and port carry. Same check under a different name: open a TCP connection.",
  },
  {
    sourceType: "UDP",
    becomes: null,
    note: "Not imported. Vigil's UDP check has to send the payload the service replies to, because UDP answers nothing it was not asked, and this importer does not copy request payloads out of a monitoring account. An imported UDP monitor would send an empty datagram and report a permanent outage, so it is refused instead. Recreate it in Vigil, where the payload and the expected reply are settings on the check.",
  },
  {
    sourceType: "HEARTBEAT",
    becomes: "push",
    note: "The expected period and grace period carry. A new token is generated, because a token authenticates one caller to one monitor, so the reporting job has to be pointed at the new endpoint.",
  },
  {
    sourceType: "API",
    becomes: "http",
    note: "Imported as an availability check. `config.apiAssertions` compares a `property` whose syntax UptimeRobot does not publish, so the assertions are reported rather than rebuilt: a misread path is an assertion that passes on the wrong thing.",
  },
  {
    sourceType: "DNS",
    becomes: null,
    note: "Not imported. The expected answers are in `config.dnsRecords`, but the published schema describes `url` on a DNS monitor as the DNS server and names no field for the record being looked up. A monitor built on a guess would resolve the resolver and go green watching nothing.",
  },
  {
    sourceType: "VISUAL_COMPARISON",
    becomes: null,
    note: "Not imported. The check compares a screenshot against a baseline image stored in the UptimeRobot account, and Vigil has no check that renders a page and diffs it.",
  },
] as const;

const MAPPED = new Map<string, ProviderCapability>(
  CAPABILITIES.map((entry) => [entry.sourceType, entry]),
);

/**
 * Whether a monitor is paused, in either encoding UptimeRobot might use.
 *
 * The v3 schema declares `status` as an empty object: no type, no enum,
 * no description. It is `required`, so it is always there, and nothing
 * published says whether it comes back as `"PAUSED"` or as the integer
 * v2 used, where `0` was paused and everything above it was a running
 * monitor. Reading only the string would import every paused monitor as
 * active on an account that answers with numbers, and an imported
 * monitor that runs when it should not is unwanted traffic against the
 * customer's endpoints and unwanted pages for their team.
 *
 * So both are read. An unrecognised value is treated as running, which
 * is what the field being absent has always meant.
 */
function statusIsPaused(value: Json): boolean {
  if (typeof value === "number") return value === 0;
  return str(value)?.toUpperCase() === "PAUSED";
}

/** Seconds on the wire, milliseconds in the model. */
function timeoutMsFrom(value: Json): number | undefined {
  const seconds = num(value);
  return seconds === undefined || seconds <= 0 ? undefined : seconds * 1000;
}

/**
 * The status expression, unless it is UptimeRobot's own default.
 *
 * `["2xx","3xx"]` is what a monitor nobody configured comes back with,
 * and it is exactly what Vigil means by no expectation, so reporting it
 * as a loss on every check would bury the checks that did narrow it.
 */
function acceptedStatusFrom(value: Json): string[] | undefined {
  const codes = strs(value);
  if (codes.length === 0) return undefined;
  const normalised = [...codes].map((code) => code.toLowerCase()).sort();
  if (normalised.join(",") === "2xx,3xx") return undefined;
  return codes;
}

function toCheck(
  row: Record<string, Json>,
  groupNames: ReadonlyMap<string, string>,
): SourceCheck {
  const sourceType = str(row.type) ?? "unknown";
  const mapping = MAPPED.get(
    sourceType as (typeof CAPABILITIES)[number]["sourceType"],
  );
  const sourceId = str(row.id) ?? str(row.friendlyName) ?? "unknown";
  const name = str(row.friendlyName) ?? `UptimeRobot monitor ${sourceId}`;
  const paused = statusIsPaused(row.status);
  const config = obj(row.config);
  const groupId = str(row.groupId);
  const groupName = groupId === undefined ? undefined : groupNames.get(groupId);

  const common = {
    sourceId,
    name,
    sourceType,
    paused,
    intervalSeconds: num(row.interval),
    timeoutMs: timeoutMsFrom(row.timeout),
    tags: arr(row.tags)
      .map((tag) => str(obj(tag).name))
      .filter((tag): tag is string => tag !== undefined),
    groupPath: groupName === undefined ? undefined : [groupName],
    regions: strs(obj(row.regionalData).REGION),
    retries:
      num(config.applicationErrorRetries) === undefined
        ? undefined
        : { count: num(config.applicationErrorRetries) },
  };

  if (mapping === undefined || mapping.becomes === null) {
    return {
      ...common,
      kind: "unsupported",
      target: {},
      unsupportedReason:
        mapping?.note ??
        `UptimeRobot calls this a "${sourceType}" monitor, which is not a type this adapter was written against, so nothing can be promised about it.`,
    };
  }

  const losses: string[] = [];
  const withheld: string[] = [];
  const headerNames = keys(row.customHttpHeaders);
  const authType = str(row.authType)?.toUpperCase();
  if (authType !== undefined && authType !== "NONE") {
    withheld.push(`the ${authType} credential this monitor authenticates with`);
  }
  if (bool(row.domainExpirationReminder) === true) {
    losses.push(
      "UptimeRobot also warned when the domain registration was about to expire. Vigil expresses that as its own domain-expiry check rather than as a flag on an HTTP monitor, and this importer will not invent a second monitor: create a domain-expiry monitor for this host if you relied on the warning.",
    );
  }

  const httpish: SourceCheck["http"] = {
    method: str(row.httpMethodType),
    acceptedStatus: acceptedStatusFrom(row.successHttpResponseCodes),
    headerNames: headerNames.length > 0 ? headerNames : undefined,
    hasRequestBody:
      row.postValueData !== null && row.postValueData !== undefined,
    hasBasicAuth: authType === "HTTP_BASIC" || authType === "DIGEST",
    followRedirects: bool(row.followRedirections),
    checkCertificateExpiry: bool(row.sslExpirationReminder),
    certificateWarnDays: num(arr(config.sslExpirationPeriodDays)[0]),
  };

  switch (sourceType) {
    case "KEYWORD": {
      const keyword = str(row.keywordValue);
      const keywordType = str(row.keywordType)?.toUpperCase();
      if (str(row.keywordCaseType) !== undefined) {
        losses.push(
          "The keyword's case sensitivity setting was not carried: Vigil's body assertion always compares exactly.",
        );
      }
      return {
        ...common,
        kind: "http",
        target: { url: str(row.url) },
        http: {
          ...httpish,
          keyword,
          keywordAbsent: keywordType === "ALERT_NOT_EXISTS",
        },
        losses,
        withheld,
      };
    }
    case "HTTP":
      return {
        ...common,
        kind: "http",
        target: { url: str(row.url) },
        http: httpish,
        losses,
        withheld,
      };
    case "API": {
      const assertions = obj(config.apiAssertions);
      const wording = arr(assertions.checks).map((entry) => {
        const check = obj(entry);
        return `UptimeRobot asserted that "${str(check.property) ?? "a property"}" ${str(check.comparison) ?? "matches"} "${str(check.target) ?? ""}". The syntax of an assertion property is not published, so rebuilding it here would risk asserting the wrong thing.`;
      });
      return {
        ...common,
        kind: "http",
        target: { url: str(row.url) },
        http: { ...httpish, otherAssertions: wording },
        losses,
        withheld,
      };
    }
    case "PING":
      return {
        ...common,
        kind: "ping",
        target: { host: str(row.url) },
        losses,
        withheld,
      };
    case "PORT":
      return {
        ...common,
        kind: "tcp",
        target: { host: str(row.url), port: num(row.port) },
        losses,
        withheld,
      };
    default:
      return {
        ...common,
        kind: "heartbeat",
        target: { label: name },
        heartbeat: {
          periodSeconds: num(row.interval),
          graceSeconds: num(row.gracePeriod),
        },
        losses,
        withheld,
      };
  }
}

export const uptimeRobotAdapter: ProviderAdapter = {
  id: "uptimerobot",
  label: "UptimeRobot",
  input: "api",
  docs: "https://uptimerobot.com/api/v3/",
  access:
    "An API token from Integrations, API in the UptimeRobot dashboard. A read-only token is enough: this importer only issues GET requests. The free plan is limited to 10 API requests a minute, which this importer respects by backing off rather than failing.",
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
    "UptimeRobot never returns the password of a monitor that authenticates, so a monitor behind HTTP authentication imports as an unauthenticated check and will report an outage until you point it at an endpoint that answers without credentials.",
    "Maintenance windows, alert contacts and public status pages are account-level records this adapter reports rather than imports.",
    "There is no official export of monitor configuration. The CSV UptimeRobot offers is the event log.",
    "UptimeRobot's v3 schema declares the response `status` and `type` fields as empty objects, with no type and no enumeration, so nothing published says how they are encoded. This adapter reads the documented string names and the integer form v2 used for `status`; a monitor whose type comes back in some other encoding is reported as not migrated rather than guessed at.",
  ],
  async read(context: ReadContext): Promise<SourceSnapshot> {
    const token = requireCredential(context, "token", "The API token");
    const transport = transportFor(context, BASE, {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    });

    const groupNames = new Map<string, string>();
    try {
      const response = await transport.json<{ data?: Json }>("/monitor-groups");
      for (const entry of arr(response.data)) {
        const group = obj(entry);
        const id = str(group.id);
        const name = str(group.name);
        if (id !== undefined && name !== undefined) groupNames.set(id, name);
      }
    } catch {
      // A token without access to groups is still a token that can read
      // monitors. The group becomes a missing folder, not a failed
      // migration, and the fact below says so.
    }

    const checks: SourceCheck[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const response = await transport.json<{ data?: Json; nextLink?: Json }>(
        "/monitors",
        cursor === undefined ? { limit: 200 } : { limit: 200, cursor },
      );
      pages += 1;
      for (const row of arr(response.data)) {
        checks.push(toCheck(obj(row), groupNames));
      }
      const next = str(response.nextLink);
      if (next === undefined) break;
      const parsed = new URL(next).searchParams.get("cursor");
      if (parsed === null || parsed === cursor) break;
      cursor = parsed;
    }

    const extras: SourceExtra[] = [
      {
        kind: "alerting",
        sourceId: "alert-contacts",
        label: "Alert contacts and escalation",
        detail:
          "UptimeRobot attaches alert contacts to individual monitors. Vigil decides who is told by escalation policy and notification channel, which are properties of the organisation rather than of the monitor, so there is no per-monitor attachment to recreate. Set up channels under Settings, Notifications.",
      },
      {
        kind: "maintenance",
        sourceId: "maintenance-windows",
        label: "Maintenance windows",
        detail:
          "Not carried. Vigil has maintenance windows of its own, but this importer does not create them: the schedules do not translate field for field, and a window imported approximately is a window that silences the wrong hours. Recreate them under Settings, Maintenance.",
      },
    ];
    if (groupNames.size === 0) {
      extras.push({
        kind: "account",
        sourceId: "monitor-groups",
        label: "Monitor groups",
        detail:
          "No monitor groups were read from this account, either because there are none or because the token cannot see them. Any monitor that belonged to a group arrives without one.",
      });
    }

    return {
      provider: "uptimerobot",
      facts: [
        `UptimeRobot API v3, ${checks.length} monitor(s) over ${pages} page(s), ${transport.requestCount} request(s).`,
        `${groupNames.size} monitor group(s) read.`,
      ],
      checks,
      statusPages: [],
      extras,
    };
  },
};
