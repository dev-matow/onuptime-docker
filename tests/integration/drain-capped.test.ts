import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { drainBodyCapped } from "@/modules/monitors/egress";
import { httpProbe } from "@/modules/monitors/types/probes/http";
import {
  signedPostOnce,
  type WebhookEvent,
  buildWebhookPayload,
} from "@/modules/notifications/webhook";

/**
 * The capped-drain contract: a response body nobody reads is released,
 * not buffered.
 *
 * Before this existed, the no-keyword `http` probe, every redirect hop
 * and every webhook delivery ran `await response.arrayBuffer()` on a
 * body the code never looked at — justified in comments as keeping
 * keep-alive sockets reusable, on a transport that runs `agent: false`
 * and has no keep-alive. Against a server that streams without ending,
 * that read held the whole stream in worker memory until the abort
 * timeout fired and then reported the endpoint DOWN. The server here is
 * exactly that server, and the assertions are the two observables that
 * flipped: the probe now succeeds (the status line and headers were
 * measured; the body was never the subject), and the bytes the server
 * managed to push stay near the cap instead of near bandwidth × timeout.
 */

/** One endless chunk every few ms, but only when the socket drains —
 * so bytesSent measures what the CLIENT accepted, not what this server
 * queued in its own memory. */
function endlessBody(res: http.ServerResponse, counter: { sent: number }) {
  const chunk = Buffer.alloc(64 * 1024, 0x6f);
  const timer = setInterval(() => {
    if (res.destroyed) {
      clearInterval(timer);
      return;
    }
    if (!res.writableNeedDrain) {
      res.write(chunk);
      counter.sent += chunk.byteLength;
    }
  }, 2);
  res.on("close", () => clearInterval(timer));
}

let server: http.Server;
let origin: string;
const counters = new Map<string, { sent: number }>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const counter = { sent: 0 };
    counters.set(req.url ?? "/", counter);
    if (req.url === "/endless") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      endlessBody(res, counter);
      return;
    }
    if (req.url === "/redirect-endless") {
      res.writeHead(302, {
        location: "/ok",
        "content-type": "application/octet-stream",
      });
      endlessBody(res, counter);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function httpContext(target: string) {
  return {
    target,
    port: null,
    config: {
      method: "GET" as const,
      expectedStatusCode: null,
      degradedThresholdMs: 30_000,
      bodyKeyword: null,
      keywordAbsent: false,
      tlsCheck: false,
      tlsWarnDays: 14,
    },
    timeoutMs: 8_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
  };
}

// Cancelling at the cap stops the transfer, but loopback TCP windows
// and node stream buffers accept a few megabytes before the RST lands.
// The old behaviour at this server's pace was ~50 MB per timed-out
// check, so the bound discriminates by an order of magnitude.
const ACCEPTED_BYTES_BOUND = 16 * 1024 * 1024;

describe("capped body drain", () => {
  it("drainBodyCapped discards chunks and cancels at the cap", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    await drainBodyCapped(new Response(stream), 10 * 1024);
    expect(cancelled).toBe(true);
    // Ten 1 KiB chunks reach the cap; a stray extra pull is stream
    // plumbing, an order of magnitude more is a missing cap.
    expect(pulls).toBeLessThan(20);
  });

  it("reports an endless no-keyword body as the 200 it answered, promptly", async () => {
    const started = Date.now();
    const result = await httpProbe(httpContext(`${origin}/endless`));
    const elapsed = Date.now() - started;

    expect(result.statusCode).toBe(200);
    expect(result.error).toBeNull();
    // Well inside the 8s abort budget: the probe stopped at the cap
    // rather than waiting for a download that never ends.
    expect(elapsed).toBeLessThan(6_000);
    expect(counters.get("/endless")!.sent).toBeLessThan(ACCEPTED_BYTES_BOUND);
  });

  it("walks past a redirect hop whose body never ends", async () => {
    const started = Date.now();
    const result = await httpProbe(httpContext(`${origin}/redirect-endless`));
    const elapsed = Date.now() - started;

    expect(result.statusCode).toBe(200);
    expect(result.error).toBeNull();
    expect(elapsed).toBeLessThan(6_000);
    expect(counters.get("/redirect-endless")!.sent).toBeLessThan(
      ACCEPTED_BYTES_BOUND,
    );
  });

  it("delivers a webhook whose receiver streams a body forever", async () => {
    const started = Date.now();
    const outcome = await signedPostOnce(
      { url: `${origin}/endless`, secret: "drain-test-secret" },
      buildWebhookPayload({
        event: "incident.opened" as WebhookEvent,
        organizationId: "org-drain-test",
        data: {},
      }),
      { timeoutMs: 8_000, allowPrivate: true },
    );
    const elapsed = Date.now() - started;

    expect(outcome.status).toBe("delivered");
    expect(elapsed).toBeLessThan(6_000);
    expect(counters.get("/endless")!.sent).toBeLessThan(ACCEPTED_BYTES_BOUND);
  });
});
