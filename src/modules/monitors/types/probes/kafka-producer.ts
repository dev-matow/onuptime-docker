import net from "node:net";
import tls from "node:tls";

import { DEFAULT_KAFKA_PORT } from "../catalog";
import type { FactBag, ProbeContext, ProbeResult } from "../contract";
import {
  KAFKA_AUTHORIZATION_ERRORS,
  kafkaErrorMessage,
  type KafkaProducerConfig,
} from "../specs/kafka-producer";
import { connectionErrorMessage, elapsedSince, refusesPrivate } from "./guard";

/**
 * One message, produced to a Kafka topic, spoken by hand.
 *
 * No client library. `kafkajs` is the obvious candidate and it was
 * rejected for the reason every other transport in this directory was
 * written by hand: it exists to keep long-lived producers and consumer
 * groups alive — connection pools, rebalancing, retry policies, an idle
 * reconnect loop — and a check needs exactly one round trip, once a
 * minute, with a deadline. What it would actually buy is protocol
 * coverage this check does not use, in exchange for a dependency in an
 * image whose pitch is two processes and a Postgres. Nothing was added
 * to package.json.
 *
 * The exchange is four requests, and each one earns its place:
 *
 * 1. **ApiVersions** — proves the thing on the port is a broker before a
 *    password is sent to it, and says whether it is new enough to
 *    understand the record format below. A broker that predates it would
 *    otherwise answer a Produce request with a parse error, and the
 *    monitor would report an outage on a cluster that is merely old.
 * 2. **SaslHandshake / SaslAuthenticate** — only when the monitor has a
 *    credential. Skipped entirely otherwise, because plenty of clusters
 *    inside a private network take anonymous connections.
 * 3. **Metadata** — which broker leads the topic's partitions. A produce
 *    sent to a follower is refused with NOT_LEADER_OR_FOLLOWER, so a
 *    monitor that skipped this step would report a false outage on any
 *    cluster with more than one broker.
 * 4. **Produce** — the observation. Everything before it is discovery.
 *
 * Versions are pinned to the newest ones that are *not* flexible
 * (tagged-field) encodings: ApiVersions v0, SaslHandshake v1,
 * SaslAuthenticate v0, Metadata v4, Produce v3. They are understood by
 * every broker since 1.0.0 (2017) and they let the codec below be a
 * hundred lines instead of a compact-encoding library.
 */

/** Identifies this client in the broker's logs, quotas and metrics. */
const CLIENT_ID = "vigil-monitor";

const API_PRODUCE = 0;
const API_METADATA = 3;
const API_SASL_HANDSHAKE = 17;
const API_API_VERSIONS = 18;
const API_SASL_AUTHENTICATE = 36;

const PRODUCE_VERSION = 3;
const METADATA_VERSION = 4;
const SASL_HANDSHAKE_VERSION = 1;
const SASL_AUTHENTICATE_VERSION = 0;

/** The one mechanism this type speaks. See the docs for why. */
const SASL_MECHANISM = "PLAIN";

const ERROR_NONE = 0;
const ERROR_UNKNOWN_TOPIC_OR_PARTITION = 3;

/**
 * `acks = -1`: the leader must have replicated the record to every
 * in-sync replica before it answers.
 *
 * `acks = 1` would be cheaper and would lie by omission. A partition
 * that has fallen below `min.insync.replicas` accepts a leader-only
 * write and loses it with the next leader election — the cluster is
 * already in the state this monitor exists to catch, and would read
 * green until it lost data. With -1 the broker answers
 * NOT_ENOUGH_REPLICAS instead, which is a sentence an operator can act
 * on.
 */
const ACKS_ALL = -1;

/** No partition leader is a negative node id. */
const NO_LEADER = -1;

/**
 * A frame larger than this is not a reply to anything this probe sent.
 * The metadata of a very large cluster is a few hundred kilobytes; the
 * cap is protection against a peer that declares a length it will never
 * fill and holds the worker's memory while it does not.
 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * The broker could not be talked to — no measurement was made. Judged as
 * a transport failure, exactly like a refused connection.
 */
class BrokerFailure extends Error {}

/**
 * The broker answered, and said this check cannot run as configured: a
 * rejected credential, a missing ACL, a broker too old for the record
 * format. `misconfigured`, never `down` — an operator error that reads
 * as an outage is indistinguishable from the cluster being gone.
 */
class BrokerUnavailable extends Error {}

export async function kafkaProducerProbe(
  ctx: ProbeContext<KafkaProducerConfig>,
): Promise<ProbeResult> {
  const topic = ctx.config.topic;
  if (topic === null) {
    // Nothing was measured and nothing is wrong with the cluster. The
    // alternative — inventing a topic name — would either fail forever
    // or, on a cluster with auto-creation enabled, create a topic
    // nobody asked for.
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: null,
      unavailable: "This monitor has no topic to produce to.",
    };
  }

  const guard = await refusesPrivate(
    ctx.target,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_KAFKA_PORT;
  const startedAt = performance.now();
  const deadlineAt = startedAt + ctx.timeoutMs;

  let bootstrap: Broker | null = null;
  let leader: Broker | null = null;
  try {
    bootstrap = await openBroker(
      ctx.target,
      port,
      ctx.config,
      deadlineAt,
      ctx.timeoutMs,
    );
    await negotiate(bootstrap, ctx.config);

    const metadata = await fetchMetadata(bootstrap, topic);
    const cluster = { brokerCount: metadata.brokers.length };

    const described = metadata.topics.find((entry) => entry.name === topic);
    if (
      !described ||
      described.errorCode === ERROR_UNKNOWN_TOPIC_OR_PARTITION
    ) {
      // Not a transport failure and not an authorization one: the
      // cluster answered, and what it said is that the topic is not
      // there. The `topic-exists` assertion turns that into the verdict.
      return measured(startedAt, {
        ...cluster,
        topicFound: false,
        partitionCount: 0,
      });
    }
    refuseIfUnauthorized(described.errorCode);
    const partitionCount = described.partitions.length;
    if (described.errorCode !== ERROR_NONE) {
      return measured(startedAt, {
        ...cluster,
        topicFound: true,
        partitionCount,
        produced: false,
        brokerError: kafkaErrorMessage(described.errorCode),
      });
    }

    const partition = choosePartition(described.partitions);
    if (partition === null) {
      return measured(startedAt, {
        ...cluster,
        topicFound: true,
        partitionCount,
        produced: false,
        brokerError: refusalOf(described.partitions),
      });
    }

    const address = metadata.brokers.find(
      (broker) => broker.nodeId === partition.leader,
    );
    if (!address) {
      return measured(startedAt, {
        ...cluster,
        topicFound: true,
        partitionCount,
        produced: false,
        brokerError: `The cluster advertised no address for broker ${partition.leader}, which leads partition ${partition.index}`,
      });
    }

    // The leader's address came out of a metadata response, so it is
    // data from the far end naming a host this probe is about to open a
    // socket to. `openLeader` gives it the same guard the operator's own
    // target got — otherwise the broker picks Vigil's next destination.
    const connection =
      address.host === ctx.target && address.port === port
        ? bootstrap
        : await openLeader(address, ctx, deadlineAt);
    if (connection !== bootstrap) leader = connection;

    const ack = await produce(connection, {
      topic,
      partition: partition.index,
      message: ctx.config.message,
      deadlineAt,
    });
    refuseIfUnauthorized(ack.errorCode);
    const accepted = ack.errorCode === ERROR_NONE;

    return measured(startedAt, {
      ...cluster,
      topicFound: true,
      partitionCount,
      produced: accepted,
      // Null on success, and only on success: the `produce-accepted`
      // assertion reads this fact and has no opinion when it is null.
      brokerError: accepted ? null : kafkaErrorMessage(ack.errorCode),
      baseOffset: accepted ? ack.baseOffset : null,
    });
  } catch (error) {
    const responseTimeMs = elapsedSince(startedAt);
    if (error instanceof BrokerUnavailable) {
      return {
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: null,
        unavailable: error.message,
      };
    }
    return {
      facts: { responseTimeMs },
      responseTimeMs,
      statusCode: null,
      // Never the empty string: `judge` reads a falsy error as "no
      // transport failure" and would go on to judge a dead broker by its
      // latency alone.
      error:
        error instanceof Error && error.message.length > 0
          ? error.message
          : "The connection failed",
    };
  } finally {
    // Cleanup must never replace the observation the probe already has,
    // and must never escape as an unhandled rejection.
    bootstrap?.close();
    leader?.close();
  }
}

/**
 * One measurement, with the clock stopped here rather than at each of
 * the eight places above that produce a result. What is being timed is
 * the whole exchange — discovery included — because that is what a
 * producer actually waits for.
 */
function measured(startedAt: number, facts: FactBag): ProbeResult {
  const responseTimeMs = elapsedSince(startedAt);
  return {
    facts: { ...facts, responseTimeMs },
    responseTimeMs,
    statusCode: null,
    error: null,
  };
}

function refuseIfUnauthorized(errorCode: number): void {
  if (KAFKA_AUTHORIZATION_ERRORS.includes(errorCode)) {
    throw new BrokerUnavailable(
      `The cluster refused this monitor's credentials: ${kafkaErrorMessage(errorCode)}. Grant the account Describe and Write on the topic.`,
    );
  }
}

/** The lowest-numbered partition with a leader and nothing to complain about. */
function choosePartition(
  partitions: readonly PartitionMetadata[],
): PartitionMetadata | null {
  const usable = partitions.filter(
    (partition) =>
      partition.errorCode === ERROR_NONE && partition.leader !== NO_LEADER,
  );
  if (usable.length === 0) return null;
  // Lowest index rather than round-robin or random: a monitor that moved
  // between partitions would produce a different check every interval,
  // and a partition whose leader is wedged would show up as an
  // intermittent failure rather than a steady one.
  return usable.reduce((low, next) => (next.index < low.index ? next : low));
}

/** Why no partition could be produced to, in the broker's own terms. */
function refusalOf(partitions: readonly PartitionMetadata[]): string {
  const failing = partitions.find(
    (partition) => partition.errorCode !== ERROR_NONE,
  );
  if (failing) return kafkaErrorMessage(failing.errorCode);
  return partitions.length === 0
    ? "The topic has no partitions"
    : "No partition of the topic currently has a leader";
}

async function openLeader(
  address: BrokerAddress,
  ctx: ProbeContext<KafkaProducerConfig>,
  deadlineAt: number,
): Promise<Broker> {
  const guard = await refusesPrivate(
    address.host,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    throw new BrokerFailure(
      `The topic's leader is ${address.host}:${address.port}, which cannot be reached: ${guard.toLowerCase()}`,
    );
  }
  const broker = await openBroker(
    address.host,
    address.port,
    ctx.config,
    deadlineAt,
    ctx.timeoutMs,
  );
  try {
    // A second connection is a second SASL session: authentication is a
    // property of the connection, not of the cluster.
    await negotiate(broker, ctx.config);
  } catch (error) {
    broker.close();
    throw error;
  }
  return broker;
}

/* ------------------------------------------------------------------ *
 * The exchange
 * ------------------------------------------------------------------ */

/**
 * ApiVersions, then SASL when there is a credential.
 *
 * ApiVersions goes first because it is one of the two requests a broker
 * will answer before authentication, and because its answer decides
 * whether the rest of this exchange is even expressible.
 */
async function negotiate(
  broker: Broker,
  config: KafkaProducerConfig,
): Promise<void> {
  const versions = await apiVersions(broker);
  requireVersion(versions, API_PRODUCE, PRODUCE_VERSION, "Produce");
  requireVersion(versions, API_METADATA, METADATA_VERSION, "Metadata");
  if (config.username === null) return;
  await authenticate(broker, config);
}

function requireVersion(
  versions: ReadonlyMap<number, number>,
  apiKey: number,
  needed: number,
  label: string,
): void {
  const supported = versions.get(apiKey);
  if (supported === undefined || supported >= needed) return;
  // A broker older than 0.11 has no v2 record batch to put a message in.
  // Saying so is worth more than a parse failure three requests later.
  throw new BrokerUnavailable(
    `This broker speaks ${label} up to v${supported}; Vigil produces with v${needed}, which needs Kafka 0.11 or newer.`,
  );
}

async function apiVersions(broker: Broker): Promise<Map<number, number>> {
  const reply = new Reader(
    await broker.request(API_API_VERSIONS, 0, Buffer.alloc(0)),
  );
  const errorCode = reply.int16();
  if (errorCode !== ERROR_NONE) {
    throw new BrokerUnavailable(
      `The broker refused to list its API versions: ${kafkaErrorMessage(errorCode)}`,
    );
  }
  const versions = new Map<number, number>();
  const count = reply.int32();
  for (let index = 0; index < count; index += 1) {
    const apiKey = reply.int16();
    reply.int16(); // minimum version — this probe never negotiates downward
    versions.set(apiKey, reply.int16());
  }
  return versions;
}

/**
 * SASL/PLAIN in two requests: agree the mechanism, then send the token.
 *
 * The token is `\0username\0password` (RFC 4616) — an empty authzid,
 * then the two fields. It is sent in the clear unless the connection is
 * TLS, which is why `tls` is a setting and why the documentation is
 * blunt about it.
 */
async function authenticate(
  broker: Broker,
  config: KafkaProducerConfig,
): Promise<void> {
  const handshake = new Reader(
    await broker.request(
      API_SASL_HANDSHAKE,
      SASL_HANDSHAKE_VERSION,
      encodeString(SASL_MECHANISM),
    ),
  );
  const handshakeError = handshake.int16();
  if (handshakeError !== ERROR_NONE) {
    const offered: string[] = [];
    const count = handshake.int32();
    for (let index = 0; index < count; index += 1)
      offered.push(handshake.string());
    throw new BrokerUnavailable(
      `This broker does not accept SASL/PLAIN${offered.length > 0 ? `; it offers ${offered.join(", ")}` : ""}. Vigil speaks PLAIN only.`,
    );
  }

  const token = Buffer.from(
    `\u0000${config.username ?? ""}\u0000${config.password ?? ""}`,
    "utf8",
  );
  const authenticated = new Reader(
    await broker.request(
      API_SASL_AUTHENTICATE,
      SASL_AUTHENTICATE_VERSION,
      encodeBytes(token),
    ),
  );
  const authError = authenticated.int16();
  const authMessage = authenticated.nullableString();
  if (authError !== ERROR_NONE) {
    // The broker's own sentence, when it gave one. Kafka's is usually
    // "Authentication failed: Invalid username or password", which is
    // exactly what the operator needs and nothing they did not know.
    throw new BrokerUnavailable(
      `The broker rejected the stored credentials: ${authMessage ?? kafkaErrorMessage(authError)}`,
    );
  }
}

interface BrokerAddress {
  nodeId: number;
  host: string;
  port: number;
}

interface PartitionMetadata {
  errorCode: number;
  index: number;
  leader: number;
}

interface TopicMetadata {
  errorCode: number;
  name: string;
  partitions: PartitionMetadata[];
}

interface ClusterMetadata {
  brokers: BrokerAddress[];
  topics: TopicMetadata[];
}

async function fetchMetadata(
  broker: Broker,
  topic: string,
): Promise<ClusterMetadata> {
  const request = Buffer.concat([
    encodeInt32(1),
    encodeString(topic),
    // Auto-creation is refused, always, and is not a setting. A monitor
    // that created the topic it was asked to watch would answer "is the
    // topic there" with "it is now" — and would leave a topic behind on
    // a cluster whose operator never asked for one.
    Buffer.from([0]),
  ]);
  const reply = new Reader(
    await broker.request(API_METADATA, METADATA_VERSION, request),
  );

  reply.int32(); // throttle_time_ms
  const brokers: BrokerAddress[] = [];
  const brokerCount = reply.int32();
  for (let index = 0; index < brokerCount; index += 1) {
    const nodeId = reply.int32();
    const host = reply.string();
    const port = reply.int32();
    reply.nullableString(); // rack
    brokers.push({ nodeId, host, port });
  }
  reply.nullableString(); // cluster_id
  reply.int32(); // controller_id

  const topics: TopicMetadata[] = [];
  const topicCount = reply.int32();
  for (let index = 0; index < topicCount; index += 1) {
    const errorCode = reply.int16();
    const name = reply.string();
    reply.boolean(); // is_internal
    const partitions: PartitionMetadata[] = [];
    const partitionCount = reply.int32();
    for (let position = 0; position < partitionCount; position += 1) {
      const partitionError = reply.int16();
      const partitionIndex = reply.int32();
      const leader = reply.int32();
      reply.skipInt32Array(); // replicas
      reply.skipInt32Array(); // in-sync replicas
      partitions.push({
        errorCode: partitionError,
        index: partitionIndex,
        leader,
      });
    }
    topics.push({ errorCode, name, partitions });
  }
  return { brokers, topics };
}

interface ProduceAck {
  errorCode: number;
  /** Where the record landed, or null when the offset does not fit. */
  baseOffset: number | null;
}

async function produce(
  broker: Broker,
  options: {
    topic: string;
    partition: number;
    message: string;
    deadlineAt: number;
  },
): Promise<ProduceAck> {
  const records = encodeRecordBatch(options.message, Date.now());
  // The broker gives up when this probe does. Without it a cluster that
  // cannot reach its replicas holds the request open for its own
  // `request.timeout.ms` — long after the worker has stopped listening —
  // and the write it eventually completes belongs to nobody.
  const brokerTimeout = Math.max(
    1,
    Math.round(options.deadlineAt - performance.now()),
  );

  const request = Buffer.concat([
    encodeNullableString(null), // transactional_id
    encodeInt16(ACKS_ALL),
    encodeInt32(brokerTimeout),
    encodeInt32(1), // one topic
    encodeString(options.topic),
    encodeInt32(1), // one partition
    encodeInt32(options.partition),
    encodeBytes(records),
  ]);

  const reply = new Reader(
    await broker.request(API_PRODUCE, PRODUCE_VERSION, request),
  );
  const topicCount = reply.int32();
  for (let index = 0; index < topicCount; index += 1) {
    reply.string(); // topic name — one was asked for and one comes back
    const partitionCount = reply.int32();
    for (let position = 0; position < partitionCount; position += 1) {
      reply.int32(); // partition index
      const errorCode = reply.int16();
      const baseOffset = reply.int64();
      reply.int64(); // log_append_time_ms
      // The first partition response is the only one: this request
      // carried exactly one record, for one partition, of one topic.
      return {
        errorCode,
        baseOffset: Number.isSafeInteger(Number(baseOffset))
          ? Number(baseOffset)
          : null,
      };
    }
  }
  throw new BrokerFailure(
    "The broker acknowledged nothing for the partition the message was sent to",
  );
}

/* ------------------------------------------------------------------ *
 * The connection
 * ------------------------------------------------------------------ */

interface Broker {
  request(apiKey: number, apiVersion: number, body: Buffer): Promise<Buffer>;
  close(): void;
}

interface Pending {
  correlationId: number;
  resolve(body: Buffer): void;
  reject(error: Error): void;
}

/**
 * One socket, framed and correlated.
 *
 * Kafka frames every message with its length, so a `data` event is not a
 * reply — a reply arrives in as many pieces as the network feels like.
 * The correlation id is checked rather than assumed: this probe sends
 * one request at a time, so a reply bearing another id means the stream
 * has desynchronised, and continuing to read it would turn arbitrary
 * bytes into facts.
 */
function openBroker(
  host: string,
  port: number,
  config: KafkaProducerConfig,
  deadlineAt: number,
  timeoutMs: number,
): Promise<Broker> {
  return new Promise<Broker>((resolve, reject) => {
    const socket = config.tls
      ? tls.connect({
          host,
          port,
          servername: host,
          // Verified, unlike `tls-expiry`'s deliberate exception: this
          // connection carries a SASL password, and an unverified TLS
          // session protects it from nobody. A private CA belongs in
          // NODE_EXTRA_CA_CERTS.
          rejectUnauthorized: true,
        })
      : net.connect({ host, port });

    let buffered: Buffer = Buffer.alloc(0);
    let pending: Pending | null = null;
    let failure: Error | null = null;
    let correlationId = 0;

    const fail = (message: string) => {
      const error = failure ?? new BrokerFailure(message);
      failure = error;
      clearTimeout(timer);
      socket.destroy();
      const waiting = pending;
      pending = null;
      waiting?.reject(error);
      // A no-op once the connection has been handed to the caller; the
      // one case it matters is a failure during the connect itself.
      reject(error);
    };

    // One deadline for the whole exchange, not per request, and not an
    // idle timeout. A peer that answers each of four requests just
    // inside an idle timer would otherwise hold a worker slot for four
    // times the budget the runner allotted this check; one that dribbles
    // a byte at a time would hold it indefinitely.
    const remaining = Math.max(1, Math.round(deadlineAt - performance.now()));
    const timer = setTimeout(
      () => fail(`Timed out after ${timeoutMs}ms`),
      remaining,
    );

    socket.on("data", (chunk: Buffer) => {
      buffered =
        buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const size = buffered.readInt32BE(0);
        if (size < 4 || size > MAX_FRAME_BYTES) {
          // Whatever is listening framed its answer as something that is
          // not a Kafka message, so there is no length to wait for.
          fail(`${host}:${port} answered, but not as a Kafka broker`);
          return;
        }
        if (buffered.length < 4 + size) return;
        const frame = buffered.subarray(4, 4 + size);
        buffered = buffered.subarray(4 + size);

        const waiting = pending;
        pending = null;
        if (!waiting) {
          fail("The broker sent a reply to a request nothing made");
          return;
        }
        if (frame.readInt32BE(0) !== waiting.correlationId) {
          fail("The broker's replies stopped matching its requests");
          return;
        }
        waiting.resolve(frame.subarray(4));
      }
    });

    socket.once("error", (error: Error) =>
      fail(connectionErrorMessage(error, "Connection failed")),
    );
    // Without this, a broker that accepts the connection and hangs up —
    // which is what one does when an unauthenticated client asks it for
    // metadata on a SASL listener — says nothing until the deadline, and
    // the operator reads "the network ate it" instead of "it dropped me".
    socket.once("close", () =>
      fail("The broker closed the connection without replying"),
    );

    const ready = () =>
      resolve({
        request(apiKey, apiVersion, body) {
          return new Promise<Buffer>((answer, refuse) => {
            if (failure) {
              refuse(failure);
              return;
            }
            correlationId += 1;
            pending = { correlationId, resolve: answer, reject: refuse };
            const header = Buffer.concat([
              encodeInt16(apiKey),
              encodeInt16(apiVersion),
              encodeInt32(correlationId),
              encodeString(CLIENT_ID),
            ]);
            const payload = Buffer.concat([header, body]);
            socket.write(Buffer.concat([encodeInt32(payload.length), payload]));
          });
        },
        close() {
          // The timer holds the event loop open; a worker that leaked one
          // per check would take the deadline's worth of extra seconds to
          // shut down for every monitor it had ever run.
          clearTimeout(timer);
          socket.destroy();
        },
      });

    socket.once(config.tls ? "secureConnect" : "connect", ready);
  });
}

/* ------------------------------------------------------------------ *
 * Encoding
 * ------------------------------------------------------------------ */

function encodeInt8(value: number): Buffer {
  return Buffer.from([value & 0xff]);
}

function encodeInt16(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeInt16BE(value, 0);
  return buffer;
}

function encodeInt32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

function encodeUInt32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function encodeInt64(value: bigint): Buffer {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigInt64BE(value, 0);
  return buffer;
}

/** A two-byte-length-prefixed string — how Kafka carries all of them. */
function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([encodeInt16(bytes.length), bytes]);
}

/** The same, with -1 as the length meaning null. */
function encodeNullableString(value: string | null): Buffer {
  return value === null ? encodeInt16(-1) : encodeString(value);
}

/** A four-byte-length-prefixed byte string. */
function encodeBytes(value: Buffer): Buffer {
  return Buffer.concat([encodeInt32(value.length), value]);
}

/**
 * A zigzag varint, as the v2 record format carries every length and
 * delta inside a record. Zigzag maps -1 to 1 and 1 to 2, so a null key
 * costs one byte rather than five.
 *
 * 32-bit arithmetic is deliberate and sufficient: every value encoded
 * here is a length, a count or a delta inside a single record, and this
 * probe writes exactly one record of at most a few hundred bytes. The
 * timestamp — the one genuinely 64-bit field — is written as an int64 by
 * the batch header, not through here.
 */
function encodeVarint(value: number): Buffer {
  let remaining = ((value << 1) ^ (value >> 31)) >>> 0;
  const bytes: number[] = [];
  do {
    const septet = remaining & 0x7f;
    remaining >>>= 7;
    bytes.push(remaining > 0 ? septet | 0x80 : septet);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

/**
 * CRC-32C (Castagnoli), which is what a v2 record batch is checksummed
 * with — not the CRC-32 in `node:zlib`. A batch whose CRC does not match
 * is refused by the broker with CORRUPT_MESSAGE, so this is load-bearing
 * rather than decorative.
 *
 * Exported so a test can pin it against the polynomial's published check
 * value; getting it silently wrong would make every produce fail with an
 * error that points at the network.
 */
const CRC32C_TABLE = (() => {
  // The reflected Castagnoli polynomial.
  const polynomial = 0x82f63b78;
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ polynomial : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
})();

export function crc32c(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC32C_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * One record, in one v2 record batch.
 *
 * The key is null on purpose. A key selects a partition by hash, and
 * this probe has already chosen the partition it wants — the one whose
 * leader it is connected to. A key would either be ignored (the
 * partition is explicit in the request) or, if this ever grew a
 * partitioner, quietly move the check to a partition it had not
 * verified.
 *
 * Exported for the protocol fixture, which decodes it: an encoder that
 * only its own decoder can read has proved nothing.
 */
export function encodeRecordBatch(
  message: string,
  timestampMs: number,
): Buffer {
  const value = Buffer.from(message, "utf8");
  const record = Buffer.concat([
    encodeInt8(0), // record attributes — unused, must be zero
    encodeVarint(0), // timestamp delta: the only record in the batch
    encodeVarint(0), // offset delta
    encodeVarint(-1), // null key
    encodeVarint(value.length),
    value,
    encodeVarint(0), // no headers
  ]);
  const framedRecord = Buffer.concat([encodeVarint(record.length), record]);

  // Everything the CRC covers: the batch from `attributes` onward.
  const crcBody = Buffer.concat([
    encodeInt16(0), // attributes: no compression, CreateTime, not transactional
    encodeInt32(0), // last offset delta
    encodeInt64(BigInt(timestampMs)), // base timestamp
    encodeInt64(BigInt(timestampMs)), // max timestamp
    encodeInt64(-1n), // producer id — not idempotent, not transactional
    encodeInt16(-1), // producer epoch
    encodeInt32(-1), // base sequence
    encodeInt32(1), // one record
    framedRecord,
  ]);

  const afterLength = Buffer.concat([
    encodeInt32(-1), // partition leader epoch: unknown to a plain producer
    encodeInt8(2), // magic: the v2 record format
    encodeUInt32(crc32c(crcBody)),
    crcBody,
  ]);

  return Buffer.concat([
    encodeInt64(0n), // base offset — the broker assigns the real one
    encodeInt32(afterLength.length),
    afterLength,
  ]);
}

/* ------------------------------------------------------------------ *
 * Decoding
 * ------------------------------------------------------------------ */

/**
 * A cursor over a response body.
 *
 * Every read is bounds-checked and throws a {@link BrokerFailure} rather
 * than returning a zero: a truncated or unexpected response must be
 * reported as "could not read the answer", never turned into a fact that
 * says the cluster is fine.
 */
class Reader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  private require(bytes: number): number {
    if (this.offset + bytes > this.buffer.length) {
      throw new BrokerFailure("The broker's reply ended mid-message");
    }
    const at = this.offset;
    this.offset += bytes;
    return at;
  }

  int16(): number {
    return this.buffer.readInt16BE(this.require(2));
  }

  int32(): number {
    return this.buffer.readInt32BE(this.require(4));
  }

  int64(): bigint {
    return this.buffer.readBigInt64BE(this.require(8));
  }

  boolean(): boolean {
    return this.buffer.readInt8(this.require(1)) !== 0;
  }

  string(): string {
    const value = this.nullableString();
    if (value === null) {
      throw new BrokerFailure("The broker sent a null where a string belongs");
    }
    return value;
  }

  nullableString(): string | null {
    const length = this.int16();
    if (length < 0) return null;
    const at = this.require(length);
    return this.buffer.subarray(at, at + length).toString("utf8");
  }

  /** An array of node ids nothing here reads — replicas, in-sync replicas. */
  skipInt32Array(): void {
    const count = this.int32();
    if (count < 0) return;
    this.require(count * 4);
  }
}
