// @covers-type: elasticsearch
import http from "node:http";

import { afterAll, describe, expect, it } from "vitest";

import { judgeMeasurement } from "@/modules/monitors/check";
import { SECRET_MASK, redactConfig } from "@/modules/monitors/types/config";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import {
  authorizationHeader,
  clusterHealthUrl,
  elasticsearchProbe,
  healthFacts,
} from "@/modules/monitors/types/probes/elasticsearch";
import {
  elasticsearchSpec,
  elasticsearchStoredSchema,
  type ElasticsearchConfig,
} from "@/modules/monitors/types/specs/elasticsearch";

import { privateLookup } from "../probe-lookup";

/**
 * Elasticsearch, checked against an HTTP server that answers on the
 * real path with real health documents.
 *
 * A stubbed `fetch` would prove the parsing and nothing else. What is
 * only visible against a server is the half that matters here: that the
 * probe asks `_cluster/health` *under* whatever path the cluster is
 * published on, and that the credential travels as an `Authorization`
 * header rather than in the URL where an export would carry it.
 */

/** A green three-node cluster, in the shape the API answers with. */
const GREEN = {
  cluster_name: "vigil-search",
  status: "green",
  timed_out: false,
  number_of_nodes: 3,
  number_of_data_nodes: 3,
  active_primary_shards: 10,
  active_shards: 20,
  relocating_shards: 0,
  initializing_shards: 0,
  unassigned_shards: 0,
  active_shards_percent_as_number: 100.0,
};

const YELLOW = {
  ...GREEN,
  status: "yellow",
  number_of_nodes: 1,
  number_of_data_nodes: 1,
  active_shards: 10,
  unassigned_shards: 10,
  active_shards_percent_as_number: 66.66666666666667,
};

const RED = {
  ...GREEN,
  status: "red",
  active_primary_shards: 8,
  active_shards: 16,
  unassigned_shards: 4,
  active_shards_percent_as_number: 80,
};

interface Received {
  url: string | undefined;
  authorization: string | undefined;
  accept: string | undefined;
}

interface FakeCluster {
  origin: string;
  received: Received[];
  close: () => Promise<void>;
}

const servers: FakeCluster[] = [];
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface FakeClusterOptions {
  status?: number;
  /** The response body. An object is serialised; a string is sent as-is. */
  body?: unknown;
  contentType?: string;
  /** Accept the request and never answer it. */
  mute?: boolean;
}

async function openCluster(
  options: FakeClusterOptions = {},
): Promise<FakeCluster> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    received.push({
      url: request.url,
      authorization: request.headers.authorization,
      accept: request.headers.accept,
    });
    // Drained even when nothing is answered: a request nobody reads
    // keeps its socket open, and `server.close()` then waits for it for
    // ever.
    request.resume();
    if (options.mute) return;
    const body =
      typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body ?? GREEN);
    response.writeHead(options.status ?? 200, {
      "content-type": options.contentType ?? "application/json",
    });
    response.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const entry: FakeCluster = {
    origin: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  servers.push(entry);
  return entry;
}

function config(
  overrides: Partial<ElasticsearchConfig> = {},
): ElasticsearchConfig {
  return {
    username: null,
    password: null,
    apiKey: null,
    minimumStatus: "green",
    degradedThresholdMs: 3_000,
    ...overrides,
  };
}

function context(
  target: string,
  overrides: Partial<ProbeContext<ElasticsearchConfig>> = {},
): ProbeContext<ElasticsearchConfig> {
  return {
    target,
    port: null,
    config: config(),
    timeoutMs: 2_000,
    allowPrivateTargets: true,
    // The global, so `egressFetch` uses its own address-pinned client —
    // the one production runs. An injected transport would skip the
    // half of the guard that decides which address is dialled.
    fetchImpl: fetch,
    ...overrides,
  };
}

/** The probe, judged the way the runner judges it. */
async function check(
  ctx: ProbeContext<ElasticsearchConfig>,
): Promise<ReturnType<typeof judgeMeasurement<ElasticsearchConfig>>> {
  const result = await elasticsearchProbe(ctx);
  return judgeMeasurement(elasticsearchSpec.assertions, ctx.config, result);
}

describe("the elasticsearch probe", () => {
  it("reports the colour and the shard counts a healthy cluster answers with", async () => {
    const cluster = await openCluster();
    const outcome = await check(context(cluster.origin));

    expect(outcome.verdict).toBe("up");
    expect(outcome.facts).toMatchObject({
      statusCode: 200,
      clusterStatus: "green",
      clusterName: "vigil-search",
      nodeCount: 3,
      unassignedShards: 0,
      activeShardsPercent: 100,
    });
    expect(cluster.received[0]?.url).toBe("/_cluster/health");
  });

  it("asks for cluster health underneath the path the cluster is published on", async () => {
    // `new URL("_cluster/health", base)` would replace the last segment
    // and ask `/_cluster/health` — a 404 from somebody else's
    // application, reported as an Elasticsearch outage.
    const cluster = await openCluster();
    await check(context(`${cluster.origin}/search`));

    expect(cluster.received[0]?.url).toBe("/search/_cluster/health");
  });

  it("sends an API key as a header, never as part of the URL", async () => {
    const cluster = await openCluster();
    await check(
      context(cluster.origin, {
        config: config({ apiKey: "a2V5OnNlY3JldA==" }),
      }),
    );

    expect(cluster.received[0]?.authorization).toBe("ApiKey a2V5OnNlY3JldA==");
    expect(cluster.received[0]?.url).not.toContain("a2V5");
  });

  it("sends a username and password as HTTP basic credentials", async () => {
    const cluster = await openCluster();
    await check(
      context(cluster.origin, {
        config: config({ username: "elastic", password: "hunter2" }),
      }),
    );

    const expected = Buffer.from("elastic:hunter2").toString("base64");
    expect(cluster.received[0]?.authorization).toBe(`Basic ${expected}`);
  });

  it("calls a yellow cluster degraded when the operator asked for green", async () => {
    const cluster = await openCluster({ body: YELLOW });
    const outcome = await check(context(cluster.origin));

    expect(outcome.verdict).toBe("degraded");
    // Degraded is still passing: amber on the dashboard, no incident,
    // nobody woken for a replica that is only unassigned.
    expect(outcome.ok).toBe(true);
    expect(outcome.error).toContain("yellow");
    expect(outcome.failedAssertions).toEqual(["cluster-degraded"]);
    expect(outcome.facts.activeShardsPercent).toBe(66.7);
  });

  it("calls a yellow cluster healthy when the operator said yellow is enough", async () => {
    // A single-node cluster is permanently yellow: it has replicas
    // configured and nowhere to put them. Amber for ever is how a team
    // learns to ignore amber.
    const cluster = await openCluster({ body: YELLOW });
    const outcome = await check(
      context(cluster.origin, { config: config({ minimumStatus: "yellow" }) }),
    );

    expect(outcome.verdict).toBe("up");
    expect(outcome.facts.clusterStatus).toBe("yellow");
  });

  it("calls a red cluster down whatever the operator considers healthy", async () => {
    const cluster = await openCluster({ body: RED });
    const outcome = await check(
      context(cluster.origin, { config: config({ minimumStatus: "yellow" }) }),
    );

    expect(outcome.verdict).toBe("down");
    expect(outcome.failureClass).toBe("assertion");
    expect(outcome.error).toContain("red");
    expect(outcome.facts.unassignedShards).toBe(4);
  });

  it("refuses to pass a colour Elasticsearch does not define", async () => {
    // Treating an unknown value as healthy is how a monitor ends up
    // green because the field it reads was renamed.
    const cluster = await openCluster({
      body: { ...GREEN, status: "chartreuse" },
    });
    const outcome = await check(context(cluster.origin));

    expect(outcome.verdict).toBe("down");
    expect(outcome.error).toContain("chartreuse");
  });

  it("reports a refused credential as misconfigured, never as down", async () => {
    const cluster = await openCluster({
      status: 401,
      body: { error: "security_exception" },
    });
    const outcome = await check(context(cluster.origin));

    expect(outcome.verdict).toBe("indeterminate");
    expect(outcome.failureClass).toBe("misconfigured");
    expect(outcome.error).toContain("401");
  });

  it("names the privilege the credential is missing when the cluster answers 403", async () => {
    const cluster = await openCluster({
      status: 403,
      body: { error: "denied" },
    });
    const outcome = await check(context(cluster.origin));

    expect(outcome.verdict).toBe("indeterminate");
    expect(outcome.failureClass).toBe("misconfigured");
    expect(outcome.error).toContain("monitor");
  });

  it("calls a cluster that answers 503 down, and says so before anything else", async () => {
    const cluster = await openCluster({
      status: 503,
      body: { error: "master_not_discovered_exception" },
    });
    const outcome = await check(context(cluster.origin));

    expect(outcome.verdict).toBe("down");
    expect(outcome.error).toContain("503");
    // The status assertion is declared first precisely so this reads as
    // the cause rather than as a complaint about a missing colour.
    expect(outcome.failedAssertions[0]).toBe("status");
  });

  it("calls a 200 that is not a health document down", async () => {
    // A proxy's error page and an SSO login screen both look like this.
    const cluster = await openCluster({
      body: "<html><body>Sign in</body></html>",
      contentType: "text/html",
    });
    const outcome = await check(context(cluster.origin));

    expect(outcome.verdict).toBe("down");
    expect(outcome.error).toContain("not an Elasticsearch cluster health");
    expect(outcome.facts.clusterStatus).toBeUndefined();
  });

  it("gives up on a cluster that accepts the request and never answers", async () => {
    const cluster = await openCluster({ mute: true });
    const outcome = await check(context(cluster.origin, { timeoutMs: 300 }));

    expect(outcome.verdict).toBe("down");
    expect(outcome.failureClass).toBe("transport");
    expect(outcome.error).toBe("Timed out after 300ms");
  });

  it("refuses a cluster URL that resolves into private space", async () => {
    // The guard is the egress module's, not this probe's — every hop of
    // every redirect goes through it, and an `Authorization` header is
    // exactly what must not follow one into somebody else's network.
    const result = await elasticsearchProbe(
      context("https://search.example.com:9200", {
        allowPrivateTargets: false,
        lookup: privateLookup,
      }),
    );

    expect(result.error).toBe("Target resolves to a private address");
    expect(result.facts).toEqual({});
    expect(result.responseTimeMs).toBeNull();
  });

  it("reports a target that is not a URL without throwing out of the probe", async () => {
    const result = await elasticsearchProbe(context("search.example.com"));
    expect(result.error).toBe("Invalid cluster URL");
  });
});

describe("what the elasticsearch facts mean", () => {
  it("keeps one decimal of the shard percentage, because sixteen are unreadable", () => {
    expect(
      healthFacts({ active_shards_percent_as_number: 66.66666666666667 })
        .activeShardsPercent,
    ).toBe(66.7);
  });

  it("records nothing at all for a body that is not an object", () => {
    expect(healthFacts("green")).toEqual({});
    expect(healthFacts([GREEN])).toEqual({});
    expect(healthFacts(null)).toEqual({});
  });

  it("strips control characters out of what the far end called itself", () => {
    // A name with a bell character in it, because the value comes off
    // the wire from a host we do not control and lands in an incident
    // email.
    const facts = healthFacts({
      ...GREEN,
      cluster_name: `vigil${String.fromCharCode(7)}search`,
    });
    expect(facts.clusterName).toBe("vigil search");
  });

  it("appends the health path and drops any query string on the target", () => {
    expect(clusterHealthUrl("https://es.example.com:9200")?.toString()).toBe(
      "https://es.example.com:9200/_cluster/health",
    );
    expect(clusterHealthUrl("https://es.example.com/search/")?.toString()).toBe(
      "https://es.example.com/search/_cluster/health",
    );
    expect(clusterHealthUrl("https://es.example.com?pretty")?.toString()).toBe(
      "https://es.example.com/_cluster/health",
    );
    expect(clusterHealthUrl("not a url")).toBeNull();
  });

  it("prefers the API key when a row somehow carries both credentials", () => {
    // The stored schema refuses that combination, but a row can predate
    // the schema — and "whichever the code wrote last" is not a rule
    // anyone can reason about.
    expect(
      authorizationHeader(
        config({ apiKey: "key", username: "elastic", password: "hunter2" }),
      ),
    ).toBe("ApiKey key");
    expect(authorizationHeader(config())).toBeNull();
    expect(authorizationHeader(config({ username: "elastic" }))).toBeNull();
  });
});

describe("what an elasticsearch monitor is allowed to store", () => {
  it("accepts an empty submission and judges by green until told otherwise", () => {
    expect(elasticsearchStoredSchema.parse({})).toEqual({
      username: null,
      password: null,
      apiKey: null,
      minimumStatus: "green",
    });
  });

  it("refuses an API key and a password at the same time", () => {
    // They set the same header. A monitor holding both has a rule
    // nobody wrote down about which one wins.
    const parsed = elasticsearchStoredSchema.safeParse({
      apiKey: "key",
      username: "elastic",
      password: "hunter2",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["apiKey"]);
  });

  it("refuses a password with nobody to authenticate as", () => {
    const parsed = elasticsearchStoredSchema.safeParse({ password: "hunter2" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["password"]);
  });

  it("refuses a status colour that is not one an operator may accept", () => {
    expect(
      elasticsearchStoredSchema.safeParse({ minimumStatus: "red" }).success,
    ).toBe(false);
  });

  it("refuses a cluster URL with the credentials written into it", () => {
    // The URL is not a secret field: it is exported verbatim and printed
    // in incident emails. A password there cannot be taken back.
    const parsed = elasticsearchSpec.targetSchema.safeParse(
      "https://elastic:hunter2@search.example.com:9200",
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("not in the URL");
    expect(
      elasticsearchSpec.targetSchema.safeParse(
        "https://search.example.com:9200",
      ).success,
    ).toBe(true);
  });

  it("survives a config blob written by a build that had other ideas", () => {
    for (const stored of [null, undefined, {}, { nonsense: true }, 42]) {
      expect(() =>
        elasticsearchSpec.fromRow({
          checkType: "elasticsearch",
          url: "https://search.example.com:9200",
          port: null,
          method: "GET",
          intervalSeconds: 60,
          timeoutMs: 10_000,
          degradedThresholdMs: 3_000,
          expectedStatusCode: null,
          bodyKeyword: null,
          keywordAbsent: false,
          tlsCheck: false,
          tlsWarnDays: 14,
          config: stored,
        }),
      ).not.toThrow();
    }
  });
});

describe("what an elasticsearch monitor shows a human", () => {
  it("masks both credentials on the way to a browser", () => {
    const redacted = redactConfig(elasticsearchSpec, {
      username: "elastic",
      password: "hunter2",
      apiKey: "a2V5",
      minimumStatus: "green",
    }) as Record<string, unknown>;

    expect(redacted.password).toBe(SECRET_MASK);
    expect(redacted.apiKey).toBe(SECRET_MASK);
    expect(redacted.username).toBe("elastic");
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
  });

  it("strips a credential out of a target stored before the schema refused one", () => {
    expect(
      elasticsearchSpec.describeTarget(
        "https://elastic:hunter2@search.example.com:9200/",
        null,
        config(),
      ),
    ).toBe("https://search.example.com:9200/");
  });

  it("prints an ordinary cluster URL unchanged", () => {
    expect(
      elasticsearchSpec.describeTarget(
        "https://search.example.com:9200",
        null,
        config(),
      ),
    ).toBe("https://search.example.com:9200");
  });
});
