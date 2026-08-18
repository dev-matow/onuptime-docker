import { z } from "zod";

import {
  ACCEPTABLE_CLUSTER_STATUSES,
  elasticsearchDescriptor,
} from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorUrlSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * A cluster's own opinion of itself, read from `_cluster/health`.
 *
 * The colour is the whole point. An HTTP monitor on `:9200` proves the
 * REST layer answers, which it does perfectly well while every replica
 * is unassigned and the cluster is one node away from losing data;
 * Elasticsearch publishes exactly one field that says so, and it says
 * it in three words. Nothing else here is invented — the facts are the
 * document's own numbers, and what a colour *means* is the operator's
 * decision, expressed as {@link ElasticsearchConfig.minimumStatus}.
 */

/**
 * The colours, worst last. Exported because the probe validates what the
 * cluster answered against this list rather than trusting a free string
 * from a host it does not control.
 */
export const CLUSTER_STATUSES = ["green", "yellow", "red"] as const;

export type ClusterStatus = (typeof CLUSTER_STATUSES)[number];

/** The colours an operator can call healthy. Red is never one of them. */

export interface ElasticsearchConfig {
  /**
   * HTTP basic credentials, for a cluster with security enabled. Null
   * on a cluster that answers unauthenticated — still the common case
   * inside a private network, and on every 7.x install that predates
   * security-by-default.
   */
  username: string | null;
  password: string | null;
  /**
   * An API key, sent as `Authorization: ApiKey …`. The alternative to
   * basic auth rather than an addition to it: Elastic Cloud issues
   * these instead of a password, and a key can be scoped to the one
   * `monitor` privilege this check needs, which a user's password
   * cannot.
   */
  apiKey: string | null;
  /**
   * The worst colour that still counts as fully healthy.
   *
   * `green` means an unassigned replica shows up as degraded, which is
   * what a multi-node cluster wants: yellow there is a real loss of
   * redundancy, and amber is the honest colour for it — it never opens
   * an incident and never wakes anyone.
   *
   * `yellow` exists because a single-node cluster is *permanently*
   * yellow: it has replicas configured and nowhere to put them, and
   * nothing will ever assign them. Defaulting to green there would give
   * an operator a monitor that is amber from the day it is created,
   * which is the fastest way to teach a team to ignore amber.
   */
  minimumStatus: (typeof ACCEPTABLE_CLUSTER_STATUSES)[number];
  degradedThresholdMs: number;
}

export const DEFAULT_MINIMUM_STATUS = "green" as const;

/**
 * The cluster URL, refusing one with a credential written into it.
 *
 * `https://elastic:hunter2@search.example.com:9200` is a perfectly legal
 * URL and exactly the wrong place to put a password: the target column
 * is not a secret field, so it is exported verbatim into a file an
 * operator emails to themselves, and no amount of redaction downstream
 * puts that back. The credentials have their own fields, which are
 * masked everywhere; this says so at the moment someone pastes the
 * wrong thing, instead of accepting it and leaking it later.
 */
export const elasticsearchTargetSchema = monitorUrlSchema.refine(
  (value) => {
    try {
      const url = new URL(value);
      return url.username === "" && url.password === "";
    } catch {
      // Not a URL at all; `monitorUrlSchema` has already said so and
      // its message is the one worth showing.
      return true;
    }
  },
  {
    message:
      "Put the username and password in this monitor's settings, not in the URL. The URL is exported and shown verbatim.",
  },
);

export const elasticsearchStoredSchema = z
  .object({
    username: z
      .string()
      .trim()
      .max(255)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null)),
    // Not trimmed, unlike the user name: trailing whitespace inside a
    // password is part of the secret, and quietly rewriting it turns a
    // working credential into a 401 nobody can account for.
    password: z
      .string()
      .max(512)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null)),
    apiKey: z
      .string()
      .trim()
      .max(1024)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null)),
    minimumStatus: z
      .enum(ACCEPTABLE_CLUSTER_STATUSES)
      .default(DEFAULT_MINIMUM_STATUS),
  })
  // One credential or the other, never both: they set the same header,
  // so a monitor holding both has a rule nobody wrote down about which
  // one wins. Refused where the operator is standing rather than
  // resolved silently at request time.
  .refine((config) => config.apiKey === null || config.username === null, {
    message: "Use either an API key or a username and password, not both.",
    path: ["apiKey"],
  })
  .refine((config) => config.username !== null || config.password === null, {
    message: "A password needs a username.",
    path: ["password"],
  });

export const elasticsearchConfigSchema: z.ZodType<ElasticsearchConfig> =
  z.object({
    username: z.string().max(255).nullable(),
    password: z.string().max(512).nullable(),
    apiKey: z.string().max(1024).nullable(),
    minimumStatus: z.enum(ACCEPTABLE_CLUSTER_STATUSES),
    degradedThresholdMs: z.number().int().min(100).max(30_000),
  });

/**
 * Declared first, so that when the endpoint answers 503 the operator
 * reads "Elasticsearch answered 503" rather than a complaint about a
 * health document that was never going to be there.
 */
const answered: Assertion<ElasticsearchConfig> = {
  id: "status",
  fact: "statusCode",
  severity: "down",
  evaluate(value) {
    // Absent only on a transport failure, which `judge` has already
    // reported by the time any assertion runs. 401 and 403 never reach
    // here either — the probe calls those `unavailable`, because a
    // credential the operator has to fix must not read as an outage.
    if (typeof value !== "number") return null;
    return value === 200
      ? null
      : `Elasticsearch answered ${value} instead of a cluster health document`;
  },
};

const notRed: Assertion<ElasticsearchConfig> = {
  id: "cluster-status",
  fact: "clusterStatus",
  severity: "down",
  evaluate(value) {
    // A 200 whose body is not a health document lands here: the probe
    // records no colour, and something that answers on 9200 without
    // publishing cluster health is not the cluster this monitor was
    // pointed at. A proxy's error page and a captive portal both look
    // exactly like this.
    if (typeof value !== "string") {
      return "The response was not an Elasticsearch cluster health document";
    }
    if (value === "red") {
      return "The cluster is red: at least one primary shard is unassigned";
    }
    // A colour Elasticsearch does not define is not something to pass
    // quietly. Treating an unknown value as healthy is how a monitor
    // ends up green because the field it reads was renamed.
    if (!(CLUSTER_STATUSES as readonly string[]).includes(value)) {
      return `Elasticsearch reported an unrecognised cluster status "${value}"`;
    }
    return null;
  },
};

const fullyReplicated: Assertion<ElasticsearchConfig> = {
  id: "cluster-degraded",
  fact: "clusterStatus",
  severity: "degraded",
  applies: (config) => config.minimumStatus === "green",
  evaluate(value) {
    // Red is the other assertion's business. Reporting it twice would
    // put a degraded line next to a down line for one cause, which is
    // how an incident stops being readable.
    return value === "yellow"
      ? "The cluster is yellow: at least one replica shard is unassigned"
      : null;
  },
};

export const elasticsearchSpec: CheckTypeSpec<ElasticsearchConfig> = {
  descriptor: elasticsearchDescriptor,
  configSchema: elasticsearchConfigSchema,
  storedSchema: elasticsearchStoredSchema,
  secretFields: ["password", "apiKey"],
  targetSchema: elasticsearchTargetSchema,
  // Nothing asserts on the node count, deliberately. A node leaving a
  // cluster that still has every shard assigned is a rolling restart
  // doing exactly what it is supposed to, and paging on it would page
  // on every upgrade. The count is recorded so a human can see it; the
  // colour is what is judged.
  assertions: [
    answered,
    notRed,
    fullyReplicated,
    latencyAssertion<ElasticsearchConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): ElasticsearchConfig {
    const stored = elasticsearchStoredSchema.safeParse(row.config ?? {});
    return {
      username: stored.success ? stored.data.username : null,
      password: stored.success ? stored.data.password : null,
      apiKey: stored.success ? stored.data.apiKey : null,
      minimumStatus: stored.success
        ? stored.data.minimumStatus
        : DEFAULT_MINIMUM_STATUS,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  /**
   * The cluster URL with any `user:password@` in front of it removed.
   *
   * The target schema refuses that shape on the way in, so this is the
   * second lock on the same door — for a row written before the schema
   * existed, or restored from a backup that predates it. It is worth
   * having twice because of where this string goes: an incident email,
   * a webhook body and a public status page. `postgres` learned that
   * the hard way the day it shipped.
   */
  describeTarget(target) {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      // Unparseable, so the credential cannot be located precisely.
      // Everything up to the last "@" is where one would be.
      return target.slice(target.lastIndexOf("@") + 1);
    }
    if (url.username === "" && url.password === "") return target;
    url.username = "";
    url.password = "";
    return url.toString();
  },
};
