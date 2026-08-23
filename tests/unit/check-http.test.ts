// @covers-type: http
import http from "node:http";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  evaluateKeyword,
  performHttpCheck,
  type CheckTarget,
} from "@/modules/monitors/check";

import { publicLookup } from "../probe-lookup";

const baseTarget: CheckTarget = {
  url: "https://example.com/health",
  method: "GET",
  timeoutMs: 5000,
  degradedThresholdMs: 3000,
  expectedStatusCode: null,
};

// The egress guard resolves every target, including under
// allowPrivateTargets — that flag widens private space, it does not
// switch the guard off. `example.com` therefore gets a real lookup;
// either answer is fine, because a public address is allowed and a name
// that does not resolve is left to the transport (which is injected
// here). The guard's refusals are covered below with "localhost",
// which resolves via the hosts file without a network.

interface TestServer {
  port: number;
  hosts: (string | undefined)[];
  close: () => Promise<void>;
}

const servers: TestServer[] = [];
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function openServer(handler: http.RequestListener): Promise<TestServer> {
  const hosts: (string | undefined)[] = [];
  const server = http.createServer((request, response) => {
    hosts.push(request.headers.host);
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const entry: TestServer = {
    port: typeof address === "object" && address ? address.port : 0,
    hosts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  servers.push(entry);
  return entry;
}

describe("performHttpCheck", () => {
  it("reports a successful 200 response with a measured response time", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));

    const outcome = await performHttpCheck(baseTarget, {
      allowPrivateTargets: true,
      fetchImpl,
      lookup: publicLookup,
    });

    expect(outcome).toMatchObject({
      ok: true,
      degraded: false,
      statusCode: 200,
      error: null,
    });
    expect(typeof outcome.responseTimeMs).toBe("number");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Manual, not "follow": an automatically followed redirect is a
    // second request the guard never saw. The hop loop in
    // modules/monitors/egress.ts follows them, one validated hop at a
    // time — see the redirect-hop tests below.
    expect(fetchImpl).toHaveBeenCalledWith(
      baseTarget.url,
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
  });

  it("reports a 503 response as a failure with an explanatory error", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));

    const outcome = await performHttpCheck(baseTarget, {
      allowPrivateTargets: true,
      fetchImpl,
      lookup: publicLookup,
    });

    expect(outcome).toMatchObject({
      ok: false,
      degraded: false,
      statusCode: 503,
      error: "Unexpected status 503",
    });
    expect(typeof outcome.responseTimeMs).toBe("number");
  });

  it("maps a TimeoutError DOMException to a timeout failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });

    const outcome = await performHttpCheck(baseTarget, {
      allowPrivateTargets: true,
      fetchImpl,
      lookup: publicLookup,
    });

    expect(outcome).toMatchObject({
      ok: false,
      degraded: false,
      statusCode: null,
      error: "Timed out after 5000ms",
    });
    expect(outcome.error).toContain("Timed out");
    expect(typeof outcome.responseTimeMs).toBe("number");
  });

  it("surfaces the cause message when fetch throws a TypeError with an Error cause", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("getaddrinfo ENOTFOUND example.com"),
      });
    });

    const outcome = await performHttpCheck(baseTarget, {
      allowPrivateTargets: true,
      fetchImpl,
      lookup: publicLookup,
    });

    expect(outcome).toMatchObject({
      ok: false,
      degraded: false,
      statusCode: null,
      error: "getaddrinfo ENOTFOUND example.com",
    });
  });

  describe("keyword assertion", () => {
    it("passes when the body contains the required keyword", async () => {
      const fetchImpl = vi.fn(
        async () => new Response('{"status":"healthy"}', { status: 200 }),
      );
      const outcome = await performHttpCheck(
        { ...baseTarget, bodyKeyword: "healthy" },
        { allowPrivateTargets: true, fetchImpl },
      );
      expect(outcome).toMatchObject({ ok: true, error: null });
    });

    it("fails a 200 when the required keyword is missing", async () => {
      const fetchImpl = vi.fn(
        async () => new Response("Database connection error", { status: 200 }),
      );
      const outcome = await performHttpCheck(
        { ...baseTarget, bodyKeyword: "healthy" },
        { allowPrivateTargets: true, fetchImpl },
      );
      expect(outcome).toMatchObject({
        ok: false,
        degraded: false,
        statusCode: 200,
        error: 'Body does not contain "healthy"',
      });
    });

    it("fails when a forbidden keyword is present (absent mode)", async () => {
      const fetchImpl = vi.fn(
        async () => new Response("Fatal: stack trace…", { status: 200 }),
      );
      const outcome = await performHttpCheck(
        { ...baseTarget, bodyKeyword: "Fatal", keywordAbsent: true },
        { allowPrivateTargets: true, fetchImpl },
      );
      expect(outcome).toMatchObject({
        ok: false,
        error: 'Body unexpectedly contains "Fatal"',
      });
    });

    it("drains and discards the body when no keyword is configured", async () => {
      // The old assertion here was "getReader is never called", written
      // against a drain that buffered the WHOLE body with arrayBuffer()
      // — the name promised no read while the code read everything. The
      // contract now is the honest one: the body is streamed through a
      // reader chunk by chunk, discarded, and the reader is released —
      // nothing is retained whatever size the server sends.
      const cancel = vi.fn(async () => undefined);
      const read = vi.fn(async () => ({
        done: true as const,
        value: undefined,
      }));
      const body = { getReader: vi.fn(() => ({ read, cancel })) };
      const fetchImpl = vi.fn(async () => {
        const res = new Response("ok", { status: 200 });
        Object.defineProperty(res, "body", { value: body });
        return res;
      });
      const outcome = await performHttpCheck(baseTarget, {
        allowPrivateTargets: true,
        fetchImpl,
        lookup: publicLookup,
      });
      expect(read).toHaveBeenCalled();
      expect(cancel).toHaveBeenCalled();
      expect(outcome).toMatchObject({ ok: true, error: null });
    });

    it("skips the keyword on a HEAD request (no body to read)", async () => {
      const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
      const outcome = await performHttpCheck(
        { ...baseTarget, method: "HEAD", bodyKeyword: "healthy" },
        { allowPrivateTargets: true, fetchImpl },
      );
      expect(outcome).toMatchObject({ ok: true, error: null });
    });

    it("keeps a keyword failure as down, never degraded", async () => {
      const fetchImpl = vi.fn(
        async () => new Response("error", { status: 200 }),
      );
      const outcome = await performHttpCheck(
        { ...baseTarget, degradedThresholdMs: 0, bodyKeyword: "ok" },
        { allowPrivateTargets: true, fetchImpl },
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.degraded).toBe(false);
    });
  });

  describe("evaluateKeyword", () => {
    it("holds when present and required", () => {
      expect(evaluateKeyword("ok", false, "all ok here")).toBeNull();
    });
    it("fails when required but missing", () => {
      expect(evaluateKeyword("ok", false, "nope")).toMatch(/does not contain/);
    });
    it("holds when absent and forbidden", () => {
      expect(evaluateKeyword("error", true, "all good")).toBeNull();
    });
    it("fails when forbidden but present", () => {
      expect(evaluateKeyword("error", true, "an error")).toMatch(
        /unexpectedly contains/,
      );
    });
  });

  describe("private-address guard", () => {
    it("refuses a hostname that resolves to loopback and never issues a request", async () => {
      const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));

      const outcome = await performHttpCheck(
        { ...baseTarget, url: "http://localhost:1/" },
        { fetchImpl },
      );

      expect(outcome).toEqual({
        ok: false,
        degraded: false,
        statusCode: null,
        responseTimeMs: null,
        error: "Target resolves to a private address",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("proceeds with the request when allowPrivateTargets is true", async () => {
      const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));

      const outcome = await performHttpCheck(
        { ...baseTarget, url: "http://localhost:1/" },
        { allowPrivateTargets: true, fetchImpl },
      );

      expect(outcome).toMatchObject({
        ok: true,
        statusCode: 200,
        error: null,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe("redirect hops", () => {
    const redirect = (location: string) =>
      new Response(null, { status: 302, headers: { location } });

    it("refuses a redirect into loopback and never issues that request", async () => {
      // The hole `redirect: "follow"` left open: the guard passed on
      // `example.com`, and the transport then made a second request to
      // wherever the 302 pointed — with nobody looking at it.
      const fetchImpl = vi.fn(async () => redirect("http://localhost:1/admin"));

      const outcome = await performHttpCheck(baseTarget, { fetchImpl });

      expect(outcome).toEqual({
        ok: false,
        degraded: false,
        statusCode: null,
        responseTimeMs: null,
        error: "Target resolves to a private address",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("refuses a redirect to the cloud metadata address", async () => {
      const fetchImpl = vi.fn(async () =>
        redirect("http://169.254.169.254/latest/meta-data/iam/"),
      );

      const outcome = await performHttpCheck(baseTarget, {
        // Even with private space allowed. Metadata is the floor.
        allowPrivateTargets: true,
        fetchImpl,
        lookup: publicLookup,
      });

      expect(outcome.error).toBe("Target resolves to a cloud metadata address");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("follows a validated redirect and judges the status it ends on", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(redirect("https://example.com/moved"))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));

      const outcome = await performHttpCheck(baseTarget, {
        allowPrivateTargets: true,
        fetchImpl,
        lookup: publicLookup,
      });

      expect(outcome).toMatchObject({ ok: true, statusCode: 200 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://example.com/moved");
    });

    it("measures a real endpoint over the pinned transport", async () => {
      // Every other test here injects a transport, so none of them
      // would notice if the shipped one stopped working. This one
      // drives the whole path — guard, pinned connection, judgment —
      // over a real socket, which is what production does.
      const server = await openServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("all healthy here");
      });

      const outcome = await performHttpCheck(
        {
          ...baseTarget,
          url: `http://127.0.0.1:${server.port}/health`,
          bodyKeyword: "healthy",
        },
        { allowPrivateTargets: true },
      );

      expect(outcome).toMatchObject({ ok: true, statusCode: 200, error: null });
      expect(typeof outcome.responseTimeMs).toBe("number");
      expect(server.hosts).toEqual([`127.0.0.1:${server.port}`]);
    });

    it("asks the transport for manual redirects on every hop", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(redirect("https://example.com/moved"))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));

      await performHttpCheck(baseTarget, {
        allowPrivateTargets: true,
        fetchImpl,
        lookup: publicLookup,
      });

      for (const call of fetchImpl.mock.calls) {
        expect((call[1] as RequestInit).redirect).toBe("manual");
      }
    });
  });
});
