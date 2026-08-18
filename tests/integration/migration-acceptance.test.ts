import { desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { monitorChecks, monitors } from "@/db/schema";
import { importSnapshot } from "@/modules/importers/engine";
import type { SourceSnapshot } from "@/modules/importers/model";
import { requireProvider } from "@/modules/importers/providers";
import { runMonitorCheck } from "@/worker/jobs/monitor-check";

import * as ACCOUNTS from "../fixtures/migrations/accounts";
import { fakeTransport, type Route } from "../fixtures/migrations/fetcher";
import { createTestOrg, db, type TestActor } from "../helpers";
import { publicLookup } from "../probe-lookup";

/**
 * Acceptance: does an imported monitor perform the check the source
 * performed?
 *
 * Every other suite here stops at the row. This one starts there. A
 * monitor that passes `createMonitorSchema` and then requests the wrong
 * URL, sends the wrong method, or judges an inverted keyword the right
 * way round is a migration that looks complete and is not, and no
 * schema assertion catches any of those.
 *
 * So each scenario reads a provider-shaped account, imports it for real,
 * and then drives the persisted monitor through `runMonitorCheck` with a
 * scripted origin: a `fetchImpl` that records the request Vigil actually
 * made and answers with the response the scenario is about. What is
 * asserted is the pair that matters, **what was requested** and **what
 * verdict came back**, because together they are the operational
 * behaviour a customer is paying to keep.
 *
 * No sockets and no network: the origin is a function, and the resolver
 * is the suite's public one, so the egress guard runs its real decision
 * path without a DNS server being involved.
 */

interface Requested {
  url: string;
  method: string;
}

/** A scripted origin, and the log of what Vigil asked it. */
function origin(reply: (request: Requested) => Response): {
  fetchImpl: typeof fetch;
  seen: Requested[];
} {
  const seen: Requested[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const request: Requested = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
    };
    seen.push(request);
    return reply(request);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

/** Read one provider account and import it, for real. */
async function importAccount(
  providerId: string,
  routes: readonly Route[],
): Promise<{ actor: TestActor; snapshot: SourceSnapshot }> {
  const actor = await createTestOrg();
  const provider = requireProvider(providerId);
  const { options } = fakeTransport(routes);
  const credentials: Record<string, string> = {};
  for (const field of provider.credentials) {
    credentials[field.name] =
      field.choices?.[0]?.value ??
      (field.name === "baseUrl"
        ? "https://synthetic-monitoring-api.grafana.net"
        : "acceptance-token");
  }
  const snapshot = await provider.read({ credentials, transport: options });
  await importSnapshot(db, actor, snapshot);
  return { actor, snapshot };
}

async function monitorNamed(actor: TestActor, name: string) {
  const all = await db
    .select()
    .from(monitors)
    .where(eq(monitors.organizationId, actor.organizationId));
  const found = all.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(
      `no monitor named "${name}"; saw ${all.map((m) => m.name).join(", ")}`,
    );
  }
  return found;
}

/** The most recent observation the runner wrote, or null if it wrote none. */
async function lastCheck(monitorId: string) {
  const [row] = await db
    .select()
    .from(monitorChecks)
    .where(eq(monitorChecks.monitorId, monitorId))
    .orderBy(desc(monitorChecks.checkedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Turn off the certificate side-read before driving a monitor.
 *
 * Vigil's HTTP probe opens a *second*, real TLS socket when `tlsCheck`
 * is set, and `fetchImpl` cannot intercept that one. This suite sends
 * traffic nowhere, so the flag is asserted on the imported row and then
 * cleared for the drive. What is being exercised here is the request and
 * the verdict, not the certificate read, which has its own tests.
 */
async function withoutCertificateRead(monitorId: string): Promise<void> {
  await db
    .update(monitors)
    .set({ tlsCheck: false })
    .where(eq(monitors.id, monitorId));
}

/** Drive one persisted monitor against a scripted origin. */
async function check(
  monitorId: string,
  reply: (request: Requested) => Response,
): Promise<{
  verdict: string | null;
  error: string | null;
  seen: Requested[];
}> {
  const { fetchImpl, seen } = origin(reply);
  await runMonitorCheck(monitorId, {
    fetchImpl,
    lookup: publicLookup,
    allowPrivateTargets: true,
  });
  const observation = await lastCheck(monitorId);
  return {
    verdict: observation?.verdict ?? null,
    error: observation?.error ?? null,
    seen,
  };
}

describe("an imported HTTP monitor requests what the source requested", () => {
  it("keeps Better Stack's keyword absence inverted, all the way to the verdict", async () => {
    const { actor } = await importAccount("betterstack", ACCOUNTS.BETTERSTACK);
    const monitor = await monitorNamed(actor, "Homepage keyword absence");
    expect(monitor.checkType).toBe("http");
    expect(monitor.bodyKeyword).toBe("maintenance");
    expect(monitor.keywordAbsent).toBe(true);
    // Better Stack's `ssl_expiration: 7` came across as a certificate
    // warning; the drive below is about the body assertion.
    expect(monitor.tlsCheck).toBe(true);
    expect(monitor.tlsWarnDays).toBe(7);
    await withoutCertificateRead(monitor.id);

    // The word is absent: the source called that healthy, and so must
    // the imported monitor.
    const healthy = await check(
      monitor.id,
      () => new Response("all systems go", { status: 200 }),
    );
    expect(healthy.seen[0]?.url).toBe("https://www.example.com/");
    expect(healthy.seen[0]?.method).toBe("GET");
    expect(healthy.verdict).toBe("up");

    // The word is present. An importer that dropped the inversion would
    // call this up, and the customer would never hear about a
    // maintenance page again.
    const broken = await check(
      monitor.id,
      () => new Response("we are down for maintenance", { status: 200 }),
    );
    expect(broken.verdict).toBe("down");
    expect(broken.error).toContain("maintenance");
  });

  it("assembles Pingdom's scheme, host, port and path into the URL it requests", async () => {
    const { actor } = await importAccount("pingdom", ACCOUNTS.PINGDOM);
    const monitor = await monitorNamed(actor, "www prod");
    expect(monitor.url).toBe("https://www.example.com/health");
    // `ssl_down_days_before: 14` with `verify_certificate` on.
    expect(monitor.tlsCheck).toBe(true);
    expect(monitor.tlsWarnDays).toBe(14);
    await withoutCertificateRead(monitor.id);

    const result = await check(
      monitor.id,
      () => new Response("ok", { status: 200 }),
    );
    // Pingdom stores a path, not a URL. A monitor that requested the
    // bare host would watch the marketing page instead of the health
    // endpoint and would look perfectly healthy doing it.
    expect(result.seen[0]?.url).toBe("https://www.example.com/health");
    expect(result.verdict).toBe("up");

    // `shouldcontain: "ok"` came across, so a page without it is down.
    const missing = await check(
      monitor.id,
      () => new Response("maintenance", { status: 200 }),
    );
    expect(missing.verdict).toBe("down");
  });

  it("issues HEAD for a StatusCake HEAD test, not GET", async () => {
    const { actor } = await importAccount("statuscake", ACCOUNTS.STATUSCAKE);
    const monitor = await monitorNamed(actor, "head check");
    expect(monitor.method).toBe("HEAD");

    const result = await check(
      monitor.id,
      () => new Response(null, { status: 200 }),
    );
    expect(result.seen[0]?.method).toBe("HEAD");
    expect(result.verdict).toBe("up");
  });

  it("really does accept a 3xx that Better Stack would have failed, as the report says", async () => {
    // The report tells the operator that a status list could not be
    // expressed and the monitor now accepts any 2xx or 3xx. This is that
    // sentence, executed: if it were false in either direction the
    // warning would be misleading rather than merely unfortunate.
    const { actor } = await importAccount("betterstack", ACCOUNTS.BETTERSTACK);
    const monitor = await monitorNamed(actor, "API status codes");
    expect(monitor.expectedStatusCode).toBeNull();

    const redirect = await check(monitor.id, (request) =>
      request.url.endsWith("/health")
        ? new Response(null, {
            status: 301,
            headers: { location: "https://api.example.com/v2" },
          })
        : new Response("ok", { status: 200 }),
    );
    // Vigil follows the redirect one validated hop at a time and judges
    // the destination.
    expect(redirect.seen.map((entry) => entry.url)).toEqual([
      "https://api.example.com/health",
      "https://api.example.com/v2",
    ]);
    expect(redirect.verdict).toBe("up");
  });

  it("carries a single expected code as an expectation the check enforces", async () => {
    const { actor } = await importAccount("uptimecom", ACCOUNTS.UPTIMECOM);
    const monitor = await monitorNamed(actor, "Marketing site");
    expect(monitor.expectedStatusCode).toBe(200);

    const wrong = await check(
      monitor.id,
      () => new Response("All systems operational", { status: 204 }),
    );
    expect(wrong.verdict).toBe("down");
    expect(wrong.error).toContain("204");
  });
});

describe("an imported monitor's state and schedule survive the trip", () => {
  it("does not check a monitor that was paused in the source", async () => {
    const { actor } = await importAccount("betterstack", ACCOUNTS.BETTERSTACK);
    const monitor = await monitorNamed(actor, "Postgres port");
    expect(monitor.paused).toBe(true);

    const { fetchImpl, seen } = origin(() => new Response("", { status: 200 }));
    await runMonitorCheck(monitor.id, {
      fetchImpl,
      lookup: publicLookup,
      allowPrivateTargets: true,
    });
    // Nothing dialled and nothing recorded: pausing is how an operator
    // says "do not watch this", and an import that quietly resumed it
    // would page somebody about a decommissioned host.
    expect(seen).toHaveLength(0);
    expect(await lastCheck(monitor.id)).toBeNull();
  });

  it("keeps the unit conversions the vendors disagree about", async () => {
    const { actor } = await importAccount("betterstack", ACCOUNTS.BETTERSTACK);
    // Seconds on an HTTP monitor, milliseconds on a TCP one, in the
    // same field.
    expect(
      (await monitorNamed(actor, "Homepage keyword absence")).timeoutMs,
    ).toBe(15_000);
    expect((await monitorNamed(actor, "Postgres port")).timeoutMs).toBe(2_000);
    // Better Stack's confirmation period is a duration already, so it is
    // Vigil's failure window unchanged rather than a reconstruction.
    expect(
      (await monitorNamed(actor, "Homepage keyword absence"))
        .failureWindowSeconds,
    ).toBe(120);

    const pingdom = await importAccount("pingdom", ACCOUNTS.PINGDOM);
    // Pingdom's resolution is minutes.
    expect(
      (await monitorNamed(pingdom.actor, "www prod")).intervalSeconds,
    ).toBe(300);
  });

  it("gives a heartbeat a deadline of its own period plus its own grace", async () => {
    const { actor } = await importAccount(
      "healthchecks",
      ACCOUNTS.HEALTHCHECKS,
    );
    const monitor = await monitorNamed(actor, "Filesystem Backup");
    expect(monitor.checkType).toBe("push");
    expect(monitor.intervalSeconds).toBe(3_600);
    const config = monitor.config as { token?: string; graceSeconds?: number };
    expect(config.graceSeconds).toBe(600);
    // A token authenticates one caller to one monitor, so it must be
    // Vigil's own and not anything the source handed over.
    expect(config.token).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(JSON.stringify(monitor)).not.toContain(
      "fixture0000000000000000000000000000000001",
    );
  });

  it("stores a certificate check against the host and port the source watched", async () => {
    const { actor } = await importAccount("checkly", ACCOUNTS.CHECKLY);
    const monitor = await monitorNamed(actor, "Certificate");
    expect(monitor.checkType).toBe("tls-expiry");
    expect(monitor.url).toBe("www.example.com");
    expect(monitor.port).toBe(8443);
    expect(monitor.config).toMatchObject({ warnDays: 21 });
    // Driving the handshake would need a real TLS listener, which this
    // suite deliberately does not open; what is asserted is that the
    // monitor dials the host and port Checkly nested one level down,
    // which is the field that was wrong before this was written.
  });
});

describe("each deep-scrutiny provider persists a monitor that dials what the source dialled", () => {
  /**
   * One representative monitor per provider, checked against the row
   * rather than the model. These are the conversions that are invisible
   * when wrong: a frequency in the wrong unit still schedules, a port
   * read as a string still stores, a target read from the wrong field
   * still validates.
   */
  const CASES: {
    provider: string;
    account: readonly Route[];
    monitor: string;
    expect: Record<string, unknown>;
  }[] = [
    {
      provider: "uptimerobot",
      account: ACCOUNTS.UPTIMEROBOT,
      monitor: "Postgres port",
      // `url` holds a bare host on a PORT monitor, and the port is its
      // own field.
      expect: {
        checkType: "tcp",
        url: "db.example.com",
        port: 5432,
        intervalSeconds: 300,
      },
    },
    {
      provider: "betterstack",
      account: ACCOUNTS.BETTERSTACK,
      monitor: "Postgres port",
      // Better Stack returns the port as a *string*.
      expect: {
        checkType: "tcp",
        url: "db.example.com",
        port: 5432,
        timeoutMs: 2_000,
      },
    },
    {
      provider: "statuscake",
      account: ACCOUNTS.STATUSCAKE,
      monitor: "postgres tcp",
      expect: {
        checkType: "tcp",
        url: "db.example.com",
        port: 5432,
        timeoutMs: 15_000,
      },
    },
    {
      provider: "datadog",
      account: ACCOUNTS.DATADOG,
      monitor: "example.com DNS",
      // The record type is the assertion's `property`, not a request
      // field, and the queried name is `request.host`.
      expect: { checkType: "dns", url: "example.com", intervalSeconds: 300 },
    },
    {
      provider: "checkly",
      account: ACCOUNTS.CHECKLY,
      monitor: "Apex record",
      expect: { checkType: "dns", url: "example.com", intervalSeconds: 900 },
    },
    {
      provider: "grafana",
      account: ACCOUNTS.GRAFANA,
      monitor: "api-prod",
      // Frequency and timeout are milliseconds here and seconds almost
      // everywhere else.
      expect: {
        checkType: "http",
        url: "https://api.example.com/health",
        intervalSeconds: 60,
        timeoutMs: 5_000,
        method: "GET",
      },
    },
    {
      provider: "newrelic",
      account: ACCOUNTS.NEWRELIC,
      monitor: "prod-api-health",
      // `frequency` is minutes; `validationString` is the body assertion.
      expect: {
        checkType: "http",
        url: "https://api.example.com/health",
        intervalSeconds: 300,
        bodyKeyword: "ok",
        keywordAbsent: false,
      },
    },
    {
      provider: "uptimecom",
      account: ACCOUNTS.UPTIMECOM,
      monitor: "Wildcard cert expiry",
      // `msp_threshold` is days on this type and seconds on most others.
      expect: { checkType: "tls-expiry", url: "www.example.com", port: 443 },
    },
    {
      provider: "pingdom",
      account: ACCOUNTS.PINGDOM,
      monitor: "smtp relay",
      expect: { checkType: "smtp", url: "mail.example.com", port: 25 },
    },
  ];

  for (const scenario of CASES) {
    it(`${scenario.provider}: ${scenario.monitor}`, async () => {
      const { actor } = await importAccount(
        scenario.provider,
        scenario.account,
      );
      const monitor = await monitorNamed(actor, scenario.monitor);
      expect(monitor).toMatchObject(scenario.expect);
    });
  }

  it("gives Uptime.com's certificate check the warning threshold it stored", async () => {
    const { actor } = await importAccount("uptimecom", ACCOUNTS.UPTIMECOM);
    const monitor = await monitorNamed(actor, "Wildcard cert expiry");
    expect(monitor.config).toMatchObject({ warnDays: 30 });
    const domain = await monitorNamed(actor, "Domain registration");
    expect(domain.checkType).toBe("domain-expiry");
    expect(domain.config).toMatchObject({ warnDays: 45 });
  });

  it("gives Datadog's certificate check the days from its own assertion", async () => {
    const { actor } = await importAccount("datadog", ACCOUNTS.DATADOG);
    const monitor = await monitorNamed(actor, "Edge certificate");
    expect(monitor.checkType).toBe("tls-expiry");
    expect(monitor.config).toMatchObject({ warnDays: 21 });
  });
});

describe("a source that misbehaves does not cost the rest of the account", () => {
  const provider = requireProvider("uptimerobot");
  const credentials = { token: "acceptance-token" };

  async function read(routes: readonly Route[]): Promise<SourceSnapshot> {
    const { options } = fakeTransport(routes);
    return provider.read({ credentials, transport: options });
  }

  async function readError(routes: readonly Route[]): Promise<string> {
    try {
      await read(routes);
      return "(no error)";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it("says the token was rejected, and never quotes it", async () => {
    for (const status of [401, 403]) {
      const message = await readError([
        { path: "/v3/monitor-groups", body: { data: [] } },
        { path: "/v3/monitors", status, body: { error: "nope" } },
      ]);
      expect(message, `status ${status}`).toContain(String(status));
      expect(message).toContain("read permission");
      expect(message).not.toContain("acceptance-token");
    }
  });

  it("gives up on a rate limit that never clears, and says which account", async () => {
    const message = await readError([
      { path: "/v3/monitor-groups", body: { data: [] } },
      {
        path: "/v3/monitors",
        status: 429,
        headers: { "retry-after": "1" },
        body: "slow down",
      },
    ]);
    expect(message).toContain("rate limited");
  });

  it("names the endpoint that answered with something that is not JSON", async () => {
    const message = await readError([
      { path: "/v3/monitor-groups", body: { data: [] } },
      { path: "/v3/monitors", body: "<html>maintenance</html>" },
    ]);
    expect(message).toContain("not JSON");
    expect(message).toContain("/v3/monitors");
  });

  it("imports an empty account as an empty import rather than an error", async () => {
    const actor = await createTestOrg();
    const snapshot = await read([
      { path: "/v3/monitor-groups", body: { data: [] } },
      { path: "/v3/monitors", body: { data: [], nextLink: null } },
    ]);
    const report = await importSnapshot(db, actor, snapshot);
    expect(report.status).toBe("completed");
    expect(report.totals.monitorsCreated).toBe(0);
    // The account-level records still get their lines, so an operator
    // reading an empty import still learns what does not come across.
    expect(report.entries.length).toBeGreaterThan(0);
  });

  it("keeps reading when the group endpoint fails, because a folder is not the migration", async () => {
    const snapshot = await read([
      { path: "/v3/monitor-groups", status: 500, body: { error: "boom" } },
      {
        path: "/v3/monitors",
        body: {
          data: [
            {
              id: 1,
              friendlyName: "Still here",
              type: "PING",
              status: "UP",
              url: "gateway.example.com",
              interval: 60,
            },
          ],
          nextLink: null,
        },
      },
    ]);
    expect(snapshot.checks).toHaveLength(1);
    expect(snapshot.checks[0]?.groupPath).toBeUndefined();
    expect(snapshot.extras.some((e) => e.label === "Monitor groups")).toBe(
      true,
    );
  });

  it("survives a detail fetch that fails after the list succeeded", async () => {
    // Pingdom's list carries no configuration, so this is the failure
    // that matters most for it: four checks read, one that will not
    // hand itself over.
    const pingdom = requireProvider("pingdom");
    const { options } = fakeTransport(ACCOUNTS.PINGDOM);
    const snapshot = await pingdom.read({
      credentials: { token: "acceptance-token" },
      transport: options,
    });
    const broken = snapshot.checks.find((entry) => entry.name === "unreadable");
    expect(broken?.kind).toBe("unsupported");
    expect(snapshot.checks).toHaveLength(5);

    const actor = await createTestOrg();
    const report = await importSnapshot(db, actor, snapshot);
    // The other checks still arrived.
    expect(report.totals.monitorsCreated).toBeGreaterThan(0);
    const line = report.entries.find((entry) => entry.label === "unreadable");
    expect(line?.outcome).toBe("unsupported");
    expect(JSON.stringify(report)).not.toContain("acceptance-token");
  });

  it("stops at a page boundary rather than asking forever", async () => {
    // A last page exactly the size of the page itself, with a cursor
    // that repeats: the shape that turns a paginator into a loop.
    const rows = Array.from({ length: 200 }, (_, index) => ({
      id: 1000 + index,
      friendlyName: `Ping ${index}`,
      type: "PING",
      status: "UP",
      url: "gateway.example.com",
      interval: 60,
    }));
    const snapshot = await read([
      { path: "/v3/monitor-groups", body: { data: [] } },
      {
        path: "/v3/monitors",
        query: { cursor: "1199" },
        body: { data: [], nextLink: null },
      },
      {
        path: "/v3/monitors",
        body: {
          data: rows,
          nextLink: "https://api.uptimerobot.com/v3/monitors?cursor=1199",
        },
      },
    ]);
    expect(snapshot.checks).toHaveLength(200);
  });

  it("reports a request that never answers as a read that did not happen", async () => {
    const timeout = async (): Promise<never> => {
      throw new Error("The operation was aborted due to timeout");
    };
    const snapshot = provider.read({
      credentials,
      transport: { fetcher: timeout, sleep: async () => undefined },
    });
    await expect(snapshot).rejects.toThrow(/timeout/);
  });
});

describe("the two clicks agree, and a second import is safe", () => {
  it("previews exactly what it then imports", async () => {
    const actor = await createTestOrg();
    const provider = requireProvider("betterstack");
    const { options } = fakeTransport(ACCOUNTS.BETTERSTACK);
    const snapshot = await provider.read({
      credentials: { token: "acceptance-token" },
      transport: options,
    });

    const preview = await importSnapshot(db, actor, snapshot, { dryRun: true });
    const applied = await importSnapshot(db, actor, snapshot);

    expect(preview.status).toBe("preview");
    expect(applied.status).toBe("completed");
    expect(applied.totals.monitorsCreated).toBe(preview.totals.monitorsCreated);
    // Not just the headline: every line's outcome and every reason.
    const shape = (report: typeof preview) =>
      report.entries.map(
        (entry) =>
          `${entry.kind}|${entry.label}|${entry.outcome}|${entry.detail}`,
      );
    expect(shape(applied)).toEqual(shape(preview));
  });

  it("adds only what was missing when a first import was partial", async () => {
    // The first run sees an account whose second monitor Vigil refuses.
    // The operator fixes it at the source and runs again; the fixed one
    // must arrive and the first must not arrive twice.
    const actor = await createTestOrg();
    const provider = requireProvider("uptimerobot");
    const account = (url: string): Route[] => [
      { path: "/v3/monitor-groups", body: { data: [] } },
      {
        path: "/v3/monitors",
        body: {
          data: [
            {
              id: 1,
              friendlyName: "Good one",
              type: "HTTP",
              status: "UP",
              url: "https://www.example.com/",
              interval: 60,
            },
            {
              id: 2,
              friendlyName: "Fixed later",
              type: "HTTP",
              status: "UP",
              url,
              interval: 60,
            },
          ],
          nextLink: null,
        },
      },
    ];

    const read = async (url: string): Promise<SourceSnapshot> => {
      const { options } = fakeTransport(account(url));
      return provider.read({
        credentials: { token: "acceptance-token" },
        transport: options,
      });
    };

    const first = await importSnapshot(
      db,
      actor,
      await read("http://127.0.0.1/"),
    );
    expect(first.totals.monitorsCreated).toBe(1);
    expect(first.totals.skipped).toBe(1);

    const second = await importSnapshot(
      db,
      actor,
      await read("https://fixed.example.com/"),
    );
    expect(second.totals.monitorsCreated).toBe(1);

    const rows = await db
      .select()
      .from(monitors)
      .where(eq(monitors.organizationId, actor.organizationId));
    expect(rows.map((row) => row.name).sort()).toEqual([
      "Fixed later",
      "Good one",
    ]);
  });

  it("refuses a self-hosted URL that points into the metadata service, before any request", async () => {
    const provider = requireProvider("healthchecks");
    let called = 0;
    await expect(
      provider.read({
        credentials: {
          apiKey: "acceptance-token",
          baseUrl: "https://169.254.169.254/hc",
        },
        transport: {
          fetcher: async () => {
            called += 1;
            return { status: 200, headers: {}, body: "{}" };
          },
          sleep: async () => undefined,
        },
      }),
    ).rejects.toThrow(/cannot be reached/);
    expect(called).toBe(0);
  });
});
