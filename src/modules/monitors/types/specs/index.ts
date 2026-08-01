import type {
  AnyCheckTypeSpec,
  CheckTypeKind,
  CheckTypeSpec,
} from "../contract";
import { groupSpec } from "./group";
import { manualSpec } from "./manual";
import { pushSpec } from "./push";
import { postgresSpec } from "./postgres";
import { mysqlSpec } from "./mysql";
import { mongodbSpec } from "./mongodb";
import { redisSpec } from "./redis";
import { dockerSpec } from "./docker";
import { mqttSpec } from "./mqtt";
import { smtpSpec } from "./smtp";
import { jsonQuerySpec } from "./json-query";
import { domainExpirySpec } from "./domain-expiry";
import { dnsSpec } from "./dns";
import { httpSpec } from "./http";
import { pingSpec } from "./ping";
import { tcpSpec } from "./tcp";
import { tlsExpirySpec } from "./tls-expiry";
import { elasticsearchSpec } from "./elasticsearch";
import { ftpSpec } from "./ftp";
import { gamedigSpec } from "./gamedig";
import { globalpingSpec } from "./globalping";
import { grpcSpec } from "./grpc";
import { imapSpec } from "./imap";
import { kafkaProducerSpec } from "./kafka-producer";
import { ldapSpec } from "./ldap";
import { memcachedSpec } from "./memcached";
import { ntpSpec } from "./ntp";
import { oracledbSpec } from "./oracledb";
import { rabbitmqSpec } from "./rabbitmq";
import { radiusSpec } from "./radius";
import { realBrowserSpec } from "./real-browser";
import { sipSpec } from "./sip";
import { snmpSpec } from "./snmp";
import { sqlserverSpec } from "./sqlserver";
import { sshSpec } from "./ssh";
import { steamSpec } from "./steam";
import { systemServiceSpec } from "./system-service";
import { tailscalePingSpec } from "./tailscale-ping";
import { udpSpec } from "./udp";
import { websocketSpec } from "./websocket";

/**
 * Every type's spec, keyed by id. Isomorphic — safe for the server
 * action layer, which needs the zod schemas but must not pull a
 * transport into the request path.
 */

/**
 * Erases a spec's config type.
 *
 * A registry holds specs with mutually incompatible `Config` types, and
 * TypeScript has no existential types to express "some config, used
 * consistently". The consistency is real — `fromRow` produces exactly
 * what this spec's own assertions, probe and `describeTarget` consume,
 * and nothing else ever constructs one — so the cast is sound. It is
 * confined to this one function so no call site has to repeat it.
 *
 * The kind is erased with it, and that is not a hole: a passive,
 * aggregate or manual spec was already checked against its own alias at
 * the point it was declared, so it carries the one function its kind is
 * evaluated by. The registry narrows back with the predicates in
 * `contract.ts` and refuses to build a type whose function is missing.
 */
function erase<Config, Kind extends CheckTypeKind>(
  spec: CheckTypeSpec<Config, Kind>,
): AnyCheckTypeSpec {
  return spec as unknown as AnyCheckTypeSpec;
}

export const CHECK_TYPE_SPECS: Readonly<Record<string, AnyCheckTypeSpec>> = {
  http: erase(httpSpec),
  tcp: erase(tcpSpec),
  ping: erase(pingSpec),
  dns: erase(dnsSpec),
  "tls-expiry": erase(tlsExpirySpec),
  elasticsearch: erase(elasticsearchSpec),
  ftp: erase(ftpSpec),
  gamedig: erase(gamedigSpec),
  globalping: erase(globalpingSpec),
  grpc: erase(grpcSpec),
  imap: erase(imapSpec),
  "kafka-producer": erase(kafkaProducerSpec),
  ldap: erase(ldapSpec),
  memcached: erase(memcachedSpec),
  ntp: erase(ntpSpec),
  oracledb: erase(oracledbSpec),
  rabbitmq: erase(rabbitmqSpec),
  radius: erase(radiusSpec),
  "real-browser": erase(realBrowserSpec),
  sip: erase(sipSpec),
  snmp: erase(snmpSpec),
  sqlserver: erase(sqlserverSpec),
  ssh: erase(sshSpec),
  steam: erase(steamSpec),
  "system-service": erase(systemServiceSpec),
  "tailscale-ping": erase(tailscalePingSpec),
  udp: erase(udpSpec),
  websocket: erase(websocketSpec),
  "domain-expiry": erase(domainExpirySpec),
  postgres: erase(postgresSpec),
  mysql: erase(mysqlSpec),
  mongodb: erase(mongodbSpec),
  redis: erase(redisSpec),
  docker: erase(dockerSpec),
  mqtt: erase(mqttSpec),
  smtp: erase(smtpSpec),
  "json-query": erase(jsonQuerySpec),
  push: erase(pushSpec),
  group: erase(groupSpec),
  manual: erase(manualSpec),
};

export function findSpec(id: string): AnyCheckTypeSpec | undefined {
  return Object.hasOwn(CHECK_TYPE_SPECS, id) ? CHECK_TYPE_SPECS[id] : undefined;
}

/** Throws for an unknown id — use at write time, where a bad type is a bug. */
export function requireSpec(id: string): AnyCheckTypeSpec {
  const spec = findSpec(id);
  if (!spec) throw new Error(`Unknown check type: ${id}`);
  return spec;
}

export {
  groupSpec,
  manualSpec,
  pushSpec,
  postgresSpec,
  mysqlSpec,
  mongodbSpec,
  redisSpec,
  dockerSpec,
  mqttSpec,
  smtpSpec,
  jsonQuerySpec,
  domainExpirySpec,
  dnsSpec,
  httpSpec,
  pingSpec,
  tcpSpec,
  tlsExpirySpec,
  elasticsearchSpec,
  ftpSpec,
  gamedigSpec,
  globalpingSpec,
  grpcSpec,
  imapSpec,
  kafkaProducerSpec,
  ldapSpec,
  memcachedSpec,
  ntpSpec,
  oracledbSpec,
  rabbitmqSpec,
  radiusSpec,
  realBrowserSpec,
  sipSpec,
  snmpSpec,
  sqlserverSpec,
  sshSpec,
  steamSpec,
  systemServiceSpec,
  tailscalePingSpec,
  udpSpec,
  websocketSpec,
};
