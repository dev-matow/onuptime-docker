import net from "node:net";

import { afterAll, describe, expect, it, vi } from "vitest";

import { performCheck, performTcpCheck } from "@/modules/monitors/check";

/** An open TCP server on loopback; returns its port. */
function openServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.end());
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

let server: { port: number; close: () => void } | null = null;
afterAll(() => server?.close());

describe("performTcpCheck", () => {
  it("succeeds against an open port and measures connect time", async () => {
    server = await openServer();
    const outcome = await performTcpCheck(
      {
        host: "127.0.0.1",
        port: server.port,
        timeoutMs: 2000,
        degradedThresholdMs: 3000,
      },
      { allowPrivateTargets: true },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.statusCode).toBeNull();
    expect(typeof outcome.responseTimeMs).toBe("number");
  });

  it("fails against a closed port", async () => {
    // A port nothing is listening on (server closed).
    const closed = await openServer();
    closed.close();
    const outcome = await performTcpCheck(
      {
        host: "127.0.0.1",
        port: closed.port,
        timeoutMs: 2000,
        degradedThresholdMs: 3000,
      },
      { allowPrivateTargets: true },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
  });

  it("refuses a private address without allowPrivateTargets", async () => {
    const outcome = await performTcpCheck(
      {
        host: "localhost",
        port: 1,
        timeoutMs: 1000,
        degradedThresholdMs: 3000,
      },
      {},
    );
    expect(outcome).toMatchObject({
      ok: false,
      error: "Target resolves to a private address",
    });
  });
});

describe("performCheck dispatch", () => {
  it("routes tcp checks to a TCP connect", async () => {
    server = server ?? (await openServer());
    const fetchImpl = vi.fn();
    const outcome = await performCheck(
      {
        checkType: "tcp",
        url: "127.0.0.1",
        port: server.port,
        method: "GET",
        timeoutMs: 2000,
        degradedThresholdMs: 3000,
        expectedStatusCode: null,
      },
      { allowPrivateTargets: true, fetchImpl },
    );
    expect(outcome.ok).toBe(true);
    // A tcp check never issues an HTTP request.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("routes http checks to an HTTP request", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const outcome = await performCheck(
      {
        checkType: "http",
        url: "https://example.com/health",
        port: null,
        method: "GET",
        timeoutMs: 2000,
        degradedThresholdMs: 3000,
        expectedStatusCode: null,
      },
      { allowPrivateTargets: true, fetchImpl },
    );
    expect(outcome.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
