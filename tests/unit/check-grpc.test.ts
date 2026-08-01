// @covers-type: grpc
import http2 from "node:http2";

import { afterAll, describe, expect, it, vi } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import { grpcProbe } from "@/modules/monitors/types/probes/grpc";
import {
  grpcSpec,
  grpcStoredSchema,
  HEALTH_METHOD,
  type GrpcConfig,
} from "@/modules/monitors/types/specs/grpc";

import { privateLookup, publicLookup } from "../probe-lookup";

/**
 * A real gRPC health service, on a real HTTP/2 socket.
 *
 * It decodes the request message itself rather than importing the
 * probe's encoder: the point of a protocol fixture is that both ends
 * were written to the specification, not to each other. If the encoder
 * were wrong, a fixture that shared it would agree with it.
 */
const SERVING = 1;
const NOT_SERVING = 2;

interface Call {
  headers: http2.IncomingHttpHeaders;
  /** The service name decoded out of the request message. */
  service: string;
}

interface Endpoint {
  port: number;
  calls: Call[];
  close: () => Promise<void>;
}

interface EndpointOptions {
  /** Serving status per service name; the empty name is the server itself. */
  statuses?: Record<string, number>;
  /** Answer every call with this status in a trailers-only response. */
  refuseWith?: number;
  /** Answer 200 with a body but no grpc-status anywhere. */
  notGrpc?: boolean;
  /** Put a field this build does not know in front of the status. */
  unknownField?: boolean;
  /** Never answer at all. */
  silent?: boolean;
}

const endpoints: Endpoint[] = [];
afterAll(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
});

/** `HealthCheckRequest`, read the way a gRPC server reads one. */
function decodeRequest(frame: Buffer): string {
  if (frame.length < 5) return "";
  const length = frame.readUInt32BE(1);
  const message = frame.subarray(5, 5 + length);
  // Field 1, wire type 2 — the only field the message has.
  if (message.length === 0 || message.readUInt8(0) !== 0x0a) return "";
  const nameLength = message.readUInt8(1);
  return message.subarray(2, 2 + nameLength).toString("utf8");
}

/** `HealthCheckResponse`, in a gRPC length-prefixed frame. */
function encodeResponse(status: number, unknownField: boolean): Buffer {
  const message = unknownField
    ? // Field 15, wire type 2: a string this build has never heard of,
      // sitting in front of the field it does read.
      Buffer.from([0x7a, 0x03, 0x61, 0x62, 0x63, 0x08, status])
    : Buffer.from([0x08, status]);
  const frame = Buffer.alloc(5 + message.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(message.length, 1);
  message.copy(frame, 5);
  return frame;
}

async function openEndpoint(options: EndpointOptions = {}): Promise<Endpoint> {
  const calls: Call[] = [];
  const open = new Set<http2.ServerHttp2Stream>();
  const server = http2.createServer();

  server.on(
    "stream",
    (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
      open.add(stream);
      stream.once("close", () => open.delete(stream));
      stream.once("error", () => undefined);
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.once("end", () => {
        const service = decodeRequest(Buffer.concat(chunks));
        calls.push({ headers, service });
        if (options.silent) return;

        if (headers[":path"] !== HEALTH_METHOD) {
          // 12 UNIMPLEMENTED, as a trailers-only response — what a server
          // with no health service actually sends.
          stream.respond(
            {
              ":status": 200,
              "grpc-status": "12",
              "grpc-message": "unknown%20method",
            },
            { endStream: true },
          );
          return;
        }
        if (options.notGrpc) {
          stream.respond({
            ":status": 200,
            "content-type": "application/json",
          });
          stream.end('{"status":"ok"}');
          return;
        }
        if (options.refuseWith !== undefined) {
          stream.respond(
            { ":status": 200, "grpc-status": String(options.refuseWith) },
            { endStream: true },
          );
          return;
        }
        const status = options.statuses?.[service];
        if (status === undefined) {
          // 5 NOT_FOUND is what the health protocol says an unregistered
          // service name gets.
          stream.respond(
            { ":status": 200, "grpc-status": "5" },
            { endStream: true },
          );
          return;
        }
        stream.respond(
          { ":status": 200, "content-type": "application/grpc" },
          { waitForTrailers: true },
        );
        stream.once("wantTrailers", () =>
          stream.sendTrailers({ "grpc-status": "0" }),
        );
        stream.end(encodeResponse(status, options.unknownField ?? false));
      });
    },
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const endpoint: Endpoint = {
    port: typeof address === "object" && address ? address.port : 0,
    calls,
    close: () => {
      // A stream the fixture was told never to answer keeps its session
      // open, and `close()` waits for every session it has.
      for (const stream of open) stream.destroy();
      open.clear();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  endpoints.push(endpoint);
  return endpoint;
}

function configFrom(stored: Record<string, unknown> | null): GrpcConfig {
  return grpcSpec.fromRow({
    checkType: "grpc",
    url: "api.example.com",
    port: 50051,
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
  port: number,
  overrides: Partial<ProbeContext<GrpcConfig>> = {},
  config: Partial<GrpcConfig> = {},
): ProbeContext<GrpcConfig> {
  return {
    target: "127.0.0.1",
    port,
    config: { ...configFrom(null), ...config },
    timeoutMs: 5_000,
    allowPrivateTargets: true,
    // gRPC is HTTP/2 all the way down, and `fetch` cannot speak it with
    // trailers. A probe that reached for one anyway would be measuring
    // something else.
    fetchImpl: vi.fn(() => {
      throw new Error("a gRPC call never goes through fetch");
    }),
    lookup: publicLookup,
    ...overrides,
  };
}

function verdict(
  config: GrpcConfig,
  result: Awaited<ReturnType<typeof grpcProbe>>,
) {
  return judge(grpcSpec.assertions, config, result);
}

describe("grpcProbe", () => {
  it("reports the server as serving when the health service says so", async () => {
    const endpoint = await openEndpoint({ statuses: { "": SERVING } });
    const config = configFrom(null);

    const result = await grpcProbe(context(endpoint.port, {}, config));

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      httpStatus: 200,
      grpcStatus: 0,
      servingStatus: "SERVING",
    });
    expect(result.statusCode).toBe(200);
    expect(verdict(config, result).verdict).toBe("up");
  });

  it("calls the health method with the metadata gRPC requires", async () => {
    const endpoint = await openEndpoint({ statuses: { "": SERVING } });

    await grpcProbe(context(endpoint.port));

    const [call] = endpoint.calls;
    expect(call?.headers[":path"]).toBe(HEALTH_METHOD);
    expect(call?.headers[":method"]).toBe("POST");
    expect(call?.headers["content-type"]).toBe("application/grpc+proto");
    // Without `te: trailers` a server is not obliged to send the trailer
    // the call's result arrives in.
    expect(call?.headers.te).toBe("trailers");
    // The server's own deadline, so a call this probe stopped waiting
    // for stops costing the monitored server anything.
    expect(call?.headers["grpc-timeout"]).toBe("5000m");
  });

  it("asks about the service the operator named", async () => {
    const endpoint = await openEndpoint({
      statuses: { "orders.v1.Orders": SERVING },
    });
    const config = configFrom({ service: "orders.v1.Orders" });

    const result = await grpcProbe(context(endpoint.port, {}, config));

    expect(endpoint.calls[0]?.service).toBe("orders.v1.Orders");
    expect(verdict(config, result).verdict).toBe("up");
  });

  it("asks about the server itself when no service is named", async () => {
    const endpoint = await openEndpoint({ statuses: { "": SERVING } });

    await grpcProbe(context(endpoint.port));

    // The empty name is the health protocol's way of saying "the whole
    // server", and an empty protobuf message is how it goes on the wire.
    expect(endpoint.calls[0]?.service).toBe("");
  });

  it("reports a service that says it is not serving as down", async () => {
    const endpoint = await openEndpoint({
      statuses: { "orders.v1.Orders": NOT_SERVING },
    });
    const config = configFrom({ service: "orders.v1.Orders" });

    const result = await grpcProbe(context(endpoint.port, {}, config));

    expect(result.facts.servingStatus).toBe("NOT_SERVING");
    expect(verdict(config, result)).toMatchObject({
      verdict: "down",
      failureClass: "assertion",
      error: '"orders.v1.Orders" reports NOT_SERVING',
    });
  });

  it("reports a server with no health service as down, in its own words", async () => {
    // The answer arrives as a trailers-only response — status in the
    // HEADERS frame, no body at all. A client that only read trailers
    // would see a successful call with nothing in it.
    const endpoint = await openEndpoint({ refuseWith: 12 });
    const config = configFrom(null);

    const result = await grpcProbe(context(endpoint.port, {}, config));

    expect(result.facts).toMatchObject({ httpStatus: 200, grpcStatus: 12 });
    expect(result.facts.servingStatus).toBeUndefined();
    expect(verdict(config, result).error).toBe(
      `The server does not implement ${HEALTH_METHOD}`,
    );
  });

  it("reports a service the server does not know as down, naming it", async () => {
    const endpoint = await openEndpoint({ statuses: { "": SERVING } });
    const config = configFrom({ service: "typo.v1.Service" });

    const result = await grpcProbe(context(endpoint.port, {}, config));

    expect(verdict(config, result).error).toBe(
      'The server does not know the service "typo.v1.Service"',
    );
  });

  it("reports the message the server sent with a failure", async () => {
    const endpoint = await openEndpoint({ refuseWith: 7 });

    const result = await grpcProbe(context(endpoint.port));

    expect(result.facts.grpcStatus).toBe(7);
    expect(verdict(configFrom(null), result).error).toBe(
      "The health check failed with PERMISSION_DENIED",
    );
  });

  it("reports an HTTP/2 server that is not gRPC as down", async () => {
    // This is the hole a check built on "did it answer 200" leaves: an
    // ordinary web server on the port answers perfectly and reports
    // nothing about any service.
    const endpoint = await openEndpoint({ notGrpc: true });
    const config = configFrom(null);

    const result = await grpcProbe(context(endpoint.port, {}, config));

    expect(result.facts).toMatchObject({ httpStatus: 200, grpcStatus: null });
    expect(verdict(config, result)).toMatchObject({
      verdict: "down",
      error:
        "The answer carried no grpc-status, so whatever is on this port is not speaking gRPC",
    });
  });

  it("reads the serving status past a field this build does not know", async () => {
    // A later version of the message may add fields. A monitor that
    // stopped reading because one appeared would be a self-inflicted
    // outage.
    const endpoint = await openEndpoint({
      statuses: { "": SERVING },
      unknownField: true,
    });

    const result = await grpcProbe(context(endpoint.port));

    expect(result.facts.servingStatus).toBe("SERVING");
  });

  it("sends the stored authorization as metadata", async () => {
    const endpoint = await openEndpoint({ statuses: { "": SERVING } });
    const config = configFrom({ authorization: "Bearer s3cret-grpc" });

    await grpcProbe(context(endpoint.port, {}, config));

    expect(endpoint.calls[0]?.headers.authorization).toBe("Bearer s3cret-grpc");
  });

  it("reports a slow answer as degraded rather than down", async () => {
    const endpoint = await openEndpoint({ statuses: { "": SERVING } });
    const config = configFrom(null);
    // Every real call takes longer than this, which is the point: the
    // threshold is what separates slow from broken, and slow is still up.
    config.degradedThresholdMs = 0.5;

    const result = await grpcProbe(context(endpoint.port, {}, config));

    expect(verdict(config, result)).toMatchObject({
      verdict: "degraded",
      ok: true,
      failedAssertions: ["latency"],
    });
  });

  it("reports a port with nothing listening as a transport failure", async () => {
    const endpoint = await openEndpoint();
    await endpoint.close();

    const result = await grpcProbe(context(endpoint.port));

    expect(result.error).toContain("ECONNREFUSED");
    expect(verdict(configFrom(null), result)).toMatchObject({
      failureClass: "transport",
      verdict: "down",
    });
  });

  it("gives up on a server that never answers", async () => {
    const endpoint = await openEndpoint({ silent: true });

    const result = await grpcProbe(context(endpoint.port, { timeoutMs: 300 }));

    expect(result.error).toBe("Timed out after 300ms");
    expect(result.facts.httpStatus).toBeUndefined();
  });

  it("fails rather than falls back when TLS is asked for and the port is plaintext", async () => {
    // The opposite mistake — plaintext against a TLS port — is the same
    // shape. Both have to be reported, because silently downgrading
    // would mean the monitor is not watching what the operator asked for.
    const endpoint = await openEndpoint({ statuses: { "": SERVING } });
    const config = configFrom({ tls: true });

    const result = await grpcProbe(
      context(endpoint.port, { timeoutMs: 2_000 }, config),
    );

    expect(result.error).not.toBeNull();
    expect(result.facts.httpStatus).toBeUndefined();
    expect(verdict(config, result).failureClass).toBe("transport");
  });

  it("refuses a target that resolves into private space", async () => {
    const result = await grpcProbe(
      context(50_051, {
        target: "internal.example.com",
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
});

describe("the grpc type's stored settings", () => {
  it("accepts an empty submission, so a monitor can be created without them", () => {
    expect(grpcStoredSchema.parse({})).toEqual({
      service: "",
      tls: false,
      authorization: null,
    });
  });

  it("refuses an authorization value carrying a line break", () => {
    const parsed = grpcStoredSchema.safeParse({
      authorization: "Bearer x\nx-injected: 1",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("line breaks");
  });

  it("refuses something that is not a protobuf service name", () => {
    const parsed = grpcStoredSchema.safeParse({ service: "/grpc.health.v1" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("grpc.health.v1.Health");
  });

  it("declares the authorization metadata as a secret", () => {
    expect(grpcSpec.secretFields).toEqual(["authorization"]);
  });

  it("survives a config blob this build cannot read", () => {
    expect(() => configFrom({ tls: "yes please" })).not.toThrow();
    expect(configFrom({ tls: "yes please" })).toMatchObject({ tls: false });
  });
});

describe("what a grpc monitor shows outside Vigil", () => {
  it("names the service alongside the host", () => {
    // Two monitors on one endpoint differ only by which service they ask
    // about, and an incident that does not say which is one somebody has
    // to go and look up.
    expect(
      grpcSpec.describeTarget(
        "api.example.com",
        50_051,
        configFrom({ service: "orders.v1.Orders" }),
      ),
    ).toBe("api.example.com:50051 (orders.v1.Orders)");
  });

  it("shows the port even when it is the default", () => {
    expect(
      grpcSpec.describeTarget("api.example.com", null, configFrom(null)),
    ).toBe("api.example.com:50051");
  });
});

describe("the target a grpc monitor accepts", () => {
  it("accepts a bare hostname", () => {
    expect(grpcSpec.targetSchema.safeParse("api.example.com").success).toBe(
      true,
    );
  });

  it.each(["grpc://api.example.com", "api.example.com:50051", "10.0.0.1"])(
    "refuses %s",
    (target) => {
      expect(grpcSpec.targetSchema.safeParse(target).success).toBe(false);
    },
  );
});
