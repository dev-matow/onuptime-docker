import { z } from "zod";

import { DEFAULT_MONGODB_PORT, mongodbDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { flatColumnsOnly, latencyAssertion } from "./shared";

export interface MongodbConfig {
  degradedThresholdMs: number;
}

export const mongodbConfigSchema: z.ZodType<MongodbConfig> = z.object({
  degradedThresholdMs: z.number().int().min(100).max(30_000),
});

const answersHello: Assertion<MongodbConfig> = {
  id: "hello",
  fact: "helloOk",
  severity: "down",
  evaluate(value) {
    // `helloOk` is the reply's `ok`, not the `helloOk: true` field a 4.4+
    // server echoes back. Anything else listening on the port — a proxy,
    // a TLS terminator, the wrong service after a compose file was
    // edited — completes the TCP connect and then fails here, which is
    // the whole reason to run this instead of a `tcp` monitor on 27017.
    return value === true
      ? null
      : "The server did not answer the hello handshake";
  },
};

export const mongodbSpec: CheckTypeSpec<MongodbConfig> = {
  descriptor: mongodbDescriptor,
  configSchema: mongodbConfigSchema,
  // No settings of its own: the port is a column and the threshold is
  // shared, so there is nothing for the config blob to hold.
  storedSchema: flatColumnsOnly,
  targetSchema: monitorHostnameSchema,
  // Nothing asserts on `isPrimary`, deliberately. A secondary answering
  // hello is a healthy member doing its job, and an election, a rolling
  // restart or a planned stepdown would each page on-call for normal
  // replica-set topology. The fact is recorded so a human can see which
  // member answered; it is not a verdict.
  assertions: [answersHello, latencyAssertion<MongodbConfig>("Handshook")],
  fromRow(row: MonitorRowView): MongodbConfig {
    return { degradedThresholdMs: row.degradedThresholdMs };
  },
  describeTarget(target, port) {
    return `${target}:${port ?? DEFAULT_MONGODB_PORT}`;
  },
};
