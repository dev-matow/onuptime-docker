// @covers-type: rabbitmq
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { judgeMeasurement } from "@/modules/monitors/check";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import {
  healthResult,
  healthUrl,
  rabbitmqProbe,
} from "@/modules/monitors/types/probes/rabbitmq";
import {
  rabbitmqSpec,
  rabbitmqStoredSchema,
  RABBITMQ_HEALTH_PATH,
  type RabbitmqConfig,
} from "@/modules/monitors/types/specs/rabbitmq";

/**
 * The RabbitMQ check, against a real management API.
 *
 * The fixture is an HTTP server that answers on the health-check path
 * the way a node does — including the Authorization header it demands
 * and the 503-with-a-reason it sends when an alarm is in effect. A
 * stubbed `fetch` would prove the probe calls a function; this proves it
 * builds a URL a node would route, sends a credential a node would
 * accept, and reads an answer a node would give.
 */

interface Answer {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** Hold the request open, so the probe's deadline is what ends it. */
  hang?: boolean;
}

interface Node {
  origin: string;
  /** Every request the server received, in order. */
  requests: { path: string; authorization: string | null }[];
  close(): Promise<void>;
}

/** A management API that answers `answer` on any path it is asked for. */
async function startNode(
  answer: Answer,
  options: { onlyPath?: string } = {},
): Promise<Node> {
  const requests: Node["requests"] = [];
  const server = http.createServer((request, response) => {
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization ?? null,
    });
    if (options.onlyPath !== undefined && request.url !== options.onlyPath) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"Object Not Found"}');
      return;
    }
    if (answer.hang) return;
    response.writeHead(answer.status, {
      "content-type": "application/json",
      ...answer.headers,
    });
    response.end(answer.body ?? "");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

const started: Node[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((node) => node.close()));
});

async function nodeAnswering(
  answer: Answer,
  options: { onlyPath?: string } = {},
): Promise<Node> {
  const node = await startNode(answer, options);
  started.push(node);
  return node;
}

function configOf(overrides: Partial<RabbitmqConfig> = {}): RabbitmqConfig {
  return {
    username: null,
    password: null,
    degradedThresholdMs: 3_000,
    ...overrides,
  };
}

function contextFor(
  target: string,
  overrides: Partial<ProbeContext<RabbitmqConfig>> = {},
): ProbeContext<RabbitmqConfig> {
  return {
    target,
    port: null,
    config: configOf(),
    timeoutMs: 2_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
    ...overrides,
  };
}

/** The probe's facts, put through the type's own declared assertions. */
function judgedProbe(
  result: Awaited<ReturnType<typeof rabbitmqProbe>>,
  config: RabbitmqConfig = configOf(),
) {
  return judgeMeasurement(rabbitmqSpec.assertions, config, result);
}

describe("the rabbitmq probe against a management API", () => {
  it("reports a node whose health checks pass as up", async () => {
    const node = await nodeAnswering({ status: 200, body: '{"status":"ok"}' });

    const result = await rabbitmqProbe(contextFor(node.origin));

    expect(result.facts).toMatchObject({ statusCode: 200, alarmsClear: true });
    expect(result.error).toBeNull();
    expect(judgedProbe(result).verdict).toBe("up");
  });

  it("asks for the health-check path under the base URL it was given", async () => {
    const node = await nodeAnswering({ status: 200, body: '{"status":"ok"}' });

    await rabbitmqProbe(contextFor(node.origin));

    expect(node.requests[0]?.path).toBe(RABBITMQ_HEALTH_PATH);
  });

  it("keeps a reverse proxy's path prefix instead of asking its root", async () => {
    // A management UI mounted at /rabbitmq is routine, and resolving an
    // absolute path against the base URL would throw the prefix away.
    const node = await nodeAnswering(
      { status: 200, body: '{"status":"ok"}' },
      { onlyPath: `/rabbitmq${RABBITMQ_HEALTH_PATH}` },
    );

    const result = await rabbitmqProbe(contextFor(`${node.origin}/rabbitmq/`));

    expect(result.facts).toMatchObject({ alarmsClear: true });
  });

  it("sends the stored credentials as HTTP Basic", async () => {
    const node = await nodeAnswering({ status: 200, body: '{"status":"ok"}' });

    await rabbitmqProbe(
      contextFor(node.origin, {
        config: configOf({ username: "monitoring", password: "s3cret pw" }),
      }),
    );

    const expected = Buffer.from("monitoring:s3cret pw", "utf8").toString(
      "base64",
    );
    expect(node.requests[0]?.authorization).toBe(`Basic ${expected}`);
  });

  it("sends no Authorization header when the monitor has no credentials", async () => {
    const node = await nodeAnswering({ status: 200, body: '{"status":"ok"}' });

    await rabbitmqProbe(contextFor(node.origin));

    expect(node.requests[0]?.authorization).toBeNull();
  });

  it("reports a node with a resource alarm as down, quoting its reason", async () => {
    const node = await nodeAnswering({
      status: 503,
      body: '{"status":"failed","reason":"resource alarm(s) in effect:[memory]"}',
    });

    const verdict = judgedProbe(await rabbitmqProbe(contextFor(node.origin)));

    expect(verdict.verdict).toBe("down");
    expect(verdict.failureClass).toBe("assertion");
    expect(verdict.error).toContain("resource alarm(s) in effect:[memory]");
  });

  it("still reports a failed check when the node gives no reason", async () => {
    const node = await nodeAnswering({ status: 503, body: "{}" });

    const result = await rabbitmqProbe(contextFor(node.origin));

    expect(result.facts.alarmsClear).toBe(false);
    expect(judgedProbe(result).verdict).toBe("down");
  });

  it("reports a rejected credential as misconfigured, never as an outage", async () => {
    // The broker is answering. A stored password that no longer works is
    // an operator error, and one that reads as `down` is indistinguishable
    // from the node being gone.
    const node = await nodeAnswering({ status: 401, body: "" });

    const verdict = judgedProbe(
      await rabbitmqProbe(
        contextFor(node.origin, {
          config: configOf({ username: "guest", password: "wrong" }),
        }),
      ),
    );

    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.failureClass).toBe("misconfigured");
    expect(verdict.error).toContain("refused the stored credentials");
  });

  it("reports a disabled management plugin as misconfigured", async () => {
    const node = await nodeAnswering({ status: 404, body: "" });

    const verdict = judgedProbe(await rabbitmqProbe(contextFor(node.origin)));

    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.error).toContain("management plugin is disabled");
  });

  it("reports a 200 that is not a health-check result as misconfigured", async () => {
    // A login page, a proxy's welcome banner, an SPA index. Reporting
    // that as up is the false green this branch exists to prevent.
    const node = await nodeAnswering({
      status: 200,
      body: "<html><body>Sign in</body></html>",
    });

    const verdict = judgedProbe(await rabbitmqProbe(contextFor(node.origin)));

    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.error).toContain("not with a health-check result");
  });

  it("reports a 500 from the management plugin as down", async () => {
    const node = await nodeAnswering({ status: 500, body: "" });

    const verdict = judgedProbe(await rabbitmqProbe(contextFor(node.origin)));

    expect(verdict.verdict).toBe("down");
    expect(verdict.error).toContain("answered 500");
  });

  it("refuses to follow a redirect rather than carry the credential across", async () => {
    const elsewhere = await nodeAnswering({
      status: 200,
      body: '{"status":"ok"}',
    });
    const node = await nodeAnswering({
      status: 302,
      headers: { location: `${elsewhere.origin}${RABBITMQ_HEALTH_PATH}` },
    });

    const verdict = judgedProbe(
      await rabbitmqProbe(
        contextFor(node.origin, {
          config: configOf({ username: "guest", password: "guest" }),
        }),
      ),
    );

    expect(verdict.verdict).toBe("down");
    expect(verdict.error).toContain("answered 302");
    // The credential never left the origin the operator typed.
    expect(elsewhere.requests).toHaveLength(0);
  });

  it("reports a slow but healthy node as degraded", async () => {
    const node = await nodeAnswering({ status: 200, body: '{"status":"ok"}' });
    const config = configOf({ degradedThresholdMs: 100 });

    const result = await rabbitmqProbe(
      contextFor(node.origin, { config: { ...config } }),
    );
    // The measurement is real; the threshold is what makes it degraded,
    // so the fact is overridden rather than the clock being slowed.
    const verdict = judgeMeasurement(rabbitmqSpec.assertions, config, {
      ...result,
      facts: { ...result.facts, responseTimeMs: 900 },
    });

    expect(verdict.verdict).toBe("degraded");
    expect(verdict.error).toContain("over the 100ms threshold");
  });

  it("reports a refused connection as a transport failure", async () => {
    const node = await nodeAnswering({ status: 200 });
    const origin = node.origin;
    await node.close();
    started.splice(started.indexOf(node), 1);

    const verdict = judgedProbe(await rabbitmqProbe(contextFor(origin)));

    expect(verdict.verdict).toBe("down");
    expect(verdict.failureClass).toBe("transport");
    expect(verdict.error).toMatch(/ECONNREFUSED|failed/i);
  });

  it("gives up on a node that never answers, and says how long it waited", async () => {
    const node = await nodeAnswering({ status: 200, hang: true });

    const result = await rabbitmqProbe(
      contextFor(node.origin, { timeoutMs: 250 }),
    );

    expect(result.error).toBe("Timed out after 250ms");
  });

  it("refuses a private address unless the deployment allows one", async () => {
    const node = await nodeAnswering({ status: 200, body: '{"status":"ok"}' });

    const result = await rabbitmqProbe(
      contextFor(node.origin, { allowPrivateTargets: false }),
    );

    expect(result.error).toBe("Target resolves to a private address");
    expect(node.requests).toHaveLength(0);
  });

  it("reports a target that is not a URL without dialling anything", async () => {
    const result = await rabbitmqProbe(contextFor("rabbit.example.com"));

    expect(result.error).toBe("Not a management API URL");
    expect(result.responseTimeMs).toBeNull();
  });
});

describe("reading one management API answer", () => {
  it("keeps the node's reason short and printable", () => {
    // The far end chose every byte of this, and it lands in an incident
    // email and on a status page.
    const noisy = `alarm\u0007 ${"x".repeat(400)}`;
    const result = healthResult(503, JSON.stringify({ reason: noisy }), 5);

    const reason = String(result.facts.alarmReason);
    // 200 characters, and the ellipsis that says it was cut.
    expect(reason).toHaveLength(201);
    expect(reason.endsWith("…")).toBe(true);
    expect(reason).not.toContain("\u0007");
  });

  it("trusts the body over a status code a proxy rewrote", () => {
    // A 200 carrying {"status":"failed"} is a proxy flattening the code,
    // not a healthy node.
    const result = healthResult(
      200,
      '{"status":"failed","reason":"node down"}',
      5,
    );

    expect(result.facts).toMatchObject({
      alarmsClear: false,
      alarmReason: "node down",
    });
  });

  it("appends the health path without doubling a trailing slash", () => {
    expect(healthUrl("https://rabbit.example.com:15672/")).toBe(
      `https://rabbit.example.com:15672${RABBITMQ_HEALTH_PATH}`,
    );
    expect(healthUrl("https://rabbit.example.com:15672")).toBe(
      `https://rabbit.example.com:15672${RABBITMQ_HEALTH_PATH}`,
    );
  });
});

describe("the rabbitmq type's configuration", () => {
  it("declares the password as a secret, so it never reaches a browser", () => {
    expect(rabbitmqSpec.secretFields).toContain("password");
  });

  it("refuses a password with no user name to send it with", () => {
    const parsed = rabbitmqStoredSchema.safeParse({ password: "only-a-pw" });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      "A password needs a username.",
    );
  });

  it("keeps the whitespace inside a password", () => {
    const parsed = rabbitmqStoredSchema.parse({
      username: "guest",
      password: " padded ",
    });

    expect(parsed.password).toBe(" padded ");
  });

  it("accepts an empty submission, because a monitor may have no credentials", () => {
    expect(rabbitmqStoredSchema.parse({})).toEqual({
      username: null,
      password: null,
    });
  });

  it("keeps credentials out of the line an incident email prints", () => {
    const described = rabbitmqSpec.describeTarget(
      "https://guest:hunter2@rabbit.example.com:15672",
      null,
      configOf(),
    );

    expect(described).toBe("https://rabbit.example.com:15672");
    expect(described).not.toContain("hunter2");
  });

  it("rejects a target that is not an http URL", () => {
    expect(
      rabbitmqSpec.targetSchema.safeParse("rabbit.example.com").success,
    ).toBe(false);
    expect(
      rabbitmqSpec.targetSchema.safeParse("https://rabbit.example.com:15672")
        .success,
    ).toBe(true);
  });
});
