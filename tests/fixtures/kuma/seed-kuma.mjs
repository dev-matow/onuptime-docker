/**
 * Seeds a real Uptime Kuma 2.4.0 instance over its own socket.io API.
 *
 * Every monitor, notification, status page, tag, maintenance window and
 * proxy in the resulting kuma.db was written by Kuma itself — this script
 * only supplies the same payloads its own frontend sends. That is the
 * point: an importer fixture hand-written with sqlite3 proves nothing
 * about the shapes Kuma actually persists.
 *
 * Usage: node seed.mjs [url]
 */
import { io } from "socket.io-client";

const URL = process.argv[2] ?? "http://localhost:3011";
const USER = "vigilseed";
const PASS = "VigilSeed!2026";

const socket = io(URL, { transports: ["websocket"], reconnection: false });

const emit = (event, ...args) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout on ${event}`)),
      20000,
    );
    socket.emit(event, ...args, (res) => {
      clearTimeout(timer);
      if (res && res.ok === false) reject(new Error(`${event}: ${res.msg}`));
      else resolve(res);
    });
  });

const ACCEPTED = ["200-299"];

/** Fields every monitor carries, mirroring Kuma's own monitorDefaults. */
const base = (over) => ({
  type: "http",
  name: "",
  parent: null,
  url: "https://example.com",
  wsSubprotocol: "",
  method: "GET",
  protocol: null,
  location: "world",
  ipFamily: null,
  interval: 60,
  retryInterval: 60,
  resendInterval: 0,
  maxretries: 0,
  retryOnlyOnStatusCodeFailure: false,
  notificationIDList: {},
  ignoreTls: false,
  upsideDown: false,
  expiryNotification: false,
  domainExpiryNotification: true,
  maxredirects: 10,
  accepted_statuscodes: ACCEPTED,
  saveResponse: false,
  saveErrorResponse: true,
  responseMaxLength: 1024,
  dns_resolve_type: "A",
  dns_resolve_server: "1.1.1.1",
  docker_container: "",
  docker_host: null,
  proxyId: null,
  basic_auth_user: "",
  basic_auth_pass: "",
  bearer_token: "",
  mqttUsername: "",
  mqttPassword: "",
  mqttTopic: "",
  mqttWebsocketPath: "",
  mqttSuccessMessage: "",
  mqttCheckType: "keyword",
  authMethod: null,
  oauth_auth_method: "client_secret_basic",
  httpBodyEncoding: "json",
  kafkaProducerBrokers: [],
  kafkaProducerSaslOptions: { mechanism: "None" },
  cacheBust: false,
  kafkaProducerSsl: false,
  kafkaProducerAllowAutoTopicCreation: false,
  gamedigGivenPortOnly: true,
  gamedigToken: "",
  remote_browser: null,
  screenshot_delay: 0,
  rabbitmqNodes: [],
  rabbitmqUsername: "",
  rabbitmqPassword: "",
  conditions: [],
  system_service_name: "",
  // Seeded monitors never run: a fixture that probes the real internet
  // is a fixture that fails in CI. Paused/disabled state is itself part
  // of what the importer has to carry across, so this is not a cheat.
  active: false,
  ...over,
});

/**
 * One monitor per top-level type in Kuma 2.4.0's selector, each carrying
 * its type-specific columns filled with distinctive values. Distinctive
 * matters: a mapping matrix generated against all-default rows cannot
 * tell a field that was carried across from a field that was dropped and
 * re-defaulted.
 */
const MONITORS = [
  // ── General ────────────────────────────────────────────────────────
  base({
    type: "http",
    name: "seed-http",
    url: "https://http.seed.invalid/path?q=1",
    method: "POST",
    body: '{"seed":"http"}',
    headers: '{"X-Seed":"http"}',
    basic_auth_user: "seeduser",
    basic_auth_pass: "seedpass",
    authMethod: "basic",
    maxredirects: 7,
    timeout: 33,
    interval: 90,
    maxretries: 3,
    retryInterval: 45,
    resendInterval: 5,
    ignoreTls: true,
    upsideDown: false,
    expiryNotification: true,
    saveResponse: true,
    responseMaxLength: 4096,
    cacheBust: true,
    description: "seeded http monitor with body, headers and basic auth",
    accepted_statuscodes: ["200-299", "301", "418"],
  }),
  base({
    type: "keyword",
    name: "seed-keyword",
    url: "https://keyword.seed.invalid/",
    keyword: "seed-keyword-value",
    invertKeyword: true,
    description: "seeded keyword monitor, inverted",
  }),
  base({
    type: "port",
    name: "seed-port",
    hostname: "port.seed.invalid",
    port: 6543,
    timeout: 12,
  }),
  base({
    type: "ping",
    name: "seed-ping",
    hostname: "ping.seed.invalid",
    packetSize: 128,
    ping_count: 4,
    ping_numeric: false,
    ping_per_request_timeout: 3,
    ipFamily: "ipv6",
    timeout: 10,
  }),
  base({
    type: "dns",
    name: "seed-dns",
    hostname: "dns.seed.invalid",
    dns_resolve_server: "9.9.9.9",
    dns_resolve_type: "MX",
    port: 5353,
    conditions: [
      {
        type: "expression",
        andOr: "and",
        variable: "record",
        operator: "contains",
        value: "seed-mx",
      },
    ],
  }),
  base({
    type: "docker",
    name: "seed-docker",
    docker_container: "seed-container",
    // docker_host is wired below, once the host row exists.
  }),
  base({
    type: "system-service",
    name: "seed-system-service",
    system_service_name: "seed-daemon.service",
  }),
  base({
    type: "real-browser",
    name: "seed-real-browser",
    url: "https://browser.seed.invalid/",
    screenshot_delay: 4,
  }),

  // ── Special ────────────────────────────────────────────────────────
  base({ type: "group", name: "seed-group", active: true }),

  // ── Passive ────────────────────────────────────────────────────────
  base({
    type: "push",
    name: "seed-push",
    pushToken: "seedPushToken1234",
    interval: 120,
  }),
  base({
    type: "manual",
    name: "seed-manual",
    manual_status: 1,
  }),

  // ── Specific ───────────────────────────────────────────────────────
  base({
    type: "globalping",
    name: "seed-globalping",
    url: "https://globalping.seed.invalid/",
    subtype: "http",
    location: "Europe",
    protocol: "HTTP2",
    keyword: "seed-globalping-keyword",
  }),
  base({
    type: "grpc-keyword",
    name: "seed-grpc",
    grpcUrl: "grpc.seed.invalid:50051",
    grpcServiceName: "SeedService",
    grpcMethod: "seedCheck",
    grpcProtobuf: 'syntax = "proto3"; message Seed { string id = 1; }',
    grpcBody: '{"id":"seed"}',
    grpcMetadata: "seed-key: seed-value",
    grpcEnableTls: true,
    keyword: "seed-grpc-keyword",
  }),
  base({
    type: "json-query",
    name: "seed-json-query",
    url: "https://jsonquery.seed.invalid/api",
    jsonPath: "$.status.state",
    jsonPathOperator: "==",
    expectedValue: "seed-ok",
  }),
  base({
    type: "kafka-producer",
    name: "seed-kafka",
    kafkaProducerTopic: "seed-topic",
    kafkaProducerBrokers: [
      "kafka1.seed.invalid:9092",
      "kafka2.seed.invalid:9092",
    ],
    kafkaProducerMessage: "seed-message",
    kafkaProducerSsl: true,
    kafkaProducerAllowAutoTopicCreation: true,
    kafkaProducerSaslOptions: {
      mechanism: "scram-sha-256",
      username: "seedkafka",
      password: "seedkafkapass",
    },
  }),
  base({
    type: "mqtt",
    name: "seed-mqtt",
    hostname: "mqtt.seed.invalid",
    port: 1883,
    mqttTopic: "seed/topic",
    mqttUsername: "seedmqtt",
    mqttPassword: "seedmqttpass",
    mqttSuccessMessage: "seed-online",
    mqttCheckType: "keyword",
    mqttWebsocketPath: "/mqtt",
  }),
  base({
    type: "rabbitmq",
    name: "seed-rabbitmq",
    rabbitmqNodes: ["https://rabbit1.seed.invalid:15672"],
    rabbitmqUsername: "seedrabbit",
    rabbitmqPassword: "seedrabbitpass",
  }),
  base({
    type: "sip-options",
    name: "seed-sip",
    hostname: "sip.seed.invalid",
    port: 5060,
  }),
  base({
    type: "smtp",
    name: "seed-smtp",
    hostname: "smtp.seed.invalid",
    port: 587,
    smtpSecurity: "starttls",
  }),
  base({
    type: "snmp",
    name: "seed-snmp",
    hostname: "snmp.seed.invalid",
    port: 161,
    snmpOid: "1.3.6.1.2.1.1.3.0",
    snmpVersion: "3",
    snmp_v3_username: "seedsnmp",
    radiusPassword: "seedsnmppass",
    conditions: [
      {
        type: "expression",
        andOr: "and",
        variable: "oid",
        operator: ">",
        value: "100",
      },
    ],
  }),
  base({
    type: "tailscale-ping",
    name: "seed-tailscale",
    hostname: "tailscale.seed.invalid",
  }),
  base({
    type: "websocket-upgrade",
    name: "seed-websocket",
    url: "wss://ws.seed.invalid/socket",
    wsSubprotocol: "seed-proto",
    wsIgnoreSecWebsocketAcceptHeader: true,
  }),

  // ── Database ───────────────────────────────────────────────────────
  base({
    type: "sqlserver",
    name: "seed-sqlserver",
    databaseConnectionString:
      "Server=mssql.seed.invalid,1433;Database=seed;User Id=seed;Password=seedpass;Encrypt=false",
    databaseQuery: "SELECT 1 AS seed",
  }),
  base({
    type: "mongodb",
    name: "seed-mongodb",
    databaseConnectionString:
      "mongodb://seed:seedpass@mongo.seed.invalid:27017/seed",
    databaseQuery: '{"ping":1}',
    jsonPath: "$.ok",
    expectedValue: "1",
  }),
  base({
    type: "mysql",
    name: "seed-mysql",
    databaseConnectionString:
      "mysql://seed:seedpass@mysql.seed.invalid:3306/seed",
    databaseQuery: "SELECT 1",
  }),
  base({
    type: "oracledb",
    name: "seed-oracledb",
    databaseConnectionString: "oracle.seed.invalid:1521/FREEPDB1",
    databaseQuery: "SELECT 1 FROM DUAL",
    radiusUsername: "seedoracle",
    radiusPassword: "seedoraclepass",
  }),
  base({
    type: "postgres",
    name: "seed-postgres",
    databaseConnectionString:
      "postgres://seed:seedpass@pg.seed.invalid:5432/seed",
    databaseQuery: "SELECT 1",
  }),
  base({
    type: "radius",
    name: "seed-radius",
    hostname: "radius.seed.invalid",
    port: 1812,
    radiusUsername: "seedradius",
    radiusPassword: "seedradiuspass",
    radiusSecret: "seedradiussecret",
    radiusCallingStationId: "seed-calling",
    radiusCalledStationId: "seed-called",
  }),
  base({
    type: "redis",
    name: "seed-redis",
    databaseConnectionString: "redis://seed:seedpass@redis.seed.invalid:6379",
  }),

  // ── Game server ────────────────────────────────────────────────────
  base({
    type: "gamedig",
    name: "seed-gamedig",
    hostname: "game.seed.invalid",
    port: 27015,
    game: "csgo",
    gamedigGivenPortOnly: false,
    gamedigToken: "seed-gamedig-token",
  }),
  base({
    type: "steam",
    name: "seed-steam",
    hostname: "steam.seed.invalid",
    port: 27016,
  }),
];

async function main() {
  await new Promise((resolve, reject) => {
    socket.on("connect", resolve);
    socket.on("connect_error", reject);
  });
  console.log("connected");

  // Kuma emits `setup` only while no user exists; after that, `login`.
  try {
    await emit("setup", USER, PASS);
    console.log("setup: created first user");
  } catch (e) {
    console.log(`setup skipped (${e.message}); logging in`);
  }
  await emit("login", { username: USER, password: PASS, token: "" });
  console.log("logged in");

  // ── prerequisites the monitors reference ──────────────────────────
  const dockerHost = await emit(
    "addDockerHost",
    {
      name: "seed-docker-host",
      dockerType: "socket",
      dockerDaemon: "/var/run/docker.sock",
    },
    null,
  );
  const dockerHostID = dockerHost.dockerHostID ?? dockerHost.id;
  console.log(`docker host ${dockerHostID}`);

  const proxy = await emit(
    "addProxy",
    {
      protocol: "http",
      host: "proxy.seed.invalid",
      port: 3128,
      auth: true,
      username: "seedproxy",
      password: "seedproxypass",
      active: true,
      default: false,
      applyExisting: false,
    },
    null,
  );
  console.log(`proxy ${proxy.id}`);

  const notifications = [];
  for (const n of [
    {
      name: "seed-webhook",
      type: "webhook",
      isDefault: false,
      applyExisting: false,
      webhookURL: "https://hooks.seed.invalid/endpoint",
      webhookContentType: "json",
    },
    {
      name: "seed-smtp-notification",
      type: "smtp",
      isDefault: false,
      applyExisting: false,
      smtpHost: "mail.seed.invalid",
      smtpPort: 587,
      smtpSecure: false,
      smtpUsername: "seedmail",
      smtpPassword: "seedmailpass",
      smtpFrom: "vigil@seed.invalid",
      smtpTo: "ops@seed.invalid",
    },
    {
      name: "seed-telegram",
      type: "telegram",
      isDefault: false,
      applyExisting: false,
      telegramBotToken: "0000:seed-telegram-token",
      telegramChatID: "-100200300",
    },
  ]) {
    const res = await emit("addNotification", n, null);
    notifications.push(res.id);
  }
  console.log(`notifications ${notifications.join(",")}`);

  // ── monitors ───────────────────────────────────────────────────────
  const ids = {};
  let groupID = null;
  for (const m of MONITORS) {
    const payload = { ...m };
    if (payload.type === "docker") payload.docker_host = dockerHostID;
    if (payload.type === "http") payload.proxyId = proxy.id;
    // Every monitor gets at least one notification so the join table is
    // exercised; the http one gets all three.
    payload.notificationIDList =
      payload.type === "http"
        ? Object.fromEntries(notifications.map((id) => [id, true]))
        : { [notifications[0]]: true };
    if (groupID && payload.type !== "group") payload.parent = groupID;

    const res = await emit("add", payload);
    ids[payload.name] = res.monitorID;
    if (payload.type === "group") groupID = res.monitorID;
    console.log(`monitor ${res.monitorID} ${payload.type} ${payload.name}`);
  }

  // ── tags ───────────────────────────────────────────────────────────
  const tagRes = await emit("addTag", {
    name: "seed-tag",
    color: "#3B82F6",
  });
  const tagID = tagRes.tag.id;
  await emit("addMonitorTag", tagID, ids["seed-http"], "seed-tag-value");
  await emit("addMonitorTag", tagID, ids["seed-postgres"], "");
  console.log(`tag ${tagID}`);

  // ── status page ────────────────────────────────────────────────────
  await emit("addStatusPage", "Seed Status", "seed-status");
  // addStatusPage only creates the shell; the monitors, groups and
  // presentation live in saveStatusPage. An importer that reads only the
  // status_page row would carry across a page with nothing on it.
  await emit(
    "saveStatusPage",
    "seed-status",
    {
      slug: "seed-status",
      title: "Seed Status",
      description: "seeded status page",
      icon: "/icon.svg",
      theme: "dark",
      published: true,
      showTags: true,
      customCSS: "body { --seed: 1; }",
      footerText: "seeded footer",
      showPoweredBy: false,
      analyticsType: "plausible",
      analyticsId: "seed.invalid",
      analyticsScriptUrl: "https://plausible.seed.invalid/js/script.js",
      rssTitle: "Seed Status feed",
      showCertificateExpiry: true,
      autoRefreshInterval: 120,
      showOnlyLastHeartbeat: false,
      domainNameList: [],
    },
    "",
    [
      {
        name: "Seeded services",
        weight: 1,
        monitorList: [
          { id: ids["seed-http"] },
          { id: ids["seed-postgres"] },
          { id: ids["seed-push"] },
        ],
      },
    ],
  );
  console.log("status page seed-status saved with 3 monitors");

  // ── maintenance ────────────────────────────────────────────────────
  const maint = await emit("addMaintenance", {
    title: "seed-maintenance",
    description: "seeded recurring maintenance window",
    strategy: "recurring-interval",
    active: true,
    intervalDay: 7,
    dateRange: ["2026-01-01 00:00:00", "2026-12-31 23:59:00"],
    timeRange: [
      { hours: 2, minutes: 0 },
      { hours: 3, minutes: 0 },
    ],
    weekdays: [],
    daysOfMonth: [],
    timezoneOption: "UTC",
  });
  const maintID = maint.maintenanceID ?? maint.id;
  if (maintID) {
    await emit("addMonitorMaintenance", maintID, [
      { id: ids["seed-http"], name: "seed-http" },
    ]);
    console.log(`maintenance ${maintID}`);
  }

  console.log(`\nseeded ${Object.keys(ids).length} monitors`);
  socket.close();
}

main().catch((e) => {
  console.error("SEED FAILED:", e.message);
  socket.close();
  process.exit(1);
});
