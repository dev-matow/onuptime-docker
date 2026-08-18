import { describe, expect, it } from "vitest";

import {
  ProviderApiError,
  ProviderTransport,
  redactUrl,
  retryDelayMs,
  type Fetcher,
} from "@/modules/importers/transport";

/**
 * The transport every adapter reads through.
 *
 * Two properties are worth more than the rest and both are about what
 * does *not* happen: the credential never appears in anything this
 * module produces, and a paginator that misbehaves stops rather than
 * hammering a customer's vendor account.
 */

const TOKEN = "tok_live_do_not_leak";

function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Fetcher {
  return async () => ({
    status,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function transport(fetcher: Fetcher, options = {}): ProviderTransport {
  return new ProviderTransport(
    "https://api.example.com/v1",
    { Authorization: `Bearer ${TOKEN}` },
    { fetcher, sleep: async () => undefined, ...options },
  );
}

describe("redacting a URL", () => {
  it("replaces every query parameter that could be a credential", () => {
    expect(redactUrl("https://api.example.com/x?api_key=abc&page=2")).toBe(
      "https://api.example.com/x?api_key=REDACTED&page=2",
    );
    expect(redactUrl("https://api.example.com/x?token=abc")).toContain(
      "token=REDACTED",
    );
    expect(redactUrl("https://api.example.com/x?apiKey=abc")).toContain(
      "apiKey=REDACTED",
    );
  });

  it("strips credentials written into the authority", () => {
    expect(redactUrl("https://user:pass@api.example.com/x")).toBe(
      "https://api.example.com/x",
    );
  });

  it("leaves a string that is not a URL alone rather than throwing", () => {
    expect(redactUrl("not a url")).toBe("not a url");
  });
});

describe("deciding how long to wait", () => {
  it("honours Retry-After in seconds", () => {
    expect(retryDelayMs({ "retry-after": "3" }, 0, 0)).toBe(3000);
  });

  it("honours Retry-After as a date", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const delay = retryDelayMs(
      { "retry-after": "Thu, 01 Jan 2026 00:00:05 GMT" },
      0,
      now,
    );
    expect(delay).toBe(5000);
  });

  it("reads a reset header as a duration when it is too small to be a clock", () => {
    expect(retryDelayMs({ "x-ratelimit-reset": "4" }, 0, 0)).toBe(4000);
  });

  it("backs off exponentially when the provider says nothing", () => {
    expect(retryDelayMs({}, 0, 0)).toBe(500);
    expect(retryDelayMs({}, 3, 0)).toBe(4000);
    // Bounded, so a long backoff never becomes an open request.
    expect(retryDelayMs({}, 20, 0)).toBe(8000);
  });
});

describe("the transport", () => {
  it("refuses a base URL that is not https", () => {
    expect(
      () => new ProviderTransport("http://api.example.com", {}),
    ).toThrowError(/https/);
  });

  it("returns the decoded body on success", async () => {
    const client = transport(respond(200, { ok: true }));
    await expect(client.json("/things")).resolves.toEqual({ ok: true });
  });

  it("retries a 429 and then succeeds", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      const headers: Record<string, string> =
        calls === 1 ? { "retry-after": "1" } : {};
      return calls === 1
        ? { status: 429, headers, body: "slow down" }
        : { status: 200, headers, body: JSON.stringify({ ok: true }) };
    };
    const client = transport(fetcher);
    await expect(client.json("/things")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(client.requestCount).toBe(2);
  });

  it("gives up on a 429 that never clears, and says the account is limited", async () => {
    const client = transport(respond(429, "slow down"), { maxRetries: 1 });
    await expect(client.json("/things")).rejects.toThrowError(/rate limited/i);
  });

  it("reports a redirect as an auth failure without following it", async () => {
    // New Relic's Synthetics API answers an unauthenticated request with
    // a 302 to its login page rather than a 401, on both its hosts.
    // Following it would hand the customer's token to a different host.
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return {
        status: 302,
        headers: { location: "https://login.example.com/?return_to=x" },
        body: "",
      };
    };
    const client = transport(fetcher);
    const error = await client.json("/things").catch((raised: Error) => raised);
    expect(calls).toBe(1);
    expect(String(error)).toContain("redirected the request");
    expect(String(error)).toContain("does not follow a redirect");
    expect(String(error)).not.toContain(TOKEN);
  });

  it("does not retry a 401, because it will still be a 401", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return { status: 401, headers: {}, body: "unauthorized" };
    };
    await expect(transport(fetcher).json("/things")).rejects.toThrowError(
      ProviderApiError,
    );
    expect(calls).toBe(1);
  });

  it("never puts the credential in the error it raises", async () => {
    const client = transport(respond(403, `forbidden`));
    const error = await client.json("/things").catch((raised: Error) => raised);
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).toContain("403");
    expect(String(error)).toContain("read permission");
  });

  it("redacts a credential that travelled in the query string", async () => {
    const client = transport(respond(500, "boom"), { maxRetries: 0 });
    const error = await client
      .json("/things", { api_key: TOKEN })
      .catch((raised: Error) => raised);
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).toContain("REDACTED");
  });

  it("says so when a provider answers with something that is not JSON", async () => {
    const client = transport(respond(200, "<html>maintenance</html>"));
    await expect(client.json("/things")).rejects.toThrowError(/not JSON/);
  });

  it("refuses to exceed its request ceiling rather than reading half an account", async () => {
    const client = transport(respond(500, "boom"), {
      maxRequests: 2,
      maxRetries: 10,
    });
    await expect(client.json("/things")).rejects.toThrowError(
      /ceiling this importer applies/,
    );
  });

  it("sends the credential in the header the adapter chose", async () => {
    let seen: Readonly<Record<string, string>> | undefined;
    const fetcher: Fetcher = async (request) => {
      seen = request.headers;
      return { status: 200, headers: {}, body: "{}" };
    };
    await transport(fetcher).json("/things");
    expect(seen?.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});
