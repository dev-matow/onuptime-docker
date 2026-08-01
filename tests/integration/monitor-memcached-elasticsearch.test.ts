import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { monitors } from "@/db/schema";
import { exportMonitors, importMonitors } from "@/modules/monitors/portability";
import { createMonitorSchema } from "@/modules/monitors/schemas";
import {
  createMonitor,
  getMonitorDetail,
  updateMonitor,
} from "@/modules/monitors/service";
import { SECRET_MASK, redactConfig } from "@/modules/monitors/types/config";
import type { AnyCheckTypeSpec } from "@/modules/monitors/types/contract";
import { CHECK_TYPE_SPECS } from "@/modules/monitors/types/specs";
import { elasticsearchSpec } from "@/modules/monitors/types/specs/elasticsearch";
import { memcachedSpec } from "@/modules/monitors/types/specs/memcached";

import { createTestOrg, db } from "../helpers";

/**
 * The two protocol types, through the real service layer and a real
 * PostgreSQL: created, edited, exported, imported.
 *
 * The interesting half is not the round trip. It is that a credential
 * survives an edit that never mentions it, and does *not* survive into
 * an export file — which is one property with two opposite-looking
 * halves, and the pair that the 1.13.0 config-merge bug got wrong in
 * both directions at once.
 */

/**
 * Registers both specs with the shared map when the index has not.
 *
 * `specs/index.ts` is wired once, for every type of this release
 * together, by the change that lands them; several of these types are
 * written in parallel and none of them may edit that file. Without this
 * the suite could not run until somebody else's edit arrived, which
 * means it could not have been written against a failing case. The
 * assignment is idempotent — once the index carries these two entries
 * it is the same object and this does nothing — and vitest isolates
 * test files, so no other suite sees it.
 */
const registry = CHECK_TYPE_SPECS as Record<string, AnyCheckTypeSpec>;
registry.memcached ??= memcachedSpec as unknown as AnyCheckTypeSpec;
registry.elasticsearch ??= elasticsearchSpec as unknown as AnyCheckTypeSpec;

const MEMCACHED_TARGET = "cache.protocol.example";
const ELASTICSEARCH_TARGET = "https://search.protocol.example:9200";

/** The null-heavy payload the monitor form actually submits. */
function payload(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: `protocol-${randomUUID().slice(0, 8)}`,
    url: MEMCACHED_TARGET,
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 10_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    tlsCheck: false,
    tlsWarnDays: 14,
    failureWindowSeconds: 120,
    config: null,
    ...overrides,
  };
}

/** The same payload, through the schema the server action validates with. */
function submit(overrides: Record<string, unknown>) {
  return createMonitorSchema.parse(payload(overrides));
}

function memcachedInput(config?: Record<string, unknown>) {
  return submit({
    checkType: "memcached",
    url: MEMCACHED_TARGET,
    config: config ?? { username: "vigil", password: "sup3r-s3cret-memcached" },
  });
}

function elasticsearchInput(config?: Record<string, unknown>) {
  return submit({
    checkType: "elasticsearch",
    url: ELASTICSEARCH_TARGET,
    config: config ?? {
      username: "elastic",
      password: "sup3r-s3cret-elastic",
      minimumStatus: "yellow",
    },
  });
}

async function storedConfig(monitorId: string): Promise<unknown> {
  const [row] = await db
    .select({ config: monitors.config })
    .from(monitors)
    .where(eq(monitors.id, monitorId));
  return row?.config ?? null;
}

describe("creating a memcached monitor", () => {
  it("stores its settings and defaults the port it was not given", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, memcachedInput());

    expect(monitor.checkType).toBe("memcached");
    // The descriptor carries the default, so an operator who leaves the
    // field alone still gets a monitor that dials something.
    expect(monitor.port).toBe(11_211);
    expect(await storedConfig(monitor.id)).toEqual({
      username: "vigil",
      password: "sup3r-s3cret-memcached",
      maxConnectionUsagePercent: 90,
    });
  });

  it("keeps a port the operator did give it", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      submit({ checkType: "memcached", url: MEMCACHED_TARGET, port: 11_212 }),
    );
    expect(monitor.port).toBe(11_212);
  });

  it("rebuilds the runtime config from the row it stored", async () => {
    // The blob makes a round trip through jsonb, and `fromRow` is what
    // the worker calls on every check. A shape that survives storage but
    // not reconstruction is a monitor that stops authenticating.
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, memcachedInput());
    const { monitor: row } = await getMonitorDetail(
      db,
      actor.organizationId,
      monitor.id,
    );

    expect(memcachedSpec.fromRow(row)).toEqual({
      username: "vigil",
      password: "sup3r-s3cret-memcached",
      maxConnectionUsagePercent: 90,
      degradedThresholdMs: 3_000,
    });
  });
});

describe("creating an elasticsearch monitor", () => {
  it("stores its settings and takes no port of its own", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, elasticsearchInput());

    expect(monitor.checkType).toBe("elasticsearch");
    // The port is in the URL. A column for it would be a second answer
    // to the same question.
    expect(monitor.port).toBeNull();
    expect(await storedConfig(monitor.id)).toEqual({
      username: "elastic",
      password: "sup3r-s3cret-elastic",
      apiKey: null,
      minimumStatus: "yellow",
    });
  });

  it("rebuilds the runtime config from the row it stored", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      elasticsearchInput({ apiKey: "a2V5OnNlY3JldA==" }),
    );
    const { monitor: row } = await getMonitorDetail(
      db,
      actor.organizationId,
      monitor.id,
    );

    expect(elasticsearchSpec.fromRow(row)).toEqual({
      username: null,
      password: null,
      apiKey: "a2V5OnNlY3JldA==",
      minimumStatus: "green",
      degradedThresholdMs: 3_000,
    });
  });
});

describe("editing either monitor keeps the credential nobody retyped", () => {
  it.each([
    ["memcached", memcachedInput, "password", "sup3r-s3cret-memcached"],
    ["elasticsearch", elasticsearchInput, "password", "sup3r-s3cret-elastic"],
  ] as const)(
    "%s: a rename that says nothing about config leaves the secret alone",
    async (_id, input, field, secret) => {
      // Exactly what the monitor form sends for a type whose fields it
      // does not render: `config: null`. This was the 1.13.0 data-loss
      // path, and the reason both of these types declare `secretFields`.
      const actor = await createTestOrg();
      const monitor = await createMonitor(db, actor, input());

      await updateMonitor(db, actor, monitor.id, {
        name: `renamed-${randomUUID().slice(0, 8)}`,
        config: null,
      });

      const stored = (await storedConfig(monitor.id)) as Record<
        string,
        unknown
      >;
      expect(stored[field]).toBe(secret);
    },
  );

  it("memcached: keeps the password when the client echoes the mask back", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, memcachedInput());

    await updateMonitor(db, actor, monitor.id, {
      config: { username: "vigil", password: SECRET_MASK },
    });

    const stored = (await storedConfig(monitor.id)) as Record<string, unknown>;
    expect(stored.password).toBe("sup3r-s3cret-memcached");
    expect(JSON.stringify(stored)).not.toContain(SECRET_MASK);
  });

  it("elasticsearch: keeps both credentials when the client echoes the mask back", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(
      db,
      actor,
      elasticsearchInput({ apiKey: "a2V5OnNlY3JldA==" }),
    );

    await updateMonitor(db, actor, monitor.id, {
      config: { apiKey: SECRET_MASK, minimumStatus: "yellow" },
    });

    const stored = (await storedConfig(monitor.id)) as Record<string, unknown>;
    expect(stored.apiKey).toBe("a2V5OnNlY3JldA==");
    expect(stored.minimumStatus).toBe("yellow");
  });

  it("memcached: clears the password when the client sends null", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, memcachedInput());

    await updateMonitor(db, actor, monitor.id, {
      config: { username: null, password: null },
    });

    const stored = (await storedConfig(monitor.id)) as Record<string, unknown>;
    expect(stored.password).toBeNull();
  });

  it("memcached: changes the saturation threshold without touching the credential", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, memcachedInput());

    await updateMonitor(db, actor, monitor.id, {
      config: { maxConnectionUsagePercent: 75 },
    });

    const stored = (await storedConfig(monitor.id)) as Record<string, unknown>;
    expect(stored.maxConnectionUsagePercent).toBe(75);
    expect(stored.password).toBe("sup3r-s3cret-memcached");
  });

  it("drops the previous type's config when the monitor becomes something else", async () => {
    const actor = await createTestOrg();
    const monitor = await createMonitor(db, actor, memcachedInput());

    await updateMonitor(db, actor, monitor.id, {
      checkType: "tcp",
      url: MEMCACHED_TARGET,
      port: 11_211,
    });

    // Otherwise a switch back would resurrect a credential the operator
    // believed they had removed with the type.
    const stored = (await storedConfig(monitor.id)) as Record<
      string,
      unknown
    > | null;
    expect(stored?.password).toBeUndefined();
  });
});

describe("what leaves the server", () => {
  it("masks both types' secrets on the way to a browser", async () => {
    const actor = await createTestOrg();
    const memcached = await createMonitor(db, actor, memcachedInput());
    const elasticsearch = await createMonitor(
      db,
      actor,
      elasticsearchInput({
        username: "elastic",
        password: "sup3r-s3cret-elastic",
      }),
    );

    const memcachedDetail = await getMonitorDetail(
      db,
      actor.organizationId,
      memcached.id,
    );
    const elasticsearchDetail = await getMonitorDetail(
      db,
      actor.organizationId,
      elasticsearch.id,
    );

    const memcachedConfig = redactConfig(
      memcachedSpec,
      memcachedDetail.monitor.config,
    ) as Record<string, unknown>;
    const elasticsearchConfig = redactConfig(
      elasticsearchSpec,
      elasticsearchDetail.monitor.config,
    ) as Record<string, unknown>;

    expect(memcachedConfig.password).toBe(SECRET_MASK);
    expect(memcachedConfig.username).toBe("vigil");
    expect(elasticsearchConfig.password).toBe(SECRET_MASK);
    expect(JSON.stringify(memcachedConfig)).not.toContain("sup3r-s3cret");
    expect(JSON.stringify(elasticsearchConfig)).not.toContain("sup3r-s3cret");
  });

  it("exports both types without their credentials, and imports what is left", async () => {
    const source = await createTestOrg();
    await createMonitor(db, source, memcachedInput());
    await createMonitor(
      db,
      source,
      elasticsearchInput({ apiKey: "a2V5OnNlY3JldA==" }),
    );

    const exported = await exportMonitors(db, source.organizationId);
    // An export is a file an operator emails to themselves or commits.
    expect(JSON.stringify(exported)).not.toContain("sup3r-s3cret-memcached");
    expect(JSON.stringify(exported)).not.toContain("a2V5OnNlY3JldA==");

    const destination = await createTestOrg();
    const report = await importMonitors(db, destination, exported);

    expect(report.skipped).toBe(0);
    expect(report.imported).toBe(2);

    const memcachedOutcome = report.outcomes.find(
      (outcome) => outcome.checkType === "memcached",
    );
    const elasticsearchOutcome = report.outcomes.find(
      (outcome) => outcome.checkType === "elasticsearch",
    );
    // The operator is told exactly what they have to re-enter. An
    // imported monitor that silently authenticated with the sentinel
    // would fail in a way that reads like a wrong password.
    expect(memcachedOutcome?.secretsToReenter).toEqual(["password"]);
    expect(elasticsearchOutcome?.secretsToReenter).toEqual(["apiKey"]);

    const importedConfig = (await storedConfig(
      memcachedOutcome?.monitorId ?? "",
    )) as Record<string, unknown>;
    expect(importedConfig.password).toBeNull();
    // Everything that is not a credential comes across intact.
    expect(importedConfig.username).toBe("vigil");
    expect(importedConfig.maxConnectionUsagePercent).toBe(90);
  });
});

describe("what the form is told when a submission is wrong", () => {
  it("refuses a memcached monitor given a URL instead of a hostname", () => {
    const parsed = createMonitorSchema.safeParse({
      ...payload({}),
      checkType: "memcached",
      url: "https://cache.protocol.example",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["url"]);
  });

  it("refuses an elasticsearch monitor given a bare hostname", () => {
    const parsed = createMonitorSchema.safeParse({
      ...payload({}),
      checkType: "elasticsearch",
      url: "search.protocol.example",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["url"]);
  });

  it("refuses an elasticsearch URL carrying the credentials", () => {
    const parsed = createMonitorSchema.safeParse({
      ...payload({}),
      checkType: "elasticsearch",
      url: "https://elastic:hunter2@search.protocol.example:9200",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("not in the URL");
  });

  it("refuses a memcached user name the protocol would read as two arguments", () => {
    const parsed = createMonitorSchema.safeParse({
      ...payload({}),
      checkType: "memcached",
      url: MEMCACHED_TARGET,
      config: { username: "vigil monitor", password: "hunter2" },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["config"]);
    expect(parsed.error?.issues[0]?.message).toContain(
      "cannot contain a space",
    );
  });

  it("refuses an elasticsearch monitor holding two kinds of credential", () => {
    const parsed = createMonitorSchema.safeParse({
      ...payload({}),
      checkType: "elasticsearch",
      url: ELASTICSEARCH_TARGET,
      config: { apiKey: "key", username: "elastic", password: "hunter2" },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["config"]);
    expect(parsed.error?.issues[0]?.message).toContain("not both");
  });

  it("still refuses the metadata endpoint, whichever type is asking", () => {
    for (const [checkType, url] of [
      ["memcached", "metadata.google.internal"],
      ["elasticsearch", "https://169.254.169.254/"],
    ] as const) {
      const parsed = createMonitorSchema.safeParse({
        ...payload({}),
        checkType,
        url,
      });
      expect(parsed.success, `${checkType} ${url}`).toBe(false);
    }
  });
});
