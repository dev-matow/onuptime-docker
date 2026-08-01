import {
  isActiveType,
  isAggregateType,
  isManualType,
  isPassiveType,
} from "./contract";
import type {
  CheckTypeDefinition,
  ProbeContext,
  ProbeResult,
} from "./contract";
import { postgresProbe } from "./probes/postgres";
import { mysqlProbe } from "./probes/mysql";
import { mongodbProbe } from "./probes/mongodb";
import { redisProbe } from "./probes/redis";
import { dockerProbe } from "./probes/docker";
import { mqttProbe } from "./probes/mqtt";
import { smtpProbe } from "./probes/smtp";
import { jsonQueryProbe } from "./probes/json-query";
import { domainExpiryProbe } from "./probes/domain-expiry";
import { dnsProbe } from "./probes/dns";
import { httpProbe } from "./probes/http";
import { pingProbe } from "./probes/ping";
import { tcpProbe } from "./probes/tcp";
import { tlsExpiryProbe } from "./probes/tls-expiry";
import { elasticsearchProbe } from "./probes/elasticsearch";
import { ftpProbe } from "./probes/ftp";
import { gamedigProbe } from "./probes/gamedig";
import { globalpingProbe } from "./probes/globalping";
import { grpcProbe } from "./probes/grpc";
import { imapProbe } from "./probes/imap";
import { kafkaProducerProbe } from "./probes/kafka-producer";
import { ldapProbe } from "./probes/ldap";
import { memcachedProbe } from "./probes/memcached";
import { ntpProbe } from "./probes/ntp";
import { oracledbProbe } from "./probes/oracledb";
import { rabbitmqProbe } from "./probes/rabbitmq";
import { radiusProbe } from "./probes/radius";
import { realBrowserProbe } from "./probes/real-browser";
import { sipProbe } from "./probes/sip";
import { snmpProbe } from "./probes/snmp";
import { sqlserverProbe } from "./probes/sqlserver";
import { sshProbe } from "./probes/ssh";
import { steamProbe } from "./probes/steam";
import { systemServiceProbe } from "./probes/system-service";
import { tailscalePingProbe } from "./probes/tailscale-ping";
import { udpProbe } from "./probes/udp";
import { websocketProbe } from "./probes/websocket";
import { CHECK_TYPE_SPECS } from "./specs";

/**
 * The check-type registry: every spec joined to its probe.
 *
 * Server-only — importing this pulls in `node:dns`, `node:net`,
 * `node:tls` and `node:child_process`. Anything that needs a type's
 * metadata in the browser imports `catalog.ts`; anything that needs its
 * validation imports `specs/`.
 *
 * The registry is a plain map on purpose. It is shaped for a loader —
 * a type is one self-contained object, and nothing here knows the set
 * of ids at compile time — but it does not have one. Publishing an
 * extension contract now would freeze it against six types; the
 * contract ships in 2.0 once enough first-party types have proved it.
 */
type AnyProbe = (context: ProbeContext<never>) => Promise<ProbeResult>;

/** The probe as the definition's own signature sees it. */
type ActiveProbe = (context: ProbeContext<unknown>) => Promise<ProbeResult>;

const PROBES: Readonly<Record<string, AnyProbe>> = {
  http: httpProbe as AnyProbe,
  tcp: tcpProbe as AnyProbe,
  ping: pingProbe as AnyProbe,
  dns: dnsProbe as AnyProbe,
  "tls-expiry": tlsExpiryProbe as AnyProbe,
  elasticsearch: elasticsearchProbe as AnyProbe,
  ftp: ftpProbe as AnyProbe,
  gamedig: gamedigProbe as AnyProbe,
  globalping: globalpingProbe as AnyProbe,
  grpc: grpcProbe as AnyProbe,
  imap: imapProbe as AnyProbe,
  "kafka-producer": kafkaProducerProbe as AnyProbe,
  ldap: ldapProbe as AnyProbe,
  memcached: memcachedProbe as AnyProbe,
  ntp: ntpProbe as AnyProbe,
  oracledb: oracledbProbe as AnyProbe,
  rabbitmq: rabbitmqProbe as AnyProbe,
  radius: radiusProbe as AnyProbe,
  "real-browser": realBrowserProbe as AnyProbe,
  sip: sipProbe as AnyProbe,
  snmp: snmpProbe as AnyProbe,
  sqlserver: sqlserverProbe as AnyProbe,
  ssh: sshProbe as AnyProbe,
  steam: steamProbe as AnyProbe,
  "system-service": systemServiceProbe as AnyProbe,
  "tailscale-ping": tailscalePingProbe as AnyProbe,
  udp: udpProbe as AnyProbe,
  websocket: websocketProbe as AnyProbe,
  "domain-expiry": domainExpiryProbe as AnyProbe,
  postgres: postgresProbe as AnyProbe,
  mysql: mysqlProbe as AnyProbe,
  mongodb: mongodbProbe as AnyProbe,
  redis: redisProbe as AnyProbe,
  docker: dockerProbe as AnyProbe,
  mqtt: mqttProbe as AnyProbe,
  smtp: smtpProbe as AnyProbe,
  "json-query": jsonQueryProbe as AnyProbe,
};

/**
 * Joins each spec to the one function its kind is evaluated by.
 *
 * The two throws are the same guarantee read in both directions, and
 * both fail at import time rather than at 3am. A missing probe used to
 * be the only way to get this wrong; since kinds exist, a *present*
 * probe on a group is the other way — somebody wrote a transport
 * believing it would run, and nothing would ever call it, so the
 * monitor would sit deriving its state from children while a probe sat
 * unreferenced next to it.
 *
 * Passive, aggregate and manual types arrive already complete: their
 * evaluation functions are pure and isomorphic, so they live in the
 * spec beside the assertions rather than in a `probes/` file that must
 * be kept out of the browser bundle.
 */
function build(): Record<string, CheckTypeDefinition<unknown>> {
  const definitions: Record<string, CheckTypeDefinition<unknown>> = {};
  for (const [id, spec] of Object.entries(CHECK_TYPE_SPECS)) {
    const probe = PROBES[id];

    if (isActiveType(spec)) {
      // A spec without a probe is unreachable code that would fail at
      // the worst moment — the first check of a monitor someone just
      // created.
      if (!probe) throw new Error(`Check type "${id}" has no probe`);
      definitions[id] = { ...spec, probe: probe as ActiveProbe };
      continue;
    }

    if (probe) {
      throw new Error(
        `Check type "${id}" is ${spec.descriptor.kind} and must not have a probe`,
      );
    }

    if (isPassiveType(spec) || isAggregateType(spec) || isManualType(spec)) {
      definitions[id] = spec;
      continue;
    }

    throw new Error(
      `Check type "${id}" declares kind "${spec.descriptor.kind}" but carries no way to evaluate it`,
    );
  }
  return definitions;
}

export const CHECK_TYPES: Readonly<
  Record<string, CheckTypeDefinition<unknown>>
> = build();

export function findCheckType(
  id: string,
): CheckTypeDefinition<unknown> | undefined {
  return Object.hasOwn(CHECK_TYPES, id) ? CHECK_TYPES[id] : undefined;
}

export function requireCheckType(id: string): CheckTypeDefinition<unknown> {
  const definition = findCheckType(id);
  if (!definition) throw new Error(`Unknown check type: ${id}`);
  return definition;
}
