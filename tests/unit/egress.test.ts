import http from "node:http";
import { promisify } from "node:util";
import zlib from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EgressBlockedError,
  egressFetch,
  egressPolicyFor,
  type EgressException,
  type EgressLookup,
  type EgressPolicy,
} from "@/modules/monitors/egress";

/**
 * The unified outbound policy.
 *
 * Two properties are being proved here, and they are the two the 1.12
 * tree had neither of: every redirect hop is classified before it is
 * issued, and the address that was classified is the address the socket
 * goes to. The first is provable with a scripted transport; the second
 * needs a real one, so the rebinding block below starts a server.
 */

const DENY_PRIVATE: EgressPolicy = { channel: "monitor", allowPrivate: false };
const ALLOW_PRIVATE: EgressPolicy = { channel: "monitor", allowPrivate: true };
const RECOVERY: EgressPolicy = { channel: "recovery", allowPrivate: true };

function resolved(address: string) {
  return { address, family: address.includes(":") ? 6 : 4 };
}

/** A resolver with a fixed answer for every hostname, and a call count. */
function lookupOf(...addresses: string[]) {
  return vi.fn<EgressLookup>(async () => addresses.map(resolved));
}

/** A resolver that answers per hostname and NXDOMAINs the rest. */
function lookupTable(table: Record<string, string[]>) {
  return vi.fn<EgressLookup>(async (hostname) => {
    const answer = table[hostname];
    if (!answer) throw new Error(`ENOTFOUND ${hostname}`);
    return answer.map(resolved);
  });
}

interface Step {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

/** A transport that replays a script and records what it was asked. */
function scriptedFetch(...script: Step[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const step = script[calls.length] ?? { status: 200 };
      calls.push({ url: String(input), init: init ?? {} });
      const status = step.status ?? 200;
      // 204/205/304 may not carry one, and `Response` throws rather than
      // ignoring the body.
      const nullBody = status === 204 || status === 205 || status === 304;
      return new Response(nullBody ? null : (step.body ?? ""), {
        status,
        headers: step.headers,
      });
    },
  ) as unknown as typeof fetch;
  return { impl, calls };
}

function redirectTo(location: string, status = 302): Step {
  return { status, headers: { location } };
}

describe("egressFetch policy", () => {
  describe("private addresses", () => {
    it("refuses a hostname that resolves into RFC1918 space", async () => {
      const { impl, calls } = scriptedFetch();
      await expect(
        egressFetch(
          "https://health.example.com/",
          {},
          {
            policy: DENY_PRIVATE,
            lookup: lookupOf("10.0.0.5"),
            fetchImpl: impl,
          },
        ),
      ).rejects.toThrow("Target resolves to a private address");
      expect(calls).toHaveLength(0);
    });

    it("refuses a host whose second answer is private, not only its first", async () => {
      // The connector picks between A records by availability, not by
      // policy, so a mixed answer is an invitation to pick the bad one.
      const { impl, calls } = scriptedFetch();
      await expect(
        egressFetch(
          "https://health.example.com/",
          {},
          {
            policy: DENY_PRIVATE,
            lookup: lookupOf("93.184.216.34", "10.0.0.5"),
            fetchImpl: impl,
          },
        ),
      ).rejects.toBeInstanceOf(EgressBlockedError);
      expect(calls).toHaveLength(0);
    });

    it("refuses CGNAT and unique-local space as private", async () => {
      for (const address of ["100.64.0.1", "fd12::1"]) {
        await expect(
          egressFetch(
            "https://health.example.com/",
            {},
            { policy: DENY_PRIVATE, lookup: lookupOf(address) },
          ),
        ).rejects.toBeInstanceOf(EgressBlockedError);
      }
    });

    it("reaches a private address when the channel's policy allows it", async () => {
      // Recovery endpoints live inside the operator's network. This is
      // the shipped behaviour and the policy preserves it.
      const { impl, calls } = scriptedFetch({ status: 204 });
      const { response } = await egressFetch(
        "https://runbook.internal/hooks/restart",
        { method: "POST" },
        { policy: RECOVERY, lookup: lookupOf("10.0.0.5"), fetchImpl: impl },
      );
      expect(response.status).toBe(204);
      expect(calls).toHaveLength(1);
    });
  });

  describe("loopback", () => {
    it("refuses a hostname that resolves to IPv4 loopback", async () => {
      await expect(
        egressFetch(
          "http://health.example.com/",
          {},
          { policy: DENY_PRIVATE, lookup: lookupOf("127.0.0.1") },
        ),
      ).rejects.toThrow("Target resolves to a private address");
    });

    it("refuses the IPv6 loopback, however it is spelled", async () => {
      for (const address of ["::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
        await expect(
          egressFetch(
            "http://health.example.com/",
            {},
            { policy: DENY_PRIVATE, lookup: lookupOf(address) },
          ),
        ).rejects.toBeInstanceOf(EgressBlockedError);
      }
    });

    it("refuses a loopback literal in the URL without resolving anything", async () => {
      const lookup = lookupOf("93.184.216.34");
      await expect(
        egressFetch(
          "http://127.0.0.1:9000/admin",
          {},
          { policy: DENY_PRIVATE, lookup },
        ),
      ).rejects.toBeInstanceOf(EgressBlockedError);
      expect(lookup).not.toHaveBeenCalled();
    });

    it("reaches loopback when the policy allows private space", async () => {
      const { impl } = scriptedFetch({ status: 200 });
      const { response } = await egressFetch(
        "http://127.0.0.1:9000/hooks/restart",
        {},
        { policy: RECOVERY, fetchImpl: impl },
      );
      expect(response.status).toBe(200);
    });
  });

  describe("link-local", () => {
    it("refuses a link-local address", async () => {
      await expect(
        egressFetch(
          "http://health.example.com/",
          {},
          { policy: DENY_PRIVATE, lookup: lookupOf("169.254.10.1") },
        ),
      ).rejects.toThrow("Target resolves to a link-local address");
    });

    it("refuses a link-local address even when private space is allowed", async () => {
      // The floor the policy cannot lower. Allowing an operator to
      // monitor their own LAN is not consent to reach the link-local
      // range that sits inside it.
      const { impl, calls } = scriptedFetch();
      await expect(
        egressFetch(
          "http://health.example.com/",
          {},
          {
            policy: ALLOW_PRIVATE,
            lookup: lookupOf("169.254.10.1"),
            fetchImpl: impl,
          },
        ),
      ).rejects.toThrow("Target resolves to a link-local address");
      expect(calls).toHaveLength(0);
    });

    it("refuses IPv6 link-local across the whole fe80::/10 range", async () => {
      for (const address of ["fe80::1", "fe90::1", "febf::1"]) {
        await expect(
          egressFetch(
            "http://health.example.com/",
            {},
            { policy: RECOVERY, lookup: lookupOf(address) },
          ),
        ).rejects.toThrow("Target resolves to a link-local address");
      }
    });
  });

  describe("cloud metadata", () => {
    it("refuses the metadata address under every channel and policy", async () => {
      for (const policy of [DENY_PRIVATE, ALLOW_PRIVATE, RECOVERY]) {
        await expect(
          egressFetch(
            "http://169.254.169.254/latest/meta-data/iam/",
            {},
            { policy },
          ),
        ).rejects.toThrow("Target resolves to a cloud metadata address");
      }
    });

    it("refuses the IPv4-mapped IPv6 spelling of the metadata address", async () => {
      // The encoding that walked past a literal string comparison.
      for (const host of ["[::ffff:169.254.169.254]", "[::ffff:a9fe:a9fe]"]) {
        await expect(
          egressFetch(
            `http://${host}/latest/meta-data/`,
            {},
            { policy: RECOVERY },
          ),
        ).rejects.toThrow("Target resolves to a cloud metadata address");
      }
    });

    it("refuses the AWS IPv6 metadata address inside otherwise-allowed ULA space", async () => {
      await expect(
        egressFetch("http://[fd00:ec2::254]/latest/", {}, { policy: RECOVERY }),
      ).rejects.toThrow("Target resolves to a cloud metadata address");
      // Its neighbour in the same prefix is ordinary private space.
      const { impl } = scriptedFetch({ status: 200 });
      const { response } = await egressFetch(
        "http://[fd00:ec2::255]/health",
        {},
        { policy: RECOVERY, fetchImpl: impl },
      );
      expect(response.status).toBe(200);
    });

    it("refuses metadata.google.internal by name, without resolving it", async () => {
      const lookup = lookupOf("93.184.216.34");
      await expect(
        egressFetch(
          "http://metadata.google.internal/computeMetadata/v1/",
          {},
          { policy: RECOVERY, lookup },
        ),
      ).rejects.toThrow("Target is a cloud metadata endpoint");
      expect(lookup).not.toHaveBeenCalled();
    });

    it("refuses a hostname that resolves to the metadata address", async () => {
      // The attack the hostname denylist cannot see: an ordinary name
      // with an A record pointed at 169.254.169.254.
      await expect(
        egressFetch(
          "https://totally-normal.example.com/",
          {},
          { policy: RECOVERY, lookup: lookupOf("169.254.169.254") },
        ),
      ).rejects.toThrow("Target resolves to a cloud metadata address");
    });
  });

  describe("schemes", () => {
    it("refuses anything that is not http or https", async () => {
      await expect(
        egressFetch("file:///etc/passwd", {}, { policy: RECOVERY }),
      ).rejects.toThrow("Only http and https targets can be reached");
    });
  });
});

describe("egressFetch redirects", () => {
  const table = lookupTable({
    "start.example.com": ["93.184.216.34"],
    "second.example.com": ["93.184.216.35"],
    "third.example.com": ["93.184.216.36"],
    "internal.example.com": ["10.0.0.5"],
    "loop.example.com": ["127.0.0.1"],
    "imds.example.com": ["169.254.169.254"],
  });

  it("never asks the transport to follow a redirect itself", async () => {
    // `redirect: "follow"` handed the whole chain to the transport, and
    // every hop after the first was a request no guard ever saw.
    const { impl, calls } = scriptedFetch(
      redirectTo("https://second.example.com/next"),
      { status: 200 },
    );
    await egressFetch(
      "https://start.example.com/",
      {},
      { policy: DENY_PRIVATE, lookup: table, fetchImpl: impl },
    );
    expect(calls.map((call) => call.init.redirect)).toEqual([
      "manual",
      "manual",
    ]);
  });

  it("follows a redirect to a public host and reports where it ended", async () => {
    const { impl, calls } = scriptedFetch(
      redirectTo("https://second.example.com/next"),
      { status: 200, body: "ok" },
    );
    const result = await egressFetch(
      "https://start.example.com/",
      {},
      { policy: DENY_PRIVATE, lookup: table, fetchImpl: impl },
    );
    expect(calls.map((call) => call.url)).toEqual([
      "https://start.example.com/",
      "https://second.example.com/next",
    ]);
    expect(result.redirects).toBe(1);
    expect(result.finalUrl).toBe("https://second.example.com/next");
    expect(await result.response.text()).toBe("ok");
  });

  it("refuses a redirect into private space and never issues that request", async () => {
    const { impl, calls } = scriptedFetch(
      redirectTo("http://internal.example.com/admin"),
    );
    await expect(
      egressFetch(
        "https://start.example.com/",
        {},
        { policy: DENY_PRIVATE, lookup: table, fetchImpl: impl },
      ),
    ).rejects.toThrow("Target resolves to a private address");
    expect(calls).toHaveLength(1);
  });

  it("refuses a redirect to a link-local address", async () => {
    const { impl } = scriptedFetch(
      redirectTo("http://169.254.169.254/latest/meta-data/"),
    );
    await expect(
      egressFetch(
        "https://start.example.com/",
        {},
        { policy: RECOVERY, lookup: table, fetchImpl: impl },
      ),
    ).rejects.toThrow("Target resolves to a cloud metadata address");
  });

  it("validates every hop of a chain, not only the first", async () => {
    // The third hop is the one that lands on loopback. A guard that
    // only checked the entry point would have followed it.
    const { impl, calls } = scriptedFetch(
      redirectTo("https://second.example.com/a"),
      redirectTo("https://third.example.com/b"),
      redirectTo("http://loop.example.com/c"),
    );
    await expect(
      egressFetch(
        "https://start.example.com/",
        {},
        { policy: DENY_PRIVATE, lookup: table, fetchImpl: impl },
      ),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(calls).toHaveLength(3);
  });

  it("resolves a relative Location against the hop that sent it", async () => {
    const { impl, calls } = scriptedFetch(redirectTo("/moved"), {
      status: 200,
    });
    await egressFetch(
      "https://start.example.com/health",
      {},
      { policy: DENY_PRIVATE, lookup: table, fetchImpl: impl },
    );
    expect(calls[1]?.url).toBe("https://start.example.com/moved");
  });

  it("returns the 3xx unfollowed when the caller allows no redirects", async () => {
    // Webhook delivery: following would downgrade the POST to a GET and
    // deliver an empty, unsigned request somewhere else.
    const { impl, calls } = scriptedFetch(
      redirectTo("https://second.example.com/next", 301),
    );
    const { response, redirects } = await egressFetch(
      "https://start.example.com/",
      { method: "POST", body: "{}" },
      {
        policy: DENY_PRIVATE,
        lookup: table,
        fetchImpl: impl,
        maxRedirects: 0,
      },
    );
    expect(response.status).toBe(301);
    expect(redirects).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("stops at the hop limit and hands back the last redirect", async () => {
    const { impl, calls } = scriptedFetch(
      redirectTo("https://second.example.com/a"),
      redirectTo("https://third.example.com/b"),
      redirectTo("https://start.example.com/c"),
    );
    const { response } = await egressFetch(
      "https://start.example.com/",
      {},
      {
        policy: DENY_PRIVATE,
        lookup: table,
        fetchImpl: impl,
        maxRedirects: 2,
      },
    );
    expect(calls).toHaveLength(3);
    expect(response.status).toBe(302);
  });

  it("downgrades a POST to a GET on a 303 and drops the body", async () => {
    const { impl, calls } = scriptedFetch(
      redirectTo("https://second.example.com/done", 303),
      { status: 200 },
    );
    await egressFetch(
      "https://start.example.com/",
      { method: "POST", body: '{"a":1}' },
      { policy: DENY_PRIVATE, lookup: table, fetchImpl: impl },
    );
    expect(calls[1]?.init.method).toBe("GET");
    expect(calls[1]?.init.body).toBeNull();
  });

  it("keeps the method and body across a 307", async () => {
    const { impl, calls } = scriptedFetch(
      redirectTo("https://second.example.com/done", 307),
      { status: 200 },
    );
    await egressFetch(
      "https://start.example.com/",
      { method: "POST", body: '{"a":1}' },
      { policy: DENY_PRIVATE, lookup: table, fetchImpl: impl },
    );
    expect(calls[1]?.init.method).toBe("POST");
    expect(calls[1]?.init.body).toBe('{"a":1}');
  });

  it("drops origin-bound headers when a hop crosses origins", async () => {
    const { impl, calls } = scriptedFetch(
      redirectTo("https://second.example.com/next", 307),
      { status: 200 },
    );
    await egressFetch(
      "https://start.example.com/",
      {
        method: "POST",
        body: "{}",
        headers: {
          "x-vigil-signature": "sha256=secret",
          authorization: "Bearer token",
          "x-vigil-event": "monitor.down",
        },
      },
      { policy: DENY_PRIVATE, lookup: table, fetchImpl: impl },
    );
    const second = new Headers(calls[1]?.init.headers);
    expect(second.get("x-vigil-signature")).toBeNull();
    expect(second.get("authorization")).toBeNull();
    // Everything that is not a credential survives the hop.
    expect(second.get("x-vigil-event")).toBe("monitor.down");
  });

  it("hands back the 3xx when the Location will not parse", async () => {
    // A broken or hostile server, not a destination. Throwing a URL
    // error here would report a check that did get a response as a
    // crash.
    // An unterminated IPv6 host. Most junk resolves against the base
    // into some relative URL; a malformed authority is one of the few
    // things `new URL` actually refuses.
    const { impl, calls } = scriptedFetch(redirectTo("http://[::1"));
    const { response } = await egressFetch(
      "https://start.example.com/",
      {},
      { policy: DENY_PRIVATE, lookup: table, fetchImpl: impl },
    );
    expect(response.status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it("refuses a redirect that leaves http entirely", async () => {
    const { impl } = scriptedFetch(redirectTo("file:///etc/passwd"));
    await expect(
      egressFetch(
        "https://start.example.com/",
        {},
        { policy: DENY_PRIVATE, lookup: table, fetchImpl: impl },
      ),
    ).rejects.toThrow("Only http and https targets can be reached");
  });

  it("re-resolves each hop rather than reusing the first hop's answer", async () => {
    const { impl } = scriptedFetch(
      redirectTo("https://second.example.com/next"),
      { status: 200 },
    );
    const lookup = lookupTable({
      "start.example.com": ["93.184.216.34"],
      "second.example.com": ["93.184.216.35"],
    });
    await egressFetch(
      "https://start.example.com/",
      {},
      { policy: DENY_PRIVATE, lookup, fetchImpl: impl },
    );
    expect(lookup.mock.calls.map(([host]) => host)).toEqual([
      "start.example.com",
      "second.example.com",
    ]);
  });
});

describe("egressFetch approved-exception audit", () => {
  it("records an exception when policy permits a private address", async () => {
    const seen: EgressException[] = [];
    const { impl } = scriptedFetch({ status: 200 });
    await egressFetch(
      "https://runbook.internal/hooks/restart",
      { method: "POST" },
      {
        policy: RECOVERY,
        lookup: lookupOf("10.0.0.5"),
        fetchImpl: impl,
        onException: (entry) => seen.push(entry),
      },
    );
    expect(seen).toEqual([
      {
        channel: "recovery",
        hostname: "runbook.internal",
        address: "10.0.0.5",
        classification: "private",
        hop: 0,
        url: "https://runbook.internal/hooks/restart",
      },
    ]);
  });

  it("records nothing when the address was public all along", async () => {
    const seen: EgressException[] = [];
    const { impl } = scriptedFetch({ status: 200 });
    await egressFetch(
      "https://health.example.com/",
      {},
      {
        policy: ALLOW_PRIVATE,
        lookup: lookupOf("93.184.216.34"),
        fetchImpl: impl,
        onException: (entry) => seen.push(entry),
      },
    );
    expect(seen).toEqual([]);
  });

  it("records the hop a redirect landed on, not just the entry point", async () => {
    const seen: EgressException[] = [];
    const { impl } = scriptedFetch(
      redirectTo("http://internal.example.com/admin"),
      { status: 200 },
    );
    await egressFetch(
      "https://start.example.com/",
      {},
      {
        policy: ALLOW_PRIVATE,
        lookup: lookupTable({
          "start.example.com": ["93.184.216.34"],
          "internal.example.com": ["10.0.0.5"],
        }),
        fetchImpl: impl,
        onException: (entry) => seen.push(entry),
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ hop: 1, address: "10.0.0.5" });
  });

  it("distinguishes loopback from private in what it records", async () => {
    const seen: EgressException[] = [];
    const { impl } = scriptedFetch({ status: 200 });
    await egressFetch(
      "http://127.0.0.1:9000/hooks/restart",
      {},
      {
        policy: RECOVERY,
        fetchImpl: impl,
        onException: (entry) => seen.push(entry),
      },
    );
    expect(seen[0]).toMatchObject({
      classification: "loopback",
      address: "127.0.0.1",
    });
  });

  it("keeps credentials and query strings out of the recorded URL", async () => {
    const seen: EgressException[] = [];
    const { impl } = scriptedFetch({ status: 200 });
    await egressFetch(
      "https://user:hunter2@runbook.internal/hooks?token=s3cret",
      {},
      {
        policy: RECOVERY,
        lookup: lookupOf("10.0.0.5"),
        fetchImpl: impl,
        onException: (entry) => seen.push(entry),
      },
    );
    expect(seen[0]?.url).toBe("https://runbook.internal/hooks");
  });
});

describe("egressPolicyFor", () => {
  it("denies private space to monitors and allows it to webhooks and recovery", () => {
    // The shipped posture: a hosted install must not probe its own
    // network, but a recovery hook on an internal address is the
    // feature and has worked since the feature shipped.
    expect(egressPolicyFor("monitor").allowPrivate).toBe(false);
    expect(egressPolicyFor("webhook").allowPrivate).toBe(true);
    expect(egressPolicyFor("recovery").allowPrivate).toBe(true);
  });

  it("lets a caller override the channel default", () => {
    expect(egressPolicyFor("monitor", true)).toEqual({
      channel: "monitor",
      allowPrivate: true,
    });
    expect(egressPolicyFor("recovery", false).allowPrivate).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The address-pinned transport                                        */
/* ------------------------------------------------------------------ */

interface Received {
  host: string | undefined;
  method: string;
  url: string;
  body: string;
}

interface TestServer {
  port: number;
  received: Received[];
  close: () => Promise<void>;
}

const servers: TestServer[] = [];

async function startServer(
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => void,
): Promise<TestServer> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        host: request.headers.host,
        method: request.method ?? "",
        url: request.url ?? "",
        body: Buffer.concat(chunks).toString(),
      });
      handler(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const entry: TestServer = {
    port: typeof address === "object" && address ? address.port : 0,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  servers.push(entry);
  return entry;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("DNS rebinding", () => {
  it("connects to the address it validated, not to a second lookup", async () => {
    // The TOCTOU the 1.12 tree had: the guard resolved, approved, and
    // then `fetch` resolved again on its own. A resolver that answers
    // differently the second time chooses where the socket lands.
    // Here the resolver answers exactly once — proving the transport
    // never asked — and the request still arrives.
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("arrived");
    });
    const lookup = lookupOf("127.0.0.1");

    const { response } = await egressFetch(
      `http://rebind.test:${server.port}/health`,
      {},
      { policy: ALLOW_PRIVATE, lookup },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("arrived");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("refuses to send when its own resolver failed, rather than letting the transport resolve", async () => {
    // The fail-open this closes: a lookup that threw became an empty
    // address list, the classification loop over zero addresses refused
    // nothing, and the request went out through the GLOBAL fetch — which
    // resolves a second time, with no classification and no pin.
    //
    // The premise in the code was "the transport is about to fail on it
    // exactly as ours did." It is a second, independent getaddrinfo, so
    // it is free to succeed. This test does not need hostile DNS to show
    // that: `localhost` resolves to loopback for the transport whatever
    // our resolver did, and `DENY_PRIVATE` is the shipped default for
    // monitors, so a request arriving here is loopback reached from the
    // channel that forbids it.
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end("reached");
    });
    const lookup = vi.fn<EgressLookup>(async () => {
      throw new Error("EAI_AGAIN localhost");
    });

    await expect(
      egressFetch(
        `http://localhost:${server.port}/`,
        {},
        {
          policy: DENY_PRIVATE,
          lookup,
        },
      ),
    ).rejects.toThrow(/EAI_AGAIN/);
    expect(server.received).toHaveLength(0);
  });

  it("keeps the original Host header on the pinned connection", async () => {
    // The reason the address is pinned through `lookup` rather than by
    // rewriting the URL to the IP: `Host` is what every name-based
    // virtual host routes on, and it is a forbidden header in `fetch`.
    const server = await startServer((_request, response) =>
      response.end("ok"),
    );

    await egressFetch(
      `http://vhost.test:${server.port}/health`,
      {},
      { policy: ALLOW_PRIVATE, lookup: lookupOf("127.0.0.1") },
    );

    expect(server.received[0]?.host).toBe(`vhost.test:${server.port}`);
    expect(server.received[0]?.url).toBe("/health");
  });

  it("re-decides on every request instead of trusting an earlier answer", async () => {
    // A pinned socket is not a licence for the next request. The second
    // call sees a rebound record and is refused.
    const server = await startServer((_request, response) =>
      response.end("ok"),
    );
    let answer = "127.0.0.1";
    const lookup: EgressLookup = async () => [resolved(answer)];
    const target = `http://rebind.test:${server.port}/health`;

    const first = await egressFetch(
      target,
      {},
      { policy: ALLOW_PRIVATE, lookup },
    );
    expect(first.response.status).toBe(200);

    answer = "169.254.169.254";
    await expect(
      egressFetch(target, {}, { policy: ALLOW_PRIVATE, lookup }),
    ).rejects.toThrow("Target resolves to a cloud metadata address");
  });

  it("pins each redirect hop to its own validated address", async () => {
    const second = await startServer((_request, response) =>
      response.end("two"),
    );
    const first = await startServer((_request, response) => {
      response.writeHead(302, {
        location: `http://hop-two.test:${second.port}/next`,
      });
      response.end();
    });
    const lookup = lookupTable({
      "hop-one.test": ["127.0.0.1"],
      "hop-two.test": ["127.0.0.1"],
    });

    const result = await egressFetch(
      `http://hop-one.test:${first.port}/`,
      {},
      { policy: ALLOW_PRIVATE, lookup },
    );

    expect(await result.response.text()).toBe("two");
    expect(second.received[0]?.host).toBe(`hop-two.test:${second.port}`);
    expect(lookup.mock.calls.map(([host]) => host)).toEqual([
      "hop-one.test",
      "hop-two.test",
    ]);
  });
});

describe("the pinned transport", () => {
  it("reports the status, headers and body of the real response", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"status":"draining"}');
    });
    const { response } = await egressFetch(
      `http://pinned.test:${server.port}/health`,
      {},
      { policy: ALLOW_PRIVATE, lookup: lookupOf("127.0.0.1") },
    );
    expect(response.status).toBe(503);
    expect(response.ok).toBe(false);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ status: "draining" });
  });

  it("decompresses a gzipped body, as fetch does", async () => {
    // A keyword assertion reads this body. A transport swap that
    // stopped decompressing would fail every gzipped health endpoint
    // and blame the endpoint.
    const gzipped = await promisify(zlib.gzip)('{"status":"healthy"}');
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-encoding": "gzip" });
      response.end(gzipped);
    });
    const { response } = await egressFetch(
      `http://pinned.test:${server.port}/health`,
      {},
      { policy: ALLOW_PRIVATE, lookup: lookupOf("127.0.0.1") },
    );
    expect(await response.text()).toBe('{"status":"healthy"}');
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it("survives a HEAD whose headers claim an encoding and carry no body", async () => {
    // The crash this exists for: Cloudflare answers HEAD with
    // `content-encoding: br` and zero bytes, because the header
    // describes the GET it is standing in for. The transport built a
    // BrotliDecompress for it anyway, piped an empty message into it,
    // and `pipe()` does not forward errors — so the decoder hit EOF at
    // byte zero, emitted `Z_BUF_ERROR` on an EventEmitter nobody was
    // listening to, and took the worker process down with it. No
    // restart policy on that container, so monitoring simply stopped.
    //
    // One seeded monitor in `scripts/seed-demo.ts` is exactly this
    // request, which means it reproduced on every fresh install within
    // two minutes.
    const server = await startServer((_request, response) => {
      response.writeHead(200, {
        "content-encoding": "br",
        "content-type": "text/html",
      });
      response.end();
    });

    const { response } = await egressFetch(
      `http://pinned.test:${server.port}/`,
      { method: "HEAD" },
      { policy: ALLOW_PRIVATE, lookup: lookupOf("127.0.0.1") },
    );

    expect(response.status).toBe(200);
    // Long enough for an unhandled 'error' event to have been raised on
    // a later tick, which is how this one killed the process.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("reports a truncated compressed body instead of crashing", async () => {
    // The same decoder, reached the other way: a server that announces
    // gzip and then hangs up mid-stream. The read must fail. The
    // process must not.
    const gzipped = await promisify(zlib.gzip)('{"status":"healthy"}');
    const server = await startServer((_request, response) => {
      // Headers and a partial body first, flushed, so the client has a
      // response in hand. Hanging up in the same tick would fail the
      // request itself and prove nothing about the decoder.
      response.writeHead(200, { "content-encoding": "gzip" });
      response.write(gzipped.subarray(0, 10), () =>
        setTimeout(() => response.destroy(), 20),
      );
    });

    const { response } = await egressFetch(
      `http://pinned.test:${server.port}/health`,
      {},
      { policy: ALLOW_PRIVATE, lookup: lookupOf("127.0.0.1") },
    );
    await expect(response.text()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("sends a POST body with its content length", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    await egressFetch(
      `http://pinned.test:${server.port}/hook`,
      {
        method: "POST",
        body: '{"event":"monitor.down"}',
        headers: { "content-type": "application/json" },
      },
      { policy: ALLOW_PRIVATE, lookup: lookupOf("127.0.0.1") },
    );
    expect(server.received[0]?.method).toBe("POST");
    expect(server.received[0]?.body).toBe('{"event":"monitor.down"}');
  });

  it("rejects with the signal's own reason so a timeout stays a TimeoutError", async () => {
    // Every probe branches on `DOMException`/`TimeoutError` to report
    // "Timed out after Nms" instead of a raw socket error.
    const server = await startServer(() => {
      /* never answers */
    });
    const failure = await egressFetch(
      `http://pinned.test:${server.port}/slow`,
      { signal: AbortSignal.timeout(50) },
      { policy: ALLOW_PRIVATE, lookup: lookupOf("127.0.0.1") },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DOMException);
    expect((failure as DOMException).name).toBe("TimeoutError");
  });

  it("reports a refused connection the way fetch does, cause and all", async () => {
    const server = await startServer((_request, response) => response.end());
    const port = server.port;
    await server.close();
    servers.splice(0);

    const failure = await egressFetch(
      `http://pinned.test:${port}/health`,
      {},
      { policy: ALLOW_PRIVATE, lookup: lookupOf("127.0.0.1") },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).cause).toBeInstanceOf(Error);
    expect(String((failure as TypeError).cause)).toContain("ECONNREFUSED");
  });
});
