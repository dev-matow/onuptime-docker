import { afterEach, describe, expect, it, vi } from "vitest";

import {
  betterStackTestFetcher,
  readIncidentsWindow,
  readOpenIncidents,
  utcDateString,
  verifyToken,
} from "@/modules/importers/bridge/evidence";

import { fakeTransport, type Route } from "../fixtures/migrations/fetcher";

/**
 * The evidence client against fixture bodies shaped like Better Stack's
 * own: JSON:API rows, `relationships` for the linkage, capitalized
 * status words, and the incidents API's own 50-per-page ceiling.
 */

const TOKEN = "evidence-secret-do-not-leak";

function incidentRow(
  id: string,
  overrides: Record<string, unknown> = {},
  relationships?: unknown,
): unknown {
  return {
    id,
    type: "incident",
    attributes: {
      name: "Demo",
      cause: "Status 503",
      status: "Started",
      started_at: "2026-08-20T10:00:00.000Z",
      acknowledged_at: null,
      resolved_at: null,
      ...overrides,
    },
    ...(relationships === undefined ? {} : { relationships }),
  };
}

describe("readIncidentsWindow", () => {
  it("paginates with date filters until pagination.next is null, parsing fields", async () => {
    const routes: Route[] = [
      {
        path: "/api/v3/incidents",
        query: { page: "2" },
        body: {
          data: [
            incidentRow(
              "22",
              {
                status: "Resolved",
                resolved_at: "2026-08-20T11:00:00.000Z",
                acknowledged_at: "2026-08-20T10:10:00.000Z",
              },
              { monitor: { data: { id: "9", type: "monitor" } } },
            ),
          ],
          pagination: { next: null },
        },
      },
      {
        path: "/api/v3/incidents",
        body: {
          data: [
            incidentRow(
              "21",
              {},
              {
                monitor: { data: { id: "9", type: "monitor" } },
              },
            ),
          ],
          pagination: {
            next: "https://uptime.betterstack.com/api/v3/incidents?page=2",
          },
        },
      },
    ];
    const { api, options } = fakeTransport(routes);
    const read = await readIncidentsWindow(
      TOKEN,
      new Date("2026-08-18T23:59:00.000Z"),
      new Date("2026-08-21T00:01:00.000Z"),
      { transport: options },
    );

    expect(read.incidents).toHaveLength(2);
    expect(read.requestCount).toBe(2);

    const first = api.requests[0]!;
    expect(first.query.from).toBe("2026-08-18");
    expect(first.query.to).toBe("2026-08-21");
    expect(first.query.per_page).toBe("50");

    const open = read.incidents.find((i) => i.id === "21")!;
    expect(open.status).toBe("Started");
    expect(open.resourceType).toBe("monitor");
    expect(open.resourceId).toBe("9");
    expect(open.startedAt.toISOString()).toBe("2026-08-20T10:00:00.000Z");
    expect(open.resolvedAt).toBeNull();

    const resolved = read.incidents.find((i) => i.id === "22")!;
    expect(resolved.resolvedAt?.toISOString()).toBe("2026-08-20T11:00:00.000Z");
    expect(resolved.acknowledgedAt?.toISOString()).toBe(
      "2026-08-20T10:10:00.000Z",
    );
  });

  it("reads heartbeat linkage, and no linkage at all, without inventing one", async () => {
    const routes: Route[] = [
      {
        path: "/api/v3/incidents",
        body: {
          data: [
            incidentRow(
              "31",
              {},
              {
                heartbeat: { data: { id: "4", type: "heartbeat" } },
              },
            ),
            incidentRow("32"),
          ],
          pagination: { next: null },
        },
      },
    ];
    const { options } = fakeTransport(routes);
    const read = await readOpenIncidents(TOKEN, { transport: options });

    const heartbeat = read.incidents.find((i) => i.id === "31")!;
    expect(heartbeat.resourceType).toBe("heartbeat");
    expect(heartbeat.resourceId).toBe("4");

    const orphan = read.incidents.find((i) => i.id === "32")!;
    expect(orphan.resourceType).toBeNull();
    expect(orphan.resourceId).toBeNull();
  });

  it("skips a row missing its id or start without losing the page", async () => {
    const routes: Route[] = [
      {
        path: "/api/v3/incidents",
        body: {
          data: [
            {
              type: "incident",
              attributes: { started_at: "2026-08-20T10:00:00.000Z" },
            },
            incidentRow("41", { started_at: "not a date" }),
            incidentRow("42"),
          ],
          pagination: { next: null },
        },
      },
    ];
    const { options } = fakeTransport(routes);
    const read = await readOpenIncidents(TOKEN, { transport: options });
    expect(read.incidents.map((i) => i.id)).toEqual(["42"]);
  });
});

describe("readOpenIncidents", () => {
  it("asks for unresolved incidents with no date bound", async () => {
    const { api, options } = fakeTransport([
      {
        path: "/api/v3/incidents",
        body: { data: [], pagination: { next: null } },
      },
    ]);
    await readOpenIncidents(TOKEN, { transport: options });
    const request = api.requests[0]!;
    expect(request.query.resolved).toBe("false");
    expect(request.query.from).toBeUndefined();
    expect(request.query.to).toBeUndefined();
  });
});

describe("verifyToken", () => {
  it("issues one authenticated single-monitor read", async () => {
    const { api, options } = fakeTransport([
      {
        path: "/api/v2/monitors",
        body: {
          data: [{ id: "1", attributes: {} }],
          pagination: { next: null },
        },
      },
    ]);
    const result = await verifyToken(TOKEN, { transport: options });
    expect(result.monitorCount).toBe(1);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]!.query.per_page).toBe("1");
  });
});

describe("the credential", () => {
  it("travels in the Authorization header and nowhere else", async () => {
    const { api, options } = fakeTransport([
      {
        path: "/api/v3/incidents",
        body: { data: [incidentRow("51")], pagination: { next: null } },
      },
    ]);
    const read = await readOpenIncidents(TOKEN, { transport: options });
    // The fixture records header NAMES only, by design; the assertion
    // that matters is that nothing the client RETURNS carries the token.
    expect(api.requests[0]!.headerNames).toContain("Authorization");
    expect(JSON.stringify(read)).not.toContain(TOKEN);
    expect(api.requests[0]!.url).not.toContain(TOKEN);
  });

  it("never appears in an error, even when the source rejects it", async () => {
    const { options } = fakeTransport([
      {
        path: "/api/v3/incidents",
        status: 401,
        body: { errors: "Unauthorized" },
      },
    ]);
    await expect(
      readOpenIncidents(TOKEN, { transport: options }),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(TOKEN),
      }) as Error,
    );
  });
});

describe("utcDateString", () => {
  it("formats the UTC calendar date, whatever the local zone says", () => {
    expect(utcDateString(new Date("2026-08-20T23:59:59.000Z"))).toBe(
      "2026-08-20",
    );
    expect(utcDateString(new Date("2026-08-21T00:00:01.000Z"))).toBe(
      "2026-08-21",
    );
  });
});

describe("betterStackTestFetcher", () => {
  const saved = process.env.VIGIL_BETTERSTACK_TEST_BASE;

  afterEach(() => {
    if (saved === undefined) delete process.env.VIGIL_BETTERSTACK_TEST_BASE;
    else process.env.VIGIL_BETTERSTACK_TEST_BASE = saved;
    vi.unstubAllGlobals();
  });

  it("is absent unless the environment names a stub", () => {
    delete process.env.VIGIL_BETTERSTACK_TEST_BASE;
    expect(betterStackTestFetcher()).toBeUndefined();
    process.env.VIGIL_BETTERSTACK_TEST_BASE = "   ";
    expect(betterStackTestFetcher()).toBeUndefined();
  });

  it("rewrites the Better Stack origin to the stub, path and query intact", async () => {
    process.env.VIGIL_BETTERSTACK_TEST_BASE = "http://127.0.0.1:43117/";
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        seen.push(String(input));
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const fetcher = betterStackTestFetcher();
    expect(fetcher).toBeDefined();
    const response = await fetcher!({
      url: "https://uptime.betterstack.com/api/v2/monitors?page=2&per_page=250",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual([
      "http://127.0.0.1:43117/v2/monitors?page=2&per_page=250",
    ]);
  });
});
