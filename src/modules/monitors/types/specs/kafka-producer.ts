import { z } from "zod";

import { DEFAULT_KAFKA_PORT, kafkaProducerDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * Can this cluster still accept a write?
 *
 * A TCP check on 9092 proves a broker process is listening. A cluster
 * that has lost its controller, whose topic has no leader, or whose
 * partitions are under-replicated below `min.insync.replicas` accepts
 * that socket and refuses every produce on it — which is the outage a
 * team wants paged, and the one a port check is blind to. Producing one
 * message is the smallest observation that separates the two.
 *
 * It is also the only check type in Vigil that *writes* to the system it
 * watches. That is inherent to the question: "can we publish" cannot be
 * answered without publishing. It has consequences an operator has to
 * agree to — a record every interval, retained for whatever the topic
 * retains, visible to every consumer of it — so the documentation says
 * to point this at a dedicated topic and the message is a setting rather
 * than a constant, for the teams whose consumers validate a schema.
 */

/**
 * What lands in the topic when nobody says otherwise.
 *
 * It names itself. A record found in a topic six months later has to be
 * traceable to the thing that put it there, or the first response is an
 * incident about an unknown producer.
 */
export const DEFAULT_KAFKA_MESSAGE = "vigil monitor check";

/**
 * Kafka's own bound on a topic name (`Topic.MAX_NAME_LENGTH`), and the
 * character set it accepts. Enforced here so a typo is refused in front
 * of the operator rather than becoming an `INVALID_TOPIC_EXCEPTION` from
 * a broker three round trips later.
 */
const MAX_TOPIC_LENGTH = 249;
const TOPIC_PATTERN = /^[a-zA-Z0-9._-]+$/;

export interface KafkaProducerConfig {
  /**
   * The topic to produce to. Null when the monitor has none — the form
   * has no section for it yet and `storedSchema` must accept an empty
   * submission, so an unconfigured monitor is representable. The probe
   * reports that as `misconfigured` rather than inventing a topic name
   * and creating it on somebody's cluster.
   */
  topic: string | null;
  /** The record's value. The key is always null — see the probe. */
  message: string;
  /**
   * SASL/PLAIN credentials, for a cluster whose listener demands them.
   * Null on a cluster that does not, which is the common case inside a
   * private network and the reason these are optional.
   */
  username: string | null;
  password: string | null;
  /**
   * Wrap the connection in TLS — a `SSL` or `SASL_SSL` listener.
   *
   * Off by default because `PLAINTEXT` is what a broker ships with, and
   * a monitor that could not reach an unconfigured cluster would be
   * useless on the day it is set up. Turning it on is what makes a
   * password safe to send: SASL/PLAIN puts the credential on the wire in
   * the clear, and the mechanism's name is not a promise about the
   * transport under it.
   */
  tls: boolean;
  degradedThresholdMs: number;
}

export const kafkaProducerStoredSchema = z
  .object({
    topic: z
      .string()
      .trim()
      .max(MAX_TOPIC_LENGTH)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null))
      .refine((value) => value === null || TOPIC_PATTERN.test(value), {
        message:
          "A topic name may only contain letters, digits, dots, underscores and hyphens.",
      })
      // Kafka refuses these two outright: they collide with the on-disk
      // directory names its log segments live in.
      .refine((value) => value !== "." && value !== "..", {
        message: 'A topic cannot be named "." or "..".',
      }),
    message: z.string().max(512).default(DEFAULT_KAFKA_MESSAGE),
    username: z
      .string()
      .trim()
      .max(255)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null)),
    // Not trimmed, unlike the user name: trailing whitespace inside a
    // password is part of the secret, and quietly rewriting it turns a
    // working credential into a refusal nobody can account for.
    password: z
      .string()
      .max(255)
      .nullish()
      .transform((value) => (value && value.length > 0 ? value : null)),
    tls: z.boolean().default(false),
  })
  // SASL/PLAIN sends `\0user\0password` as one token; there is no shape
  // for a password on its own. Refused here, where the operator is
  // standing, rather than dropped at connect time — a silently unsent
  // password comes back from the broker as an authentication failure,
  // which sends the search for the cause in the wrong direction.
  .refine((config) => config.username !== null || config.password === null, {
    message: "A password needs a username.",
    path: ["password"],
  });

export const kafkaProducerConfigSchema: z.ZodType<KafkaProducerConfig> =
  z.object({
    topic: z.string().max(MAX_TOPIC_LENGTH).nullable(),
    message: z.string().max(512),
    username: z.string().max(255).nullable(),
    password: z.string().max(255).nullable(),
    tls: z.boolean(),
    degradedThresholdMs: z.number().int().min(100).max(30_000),
  });

/**
 * The protocol error codes a producer can actually be handed, in the
 * broker's own vocabulary.
 *
 * Deliberately not the full table — Kafka defines over a hundred codes
 * and most belong to consumer groups, transactions and admin operations
 * this check never performs. An unlisted code still reaches the operator
 * as a number, which is greppable; a wrong name would be worse than no
 * name at all.
 *
 * Every one of these is the broker *answering*: the process is alive and
 * speaking the protocol. So a refusal is recorded as a fact and judged
 * by an assertion, never returned as a transport error — an operator who
 * cannot write to a topic still needs to know the cluster is up.
 */
export const KAFKA_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  1: "OFFSET_OUT_OF_RANGE",
  2: "CORRUPT_MESSAGE — the broker rejected the batch's checksum",
  3: "UNKNOWN_TOPIC_OR_PARTITION",
  5: "LEADER_NOT_AVAILABLE — the partition is electing a leader",
  6: "NOT_LEADER_OR_FOLLOWER — this broker no longer leads the partition",
  7: "REQUEST_TIMED_OUT — the leader could not replicate in time",
  8: "BROKER_NOT_AVAILABLE",
  9: "REPLICA_NOT_AVAILABLE",
  10: "MESSAGE_TOO_LARGE",
  13: "NETWORK_EXCEPTION",
  17: "INVALID_TOPIC_EXCEPTION",
  18: "RECORD_LIST_TOO_LARGE",
  19: "NOT_ENOUGH_REPLICAS — fewer in-sync replicas than min.insync.replicas",
  20: "NOT_ENOUGH_REPLICAS_AFTER_APPEND",
  21: "INVALID_REQUIRED_ACKS",
  29: "TOPIC_AUTHORIZATION_FAILED",
  31: "CLUSTER_AUTHORIZATION_FAILED",
  32: "INVALID_TIMESTAMP",
  33: "UNSUPPORTED_SASL_MECHANISM",
  34: "ILLEGAL_SASL_STATE",
  35: "UNSUPPORTED_VERSION",
  42: "INVALID_REQUEST",
  43: "UNSUPPORTED_FOR_MESSAGE_FORMAT",
  44: "POLICY_VIOLATION",
};

export function kafkaErrorMessage(code: number): string {
  return KAFKA_ERROR_MESSAGES[code] ?? `Kafka error code ${code}`;
}

/**
 * Codes that mean the cluster is healthy and this monitor's credential
 * is not allowed to do what it was asked.
 *
 * Reported as `misconfigured`, never `down`, for the same reason a
 * rejected Redis password is: an ACL that was never granted is an
 * operator error, and an operator error indistinguishable from an outage
 * is the one failure a monitoring product may not have.
 */
export const KAFKA_AUTHORIZATION_ERRORS: readonly number[] = [29, 31];

const topicExists: Assertion<KafkaProducerConfig> = {
  id: "topic-exists",
  fact: "topicFound",
  severity: "down",
  evaluate(value, config) {
    // Absent when metadata never came back, which the probe reports as a
    // transport failure; there is nothing here to have an opinion about.
    if (typeof value !== "boolean") return null;
    if (value) return null;
    return `The cluster has no topic "${config.topic ?? ""}"`;
  },
};

/**
 * Reads the broker's own words rather than the `produced` boolean beside
 * it, because the words are what an operator acts on:
 * `NOT_ENOUGH_REPLICAS` and `TOPIC_AUTHORIZATION_FAILED` have nothing in
 * common except that neither of them wrote the message. The probe leaves
 * this fact null when — and only when — the write succeeded, so a null
 * is never a silently skipped assertion.
 */
const produceAccepted: Assertion<KafkaProducerConfig> = {
  id: "produce-accepted",
  fact: "brokerError",
  severity: "down",
  evaluate(value) {
    if (typeof value !== "string" || value.length === 0) return null;
    return `The broker refused the message: ${value}`;
  },
};

export const kafkaProducerSpec: CheckTypeSpec<KafkaProducerConfig> = {
  descriptor: kafkaProducerDescriptor,
  configSchema: kafkaProducerConfigSchema,
  storedSchema: kafkaProducerStoredSchema,
  secretFields: ["password"],
  targetSchema: monitorHostnameSchema,
  assertions: [
    topicExists,
    produceAccepted,
    latencyAssertion<KafkaProducerConfig>("Produced"),
  ],
  fromRow(row: MonitorRowView): KafkaProducerConfig {
    const stored = kafkaProducerStoredSchema.safeParse(row.config ?? {});
    return {
      topic: stored.success ? stored.data.topic : null,
      message: stored.success ? stored.data.message : DEFAULT_KAFKA_MESSAGE,
      username: stored.success ? stored.data.username : null,
      password: stored.success ? stored.data.password : null,
      tls: stored.success ? stored.data.tls : false,
      degradedThresholdMs: row.degradedThresholdMs,
    };
  },
  describeTarget(target, port, config) {
    // Broker, port and topic — never the credential, which lives in the
    // config this function is handed. Two monitors on one cluster differ
    // only by their topic, so an incident email that omitted it would be
    // an email that gets replied to.
    const broker = `${target}:${port ?? DEFAULT_KAFKA_PORT}`;
    return config.topic === null ? broker : `${broker}/${config.topic}`;
  },
};
