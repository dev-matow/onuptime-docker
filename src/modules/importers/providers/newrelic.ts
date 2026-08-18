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
 * New Relic Synthetics, read through two APIs because neither one is
 * enough.
 *
 * NerdGraph is New Relic's own recommendation and its documented read
 * for a synthetic monitor returns five fields: the entity's guid, its
 * name, its account, its type and its tags. `period`, `uri`, `locations`
 * and `advancedOptions` appear in New Relic's documentation only as
 * *mutation inputs*. There is no documented NerdGraph query that returns
 * a monitor's URL, so a NerdGraph-only importer could not tell you what
 * a single monitor watches.
 *
 * The Synthetics REST API v3 does return the configuration and is still
 * documented and live. It is also, in New Relic's own words,
 * deprecated: "REST APIs are deprecated. We recommend that you use
 * NerdGraph instead, as the new runtimes can only be managed by
 * NerdGraph." No end-of-life date has been announced for it, and the
 * one REST end-of-life New Relic has published covers a different API.
 * So this adapter reads configuration from v3 and says plainly that it
 * is reading a deprecated interface, because an importer that outlives
 * its source is a promise that quietly stops being kept.
 *
 * That leaves one hole worth closing rather than hiding: v3 documents
 * four monitor types, and New Relic has since added kinds that may not
 * appear in it at all. A v3-only read would therefore be silently
 * incomplete, which is the exact failure this whole feature exists to
 * prevent. So NerdGraph is still queried, for the one thing it does
 * answer well: the complete list of monitors. Anything the entity search
 * knows about and v3 did not return gets a report line naming it.
 *
 * The cross-check matches on name, because v3's identifier and the
 * entity guid are different namespaces and joining them costs a query
 * per monitor. Two monitors sharing a name are reported as one; the fact
 * line says how many of each were seen so the discrepancy is visible.
 */

const REGIONS: readonly { value: string; label: string }[] = [
  { value: "us", label: "United States (api.newrelic.com)" },
  { value: "eu", label: "Europe (api.eu.newrelic.com)" },
];

const NERDGRAPH: Readonly<Record<string, string>> = {
  us: "https://api.newrelic.com",
  eu: "https://api.eu.newrelic.com",
};

const SYNTHETICS: Readonly<Record<string, string>> = {
  us: "https://synthetics.newrelic.com/synthetics/api",
  eu: "https://synthetics.eu.newrelic.com/synthetics/api",
};

const CAPABILITIES: readonly ProviderCapability[] = [
  {
    sourceType: "SIMPLE",
    becomes: "http",
    note: "The URL, frequency and enabled state carry, and `validationString` becomes Vigil's body assertion. `verifySSL`, `bypassHEADRequest` and `treatRedirectAsFailure` are reported: Vigil always verifies certificates, always issues the method the monitor stores, and treats a redirect chain that ends in a good response as a pass.",
  },
  {
    sourceType: "BROWSER",
    becomes: null,
    note: "Not imported. New Relic renders the page in a real browser and judges what loads. Vigil's HTTP check fetches the document and nothing it references, so importing one as an HTTP monitor would claim to watch something it does not. Create an HTTP monitor by hand if fetching the page is enough.",
  },
  {
    sourceType: "SCRIPT_API",
    becomes: null,
    note: "Not imported. The monitor is a Node.js script that may make any number of requests in any order.",
  },
  {
    sourceType: "SCRIPT_BROWSER",
    becomes: null,
    note: "Not imported. The monitor is a Node.js script driving a real browser.",
  },
  {
    sourceType: "CERT_CHECK",
    becomes: null,
    note: "Not imported by this adapter. New Relic's certificate monitors are configured through NerdGraph, whose documented read does not return `domain` or `numberDaysToFailBeforeCertExpires`, and the Synthetics REST API does not list them. Vigil has a TLS expiry check: create one per domain.",
  },
  {
    sourceType: "STEP_MONITOR",
    becomes: null,
    note: "Not imported. The monitor is an ordered sequence of browser steps.",
  },
  {
    sourceType: "BROKEN_LINKS",
    becomes: null,
    note: "Not imported. The monitor crawls a page for broken links and Vigil has no crawler.",
  },
];

const MAPPED = new Map(CAPABILITIES.map((entry) => [entry.sourceType, entry]));

function toCheck(monitor: Record<string, Json>): SourceCheck {
  const sourceType = str(monitor.type)?.toUpperCase() ?? "unknown";
  const mapping = MAPPED.get(sourceType);
  const sourceId = str(monitor.id) ?? str(monitor.name) ?? "unknown";
  const name = str(monitor.name) ?? `New Relic monitor ${sourceId}`;
  const status = str(monitor.status)?.toUpperCase();
  const options = obj(monitor.options);

  const common = {
    sourceId,
    name,
    sourceType,
    // v3 documents exactly two values, ENABLED and DISABLED. MUTED was
    // removed in February 2024 and its two halves became monitor
    // downtimes, which stop execution, and muting rules, which stop
    // notifications; neither is on the monitor, so neither can be read
    // here. Anything that is not ENABLED is not running.
    paused: status !== undefined && status !== "ENABLED",
    // `frequency` is minutes.
    intervalSeconds:
      num(monitor.frequency) === undefined
        ? undefined
        : (num(monitor.frequency) ?? 0) * 60,
    regions: strs(monitor.locations),
  };

  if (mapping === undefined || mapping.becomes === null) {
    return {
      ...common,
      kind: "unsupported",
      target: {},
      unsupportedReason:
        mapping?.note ??
        `New Relic calls this a "${sourceType}" monitor, which is not a type this adapter was written against, so nothing can be promised about it.`,
    };
  }

  const losses: string[] = [];
  if (bool(options.verifySSL) === false) {
    losses.push(
      "New Relic was told not to verify the certificate. Vigil always verifies, so a monitor on a self-signed or expired certificate will read as down here.",
    );
  }
  if (bool(options.bypassHEADRequest) === true) {
    losses.push(
      "New Relic sent a HEAD request first and fell back to GET. Vigil issues one method, the one on the monitor, so this monitor arrives as a plain GET.",
    );
  }
  if (bool(options.treatRedirectAsFailure) === true) {
    losses.push(
      "New Relic treated a redirect as a failure. Vigil follows redirects one validated hop at a time and judges the final response, so a monitor that failed on a 301 will pass here if the destination answers.",
    );
  }
  if (num(monitor.slaThreshold) !== undefined) {
    losses.push(
      `New Relic scored this monitor against an Apdex threshold of ${num(monitor.slaThreshold)}s. Vigil marks a monitor degraded over its own response-time threshold instead.`,
    );
  }

  return {
    ...common,
    kind: "http",
    target: { url: str(monitor.uri) },
    http: {
      method: "GET",
      keyword: str(options.validationString),
    },
    losses,
  };
}

export const newRelicAdapter: ProviderAdapter = {
  id: "newrelic",
  label: "New Relic Synthetics",
  input: "api",
  docs: "https://docs.newrelic.com/docs/apis/synthetics-rest-api/monitor-examples/manage-synthetics-monitors-rest-api/",
  access:
    "A user key from New Relic, API keys. It must be a user key, whose value begins NRAK: a license key or a browser key is an ingest credential and will be refused. The key carries the same synthetic-monitoring permissions as the account it belongs to.",
  credentials: [
    {
      name: "region",
      label: "Data centre",
      help: "New Relic's regions are separate services with separate hostnames.",
      secret: false,
      required: true,
      choices: REGIONS,
    },
    {
      name: "apiKey",
      label: "User key",
      help: "Sent in the Api-Key header. It is used for this read and never stored.",
      secret: true,
      required: true,
    },
  ],
  capabilities: CAPABILITIES,
  limitations: [
    "New Relic publishes no NerdGraph query that returns a monitor's URL, period or options: those field names appear only in mutation inputs. Configuration is therefore read from the Synthetics REST API v3, which does return them.",
    "That REST API is deprecated. New Relic recommends NerdGraph instead and states that the newer runtimes can only be managed there. No end-of-life date has been announced, and the REST end-of-life New Relic has published covers a different API, so this path works today and is on notice.",
    "Monitor downtimes and muting rules are not on the monitor, so a monitor that New Relic is currently suppressing imports as running. Check the report against your downtime schedule.",
    "A key New Relic does not accept produces a redirect to its interactive login page rather than a 401, on both hosts. This importer reports that as a rejected token and does not follow the redirect, because the request carries your key.",
    "v3 documents four monitor types, and New Relic has added kinds since. This adapter cross-checks the v3 list against NerdGraph's entity search and reports every monitor the entity search knows about that v3 did not return, so an incomplete read is visible rather than silent.",
    "The cross-check matches on name, because a v3 monitor id and an entity guid are different namespaces. Two monitors sharing a name look like one to the cross-check; the counts on the report say how many of each were seen.",
    "Scripted monitors are Node.js. Their source can be read, and it cannot be translated into a check that makes one request, so they are reported as not migrated.",
    "Secure credentials cannot be read at all: New Relic documents that their values are not accessible through the API. Any script that used one is unmigratable for that reason alone.",
    "A simple monitor's only content assertion is a single validation string, so there is nothing richer to lose. There is also no HTTP method, header or body field to carry.",
    "The REST API allows three requests a second per account and NerdGraph limits concurrency rather than rate. This importer issues its requests one at a time.",
  ],
  async read(context: ReadContext): Promise<SourceSnapshot> {
    const region = requireCredential(context, "region", "The data centre");
    const apiKey = requireCredential(context, "apiKey", "The user key");
    const nerdgraph = NERDGRAPH[region];
    const synthetics = SYNTHETICS[region];
    if (nerdgraph === undefined || synthetics === undefined) {
      throw new Error(
        "That is not one of New Relic's published regions. Choose a data centre from the list.",
      );
    }

    const rest = transportFor(context, synthetics, {
      "Api-Key": apiKey,
      Accept: "application/json",
    });

    const monitors: Record<string, Json>[] = [];
    const pageSize = 100;
    let offset = 0;
    for (;;) {
      const response = await rest.json<{ monitors?: Json }>("/v3/monitors", {
        offset,
        limit: pageSize,
      });
      const page = arr(response.monitors).map((entry) => obj(entry));
      monitors.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
    }

    const checks = monitors.map((monitor) => toCheck(monitor));
    const readNames = new Set(
      monitors
        .map((monitor) => str(monitor.name)?.toLowerCase())
        .filter((name): name is string => name !== undefined),
    );

    // The completeness cross-check. It is allowed to fail: a key that
    // can read the Synthetics API but not NerdGraph should still produce
    // a migration, with a fact line saying the check did not run.
    const extras: SourceExtra[] = [];
    let entityCount: number | null = null;
    try {
      const graph = transportFor(context, nerdgraph, {
        "Api-Key": apiKey,
        Accept: "application/json",
      });
      let cursor: string | null = null;
      const entities: Record<string, Json>[] = [];
      for (;;) {
        const query = `{ actor { entitySearch(query: "domain = 'SYNTH' AND type = 'MONITOR'") { results${
          cursor === null ? "" : `(cursor: "${cursor}")`
        } { nextCursor entities { ... on SyntheticMonitorEntityOutline { guid name monitorType } } } } } }`;
        const response = await graph.post<{ data?: Json }>("/graphql", {
          query,
        });
        const results = obj(
          obj(obj(obj(obj(response.data).actor).entitySearch).results),
        );
        for (const entity of arr(results.entities)) {
          entities.push(obj(entity));
        }
        const next = str(results.nextCursor);
        if (next === undefined || next === cursor) break;
        cursor = next;
      }
      entityCount = entities.length;
      for (const entity of entities) {
        const name = str(entity.name);
        if (name === undefined || readNames.has(name.toLowerCase())) continue;
        extras.push({
          kind: "account",
          sourceId: str(entity.guid) ?? name,
          label: name,
          detail: `New Relic's entity search lists this as a "${str(entity.monitorType) ?? "unknown"}" monitor and the Synthetics REST API did not return it, so its configuration could not be read and it was not imported. New Relic publishes no query that returns a monitor's URL, so nothing else can be said about it here. Recreate it by hand.`,
        });
      }
    } catch {
      extras.push({
        kind: "account",
        sourceId: "completeness-check",
        label: "Completeness cross-check",
        detail:
          "The NerdGraph entity search, which this importer uses to notice monitors the Synthetics REST API does not return, could not be reached with this key. The migration below is what the REST API returned, and it may not be everything: check the monitor count against your New Relic account.",
      });
    }

    extras.push(
      {
        kind: "variable",
        sourceId: "secure-credentials",
        label: "Secure credentials",
        detail:
          "New Relic documents that a secure credential's value cannot be viewed through the API, so no importer can copy one. Any monitor that used one is unmigratable for that reason alone.",
      },
      {
        kind: "region",
        sourceId: "private-locations",
        label: "Private locations",
        detail:
          "A private location is a job manager inside your own network. A monitor assigned to one may be watching a target that is not reachable from where Vigil runs; enrol a Vigil remote probe in the same network for those.",
      },
    );

    return {
      provider: "newrelic",
      facts: [
        `New Relic Synthetics REST API v3 in the ${region.toUpperCase()} region, ${monitors.length} monitor(s), ${rest.requestCount} request(s).`,
        entityCount === null
          ? "The NerdGraph completeness cross-check did not run."
          : `NerdGraph's entity search reported ${entityCount} synthetic monitor(s) on this account.`,
      ],
      checks,
      statusPages: [],
      extras,
    };
  },
};
