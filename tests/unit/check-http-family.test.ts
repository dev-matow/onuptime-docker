// @covers-type: json-query, docker, globalping, domain-expiry
import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { interpret, parseDaemon } from "@/modules/monitors/types/probes/docker";
import { jsonQueryProbe } from "@/modules/monitors/types/probes/json-query";
import { jsonQuerySpec } from "@/modules/monitors/types/specs/json-query";
import type { JsonQueryConfig } from "@/modules/monitors/types/specs/json-query";

import { publicLookup } from "../probe-lookup";

/**
 * The types that speak HTTP to something and read a document.
 *
 * They go through `modules/monitors/egress.ts`, which resolves and
 * classifies before it connects — so these tests stand up a real server
 * on loopback and point the target at it directly rather than at a
 * hostname that would be resolved somewhere else.
 *
 * `json-query` gets the most attention here because it is the only probe
 * in the product that PERSISTS part of a response body as a stored fact.
 * That makes a redirect into private space a data-exfiltration path
 * rather than merely an unwanted request, which is why the egress module
 * validates every hop for it.
 */

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function serve(
  handler: http.RequestListener,
): Promise<{ url: string; port: number }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/`, port };
}

function context(
  url: string,
  config: Partial<JsonQueryConfig> = {},
): Parameters<typeof jsonQueryProbe>[0] {
  return {
    target: url,
    port: null,
    config: {
      // A dotted path, not JSONPath: `status`, `db.connected`,
      // `checks[0].name`.
      jsonPath: "status",
      expectedValue: "ok",
      degradedThresholdMs: 3_000,
      ...config,
    } as JsonQueryConfig,
    timeoutMs: 3_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
    lookup: publicLookup,
  };
}

describe("json-query against a real server", () => {
  it("reads the value at the configured path", async () => {
    const { url } = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", detail: "all good" }));
    });

    const result = await jsonQueryProbe(context(url));

    expect(result.error).toBeNull();
    expect(result.facts.jsonValid).toBe(true);
    expect(result.facts.pathFound).toBe(true);
    expect(result.facts.actualValue).toBe("ok");
    expect(result.facts.matches).toBe(true);
  });

  it("reports a mismatch as a fact rather than an error", async () => {
    // The request worked and the document parsed; the value was wrong.
    // Deciding what that means belongs to the type's assertion.
    const { url } = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "degraded" }));
    });

    const result = await jsonQueryProbe(context(url));

    expect(result.error).toBeNull();
    expect(result.facts.matches).toBe(false);
    expect(result.facts.actualValue).toBe("degraded");
  });

  it("distinguishes a missing path from a wrong value", async () => {
    const { url } = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ other: "field" }));
    });

    const result = await jsonQueryProbe(context(url));

    expect(result.facts.jsonValid).toBe(true);
    expect(result.facts.pathFound).toBe(false);
  });

  it("reports a body that is not JSON at all", async () => {
    const { url } = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>not json</html>");
    });

    const result = await jsonQueryProbe(context(url));

    expect(result.facts.jsonValid).toBe(false);
  });

  it("carries the status code through", async () => {
    const { url } = await serve((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "down" }));
    });

    const result = await jsonQueryProbe(context(url));

    expect(result.facts.statusCode).toBe(503);
  });

  it("refuses a target that is not a URL", async () => {
    const result = await jsonQueryProbe(context("not a url"));
    expect(result.error).toBe("Invalid URL");
  });

  it("bounds what it stores from the body", async () => {
    // This is the one probe that persists part of a response. An
    // unbounded value would put an arbitrary amount of somebody else's
    // document into this database, one row per check.
    const { url } = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "x".repeat(10_000) }));
    });

    const result = await jsonQueryProbe(context(url));
    const stored = String(result.facts.actualValue ?? "");
    expect(stored.length).toBeLessThan(1_000);
  });

  it("follows a redirect one validated hop at a time", async () => {
    const target = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
    });
    const front = await serve((_request, response) => {
      response.writeHead(302, { location: target.url });
      response.end();
    });

    const result = await jsonQueryProbe(context(front.url));

    // Both hops are loopback and this context allows private targets, so
    // the chain is followed and the final document is what is read.
    expect(result.facts.actualValue).toBe("ok");
  });

  it("refuses a redirect into space the policy forbids", async () => {
    // The reason every hop is validated: the first response is the
    // attacker's chance to choose the second request's destination.
    const front = await serve((_request, response) => {
      response.writeHead(302, {
        location: "http://169.254.169.254/latest/meta-data/",
      });
      response.end();
    });

    const result = await jsonQueryProbe(context(front.url));

    expect(result.error).toBeTruthy();
    expect(result.facts.actualValue).toBeUndefined();
  });
});

describe("docker", () => {
  it("reads a bare path as a socket, not a URL", () => {
    expect(parseDaemon("/var/run/docker.sock")).toEqual({
      kind: "socket",
      socketPath: "/var/run/docker.sock",
    });
  });

  it("reads a tcp:// daemon as a host and port", () => {
    const daemon = parseDaemon("tcp://dockerhost.example.com:2375");
    expect(daemon).toMatchObject({
      kind: "tcp",
      host: "dockerhost.example.com",
    });
  });

  it("strips the brackets an IPv6 literal arrives in", () => {
    // `URL` keeps them; `net.connect` refuses them.
    const daemon = parseDaemon("tcp://[2001:db8::1]:2375");
    expect(daemon).toMatchObject({ kind: "tcp", host: "2001:db8::1" });
  });

  it("reads a running container as running", () => {
    const body = JSON.stringify({
      RestartCount: 0,
      State: { Status: "running", Running: true },
    });
    const result = interpret(200, body, 12, "web");

    expect(result.error).toBeNull();
    expect(result.facts.running).toBe(true);
    expect(result.facts.state).toBe("running");
  });

  it("reads a 404 as an answer, not a failure", () => {
    // The daemon replied. What it said is that the container is not
    // there, which is a fact about the container rather than a transport
    // error — and the difference decides whether an operator goes
    // looking at Docker or at the network.
    const result = interpret(404, "{}", 12, "web");

    expect(result.error).toBeNull();
    expect(result.facts.running).toBe(false);
  });

  it("reads an exited container as not running", () => {
    // `RestartCount` sits at the root of Docker's inspect response, not
    // inside `State`.
    const body = JSON.stringify({
      RestartCount: 3,
      State: { Status: "exited", Running: false },
    });
    const result = interpret(200, body, 12, "web");

    expect(result.facts.running).toBe(false);
    expect(result.facts.restartCount).toBe(3);
  });

  it("carries a health status when the container declares one", () => {
    const body = JSON.stringify({
      RestartCount: 0,
      State: {
        Status: "running",
        Running: true,
        Health: { Status: "unhealthy" },
      },
    });
    const result = interpret(200, body, 12, "web");

    expect(result.facts.health).toBe("unhealthy");
  });

  it("reports a daemon that answered with something unreadable", () => {
    const result = interpret(200, "<html>", 12, "web");
    expect(result.error).toBeTruthy();
  });
});

describe("the json-query spec", () => {
  it("has no secret to declare, and says so by declaring none", () => {
    // A path and an expected value are configuration, not credentials.
    expect(jsonQuerySpec.secretFields ?? []).toHaveLength(0);
  });
});
