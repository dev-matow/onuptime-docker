// @covers-type: kafka-producer
import net from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { judgeMeasurement } from "@/modules/monitors/check";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import {
  crc32c,
  kafkaProducerProbe,
} from "@/modules/monitors/types/probes/kafka-producer";
import {
  DEFAULT_KAFKA_MESSAGE,
  kafkaProducerSpec,
  kafkaProducerStoredSchema,
  type KafkaProducerConfig,
} from "@/modules/monitors/types/specs/kafka-producer";

/**
 * The Kafka producer check, against a broker that speaks the protocol.
 *
 * The fixture below is a TCP server that frames requests the way Kafka
 * does, parses the four request types this probe sends, and answers them
 * in the wire format the probe parses back. It decodes the record batch
 * it is sent and recomputes its checksum, so "the message was produced"
 * means the bytes on the wire were a v2 record batch carrying the
 * configured message — not that a mock was called.
 *
 * That is the point of doing it this way. Every interesting failure of
 * this type is a protocol failure: a checksum computed with the wrong
 * polynomial, a length prefix off by four, a produce sent to a follower.
 * None of them are observable through a stubbed client.
 */

/* ------------------------------------------------------------------ *
 * Wire codecs — written for the fixture, not shared with the probe
 * ------------------------------------------------------------------ */

class Writer {
  private readonly parts: Buffer[] = [];

  int8(value: number): this {
    this.parts.push(Buffer.from([value & 0xff]));
    return this;
  }

  int16(value: number): this {
    const buffer = Buffer.alloc(2);
    buffer.writeInt16BE(value, 0);
    this.parts.push(buffer);
    return this;
  }

  int32(value: number): this {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value, 0);
    this.parts.push(buffer);
    return this;
  }

  int64(value: bigint): this {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(value, 0);
    this.parts.push(buffer);
    return this;
  }

  string(value: string): this {
    const bytes = Buffer.from(value, "utf8");
    return this.int16(bytes.length).raw(bytes);
  }

  nullableString(value: string | null): this {
    return value === null ? this.int16(-1) : this.string(value);
  }

  bytes(value: Buffer): this {
    return this.int32(value.length).raw(value);
  }

  raw(value: Buffer): this {
    this.parts.push(value);
    return this;
  }

  build(): Buffer {
    return Buffer.concat(this.parts);
  }
}

class Cursor {
  offset = 0;

  constructor(readonly buffer: Buffer) {}

  int8(): number {
    const value = this.buffer.readInt8(this.offset);
    this.offset += 1;
    return value;
  }

  int16(): number {
    const value = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  int32(): number {
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  uint32(): number {
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  int64(): bigint {
    const value = this.buffer.readBigInt64BE(this.offset);
    this.offset += 8;
    return value;
  }

  string(): string | null {
    const length = this.int16();
    if (length < 0) return null;
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value.toString("utf8");
  }

  bytes(): Buffer {
    const length = this.int32();
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  /** A zigzag varint, as the v2 record format carries every length. */
  varint(): number {
    let raw = 0;
    let shift = 0;
    for (;;) {
      const byte = this.buffer.readUInt8(this.offset);
      this.offset += 1;
      raw |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return (raw >>> 1) ^ -(raw & 1);
  }
}

interface DecodedBatch {
  value: string;
  /** Whether the CRC-32C in the batch matches the bytes it covers. */
  checksumValid: boolean;
  magic: number;
  recordCount: number;
  keyIsNull: boolean;
}

/**
 * Decodes a v2 record batch the way a broker does, checksum included.
 *
 * A broker answers CORRUPT_MESSAGE when this does not add up, so a
 * fixture that skipped the checksum would accept a batch a real cluster
 * refuses.
 */
function decodeRecordBatch(records: Buffer): DecodedBatch {
  const cursor = new Cursor(records);
  cursor.int64(); // base offset
  const batchLength = cursor.int32();
  cursor.int32(); // partition leader epoch
  const magic = cursor.int8();
  const declaredCrc = cursor.uint32();
  // The checksum covers everything after itself, to the end of the batch.
  const crcStart = cursor.offset;
  const crcEnd = crcStart + batchLength - 9; // epoch(4) + magic(1) + crc(4)
  const checksumValid =
    crc32c(records.subarray(crcStart, crcEnd)) === declaredCrc;

  cursor.int16(); // attributes
  cursor.int32(); // last offset delta
  cursor.int64(); // base timestamp
  cursor.int64(); // max timestamp
  cursor.int64(); // producer id
  cursor.int16(); // producer epoch
  cursor.int32(); // base sequence
  const recordCount = cursor.int32();

  cursor.varint(); // record length
  cursor.int8(); // record attributes
  cursor.varint(); // timestamp delta
  cursor.varint(); // offset delta
  const keyLength = cursor.varint();
  if (keyLength >= 0) cursor.offset += keyLength;
  const valueLength = cursor.varint();
  const value = records
    .subarray(cursor.offset, cursor.offset + valueLength)
    .toString("utf8");

  return {
    value,
    checksumValid,
    magic,
    recordCount,
    keyIsNull: keyLength < 0,
  };
}

/* ------------------------------------------------------------------ *
 * The fixture
 * ------------------------------------------------------------------ */

const API_PRODUCE = 0;
const API_METADATA = 3;
const API_SASL_HANDSHAKE = 17;
const API_API_VERSIONS = 18;
const API_SASL_AUTHENTICATE = 36;

const ERROR_UNSUPPORTED_SASL_MECHANISM = 33;
const ERROR_SASL_AUTHENTICATION_FAILED = 58;

interface PartitionSpec {
  index: number;
  leader: number;
  errorCode?: number;
}

interface BrokerOptions {
  nodeId?: number;
  /** What metadata advertises. Defaults to this server alone. */
  advertise?: { nodeId: number; host: string; port: number }[];
  topic?: string;
  topicErrorCode?: number;
  partitions?: PartitionSpec[];
  produceErrorCode?: number;
  baseOffset?: bigint;
  maxProduceVersion?: number;
  /** When set, everything but ApiVersions needs a successful SASL first. */
  sasl?: { username: string; password: string };
  /** What SaslHandshake offers. An empty PLAIN means it is refused. */
  mechanisms?: string[];
  /** Answer every request with bytes that are not a Kafka frame. */
  garbage?: boolean;
  /** Accept the connection and never answer anything. */
  silent?: boolean;
}

interface FakeBroker {
  host: string;
  port: number;
  /** Api keys seen, in order, across every connection. */
  requests: number[];
  connections: number;
  produced: {
    topic: string;
    partition: number;
    acks: number;
    timeoutMs: number;
    batch: DecodedBatch;
  }[];
  /** The SASL tokens received, as `user:password`. */
  tokens: string[];
  /** `allow_auto_topic_creation` on each metadata request. */
  autoCreate: boolean[];
  close(): Promise<void>;
}

const running: FakeBroker[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((broker) => broker.close()));
});

async function startBroker(options: BrokerOptions = {}): Promise<FakeBroker> {
  const nodeId = options.nodeId ?? 1;
  const topic = options.topic ?? "orders";
  const partitions = options.partitions ?? [{ index: 0, leader: nodeId }];
  const mechanisms = options.mechanisms ?? ["PLAIN"];

  const state = {
    requests: [] as number[],
    connections: 0,
    produced: [] as FakeBroker["produced"],
    tokens: [] as string[],
    autoCreate: [] as boolean[],
  };

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    if (options.silent) return;

    let authenticated = options.sasl === undefined;
    let buffered = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const size = buffered.readInt32BE(0);
        if (buffered.length < 4 + size) return;
        const frame = buffered.subarray(4, 4 + size);
        buffered = buffered.subarray(4 + size);

        if (options.garbage) {
          // A length prefix no Kafka message could carry.
          socket.write(Buffer.from([0x7f, 0xff, 0xff, 0xff, 0x00]));
          return;
        }

        const cursor = new Cursor(frame);
        const apiKey = cursor.int16();
        cursor.int16(); // api version
        const correlationId = cursor.int32();
        cursor.string(); // client id
        state.requests.push(apiKey);

        const beforeAuth =
          apiKey === API_API_VERSIONS ||
          apiKey === API_SASL_HANDSHAKE ||
          apiKey === API_SASL_AUTHENTICATE;
        if (!authenticated && !beforeAuth) {
          // What a broker on a SASL listener actually does with a
          // request from a client that has not authenticated.
          socket.destroy();
          return;
        }

        const body = new Writer();
        switch (apiKey) {
          case API_API_VERSIONS: {
            body.int16(0).int32(4);
            for (const [key, max] of [
              [API_PRODUCE, options.maxProduceVersion ?? 7],
              [API_METADATA, 9],
              [API_SASL_HANDSHAKE, 1],
              [API_SASL_AUTHENTICATE, 2],
            ] as const) {
              body.int16(key).int16(0).int16(max);
            }
            break;
          }
          case API_SASL_HANDSHAKE: {
            const asked = cursor.string();
            const offered = mechanisms.includes(asked ?? "");
            body.int16(offered ? 0 : ERROR_UNSUPPORTED_SASL_MECHANISM);
            body.int32(mechanisms.length);
            for (const mechanism of mechanisms) body.string(mechanism);
            break;
          }
          case API_SASL_AUTHENTICATE: {
            const token = cursor.bytes().toString("utf8").split("\u0000");
            const [, username = "", password = ""] = token;
            state.tokens.push(`${username}:${password}`);
            const ok =
              username === options.sasl?.username &&
              password === options.sasl?.password;
            authenticated = ok;
            body
              .int16(ok ? 0 : ERROR_SASL_AUTHENTICATION_FAILED)
              .nullableString(
                ok
                  ? null
                  : "Authentication failed: Invalid username or password",
              )
              .bytes(Buffer.alloc(0));
            break;
          }
          case API_METADATA: {
            const asked: string[] = [];
            const count = cursor.int32();
            for (let index = 0; index < count; index += 1) {
              asked.push(cursor.string() ?? "");
            }
            state.autoCreate.push(cursor.int8() !== 0);

            const advertised = options.advertise ?? [
              { nodeId, host: "127.0.0.1", port },
            ];
            body.int32(0); // throttle time
            body.int32(advertised.length);
            for (const broker of advertised) {
              body
                .int32(broker.nodeId)
                .string(broker.host)
                .int32(broker.port)
                .nullableString(null);
            }
            body.nullableString("test-cluster").int32(nodeId);
            body.int32(asked.length);
            for (const name of asked) {
              body
                .int16(options.topicErrorCode ?? 0)
                .string(name === topic ? topic : name)
                .int8(0); // is_internal
              const listed = name === topic ? partitions : [];
              body.int32(listed.length);
              for (const partition of listed) {
                body
                  .int16(partition.errorCode ?? 0)
                  .int32(partition.index)
                  .int32(partition.leader)
                  .int32(0) // replicas
                  .int32(0); // in-sync replicas
              }
            }
            break;
          }
          case API_PRODUCE: {
            cursor.string(); // transactional id
            const acks = cursor.int16();
            const timeoutMs = cursor.int32();
            const topicCount = cursor.int32();
            body.int32(topicCount);
            for (let index = 0; index < topicCount; index += 1) {
              const name = cursor.string() ?? "";
              const partitionCount = cursor.int32();
              body.string(name).int32(partitionCount);
              for (let position = 0; position < partitionCount; position += 1) {
                const partitionIndex = cursor.int32();
                state.produced.push({
                  topic: name,
                  partition: partitionIndex,
                  acks,
                  timeoutMs,
                  batch: decodeRecordBatch(cursor.bytes()),
                });
                body
                  .int32(partitionIndex)
                  .int16(options.produceErrorCode ?? 0)
                  .int64(options.baseOffset ?? 42n)
                  .int64(-1n);
              }
            }
            body.int32(0); // throttle time
            break;
          }
          default:
            socket.destroy();
            return;
        }

        const payload = new Writer()
          .int32(correlationId)
          .raw(body.build())
          .build();
        socket.write(new Writer().int32(payload.length).raw(payload).build());
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const broker: FakeBroker = {
    host: "127.0.0.1",
    port,
    get requests() {
      return state.requests;
    },
    get connections() {
      return state.connections;
    },
    get produced() {
      return state.produced;
    },
    get tokens() {
      return state.tokens;
    },
    get autoCreate() {
      return state.autoCreate;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  running.push(broker);
  return broker;
}

function configOf(
  overrides: Partial<KafkaProducerConfig> = {},
): KafkaProducerConfig {
  return {
    topic: "orders",
    message: DEFAULT_KAFKA_MESSAGE,
    username: null,
    password: null,
    tls: false,
    degradedThresholdMs: 3_000,
    ...overrides,
  };
}

function contextFor(
  broker: { host: string; port: number },
  overrides: Partial<ProbeContext<KafkaProducerConfig>> = {},
): ProbeContext<KafkaProducerConfig> {
  return {
    target: broker.host,
    port: broker.port,
    config: configOf(),
    timeoutMs: 2_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
    ...overrides,
  };
}

async function probeAndJudge(
  context: ProbeContext<KafkaProducerConfig>,
): Promise<ReturnType<typeof judgeMeasurement>> {
  const result = await kafkaProducerProbe(context);
  return judgeMeasurement(kafkaProducerSpec.assertions, context.config, result);
}

/* ------------------------------------------------------------------ *
 * The tests
 * ------------------------------------------------------------------ */

describe("the kafka-producer probe against a broker", () => {
  it("writes the configured message to the topic and reports the offset", async () => {
    const broker = await startBroker({ baseOffset: 1_234n });

    const result = await kafkaProducerProbe(
      contextFor(broker, { config: configOf({ message: "still alive" }) }),
    );

    expect(result.facts).toMatchObject({
      topicFound: true,
      partitionCount: 1,
      produced: true,
      baseOffset: 1_234,
      brokerError: null,
      brokerCount: 1,
    });
    expect(broker.produced[0]?.batch.value).toBe("still alive");
    expect(result.error).toBeNull();
  });

  it("frames the record as a v2 batch whose checksum a broker would accept", async () => {
    const broker = await startBroker();

    await kafkaProducerProbe(contextFor(broker));

    const batch = broker.produced[0]?.batch;
    expect(batch).toMatchObject({
      magic: 2,
      recordCount: 1,
      checksumValid: true,
      keyIsNull: true,
      value: DEFAULT_KAFKA_MESSAGE,
    });
  });

  it("waits for every in-sync replica rather than the leader alone", async () => {
    // acks=1 would report success on a partition that is about to lose
    // the write in the next leader election.
    const broker = await startBroker();

    await kafkaProducerProbe(contextFor(broker));

    expect(broker.produced[0]?.acks).toBe(-1);
  });

  it("gives the broker the deadline it is working to", async () => {
    const broker = await startBroker();

    await kafkaProducerProbe(contextFor(broker, { timeoutMs: 2_000 }));

    const timeout = broker.produced[0]?.timeoutMs ?? 0;
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(2_000);
  });

  it("never asks the cluster to create the topic it is watching", async () => {
    // Auto-creation would answer "is the topic there" with "it is now",
    // and leave a topic behind on a cluster nobody asked.
    const broker = await startBroker();

    await kafkaProducerProbe(contextFor(broker));

    expect(broker.autoCreate).toEqual([false]);
  });

  it("produces to the partition's leader when the bootstrap broker is not it", async () => {
    const leader = await startBroker({ nodeId: 2, topic: "orders" });
    const bootstrap = await startBroker({
      nodeId: 1,
      partitions: [{ index: 0, leader: 2 }],
      advertise: [
        { nodeId: 1, host: "127.0.0.1", port: 0 },
        { nodeId: 2, host: leader.host, port: leader.port },
      ],
    });

    const result = await kafkaProducerProbe(contextFor(bootstrap));

    expect(result.facts).toMatchObject({ produced: true, topicFound: true });
    // The bootstrap broker answered metadata and nothing else: a produce
    // sent to a follower comes back NOT_LEADER_OR_FOLLOWER, which is a
    // false outage on any cluster with more than one broker.
    expect(bootstrap.produced).toHaveLength(0);
    expect(leader.produced).toHaveLength(1);
  });

  it("reuses the connection when the broker it dialled is the leader", async () => {
    const broker = await startBroker();

    await kafkaProducerProbe(contextFor(broker));

    expect(broker.connections).toBe(1);
    expect(broker.requests).toEqual([18, 3, 0]);
  });

  it("reports a missing topic as down, naming the topic", async () => {
    const broker = await startBroker({ topicErrorCode: 3 });

    const verdict = await probeAndJudge(contextFor(broker));

    expect(verdict.verdict).toBe("down");
    expect(verdict.failureClass).toBe("assertion");
    expect(verdict.error).toBe('The cluster has no topic "orders"');
  });

  it("reports an under-replicated partition in the broker's own words", async () => {
    const broker = await startBroker({ produceErrorCode: 19 });

    const verdict = await probeAndJudge(contextFor(broker));

    expect(verdict.verdict).toBe("down");
    expect(verdict.error).toContain("NOT_ENOUGH_REPLICAS");
    expect(verdict.error).toContain("min.insync.replicas");
  });

  it("reports a partition with no leader without pretending to produce", async () => {
    const broker = await startBroker({
      partitions: [{ index: 0, leader: -1 }],
    });

    const verdict = await probeAndJudge(contextFor(broker));

    expect(verdict.verdict).toBe("down");
    expect(verdict.error).toContain("No partition of the topic");
    expect(broker.produced).toHaveLength(0);
  });

  it("reports a missing ACL as misconfigured, never as an outage", async () => {
    // The cluster is up and this monitor's account is not allowed to
    // write. Reporting that as `down` would page somebody about a
    // healthy cluster.
    const broker = await startBroker({ produceErrorCode: 29 });

    const verdict = await probeAndJudge(contextFor(broker));

    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.failureClass).toBe("misconfigured");
    expect(verdict.error).toContain("TOPIC_AUTHORIZATION_FAILED");
  });

  it("reports a slow produce as degraded", async () => {
    const broker = await startBroker();
    const config = configOf({ degradedThresholdMs: 100 });

    const result = await kafkaProducerProbe(
      contextFor(broker, { config: { ...config } }),
    );
    const verdict = judgeMeasurement(kafkaProducerSpec.assertions, config, {
      ...result,
      facts: { ...result.facts, responseTimeMs: 800 },
    });

    expect(verdict.verdict).toBe("degraded");
    expect(verdict.error).toContain("Produced in 800ms");
  });
});

describe("the kafka-producer probe and SASL", () => {
  it("authenticates with SASL/PLAIN before it produces anything", async () => {
    const broker = await startBroker({
      sasl: { username: "vigil", password: "s3cret" },
    });

    const result = await kafkaProducerProbe(
      contextFor(broker, {
        config: configOf({ username: "vigil", password: "s3cret" }),
      }),
    );

    expect(result.facts).toMatchObject({ produced: true });
    expect(broker.tokens).toEqual(["vigil:s3cret"]);
    // Versions, handshake, token, metadata, produce — in that order, and
    // with nothing before the credential that could have leaked it.
    expect(broker.requests).toEqual([18, 17, 36, 3, 0]);
  });

  it("reports a rejected credential as misconfigured, in the broker's words", async () => {
    const broker = await startBroker({
      sasl: { username: "vigil", password: "s3cret" },
    });

    const verdict = await probeAndJudge(
      contextFor(broker, {
        config: configOf({ username: "vigil", password: "rotated" }),
      }),
    );

    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.failureClass).toBe("misconfigured");
    expect(verdict.error).toContain("Invalid username or password");
  });

  it("says what a broker offers when it will not accept PLAIN", async () => {
    const broker = await startBroker({
      sasl: { username: "vigil", password: "s3cret" },
      mechanisms: ["SCRAM-SHA-512", "GSSAPI"],
    });

    const verdict = await probeAndJudge(
      contextFor(broker, {
        config: configOf({ username: "vigil", password: "s3cret" }),
      }),
    );

    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.error).toContain("SCRAM-SHA-512, GSSAPI");
  });

  it("reports the drop when an unauthenticated monitor meets a SASL listener", async () => {
    const broker = await startBroker({
      sasl: { username: "vigil", password: "s3cret" },
    });

    const verdict = await probeAndJudge(contextFor(broker));

    expect(verdict.verdict).toBe("down");
    expect(verdict.failureClass).toBe("transport");
    expect(verdict.error).toContain("closed the connection");
  });
});

describe("the kafka-producer probe when it cannot measure", () => {
  it("refuses a broker too old for the v2 record format", async () => {
    // Produce v3 needs Kafka 0.11. Saying so beats a parse failure three
    // requests later, and beats reporting an old cluster as down.
    const broker = await startBroker({ maxProduceVersion: 2 });

    const verdict = await probeAndJudge(contextFor(broker));

    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.error).toContain("Produce up to v2");
    expect(broker.produced).toHaveLength(0);
  });

  it("says so when the monitor has no topic, rather than inventing one", async () => {
    const broker = await startBroker();

    const verdict = await probeAndJudge(
      contextFor(broker, { config: configOf({ topic: null }) }),
    );

    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.error).toBe("This monitor has no topic to produce to.");
    expect(broker.connections).toBe(0);
  });

  it("reports something that is not a broker as a transport failure", async () => {
    const broker = await startBroker({ garbage: true });

    const verdict = await probeAndJudge(contextFor(broker));

    expect(verdict.verdict).toBe("down");
    expect(verdict.failureClass).toBe("transport");
    expect(verdict.error).toContain("not as a Kafka broker");
  });

  it("gives up on a broker that never answers, and says how long it waited", async () => {
    const broker = await startBroker({ silent: true });

    const result = await kafkaProducerProbe(
      contextFor(broker, { timeoutMs: 300 }),
    );

    expect(result.error).toBe("Timed out after 300ms");
  });

  it("reports a refused connection as a transport failure", async () => {
    const broker = await startBroker();
    const { host, port } = broker;
    await broker.close();
    running.splice(running.indexOf(broker), 1);

    const result = await kafkaProducerProbe(contextFor({ host, port }));

    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it("refuses a private address unless the deployment allows one", async () => {
    const broker = await startBroker();

    const result = await kafkaProducerProbe(
      contextFor(broker, { allowPrivateTargets: false }),
    );

    expect(result.error).toBe("Target resolves to a private address");
    expect(broker.connections).toBe(0);
  });
});

describe("the record batch checksum", () => {
  it("computes the check value the Castagnoli polynomial publishes", () => {
    // The standard vector for CRC-32C. `node:zlib` computes CRC-32
    // (IEEE), which passes every self-consistency test and is rejected by
    // every broker.
    expect(crc32c(Buffer.from("123456789", "utf8"))).toBe(0xe3069283);
  });

  it("is not the IEEE CRC-32 that a checksum library would hand you", () => {
    expect(crc32c(Buffer.from("123456789", "utf8"))).not.toBe(0xcbf43926);
  });
});

describe("the kafka-producer type's configuration", () => {
  it("declares the password as a secret, so it never reaches a browser", () => {
    expect(kafkaProducerSpec.secretFields).toContain("password");
  });

  it("refuses a password with no user name to send it with", () => {
    const parsed = kafkaProducerStoredSchema.safeParse({ password: "only-pw" });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      "A password needs a username.",
    );
  });

  it("refuses a topic name Kafka itself would refuse", () => {
    for (const topic of ["with space", "slash/es", "..", "wildcard*"]) {
      expect(kafkaProducerStoredSchema.safeParse({ topic }).success).toBe(
        false,
      );
    }
    expect(
      kafkaProducerStoredSchema.safeParse({ topic: "orders.v2_2-a" }).success,
    ).toBe(true);
  });

  it("accepts an empty submission and defaults the message", () => {
    expect(kafkaProducerStoredSchema.parse({})).toEqual({
      topic: null,
      message: DEFAULT_KAFKA_MESSAGE,
      username: null,
      password: null,
      tls: false,
    });
  });

  it("keeps the whitespace inside a password", () => {
    const parsed = kafkaProducerStoredSchema.parse({
      username: "vigil",
      password: " padded ",
    });

    expect(parsed.password).toBe(" padded ");
  });

  it("names the topic in the line an incident email prints, and no credential", () => {
    const described = kafkaProducerSpec.describeTarget(
      "kafka-1.example.com",
      9092,
      configOf({ username: "vigil", password: "s3cret" }),
    );

    expect(described).toBe("kafka-1.example.com:9092/orders");
    expect(described).not.toContain("s3cret");
  });

  it("rebuilds its config from a row that predates the blob", () => {
    const config = kafkaProducerSpec.fromRow({
      checkType: "kafka-producer",
      url: "kafka-1.example.com",
      port: 9092,
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 10_000,
      degradedThresholdMs: 3_000,
      expectedStatusCode: null,
      bodyKeyword: null,
      keywordAbsent: false,
      tlsCheck: false,
      tlsWarnDays: 14,
      config: null,
    });

    expect(config).toEqual({
      topic: null,
      message: DEFAULT_KAFKA_MESSAGE,
      username: null,
      password: null,
      tls: false,
      degradedThresholdMs: 3_000,
    });
  });
});
