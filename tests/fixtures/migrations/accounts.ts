import type { Route } from "./fetcher";

/**
 * Sanitized vendor accounts, one per adapter.
 *
 * Every body here is shaped like the vendor's own published response and
 * filled with values that belong to nobody: `example.com` and its
 * subdomains, RFC 5737 documentation addresses, and identifiers that are
 * obviously invented.
 *
 * Each account deliberately contains the awkward rows rather than the
 * happy path only: a type with no Vigil equivalent, a row missing the
 * field the adapter keys on, a check whose target Vigil's own rules
 * refuse, a paginated list that must be walked to the end, and a
 * credential the adapter must not carry.
 *
 * `FIXTURE_SECRET` is the last of those. It appears in every account, in
 * whichever field that vendor keeps a password in, and one test asserts
 * that the string never appears anywhere in a snapshot, a report or a
 * rendered summary. It is not a real credential; it is a tracer.
 */

export const FIXTURE_SECRET = "fixture-secret-do-not-leak";

/* ─────────────────────────── UptimeRobot ─────────────────────────── */

export const UPTIMEROBOT: Route[] = [
  {
    path: "/v3/monitor-groups",
    body: { data: [{ id: 41, name: "Payments" }] },
  },
  {
    path: "/v3/monitors",
    query: { cursor: "7770004" },
    body: {
      data: [
        {
          id: 7770005,
          friendlyName: "Zone A record",
          type: "DNS",
          status: "PAUSED",
          url: "1.1.1.1",
          interval: 900,
          config: { dnsRecords: { A: ["203.0.113.10"] } },
        },
        {
          id: 7770006,
          friendlyName: "Homepage screenshot",
          type: "VISUAL_COMPARISON",
          status: "UP",
          url: "https://www.example.com",
          interval: 3600,
        },
        // A row with no type at all. Every adapter has to survive one.
        { id: 7770007, friendlyName: "Half a monitor" },
      ],
      nextLink: null,
    },
  },
  {
    path: "/v3/monitors",
    body: {
      data: [
        {
          id: 7770001,
          friendlyName: "Marketing site",
          type: "HTTP",
          status: "UP",
          url: "https://www.example.com/",
          interval: 60,
          timeout: 30,
          httpMethodType: "GET",
          authType: "NONE",
          customHttpHeaders: { "X-Env": "prod", Authorization: FIXTURE_SECRET },
          successHttpResponseCodes: ["2xx", "3xx"],
          followRedirections: true,
          checkSSLErrors: true,
          sslExpirationReminder: true,
          domainExpirationReminder: true,
          groupId: 41,
          tags: [{ id: 12, name: "prod" }],
          regionalData: { REGION: ["na", "eu"] },
          config: { sslExpirationPeriodDays: [21], applicationErrorRetries: 2 },
        },
        {
          id: 7770002,
          friendlyName: "Checkout keyword",
          type: "KEYWORD",
          status: "UP",
          url: "https://shop.example.com/health",
          interval: 300,
          timeout: 30,
          httpMethodType: "POST",
          keywordValue: "READY",
          keywordType: "ALERT_NOT_EXISTS",
          keywordCaseType: 0,
          authType: "HTTP_BASIC",
          httpUsername: "probe",
          httpPassword: FIXTURE_SECRET,
          postValueData: '{"probe":true}',
          successHttpResponseCodes: ["200"],
          groupId: 41,
          tags: [],
        },
        {
          id: 7770003,
          friendlyName: "Gateway ping",
          type: "PING",
          status: "UP",
          url: "gateway.example.com",
          interval: 120,
        },
        {
          id: 7770004,
          friendlyName: "Postgres port",
          type: "PORT",
          status: "UP",
          url: "db.example.com",
          port: 5432,
          interval: 300,
        },
      ],
      nextLink: "https://api.uptimerobot.com/v3/monitors?cursor=7770004",
    },
  },
];

/* ─────────────────────────── Better Stack ────────────────────────── */

function betterStackMonitor(
  id: string,
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  return { id, type: "monitor", attributes };
}

export const BETTERSTACK: Route[] = [
  {
    path: "/api/v2/monitor-groups",
    body: { data: [{ id: "900", attributes: { name: "Public" } }] },
  },
  {
    path: "/api/v2/monitors",
    query: { page: "2" },
    body: {
      data: [
        betterStackMonitor("5", {
          url: "1.1.1.1",
          pronounceable_name: "Zone lookup",
          monitor_type: "dns",
          request_body: "example.com",
          check_frequency: 300,
          request_timeout: 3000,
        }),
        betterStackMonitor("6", {
          url: "https://app.example.com/journey",
          pronounceable_name: "Signup journey",
          monitor_type: "playwright",
          check_frequency: 600,
          request_timeout: 60,
        }),
        betterStackMonitor("7", {
          url: "mail.example.com",
          pronounceable_name: "POP mailbox",
          monitor_type: "pop",
          port: "110",
          check_frequency: 300,
          request_timeout: 2000,
        }),
        betterStackMonitor("8", {
          url: "dns.example.com",
          pronounceable_name: "Datagram probe",
          monitor_type: "udp",
          port: "53",
          check_frequency: 60,
          request_timeout: 2000,
          request_body: "ping",
        }),
        betterStackMonitor("9", {
          url: "mail.example.com",
          pronounceable_name: "Submission over TLS",
          monitor_type: "smtp",
          // 465 speaks TLS before a byte of SMTP, and Vigil's probe is
          // plaintext, so this must be refused rather than imported down.
          port: "465",
          check_frequency: 300,
          request_timeout: 2000,
        }),
      ],
      pagination: { next: null },
    },
  },
  {
    path: "/api/v2/monitors",
    body: {
      data: [
        betterStackMonitor("2", {
          url: "https://www.example.com",
          pronounceable_name: "Homepage keyword absence",
          monitor_type: "keyword_absence",
          monitor_group_id: "900",
          required_keyword: "maintenance",
          verify_ssl: true,
          check_frequency: 30,
          http_method: "get",
          request_timeout: 15,
          request_headers: [
            { id: "1", name: "Content-Type", value: "application/json" },
            { id: "2", name: "Authorization", value: FIXTURE_SECRET },
          ],
          request_body: "",
          paused_at: null,
          ssl_expiration: 7,
          domain_expiration: 14,
          regions: ["us", "eu"],
          confirmation_period: 120,
          expected_status_codes: [],
          auth_username: "probe",
          auth_password: FIXTURE_SECRET,
        }),
        betterStackMonitor("3", {
          url: "db.example.com",
          pronounceable_name: "Postgres port",
          monitor_type: "tcp",
          port: "5432",
          check_frequency: 60,
          // Milliseconds on this type, seconds on an HTTP one.
          request_timeout: 2000,
          paused_at: "2026-06-01T10:00:00.000Z",
          confirmation_period: 60,
        }),
        betterStackMonitor("4", {
          url: "https://api.example.com/health",
          pronounceable_name: "API status codes",
          monitor_type: "expected_status_code",
          check_frequency: 60,
          request_timeout: 10,
          expected_status_codes: [200, 201],
          follow_redirects: false,
        }),
      ],
      pagination: {
        next: "https://uptime.betterstack.com/api/v2/monitors?page=2",
      },
    },
  },
];

/* ───────────────────────────── Pingdom ───────────────────────────── */

export const PINGDOM: Route[] = [
  {
    path: "/api/3.1/checks",
    body: {
      checks: [
        {
          id: 100,
          name: "www prod",
          type: "http",
          hostname: "www.example.com",
        },
        {
          id: 101,
          name: "checkout post",
          type: "http",
          hostname: "shop.example.com",
        },
        {
          id: 102,
          name: "smtp relay",
          type: "smtp",
          hostname: "mail.example.com",
        },
        {
          id: 103,
          name: "authoritative dns",
          type: "dns",
          hostname: "example.com",
        },
        {
          id: 104,
          name: "unreadable",
          type: "http",
          hostname: "gone.example.com",
        },
      ],
      counts: { total: 5 },
    },
  },
  {
    path: "/api/3.1/checks/100",
    body: {
      check: {
        id: 100,
        name: "www prod",
        hostname: "www.example.com",
        status: "up",
        resolution: 5,
        sendnotificationwhendown: 2,
        tags: [{ name: "prod", type: "u" }],
        probe_filters: ["region: EU"],
        type: {
          http: {
            url: "/health",
            encryption: true,
            port: 443,
            shouldcontain: "ok",
            verify_certificate: true,
            ssl_down_days_before: 14,
            requestheaders: ["X-Env:prod", `Authorization:${FIXTURE_SECRET}`],
          },
        },
      },
    },
  },
  {
    path: "/api/3.1/checks/101",
    body: {
      check: {
        id: 101,
        name: "checkout post",
        hostname: "shop.example.com",
        status: "paused",
        resolution: 1,
        type: {
          http: {
            url: "/orders",
            encryption: true,
            postdata: '{"probe":true}',
            username: "probe",
            password: FIXTURE_SECRET,
          },
        },
      },
    },
  },
  {
    path: "/api/3.1/checks/102",
    body: {
      check: {
        id: 102,
        name: "smtp relay",
        hostname: "mail.example.com",
        status: "up",
        resolution: 5,
        type: { smtp: { port: 25, stringtoexpect: "220", username: "probe" } },
      },
    },
  },
  {
    path: "/api/3.1/checks/103",
    body: {
      check: {
        id: 103,
        name: "authoritative dns",
        hostname: "example.com",
        status: "up",
        resolution: 15,
        type: {
          dns: { nameserver: "ns1.example.com", expectedip: "203.0.113.10" },
        },
      },
    },
  },
  {
    path: "/api/3.1/checks/104",
    status: 500,
    body: { error: { statusdesc: "Internal Server Error" } },
  },
];

/* ──────────────────────────── StatusCake ─────────────────────────── */

export const STATUSCAKE: Route[] = [
  {
    path: "/v1/uptime",
    query: { page: "2" },
    body: {
      data: [{ id: "127", name: "apex A record", test_type: "DNS" }],
      metadata: { page: 2, per_page: 100, page_count: 2, total_count: 4 },
    },
  },
  {
    path: "/v1/uptime",
    body: {
      data: [
        { id: "123", name: "example HTTP check", test_type: "HTTP" },
        { id: "124", name: "head check", test_type: "HEAD" },
        { id: "125", name: "postgres tcp", test_type: "TCP" },
      ],
      metadata: { page: 1, per_page: 100, page_count: 2, total_count: 4 },
    },
  },
  {
    path: "/v1/uptime/123",
    body: {
      data: {
        name: "example HTTP check",
        website_url: "https://www.example.com",
        test_type: "HTTP",
        check_rate: 300,
        timeout: 20,
        paused: false,
        tags: ["prod"],
        find_string: "operational",
        do_not_find: false,
        follow_redirects: true,
        confirmation: 3,
        enable_ssl_alert: true,
        status_codes: ["500", "503"],
        // A JSON document inside a JSON string, which is how StatusCake
        // stores headers. The value must never travel.
        custom_header: `{"X-Env":"prod","Authorization":"${FIXTURE_SECRET}"}`,
        basic_username: "probe",
        servers: [{ region_code: "lon", region: "London" }],
      },
    },
  },
  {
    path: "/v1/uptime/124",
    body: {
      data: {
        name: "head check",
        website_url: "https://cdn.example.com",
        test_type: "HEAD",
        check_rate: 60,
        timeout: 10,
        paused: false,
        // Malformed on purpose: a header blob that is not JSON.
        custom_header: "{not json at all",
      },
    },
  },
  {
    path: "/v1/uptime/125",
    body: {
      data: {
        name: "postgres tcp",
        website_url: "db.example.com",
        test_type: "TCP",
        port: 5432,
        check_rate: 300,
        timeout: 15,
        paused: false,
      },
    },
  },
  {
    path: "/v1/uptime/127",
    body: {
      data: {
        name: "apex A record",
        website_url: "example.com",
        test_type: "DNS",
        check_rate: 900,
        dns_ips: ["203.0.113.10"],
      },
    },
  },
];

/* ───────────────────────────── updown.io ─────────────────────────── */

export const UPDOWN: Route[] = [
  {
    path: "/api/checks",
    body: [
      {
        token: "ngg8",
        url: "https://www.example.com",
        type: "https",
        alias: "Marketing site",
        period: 60,
        apdex_t: 0.5,
        string_match: "All systems operational",
        enabled: true,
        published: true,
        disabled_locations: ["fra"],
        custom_headers: { Authorization: FIXTURE_SECRET },
        http_verb: "GET/HEAD",
        http_body: "",
      },
      {
        token: "a1b2",
        url: "https://api.example.com/health",
        type: "https",
        alias: "API status",
        period: 120,
        // A status code rather than a keyword: the overloaded column.
        string_match: "204",
        enabled: true,
        http_verb: "GET/HEAD",
      },
      {
        token: "c3d4",
        url: null,
        type: "pulse",
        alias: "Nightly backup",
        period: 93600,
        enabled: true,
      },
      {
        token: "e5f6",
        url: "tcp://db.example.com:5432",
        type: "tcp",
        alias: "Primary DB port",
        period: 300,
        enabled: false,
      },
      {
        token: "g7h8",
        url: "gateway.example.com",
        type: "icmp",
        alias: "Edge gateway",
        period: 60,
        enabled: true,
      },
    ],
  },
];

/* ──────────────────────────── Hyperping ──────────────────────────── */

export const HYPERPING: Route[] = [
  {
    path: "/v1/monitors",
    body: [
      {
        name: "API",
        url: "https://api.example.com",
        uuid: "mon_one",
        paused: false,
        protocol: "http",
        port: null,
        http_method: "GET",
        regions: ["amsterdam", "london"],
        check_frequency: 30,
        follow_redirects: true,
        expected_status_code: "2xx",
        request_body: "",
        request_headers: [],
        alerts_wait: 2,
        escalation_policy: { uuid: "policy_one", name: "On-Call DevOps" },
      },
      {
        name: "Apex DNS",
        url: "example.com",
        uuid: "mon_two",
        paused: true,
        protocol: "dns",
        check_frequency: 300,
      },
      {
        name: "Postgres",
        url: "db.example.com",
        uuid: "mon_three",
        protocol: "port",
        port: 5432,
        check_frequency: 60,
      },
    ],
  },
  {
    path: "/v1/monitors/mon_one",
    body: {
      name: "API",
      url: "https://api.example.com",
      uuid: "mon_one",
      protocol: "http",
      // Only the detail carries this, which is why the adapter merges.
      required_keyword: "healthy",
      request_headers: [{ name: "Authorization", value: FIXTURE_SECRET }],
      expected_status_code: "200",
    },
  },
  {
    path: "/v1/monitors/mon_two",
    body: {
      name: "Apex DNS",
      url: "example.com",
      uuid: "mon_two",
      protocol: "dns",
      dns_record_type: "A",
      dns_nameserver: "ns1.example.com",
      dns_expected_answer: "203.0.113.10",
    },
  },
  {
    path: "/v1/monitors/mon_three",
    status: 500,
    body: { error: "unavailable" },
  },
];

/* ─────────────────────────── Healthchecks ────────────────────────── */

export const HEALTHCHECKS: Route[] = [
  {
    path: "/api/v3/checks/",
    body: {
      checks: [
        {
          name: "Filesystem Backup",
          slug: "filesystem-backup",
          tags: "backup fs",
          desc: "Runs incremental backup every hour",
          grace: 600,
          timeout: 3600,
          status: "up",
          methods: "",
          start_kw: "START",
          success_kw: "SUCCESS",
          failure_kw: "ERROR",
          unique_key: "fixture0000000000000000000000000000000001",
        },
        {
          name: "Database Backup",
          slug: "database-backup",
          tags: "production db",
          grace: 1200,
          status: "paused",
          schedule: "15 5 * * *",
          tz: "UTC",
          unique_key: "fixture0000000000000000000000000000000002",
        },
      ],
    },
  },
];

/* ───────────────────────────── Cronitor ──────────────────────────── */

export const CRONITOR: Route[] = [
  {
    path: "/api/monitors",
    body: {
      monitors: [
        {
          key: "website-homepage",
          name: "Homepage",
          type: "check",
          platform: "http",
          group: "production",
          paused: false,
          request: {
            url: "https://www.example.com/health",
            method: "GET",
            headers: { Authorization: FIXTURE_SECRET },
            timeout_seconds: 10,
            follow_redirects: true,
            verify_ssl: true,
          },
          regions: ["us-east-1"],
          assertions: [
            "response.code = 200",
            'response.body contains "ok"',
            "response.time < 2s",
            "ssl_certificate.expires_in > 30 days",
          ],
          failure_tolerance: 2,
        },
        {
          key: "nightly-backup-job",
          name: "Nightly Backup",
          type: "job",
          platform: "linux cron",
          schedule: "0 2 * * *",
          grace_seconds: 300,
          paused: false,
        },
        {
          key: "signup-journey",
          name: "Signup journey",
          type: "check",
          platform: "browser",
          paused: false,
        },
        {
          key: "smtp-port",
          name: "SMTP port",
          type: "check",
          platform: "tcp",
          request: { url: "mail.example.com:25" },
        },
      ],
    },
  },
];

/* ───────────────────────────── Oh Dear ───────────────────────────── */

export const OHDEAR: Route[] = [
  {
    path: "/api/monitors",
    body: {
      data: [
        {
          id: 99,
          type: "http",
          url: "https://www.example.com",
          label: "example.com",
        },
        {
          id: 101,
          type: "tcp",
          url: "smtp.example.com:587",
          label: "Outbound SMTP",
        },
      ],
      meta: { current_page: 1, last_page: 1, per_page: 200, total: 2 },
    },
  },
  {
    path: "/api/monitors/99",
    body: {
      data: {
        id: 99,
        type: "http",
        url: "https://www.example.com",
        label: "example.com",
        group_name: "Marketing",
        tags: ["production"],
        checks: [
          { id: 100, type: "uptime", enabled: true },
          { id: 110, type: "certificate_health", enabled: true },
          { id: 111, type: "broken_links", enabled: true },
          { id: 112, type: "lighthouse", enabled: false },
        ],
        uptime_check_settings: {
          location: "paris",
          look_for_string: "operational",
          absent_string: null,
          expected_response_headers: [
            { name: "X-Env", condition: "equals", value: "prod" },
          ],
          failed_notification_threshold: 2,
          http_verb: "get",
          payload: [],
          timeout: 5,
          valid_status_codes: ["2*"],
          http_client_headers: [
            { name: "Authorization", value: FIXTURE_SECRET },
          ],
        },
        certificate_health_check_settings: {
          expires_soon_threshold_in_days: 21,
        },
      },
    },
  },
  {
    path: "/api/monitors/101",
    body: {
      data: {
        id: 101,
        type: "tcp",
        url: "smtp.example.com:587",
        label: "Outbound SMTP",
        checks: [{ id: 501, type: "uptime", enabled: false }],
        uptime_check_settings: {
          location: "paris",
          timeout_in_ms: 3000,
          failed_notification_threshold: 2,
        },
      },
    },
  },
];

/* ───────────────────────────── Checkly ───────────────────────────── */

export const CHECKLY: Route[] = [
  {
    path: "/v1/check-groups",
    body: [{ id: "grp_1", name: "Payments" }],
  },
  {
    path: "/v1/checks",
    body: [
      {
        id: "chk_api",
        name: "Checkout API",
        checkType: "API",
        activated: true,
        muted: false,
        shouldFail: false,
        frequency: 5,
        maxResponseTime: 20000,
        locations: ["us-east-1", "eu-central-1"],
        tags: ["production"],
        groupId: "grp_1",
        retryStrategy: {
          type: "LINEAR",
          baseBackoffSeconds: 60,
          maxRetries: 2,
        },
        request: {
          method: "GET",
          url: "https://api.example.com/v1/health",
          followRedirects: true,
          headers: [
            { key: "Content-Type", value: "application/json" },
            { key: "Authorization", value: FIXTURE_SECRET },
          ],
          queryParameters: [{ key: "verbose", value: "1" }],
          basicAuth: { username: "probe", password: FIXTURE_SECRET },
          assertions: [
            {
              source: "STATUS_CODE",
              comparison: "EQUALS",
              property: "",
              target: "200",
            },
            {
              source: "TEXT_BODY",
              comparison: "CONTAINS",
              property: "",
              target: "ok",
            },
            {
              source: "JSON_BODY",
              comparison: "NOT_NULL",
              property: "$.orderId",
              target: "",
            },
          ],
        },
        alertSettings: {
          sslCertificates: { enabled: true, alertThreshold: 30 },
        },
        environmentVariables: [
          { key: "LOGIN_PASS", value: null, locked: true, secret: true },
        ],
      },
      {
        id: "chk_browser",
        name: "Login flow",
        checkType: "BROWSER",
        activated: true,
        frequency: 10,
        script: "import { test } from '@playwright/test'",
      },
      {
        id: "chk_hb",
        name: "Nightly ETL",
        checkType: "HEARTBEAT",
        activated: true,
        heartbeat: {
          period: 24,
          periodUnit: "hours",
          grace: 30,
          graceUnit: "minutes",
        },
      },
      {
        id: "chk_dns",
        name: "Apex record",
        checkType: "DNS",
        activated: true,
        frequency: 15,
        request: {
          query: "example.com",
          recordType: "A",
          nameServer: "8.8.8.8",
          assertions: [],
        },
      },
      {
        id: "chk_ssl",
        name: "Certificate",
        checkType: "SSL",
        activated: false,
        frequency: 60,
        request: {
          // The target is nested, and there is no flat url or hostname
          // on an SSL check. Reading the flat fields gave every
          // certificate check no host at all.
          sslConfig: {
            hostname: "www.example.com",
            port: 8443,
            alertDaysBeforeExpiry: 21,
            securityBaseline: { minTlsVersion: { severity: "fail" } },
          },
        },
      },
      {
        id: "chk_grpc",
        name: "Payments gRPC",
        checkType: "GRPC",
        activated: true,
        frequency: 5,
        request: {
          hostname: "grpc.example.com",
          port: 50051,
          grpcConfig: { mode: "BEHAVIOR", service: "payments.v1.Pay" },
        },
      },
      {
        id: "chk_fast",
        name: "Sub-minute API",
        checkType: "API",
        activated: true,
        frequency: 0,
        frequencyOffset: 20,
        maxResponseTime: 5000,
        degradedResponseTime: 2000,
        request: {
          method: "GET",
          url: "https://fast.example.com/",
          assertions: [],
        },
      },
    ],
  },
];

/* ───────────────────────── Datadog Synthetics ────────────────────── */

export const DATADOG: Route[] = [
  {
    path: "/api/v1/synthetics/tests",
    body: {
      tests: [
        {
          public_id: "abc-def-ghi",
          name: "Checkout API",
          type: "api",
          subtype: "http",
          status: "live",
          tags: ["env:production"],
          locations: ["aws:eu-west-3"],
          config: {
            request: {
              url: "https://api.example.com/checkout",
              method: "GET",
              timeout: 30,
              headers: {
                accept: "application/json",
                authorization: FIXTURE_SECRET,
              },
              follow_redirects: true,
              basicAuth: {
                type: "web",
                username: "probe",
                password: FIXTURE_SECRET,
              },
            },
            assertions: [
              { type: "statusCode", operator: "is", target: 200 },
              { type: "responseTime", operator: "lessThan", target: 1000 },
              { type: "body", operator: "contains", target: "ready" },
            ],
          },
          options: {
            tick_every: 60,
            min_location_failed: 1,
            retry: { count: 2, interval: 300 },
          },
        },
        {
          public_id: "jkl-mno-pqr",
          name: "example.com DNS",
          type: "api",
          subtype: "dns",
          status: "live",
          locations: ["aws:eu-west-3"],
          config: {
            request: { host: "example.com", dnsServer: "8.8.8.8", timeout: 10 },
            assertions: [
              {
                type: "recordSome",
                property: "A",
                operator: "is",
                target: "203.0.113.10",
              },
            ],
          },
          options: { tick_every: 300 },
        },
        {
          public_id: "grp-cxx-001",
          name: "Payments gRPC",
          type: "api",
          subtype: "grpc",
          status: "live",
          locations: ["aws:eu-west-3"],
          config: {
            request: {
              host: "grpc.example.com",
              port: 50051,
              callType: "unary",
              service: "payments.v1.Pay",
            },
            assertions: [],
          },
          options: { tick_every: 60 },
        },
        {
          public_id: "ssl-cxx-002",
          name: "Edge certificate",
          type: "api",
          subtype: "ssl",
          status: "live",
          locations: ["aws:eu-west-3"],
          config: {
            request: { host: "www.example.com", port: 443 },
            assertions: [
              { type: "certificate", operator: "isInMoreThan", target: 21 },
            ],
          },
          options: { tick_every: 3600 },
        },
        {
          public_id: "stu-vwx-yz1",
          name: "Login flow",
          type: "browser",
          status: "paused",
          locations: ["aws:eu-west-3"],
          options: { tick_every: 900 },
        },
      ],
    },
  },
  {
    path: "/api/v1/synthetics/tests/browser/stu-vwx-yz1",
    body: {
      public_id: "stu-vwx-yz1",
      name: "Login flow",
      type: "browser",
      status: "paused",
      steps: [{ name: "click", type: "click", params: {} }],
    },
  },
];

/* ──────────────── Grafana Cloud Synthetic Monitoring ─────────────── */

export const GRAFANA: Route[] = [
  {
    path: "/api/v1/check",
    body: [
      {
        id: 101,
        job: "api-prod",
        target: "https://api.example.com/health",
        frequency: 60000,
        timeout: 5000,
        enabled: true,
        probes: [1, 12],
        labels: [{ name: "env", value: "prod" }],
        settings: {
          http: {
            method: "GET",
            ipVersion: "V4",
            validStatusCodes: [200, 204],
            headers: ["Accept: application/json"],
            noFollowRedirects: false,
            failIfBodyNotMatchesRegexp: ['"status"\\s*:\\s*"ok"'],
            bearerToken: FIXTURE_SECRET,
          },
        },
      },
      {
        id: 102,
        job: "dns-apex",
        target: "example.com",
        frequency: 120000,
        timeout: 3000,
        enabled: true,
        probes: [1],
        labels: [],
        settings: {
          dns: {
            server: "8.8.8.8",
            port: 53,
            // The integer form of the enum, which the OpenAPI declares.
            protocol: 1,
            recordType: 1,
            ipVersion: 1,
            validRCodes: ["NOERROR"],
            validateAnswerRRS: { failIfNotMatchesRegexp: ["^93\\.184\\."] },
          },
        },
      },
      {
        id: 103,
        job: "smtp-edge",
        target: "mail.example.com:25",
        frequency: 300000,
        timeout: 10000,
        enabled: false,
        probes: [12],
        settings: {
          tcp: {
            ipVersion: 1,
            tls: false,
            queryResponse: [{ send: "RUhMTyB2aWdpbA==", expect: "MjUw" }],
          },
        },
      },
      {
        id: 104,
        job: "k6-journey",
        target: "https://app.example.com",
        frequency: 600000,
        timeout: 30000,
        enabled: true,
        settings: {
          scripted: { script: "aW1wb3J0IGh0dHAgZnJvbSAnazYvaHR0cCc7" },
        },
      },
    ],
  },
];

/* ─────────────────────── New Relic Synthetics ────────────────────── */

export const NEWRELIC: Route[] = [
  {
    path: "/synthetics/api/v3/monitors",
    body: {
      monitors: [
        {
          id: "11111111-2222-3333-4444-555555555555",
          name: "prod-api-health",
          type: "SIMPLE",
          frequency: 5,
          uri: "https://api.example.com/health",
          locations: ["AWS_US_EAST_1"],
          status: "ENABLED",
          slaThreshold: 7,
          options: {
            validationString: "ok",
            verifySSL: true,
            bypassHEADRequest: true,
            treatRedirectAsFailure: false,
          },
        },
        {
          id: "22222222-3333-4444-5555-666666666666",
          name: "checkout-flow",
          type: "SCRIPT_BROWSER",
          frequency: 15,
          locations: ["AWS_EU_WEST_1"],
          status: "DISABLED",
          options: {},
        },
      ],
      count: 2,
    },
  },
  {
    path: "/graphql",
    body: {
      data: {
        actor: {
          entitySearch: {
            results: {
              nextCursor: null,
              entities: [
                {
                  guid: "GUID1",
                  name: "prod-api-health",
                  monitorType: "SIMPLE",
                },
                {
                  guid: "GUID2",
                  name: "checkout-flow",
                  monitorType: "SCRIPT_BROWSER",
                },
                // Known to the entity search and absent from REST v3:
                // exactly the silent loss the cross-check exists for.
                { guid: "GUID3", name: "cert-www", monitorType: "CERT_CHECK" },
              ],
            },
          },
        },
      },
    },
  },
];

/* ──────────────────────────── Uptime.com ─────────────────────────── */

export const UPTIMECOM: Route[] = [
  {
    path: "/api/v1/checks/",
    body: {
      count: 6,
      next: null,
      previous: null,
      results: [
        {
          pk: 123456,
          name: "Marketing site",
          monitoring_service_type: "HTTP",
          is_paused: false,
          msp_address: "https://www.example.com/health",
          msp_interval: 5,
          msp_threshold: 30,
          msp_status_code: "200",
          msp_expect_string: "All systems operational",
          msp_expect_string_type: "STRING",
          msp_headers: `Content-Type: application/json\nAuthorization: ${FIXTURE_SECRET}`,
          msp_username: "probe",
          msp_num_retries: 2,
          msp_sensitivity: 2,
          locations: ["US East", "Europe West"],
          tags: ["prod"],
        },
        {
          pk: 123457,
          name: "Apex A record",
          monitoring_service_type: "DNS",
          msp_address: "example.com",
          msp_dns_record_type: "A",
          msp_dns_server: "8.8.8.8",
          msp_expect_string: "203.0.113.10",
          msp_interval: 15,
          msp_threshold: 20,
        },
        {
          pk: 123458,
          name: "Wildcard cert expiry",
          monitoring_service_type: "SSL_CERT",
          msp_address: "www.example.com",
          msp_port: 443,
          msp_threshold: 30,
          sslconfig: {
            ssl_cert_protocol: "https",
            ssl_cert_issuer: "Example CA",
          },
        },
        {
          pk: 123459,
          name: "Domain registration",
          monitoring_service_type: "WHOIS",
          msp_address: "example.com",
          msp_threshold: 45,
        },
        {
          pk: 123460,
          name: "Checkout API script",
          monitoring_service_type: "API",
          msp_address: "https://api.example.com",
          msp_script: '[{"step_def":"C_POST"}]',
        },
        {
          pk: 123461,
          name: "Regex match",
          monitoring_service_type: "HTTP",
          msp_address: "https://blog.example.com",
          msp_expect_string: "^ok$",
          msp_expect_string_type: "REGEX",
          msp_interval: 5,
          msp_threshold: 10,
        },
      ],
    },
  },
];
