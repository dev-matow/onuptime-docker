import { z } from "zod";

import { DEFAULT_GRPC_PORT, grpcDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * The method every gRPC server is expected to expose, from the health
 * checking protocol that ships with gRPC itself. Watching it rather than
 * one of the server's own RPCs is what makes this type generic: no
 * `.proto` file to upload, no method signature to configure, and the one
 * call that is safe to make against production every interval.
 */
export const HEALTH_METHOD = "/grpc.health.v1.Health/Check";

/**
 * gRPC reports failure in a trailer, not in the HTTP status: a call that
 * was refused, timed out or hit a method that does not exist still comes
 * back as 200. Anything else means whatever answered the port was not
 * speaking gRPC at all.
 */
export const GRPC_HTTP_STATUS = 200;

export const GRPC_OK = 0;
export const GRPC_NOT_FOUND = 5;
export const GRPC_UNIMPLEMENTED = 12;

/**
 * The canonical status names, so a failure reads as `PERMISSION_DENIED`
 * rather than as `7`. Written out rather than derived: these are wire
 * constants an operator will search the gRPC documentation for, and the
 * numbers are the only thing the server actually sends.
 */
const GRPC_STATUS_NAMES: Readonly<Record<number, string>> = {
  0: "OK",
  1: "CANCELLED",
  2: "UNKNOWN",
  3: "INVALID_ARGUMENT",
  4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND",
  6: "ALREADY_EXISTS",
  7: "PERMISSION_DENIED",
  8: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION",
  10: "ABORTED",
  11: "OUT_OF_RANGE",
  12: "UNIMPLEMENTED",
  13: "INTERNAL",
  14: "UNAVAILABLE",
  15: "DATA_LOSS",
  16: "UNAUTHENTICATED",
};

export function grpcStatusName(code: number): string {
  return GRPC_STATUS_NAMES[code] ?? `status ${code}`;
}

/** What the health protocol says a server may answer with. */
export const SERVING = "SERVING";

export interface GrpcConfig {
  /**
   * The service to ask about. Empty means the server as a whole, which
   * is what the health protocol defines an empty name to mean and the
   * right default: a server that is up but has not registered any
   * service is still a server that is up.
   */
  service: string;
  /**
   * Whether the HTTP/2 connection runs over TLS. A flag rather than a
   * scheme in the target, because the target is a bare hostname here —
   * `grpc://` is not a URL scheme anything else in the ecosystem
   * accepts, and inventing one would put a second, private syntax in a
   * field every other host-shaped type validates the same way.
   */
  tls: boolean;
  /**
   * Sent as `authorization` metadata. gRPC carries credentials in
   * headers exactly as HTTP does, so a bearer token belongs here rather
   * than in the target.
   */
  authorization: string | null;
  degradedThresholdMs: number;
}

/** A protobuf fully-qualified service name: dotted identifiers. */
const SERVICE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** No CR, LF or NUL: the value goes into a header frame verbatim. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/;

export const grpcStoredSchema = z.object({
  service: z
    .string()
    .trim()
    .max(200)
    .default("")
    .refine((value) => value === "" || SERVICE_NAME.test(value), {
      message:
        "A service name looks like grpc.health.v1.Health. Leave it empty to ask about the whole server.",
    }),
  tls: z.boolean().default(false),
  authorization: z
    .string()
    .trim()
    .max(2048)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null))
    .refine((value) => value === null || HEADER_VALUE.test(value), {
      message:
        "An authorization value cannot contain line breaks or control characters.",
    }),
});

export const grpcConfigSchema: z.ZodType<GrpcConfig> = z.object({
  service: z.string().max(200),
  tls: z.boolean(),
  authorization: z.string().max(2048).nullable(),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

const answeredAsGrpc: Assertion<GrpcConfig> = {
  id: "http-status",
  fact: "httpStatus",
  severity: "down",
  evaluate(value) {
    if (typeof value !== "number") return null;
    return value === GRPC_HTTP_STATUS
      ? null
      : `The server answered HTTP ${value}; a gRPC endpoint answers 200 and reports failure in its trailers`;
  },
};

const healthCallSucceeded: Assertion<GrpcConfig> = {
  id: "grpc-status",
  fact: "grpcStatus",
  severity: "down",
  evaluate(value, config) {
    // Explicitly null — as opposed to absent — is the answer that
    // arrived with no `grpc-status` anywhere in it. That is a working
    // HTTP/2 server that is not a gRPC one, and it is the case a check
    // built only on "did it answer 200" reports as healthy for ever.
    if (value === null) {
      return "The answer carried no grpc-status, so whatever is on this port is not speaking gRPC";
    }
    if (typeof value !== "number") return null;
    if (value === GRPC_OK) return null;
    if (value === GRPC_UNIMPLEMENTED) {
      return `The server does not implement ${HEALTH_METHOD}`;
    }
    if (value === GRPC_NOT_FOUND) {
      return config.service === ""
        ? "The server does not report a health status for itself"
        : `The server does not know the service "${config.service}"`;
    }
    return `The health check failed with ${grpcStatusName(value)}`;
  },
};

const reportsServing: Assertion<GrpcConfig> = {
  id: "serving",
  fact: "servingStatus",
  severity: "down",
  evaluate(value, config) {
    // Absent whenever the call itself failed: the assertion above has
    // named that, and a server that answered UNIMPLEMENTED owes no body.
    if (value === undefined) return null;
    const subject =
      config.service === "" ? "The server" : `"${config.service}"`;
    // Null is a successful call whose body could not be read — an OK
    // that says nothing is not the same as an OK that says SERVING, and
    // treating it as healthy is how a monitor goes green against a
    // half-implemented endpoint.
    if (value === null) {
      return `${subject} answered OK without a health status`;
    }
    if (typeof value !== "string") return null;
    return value === SERVING ? null : `${subject} reports ${value}`;
  },
};

export const grpcSpec: CheckTypeSpec<GrpcConfig> = {
  descriptor: grpcDescriptor,
  configSchema: grpcConfigSchema,
  storedSchema: grpcStoredSchema,
  secretFields: ["authorization"],
  targetSchema: monitorHostnameSchema,
  assertions: [
    answeredAsGrpc,
    healthCallSucceeded,
    reportsServing,
    latencyAssertion<GrpcConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): GrpcConfig {
    const stored = grpcStoredSchema.safeParse(row.config ?? {});
    return {
      service: stored.success ? stored.data.service : "",
      tls: stored.success ? stored.data.tls : false,
      authorization: stored.success ? stored.data.authorization : null,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  // The credential lives in the config, never in the target. The service
  // is worth printing next to the host: two monitors on one endpoint
  // differ only by which service they ask about, and an incident that
  // does not say which one is an incident somebody has to go and look up.
  describeTarget(target, port, config) {
    const host = `${target}:${port ?? DEFAULT_GRPC_PORT}`;
    return config.service === "" ? host : `${host} (${config.service})`;
  },
};
