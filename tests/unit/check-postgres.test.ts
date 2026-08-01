// @covers-type: postgres
import { describe, expect, it } from "vitest";

import {
  connectionErrorMessage,
  postgresProbe,
} from "@/modules/monitors/types/probes/postgres";
import { postgresSpec } from "@/modules/monitors/types/specs/postgres";
import type { PostgresConfig } from "@/modules/monitors/types/specs/postgres";

import { publicLookup } from "../probe-lookup";

/**
 * Postgres, against a real Postgres.
 *
 * The protocol fixture here is not a stand-in — the test suite already
 * requires a live server, so the probe dials that one. Nothing about the
 * startup handshake, the authentication exchange or the wire encoding is
 * being approximated, which is exactly what a hand-written fixture for a
 * binary protocol this large would end up doing.
 *
 * The cases worth having are the ones a mock gets wrong: a database that
 * does not exist, a password that is not accepted, a port with something
 * else behind it, and a connection string this build cannot parse.
 */

const LIVE =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@localhost:5433/vigil_test";

function context(
  target: string,
  config: Partial<PostgresConfig> = {},
): Parameters<typeof postgresProbe>[0] {
  return {
    target,
    port: null,
    config: { degradedThresholdMs: 3_000, ...config } as PostgresConfig,
    timeoutMs: 5_000,
    // The live server is on loopback, which is the whole reason this
    // flag exists.
    allowPrivateTargets: true,
    fetchImpl: fetch,
    lookup: publicLookup,
  };
}

describe("connectionErrorMessage", () => {
  it("names a refused connection in words an operator can act on", () => {
    const message = connectionErrorMessage(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
        code: "ECONNREFUSED",
      }),
    );
    expect(message).toBeTruthy();
    expect(message.toLowerCase()).toContain("refused");
  });

  it("passes an unrecognised failure through rather than swallowing it", () => {
    expect(connectionErrorMessage(new Error("something specific"))).toContain(
      "something specific",
    );
  });
});

describe("postgresProbe against a live server", () => {
  it("reports a successful query", async () => {
    const result = await postgresProbe(context(LIVE));

    expect(result.error).toBeNull();
    expect(result.facts.queryOk).toBe(true);
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a database that does not exist", async () => {
    const url = new URL(LIVE);
    url.pathname = "/vigil_no_such_database";

    const result = await postgresProbe(context(url.toString()));

    expect(result.error).toBeTruthy();
    expect(result.facts.queryOk).not.toBe(true);
  });

  it("reports a port with nothing listening", async () => {
    const url = new URL(LIVE);
    url.port = "1";

    const result = await postgresProbe(context(url.toString()));

    expect(result.error).toBeTruthy();
  });

  it("refuses a target that is not a connection string at all", async () => {
    // A row can predate the target schema or survive a downgrade, and
    // `new URL` throwing on the worker's hot path would escape the probe
    // entirely.
    const result = await postgresProbe(context("db.example.com"));

    expect(result.error).toBe("Not a PostgreSQL connection string");
    expect(result.responseTimeMs).toBeNull();
  });

  it("does not put the password in anything it returns", async () => {
    const url = new URL(LIVE);
    url.password = "hunter2";
    url.username = url.username || "postgres";

    const result = await postgresProbe(context(url.toString()));

    // Whether it connected or not, the credential must not travel: this
    // string reaches incident emails and the audit log.
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });
});

describe("the postgres spec", () => {
  it("redacts the credential from the target it describes", () => {
    // `describeTarget` is what a status page and an incident email
    // print, and the connection string is the one target in the product
    // that carries a password inside it.
    const described = postgresSpec.describeTarget(
      "postgres://app:hunter2@db.example.com:5432/orders",
      null,
      { degradedThresholdMs: 3_000 },
    );
    expect(described).not.toContain("hunter2");
    expect(described).toContain("db.example.com");
  });
});
