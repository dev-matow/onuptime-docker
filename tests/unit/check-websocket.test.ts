// @covers-type: websocket
import { createHash } from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";

import { afterAll, describe, expect, it, vi } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import { websocketProbe } from "@/modules/monitors/types/probes/websocket";
import {
  websocketSpec,
  websocketStoredSchema,
  type WebsocketConfig,
} from "@/modules/monitors/types/specs/websocket";

import { privateLookup, publicLookup } from "../probe-lookup";

/**
 * A real WebSocket endpoint, on a real socket, answering a real
 * handshake.
 *
 * The digest is computed here from RFC 6455's GUID rather than by
 * calling the probe's own helper: a fixture that shares the code under
 * test proves that two copies of one function agree, which is not what
 * this check is for. The whole value of `Sec-WebSocket-Accept` is that
 * the two sides derive it independently.
 */
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function digestFor(key: string): string {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

interface Handshake {
  headers: http.IncomingHttpHeaders;
  /** Everything the client sent after the upgrade — its Close frame. */
  frames: Buffer[];
}

interface Endpoint {
  port: number;
  handshakes: Handshake[];
  close: () => Promise<void>;
}

interface EndpointOptions {
  /** Answer with a digest that does not match the key sent. */
  wrongDigest?: boolean;
  /** Echo this subprotocol back. */
  subprotocol?: string;
  /** Refuse the upgrade with this HTTP status instead. */
  refuseWith?: number;
  /** Hold the answer back, to measure a slow handshake. */
  delayMs?: number;
}

const endpoints: Endpoint[] = [];
afterAll(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
});

async function openEndpoint(options: EndpointOptions = {}): Promise<Endpoint> {
  const handshakes: Handshake[] = [];
  // A delayed answer outlives the check that gave up on it, and
  // `server.close()` waits for every connection it still has. Both are
  // held so shutting the fixture down is immediate rather than a hook
  // that hangs for as long as the slowest test asked the server to wait.
  const pending = new Set<NodeJS.Timeout>();
  // An upgraded socket has been handed to the application, so the HTTP
  // server no longer counts it and `close()` waits for a connection it
  // will not close itself.
  const sockets = new Set<Socket>();
  // The request listener answers anything that is not an upgrade, which
  // is how a real server behind the same path replies to a browser.
  const server = http.createServer((_request, response) =>
    response.writeHead(200).end("this is an ordinary page"),
  );

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  server.on("upgrade", (request, socket: Socket) => {
    const record: Handshake = { headers: request.headers, frames: [] };
    handshakes.push(record);
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      record.frames.push(chunk);
      // A compliant endpoint answers a Close by closing.
      socket.destroy();
    });

    const answer = () => {
      if (options.refuseWith !== undefined) {
        socket.end(
          `HTTP/1.1 ${options.refuseWith} Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        );
        return;
      }
      const key = String(request.headers["sec-websocket-key"] ?? "");
      const accept = options.wrongDigest
        ? "0000000000000000000000000000"
        : digestFor(key);
      const lines = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
      ];
      if (options.subprotocol !== undefined) {
        lines.push(`Sec-WebSocket-Protocol: ${options.subprotocol}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    };

    if (options.delayMs === undefined) answer();
    else pending.add(setTimeout(answer, options.delayMs));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const endpoint: Endpoint = {
    port: typeof address === "object" && address ? address.port : 0,
    handshakes,
    close: () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  endpoints.push(endpoint);
  return endpoint;
}

/** The config a stored row produces, so every test judges what a monitor would. */
function configFrom(stored: Record<string, unknown> | null): WebsocketConfig {
  return websocketSpec.fromRow({
    checkType: "websocket",
    url: "wss://example.com/socket",
    port: null,
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 5_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    tlsCheck: false,
    tlsWarnDays: 14,
    config: stored,
  });
}

function context(
  target: string,
  overrides: Partial<ProbeContext<WebsocketConfig>> = {},
  config: Partial<WebsocketConfig> = {},
): ProbeContext<WebsocketConfig> {
  return {
    target,
    port: null,
    config: { ...configFrom(null), ...config },
    timeoutMs: 5_000,
    allowPrivateTargets: true,
    // A probe that quietly went through `fetch` would be one the tests
    // below could not tell apart from one that spoke the protocol.
    fetchImpl: vi.fn(() => {
      throw new Error("a WebSocket handshake never goes through fetch");
    }),
    lookup: publicLookup,
    ...overrides,
  };
}

function verdict(
  config: WebsocketConfig,
  result: Awaited<ReturnType<typeof websocketProbe>>,
) {
  return judge(websocketSpec.assertions, config, result);
}

describe("websocketProbe", () => {
  it("completes the handshake and reports the digest as matching", async () => {
    const endpoint = await openEndpoint();

    const result = await websocketProbe(
      context(`ws://127.0.0.1:${endpoint.port}/socket`),
    );

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      statusCode: 101,
      acceptValid: true,
      subprotocol: null,
    });
    expect(typeof result.responseTimeMs).toBe("number");
    expect(verdict(configFrom(null), result).verdict).toBe("up");
  });

  it("asks for the path and the host the operator typed", async () => {
    const endpoint = await openEndpoint();

    await websocketProbe(context(`ws://127.0.0.1:${endpoint.port}/live/feed`));

    const [handshake] = endpoint.handshakes;
    expect(handshake?.headers.upgrade).toBe("websocket");
    expect(handshake?.headers["sec-websocket-version"]).toBe("13");
    expect(handshake?.headers.host).toBe(`127.0.0.1:${endpoint.port}`);
  });

  it("closes the upgraded socket with a Close frame instead of resetting it", async () => {
    // A monitor that resets an upgraded connection writes an error into
    // the monitored server's log on every interval, which is how a
    // server's logs become unreadable.
    const endpoint = await openEndpoint();

    await websocketProbe(context(`ws://127.0.0.1:${endpoint.port}/socket`));
    await vi.waitFor(() =>
      expect(endpoint.handshakes[0]?.frames.length).toBeGreaterThan(0),
    );

    const frame = Buffer.concat(endpoint.handshakes[0]?.frames ?? []);
    // 0x88: FIN plus opcode 8 (Close). 0x80: masked, zero-length payload
    // — RFC 6455 requires every frame a client sends to be masked, and a
    // compliant server closes on an unmasked one.
    expect(frame.subarray(0, 2)).toEqual(Buffer.from([0x88, 0x80]));
    expect(frame).toHaveLength(6);
  });

  it("reports a handshake whose digest does not match the key as down", async () => {
    const endpoint = await openEndpoint({ wrongDigest: true });

    const result = await websocketProbe(
      context(`ws://127.0.0.1:${endpoint.port}/socket`),
    );

    expect(result.error).toBeNull(); // nothing failed at the transport
    expect(result.facts.acceptValid).toBe(false);
    expect(verdict(configFrom(null), result)).toMatchObject({
      verdict: "down",
      failureClass: "assertion",
      failedAssertions: ["accept-key"],
    });
  });

  it("sends the subprotocol the operator asked for and reports the one negotiated", async () => {
    const endpoint = await openEndpoint({ subprotocol: "graphql-ws" });
    const config = configFrom({ subprotocol: "graphql-ws" });

    const result = await websocketProbe(
      context(`ws://127.0.0.1:${endpoint.port}/socket`, {}, config),
    );

    expect(endpoint.handshakes[0]?.headers["sec-websocket-protocol"]).toBe(
      "graphql-ws",
    );
    expect(result.facts.subprotocol).toBe("graphql-ws");
    expect(verdict(config, result).verdict).toBe("up");
  });

  it("reports a handshake that ignored the requested subprotocol as down", async () => {
    // The server upgraded, so a check that only watched the status code
    // would be green — while every client that needs that subprotocol
    // fails on connect.
    const endpoint = await openEndpoint();
    const config = configFrom({ subprotocol: "graphql-ws" });

    const result = await websocketProbe(
      context(`ws://127.0.0.1:${endpoint.port}/socket`, {}, config),
    );

    expect(verdict(config, result)).toMatchObject({
      verdict: "down",
      error:
        'The server accepted the upgrade without the "graphql-ws" subprotocol',
    });
  });

  it("reports a server that answers the wrong subprotocol as down", async () => {
    const endpoint = await openEndpoint({ subprotocol: "mqtt" });
    const config = configFrom({ subprotocol: "graphql-ws" });

    const result = await websocketProbe(
      context(`ws://127.0.0.1:${endpoint.port}/socket`, {}, config),
    );

    expect(verdict(config, result).error).toBe(
      'Expected the "graphql-ws" subprotocol, got "mqtt"',
    );
  });

  it("sends the stored Authorization header", async () => {
    const endpoint = await openEndpoint();
    const config = configFrom({ authorization: "Bearer s3cret-token" });

    await websocketProbe(
      context(`ws://127.0.0.1:${endpoint.port}/socket`, {}, config),
    );

    expect(endpoint.handshakes[0]?.headers.authorization).toBe(
      "Bearer s3cret-token",
    );
  });

  it("reports a refused upgrade as a status code, not as a transport failure", async () => {
    // The distinction matters downstream: a transport failure is "we
    // could not reach it", an assertion failure is "we reached it and it
    // said no". A 401 is the second one, and an operator reading the
    // incident needs to know the server answered.
    const endpoint = await openEndpoint({ refuseWith: 401 });

    const result = await websocketProbe(
      context(`ws://127.0.0.1:${endpoint.port}/socket`),
    );

    expect(result.error).toBeNull();
    expect(result.statusCode).toBe(401);
    expect(verdict(configFrom(null), result)).toMatchObject({
      verdict: "down",
      failureClass: "assertion",
      error: "Expected 101 Switching Protocols, got 401",
    });
  });

  it("reports a slow handshake as degraded rather than down", async () => {
    const endpoint = await openEndpoint({ delayMs: 60 });
    const config = configFrom(null);
    config.degradedThresholdMs = 10;

    const result = await websocketProbe(
      context(`ws://127.0.0.1:${endpoint.port}/socket`, {}, config),
    );

    expect(verdict(config, result)).toMatchObject({
      verdict: "degraded",
      ok: true,
      failedAssertions: ["latency"],
    });
  });

  it("reports a port with nothing listening as a transport failure", async () => {
    const endpoint = await openEndpoint();
    await endpoint.close();

    const result = await websocketProbe(
      context(`ws://127.0.0.1:${endpoint.port}/socket`),
    );

    expect(result.error).toContain("ECONNREFUSED");
    expect(verdict(configFrom(null), result).failureClass).toBe("transport");
  });

  it("gives up on a server that never answers the handshake", async () => {
    const endpoint = await openEndpoint({ delayMs: 5_000 });

    const result = await websocketProbe(
      context(`ws://127.0.0.1:${endpoint.port}/socket`, { timeoutMs: 200 }),
    );

    expect(result.error).toBe("Timed out after 200ms");
    expect(result.facts.statusCode).toBeUndefined();
  });

  it("refuses a target that resolves into private space", async () => {
    const result = await websocketProbe(
      context("wss://internal.example.com/socket", {
        allowPrivateTargets: false,
        lookup: privateLookup,
      }),
    );

    expect(result).toMatchObject({
      error: "Target resolves to a private address",
      responseTimeMs: null,
      facts: {},
    });
  });

  it("refuses a target that is not a WebSocket URL", async () => {
    // A row can predate the target schema or survive a downgrade, and a
    // `new URL` throwing on the worker's hot path would escape the probe.
    const result = await websocketProbe(context("https://example.com/socket"));

    expect(result.error).toBe("Not a WebSocket URL — expected ws:// or wss://");
  });
});

describe("the websocket type's stored settings", () => {
  it("accepts an empty submission, so a monitor can be created without them", () => {
    expect(websocketStoredSchema.parse({})).toEqual({
      subprotocol: null,
      authorization: null,
    });
  });

  it("treats a cleared field as unset rather than as an empty header", () => {
    expect(
      websocketStoredSchema.parse({ subprotocol: "", authorization: "" }),
    ).toEqual({ subprotocol: null, authorization: null });
  });

  it("refuses an Authorization value carrying a line break", () => {
    // The value is written into the handshake request as-is, so a
    // newline would let whoever can edit a monitor append headers of
    // their own to a request Vigil makes.
    const parsed = websocketStoredSchema.safeParse({
      authorization: "Bearer x\r\nX-Injected: 1",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("line breaks");
  });

  it("refuses a subprotocol that is not a single token", () => {
    expect(
      websocketStoredSchema.safeParse({ subprotocol: "graphql ws" }).success,
    ).toBe(false);
  });

  it("declares the Authorization header as a secret", () => {
    // Without this the value is serialised into the edit dialog's props,
    // where anyone who can open the page can read it.
    expect(websocketSpec.secretFields).toEqual(["authorization"]);
  });

  it("survives a config blob this build cannot read", () => {
    expect(configFrom(null)).toMatchObject({ subprotocol: null });
    expect(() => configFrom({ subprotocol: 42 })).not.toThrow();
  });
});

describe("what a websocket monitor shows outside Vigil", () => {
  it("keeps a query-string token out of the line incidents print", () => {
    // A browser cannot set an Authorization header on a WebSocket, so
    // `?token=` is the ordinary way these endpoints authenticate — and
    // this string goes into incident emails, webhook bodies and public
    // status pages.
    expect(
      websocketSpec.describeTarget(
        "wss://example.com/socket?token=abcd1234",
        null,
        configFrom(null),
      ),
    ).toBe("wss://example.com/socket");
  });

  it("keeps userinfo out of it too", () => {
    expect(
      websocketSpec.describeTarget(
        "wss://user:hunter2@example.com/socket",
        null,
        configFrom(null),
      ),
    ).toBe("wss://example.com/socket");
  });
});

/**
 * What the operator's target field accepts, and what it says when it
 * does not. The monitor form renders this type's label, placeholder and
 * help from the descriptor and puts the message below the field; the
 * end-to-end path through `createMonitorSchema` is covered in
 * `tests/integration/check-websocket-grpc.test.ts`, which needs the type
 * registered.
 */
describe("the target a websocket monitor accepts", () => {
  it.each([
    "wss://example.com/socket",
    "ws://socket.example.com/live?room=42",
    "wss://example.com:8443/socket",
  ])("accepts %s", (target) => {
    expect(websocketSpec.targetSchema.safeParse(target).success).toBe(true);
  });

  it("tells the operator what the field wants when the scheme is https", () => {
    // The message is the only route an operator has to fixing this, and
    // "Invalid URL" would send them looking at the host.
    const parsed = websocketSpec.targetSchema.safeParse(
      "https://example.com/socket",
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("ws://");
  });

  it("refuses a bare hostname", () => {
    expect(websocketSpec.targetSchema.safeParse("example.com").success).toBe(
      false,
    );
  });

  it("refuses the cloud metadata endpoint by name", () => {
    expect(
      websocketSpec.targetSchema.safeParse(
        "ws://metadata.google.internal/socket",
      ).success,
    ).toBe(false);
  });
});
