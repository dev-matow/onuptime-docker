// @covers-type: real-browser
import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { redactConfig, SECRET_MASK } from "@/modules/monitors/types/config";
import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import {
  interpretServiceStatus,
  realBrowserProbe,
  renderRequest,
} from "@/modules/monitors/types/probes/real-browser";
import {
  realBrowserSpec,
  realBrowserStoredSchema,
  type RealBrowserConfig,
} from "@/modules/monitors/types/specs/real-browser";

import { privateLookup, publicLookup } from "../probe-lookup";

/**
 * The browser check, against a real rendering service.
 *
 * The fixture below is an HTTP server that implements the endpoint a
 * browserless-compatible renderer implements: it reads the JSON body,
 * checks the Authorization header and answers with a document or with
 * the status a real renderer would use. The probe reaches it over a real
 * socket, through the egress guard, with nothing stubbed.
 *
 * What these tests exist to pin is one rule: a failure of the *renderer*
 * is never an outage of the *page*. Every way the service can let Vigil
 * down — absent, unreachable, unauthorised, out of slots, broken —
 * reports `misconfigured`. Only the browser's verdict on the page
 * becomes up or down.
 */

interface RendererRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface FakeRenderer {
  url: string;
  requests: RendererRequest[];
  close: () => Promise<void>;
}

interface Reply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

const running: FakeRenderer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((renderer) => renderer.close()));
});

async function startRenderer(
  reply: (request: RendererRequest) => Reply,
): Promise<FakeRenderer> {
  const requests: RendererRequest[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const received: RendererRequest = {
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        body,
      };
      requests.push(received);
      const answer = reply(received);
      response.writeHead(answer.status, {
        "content-type": "text/html",
        ...answer.headers,
      });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const renderer: FakeRenderer = {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  running.push(renderer);
  return renderer;
}

/** A renderer that always renders the same page. */
function servingDocument(html: string): Promise<FakeRenderer> {
  return startRenderer(() => ({ status: 200, body: html }));
}

function context(
  config: Partial<RealBrowserConfig> = {},
): ProbeContext<RealBrowserConfig> {
  return {
    target: "https://app.example.com/dashboard",
    port: null,
    config: {
      serviceUrl: null,
      token: null,
      settleMs: 0,
      bodyKeyword: null,
      keywordAbsent: false,
      degradedThresholdMs: 3_000,
      ...config,
    },
    timeoutMs: 5_000,
    // The renderer lives on loopback in these tests, exactly as it does
    // in a Compose file; the guard is what makes that a policy decision.
    allowPrivateTargets: true,
    fetchImpl: fetch,
    lookup: publicLookup,
  };
}

function judged(
  result: Awaited<ReturnType<typeof realBrowserProbe>>,
  config: RealBrowserConfig,
) {
  return judge(realBrowserSpec.assertions, config, result);
}

describe("realBrowserProbe", () => {
  it("reports the document the browser rendered", async () => {
    const renderer = await servingDocument(
      "<html><body><h1>Dashboard</h1></body></html>",
    );
    const ctx = context({ serviceUrl: renderer.url });

    const result = await realBrowserProbe(ctx);

    expect(result.error).toBeNull();
    expect(result.unavailable).toBeUndefined();
    expect(result.facts).toMatchObject({ rendered: true, contentBytes: 44 });
    expect(judged(result, ctx.config).verdict).toBe("up");
  });

  it("asks the renderer to wait for the network before reading the DOM", async () => {
    // `load` fires on the empty shell of a single-page app. Reading the
    // DOM there would assert against exactly the thing this type exists
    // to see past.
    const renderer = await servingDocument("<html>ok</html>");
    const ctx = context({ serviceUrl: renderer.url });

    await realBrowserProbe(ctx);

    const request = renderer.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/content");
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      url: "https://app.example.com/dashboard",
      gotoOptions: { waitUntil: "networkidle2", timeout: 5_000 },
    });
  });

  it("sends its token in a header, never in the query string", async () => {
    // A query string reaches the renderer's access log, every proxy in
    // between, and any error message that quotes the URL.
    const renderer = await servingDocument("<html>ok</html>");
    const ctx = context({ serviceUrl: renderer.url, token: "s3cret-token" });

    await realBrowserProbe(ctx);

    expect(renderer.requests[0]?.headers.authorization).toBe(
      "Bearer s3cret-token",
    );
    expect(renderer.requests[0]?.path).not.toContain("s3cret-token");
  });

  it("asserts the keyword against the rendered DOM, not the source", async () => {
    // The keyword is in content the server never sent — which is the
    // whole difference between this type and `http`.
    const renderer = await servingDocument(
      "<html><body><div id=root><span>Signed in</span></div></body></html>",
    );
    const ctx = context({ serviceUrl: renderer.url, bodyKeyword: "Signed in" });

    const result = await realBrowserProbe(ctx);

    expect(result.facts.keywordPresent).toBe(true);
    expect(judged(result, ctx.config).verdict).toBe("up");
  });

  it("is down when the rendered page lost the keyword", async () => {
    const renderer = await servingDocument("<html><body>Error</body></html>");
    const ctx = context({ serviceUrl: renderer.url, bodyKeyword: "Signed in" });

    const result = await realBrowserProbe(ctx);

    expect(judged(result, ctx.config)).toMatchObject({
      verdict: "down",
      failureClass: "assertion",
      error: 'The rendered page does not contain "Signed in"',
    });
  });

  it("is down when a keyword that must be absent appears", async () => {
    const renderer = await servingDocument("<html>Something went wrong</html>");
    const ctx = context({
      serviceUrl: renderer.url,
      bodyKeyword: "went wrong",
      keywordAbsent: true,
    });

    const result = await realBrowserProbe(ctx);

    expect(judged(result, ctx.config).error).toBe(
      'The rendered page contains "went wrong"',
    );
  });

  it("skips the keyword assertion when the monitor has no keyword", async () => {
    const renderer = await servingDocument("<html>anything</html>");
    const ctx = context({ serviceUrl: renderer.url });

    const result = await realBrowserProbe(ctx);

    expect(result.facts.keywordPresent).toBeUndefined();
    expect(judged(result, ctx.config).failedAssertions).toEqual([]);
  });

  it("is down when the browser rendered a blank page", async () => {
    // A white screen: navigation succeeded, and the user sees nothing.
    // `http` reports this as a healthy 200.
    const renderer = await servingDocument("   \n  ");
    const ctx = context({ serviceUrl: renderer.url });

    const result = await realBrowserProbe(ctx);

    expect(judged(result, ctx.config)).toMatchObject({
      verdict: "down",
      error: "The browser loaded the page and it rendered nothing",
    });
  });

  it("reports a page that would not load as down, in the browser's words", async () => {
    const renderer = await startRenderer(() => ({
      status: 400,
      body: "net::ERR_NAME_NOT_RESOLVED at https://app.example.com/dashboard",
    }));
    const ctx = context({ serviceUrl: renderer.url });

    const result = await realBrowserProbe(ctx);

    expect(judged(result, ctx.config)).toMatchObject({
      verdict: "down",
      failureClass: "transport",
      error: "net::ERR_NAME_NOT_RESOLVED at https://app.example.com/dashboard",
    });
  });

  it("is degraded when the render took longer than the threshold", async () => {
    const renderer = await startRenderer(() => ({
      status: 200,
      body: "<html>slow</html>",
    }));
    const ctx = context({ serviceUrl: renderer.url, degradedThresholdMs: 100 });

    const result = await realBrowserProbe(ctx);
    // The measurement is real, so the threshold is forced rather than
    // the clock: what is being pinned is that the assertion reads it.
    const verdict = judge(realBrowserSpec.assertions, ctx.config, {
      ...result,
      facts: { ...result.facts, responseTimeMs: 900 },
    });

    expect(verdict).toMatchObject({
      verdict: "degraded",
      error: "Rendered in 900ms, over the 100ms threshold",
    });
  });

  it("refuses a target that resolves into private space", async () => {
    const renderer = await servingDocument("<html>ok</html>");
    const result = await realBrowserProbe({
      ...context({ serviceUrl: renderer.url }),
      target: "https://localhost/admin",
      allowPrivateTargets: false,
      // This case wants the refusal, so it supplies the answer that
      // earns one. The shared context resolves public on purpose, so
      // that every other test exercises the path it means to.
      lookup: privateLookup,
    });

    // The browser is the one that would dial it, so this is the only
    // point at which Vigil can refuse.
    expect(result.error).toBe("Target resolves to a private address");
    expect(renderer.requests).toHaveLength(0);
  });
});

describe("realBrowserProbe: the renderer failing is never the page failing", () => {
  it("reports no configured service as misconfigured, and says how to fix it", async () => {
    const ctx = context();

    const result = await realBrowserProbe(ctx, null);

    expect(result.error).toBeNull();
    expect(result.unavailable).toMatch(/BROWSER_SERVICE_URL/);
    expect(judged(result, ctx.config)).toMatchObject({
      verdict: "indeterminate",
      failureClass: "misconfigured",
    });
  });

  it("uses the service the environment names when the monitor names none", async () => {
    const renderer = await servingDocument("<html>ok</html>");
    const ctx = context();

    const result = await realBrowserProbe(ctx, renderer.url);

    expect(judged(result, ctx.config).verdict).toBe("up");
  });

  it("prefers the monitor's own service over the environment's", async () => {
    const mine = await servingDocument("<html>mine</html>");
    const shared = await servingDocument("<html>shared</html>");
    const ctx = context({ serviceUrl: mine.url });

    await realBrowserProbe(ctx, shared.url);

    expect(mine.requests).toHaveLength(1);
    expect(shared.requests).toHaveLength(0);
  });

  it("reports a rejected token as misconfigured", async () => {
    const renderer = await startRenderer(() => ({
      status: 401,
      body: "Unauthorized",
    }));
    const ctx = context({ serviceUrl: renderer.url, token: "wrong" });

    const result = await realBrowserProbe(ctx);

    expect(result.unavailable).toMatch(/rejected Vigil's credentials/);
    expect(judged(result, ctx.config).verdict).toBe("indeterminate");
  });

  it("reports a renderer out of concurrency slots as misconfigured", async () => {
    // The most likely failure in production, and the one that would be
    // most damaging as a false outage: it fires when the *monitoring*
    // is busy, i.e. on every page at once.
    const renderer = await startRenderer(() => ({
      status: 429,
      body: "Too many requests",
    }));
    const ctx = context({ serviceUrl: renderer.url });

    const result = await realBrowserProbe(ctx);

    expect(result.unavailable).toMatch(/out of concurrency slots/);
    expect(judged(result, ctx.config).verdict).toBe("indeterminate");
  });

  it("reports a service that has no /content endpoint as misconfigured", async () => {
    const renderer = await startRenderer(() => ({
      status: 404,
      body: "Not found",
    }));
    const ctx = context({ serviceUrl: renderer.url });

    const result = await realBrowserProbe(ctx);

    expect(result.unavailable).toMatch(/no \/content endpoint/);
  });

  it("reports a broken renderer as misconfigured", async () => {
    const renderer = await startRenderer(() => ({
      status: 503,
      body: "browser crashed",
    }));
    const ctx = context({ serviceUrl: renderer.url });

    const result = await realBrowserProbe(ctx);

    expect(result.unavailable).toMatch(/answered 503: browser crashed/);
    expect(judged(result, ctx.config).verdict).toBe("indeterminate");
  });

  it("never follows a redirect out of the renderer", async () => {
    // Following it would replay the POST — token included — at a host
    // nobody configured.
    const renderer = await startRenderer(() => ({
      status: 302,
      body: "",
      headers: { location: "http://elsewhere.example.com/content" },
    }));
    const ctx = context({ serviceUrl: renderer.url, token: "s3cret" });

    const result = await realBrowserProbe(ctx);

    expect(renderer.requests).toHaveLength(1);
    expect(result.unavailable).toMatch(/answered 302/);
  });

  it("reports an unreachable renderer as misconfigured", async () => {
    const renderer = await servingDocument("<html>ok</html>");
    const url = renderer.url;
    await renderer.close();
    running.splice(running.indexOf(renderer), 1);
    const ctx = context({ serviceUrl: url });

    const result = await realBrowserProbe(ctx);

    expect(result.unavailable).toMatch(/could not be reached/);
    expect(judged(result, ctx.config).verdict).toBe("indeterminate");
  });

  it("explains the policy when the renderer sits in refused address space", async () => {
    const renderer = await servingDocument("<html>ok</html>");
    const ctx = {
      ...context({ serviceUrl: renderer.url }),
      allowPrivateTargets: false,
    };

    const result = await realBrowserProbe(ctx);

    expect(result.unavailable).toMatch(/ALLOW_PRIVATE_MONITOR_TARGETS/);
    expect(judged(result, ctx.config).verdict).toBe("indeterminate");
  });
});

describe("interpretServiceStatus", () => {
  it("keeps the browser's first line, and only its first line", () => {
    const result = interpretServiceStatus(
      400,
      "TimeoutError: Navigation timeout of 5000 ms exceeded\n    at async Frame.goto",
      120,
      "http://browserless:3000",
    );
    expect(result.error).toBe(
      "TimeoutError: Navigation timeout of 5000 ms exceeded",
    );
  });

  it("treats a navigation timeout from the browser as the page being down", () => {
    // The renderer answered; the page did not load. That is the outage.
    expect(interpretServiceStatus(408, "timed out", 10, "svc").error).toBe(
      "timed out",
    );
    expect(
      interpretServiceStatus(408, "timed out", 10, "svc").unavailable,
    ).toBe(undefined);
  });

  it("names the service in every message an operator has to act on", () => {
    for (const status of [401, 429, 500]) {
      expect(
        interpretServiceStatus(status, "x", 10, "http://browserless:3000")
          .unavailable,
      ).toContain("http://browserless:3000");
    }
  });
});

describe("renderRequest", () => {
  it("asks the page to settle only when the monitor said to", () => {
    const base = context({ settleMs: 0 });
    expect(renderRequest(base).waitForTimeout).toBeUndefined();
    expect(renderRequest(context({ settleMs: 750 })).waitForTimeout).toBe(750);
  });
});

describe("real-browser spec", () => {
  it("declares its token as a secret, so it never reaches a browser", () => {
    expect(realBrowserSpec.secretFields).toContain("token");
    const redacted = redactConfig(realBrowserSpec, {
      serviceUrl: "http://browserless:3000",
      token: "s3cret-token",
      settleMs: 0,
    }) as Record<string, unknown>;
    expect(redacted.token).toBe(SECRET_MASK);
    expect(redacted.serviceUrl).toBe("http://browserless:3000");
  });

  it("describes the page and nothing else", () => {
    // The renderer's URL can carry a credential, and this string is
    // printed in incident emails and on public status pages.
    const config = realBrowserSpec.fromRow({
      checkType: "real-browser",
      url: "https://app.example.com/dashboard",
      port: null,
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 10_000,
      degradedThresholdMs: 3_000,
      expectedStatusCode: null,
      bodyKeyword: "Signed in",
      keywordAbsent: false,
      tlsCheck: false,
      tlsWarnDays: 14,
      config: {
        serviceUrl: "http://user:pw@browserless:3000",
        token: "s3cret",
      },
    });
    const described = realBrowserSpec.describeTarget(
      "https://app.example.com/dashboard",
      null,
      config,
    );
    expect(described).toBe("https://app.example.com/dashboard");
    expect(described).not.toContain("s3cret");
    // The keyword comes from the shared column, which is what lets the
    // monitor form edit it without a type-specific field.
    expect(config).toMatchObject({
      bodyKeyword: "Signed in",
      keywordAbsent: false,
    });
  });

  it("refuses a service URL that is not an http endpoint", () => {
    expect(
      realBrowserStoredSchema.safeParse({ serviceUrl: "browserless:3000" })
        .success,
    ).toBe(false);
    expect(
      realBrowserStoredSchema.safeParse({ serviceUrl: "ws://browserless:3000" })
        .success,
    ).toBe(false);
    // A service name with no dot in it is the common case in Compose.
    expect(
      realBrowserStoredSchema.safeParse({
        serviceUrl: "http://browserless:3000",
      }).success,
    ).toBe(true);
  });

  it("keeps a token exactly as it was typed", () => {
    // Trimming a credential turns a working token into a 401 with no
    // visible cause.
    expect(realBrowserStoredSchema.parse({ token: " padded " }).token).toBe(
      " padded ",
    );
  });
});
