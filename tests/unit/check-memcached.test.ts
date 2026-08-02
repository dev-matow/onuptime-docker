// @covers-type: memcached
import net from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import { judgeMeasurement } from "@/modules/monitors/check";
import { SECRET_MASK, redactConfig } from "@/modules/monitors/types/config";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import {
  isAuthError,
  memcachedFacts,
  memcachedProbe,
} from "@/modules/monitors/types/probes/memcached";
import {
  DEFAULT_MAX_CONNECTION_USAGE_PERCENT,
  memcachedSpec,
  memcachedStoredSchema,
  type MemcachedConfig,
} from "@/modules/monitors/types/specs/memcached";

/**
 * memcached, checked against a server that actually speaks the text
 * protocol.
 *
 * The fixture below is a real TCP server: it frames lines on CRLF,
 * consumes the length-prefixed data block of a `set`, refuses commands
 * until a credential arrives when it is told to, and answers `stats`
 * with `STAT` lines terminated by `END`. That matters more here than a
 * stubbed function would allow, because two of the things this type
 * must get right are only visible on the wire — that a reply split
 * across packets is reassembled, and that the probe never sends a
 * credential to a server that did not ask for one.
 */

/** Counters as a real server reports them: text, and mostly cumulative. */
const STATS = {
  pid: "1",
  uptime: "864000",
  time: "1754049600",
  version: "1.6.21",
  curr_connections: "12",
  total_connections: "4200",
  cmd_get: "9182",
  get_hits: "9001",
  evictions: "0",
};

const SETTINGS = {
  maxconns: "1024",
  maxbytes: "67108864",
  // A multi-word value, because `STAT` values are not single tokens and
  // a parser that assumed they were would silently truncate this one.
  maxconns_fast: "yes please",
};

interface FakeMemcachedOptions {
  version?: string;
  /** Replaces the whole reply to `version` — for a peer that is not memcached. */
  versionReply?: string;
  stats?: Record<string, string>;
  /** null makes `stats settings` answer ERROR, as a restricted host does. */
  settings?: Record<string, string> | null;
  /** When set, every command is refused until this credential arrives. */
  auth?: { username: string; password: string };
  /** Accept the connection and never say anything. */
  mute?: boolean;
  /** Accept the connection and hang up without a word. */
  hangUp?: boolean;
  /** Split every reply across two packets, mid-line. */
  splitReplies?: boolean;
  /**
   * Hold every reply back by this many milliseconds.
   *
   * The degraded-latency test used to set the threshold to 0.5ms and
   * trust a loopback round trip to be slower than that. On a quick
   * runner it is not — the check came back `up` and the suite failed
   * for a reason that had nothing to do with the code. A server that
   * really is slow makes the assertion deterministic instead of
   * hardware-dependent.
   */
  replyDelayMs?: number;
}

interface FakeMemcached {
  port: number;
  /** Every command line the server received, in order. */
  received: string[];
  close: () => Promise<void>;
}

const servers: FakeMemcached[] = [];
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function statBlock(entries: Record<string, string>): string {
  return `${Object.entries(entries)
    .map(([key, value]) => `STAT ${key} ${value}\r\n`)
    .join("")}END\r\n`;
}

async function openMemcached(
  options: FakeMemcachedOptions = {},
): Promise<FakeMemcached> {
  const received: string[] = [];

  const server = net.createServer((socket) => {
    // What memcached itself does to every connection it accepts, and
    // what this fixture has to do too: without it the kernel holds a
    // small reply back waiting for an ACK, and every measurement in
    // this file picks up 40ms of Nagle that no real server would show.
    socket.setNoDelay(true);
    socket.on("error", () => undefined);

    if (options.hangUp) {
      // Drained before the FIN. A socket nobody reads from never
      // reaches 'end', so it never fully closes and `server.close()`
      // waits for it for ever — which is a hang in the fixture, not in
      // anything being tested.
      socket.resume();
      socket.end();
      return;
    }

    // Replies go out in order even when each one is split in two: a
    // second reply written while the first is half-sent would arrive
    // interleaved, which is a fixture that lies about TCP rather than a
    // fixture that tests packet boundaries.
    let queue = Promise.resolve();
    const send = (text: string) => {
      if (options.replyDelayMs) {
        const delay = options.replyDelayMs;
        queue = queue.then(
          () =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                socket.write(text);
                resolve();
              }, delay);
            }),
        );
        return;
      }
      if (!options.splitReplies) {
        socket.write(text);
        return;
      }
      queue = queue.then(
        () =>
          new Promise<void>((resolve) => {
            const middle = Math.max(1, Math.floor(text.length / 2));
            socket.write(text.slice(0, middle));
            setTimeout(() => {
              socket.write(text.slice(middle));
              resolve();
            }, 5);
          }),
      );
    };

    let buffer: Buffer = Buffer.alloc(0);
    let authenticated = options.auth === undefined;
    let block: { bytes: number; username: string } | null = null;

    socket.on("data", (chunk: Buffer) => {
      if (options.mute) return;
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (block !== null) {
          // The data block of a `set` is length-prefixed and followed by
          // its own CRLF, so it is read by count and not by delimiter —
          // a password may contain anything, newlines included.
          if (buffer.length < block.bytes + 2) return;
          const password = buffer.subarray(0, block.bytes).toString("utf8");
          buffer = buffer.subarray(block.bytes + 2);
          const accepted =
            options.auth !== undefined &&
            block.username === options.auth.username &&
            password === options.auth.password;
          block = null;
          authenticated = authenticated || accepted;
          send(
            accepted ? "STORED\r\n" : "CLIENT_ERROR authentication failure\r\n",
          );
          continue;
        }

        const end = buffer.indexOf("\r\n");
        if (end === -1) return;
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 2);
        received.push(line);

        if (line.startsWith("set ")) {
          const [, username = "", , , bytes = "0"] = line.split(" ");
          block = { bytes: Number(bytes), username };
          continue;
        }
        if (!authenticated) {
          send("CLIENT_ERROR authentication required\r\n");
          continue;
        }
        if (line === "version") {
          send(
            options.versionReply ??
              `VERSION ${options.version ?? "1.6.21"}\r\n`,
          );
          continue;
        }
        if (line === "stats") {
          send(statBlock(options.stats ?? STATS));
          continue;
        }
        if (line === "stats settings") {
          send(
            options.settings === null
              ? "ERROR\r\n"
              : statBlock(options.settings ?? SETTINGS),
          );
          continue;
        }
        send("ERROR\r\n");
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const entry: FakeMemcached = {
    port: typeof address === "object" && address ? address.port : 0,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  servers.push(entry);
  return entry;
}

function config(overrides: Partial<MemcachedConfig> = {}): MemcachedConfig {
  return {
    username: null,
    password: null,
    maxConnectionUsagePercent: DEFAULT_MAX_CONNECTION_USAGE_PERCENT,
    degradedThresholdMs: 3_000,
    ...overrides,
  };
}

function context(
  port: number,
  overrides: Partial<ProbeContext<MemcachedConfig>> = {},
): ProbeContext<MemcachedConfig> {
  return {
    target: "127.0.0.1",
    port,
    config: config(),
    timeoutMs: 2_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
    ...overrides,
  };
}

/** The probe, judged the way the runner judges it. */
async function check(
  ctx: ProbeContext<MemcachedConfig>,
): Promise<ReturnType<typeof judgeMeasurement<MemcachedConfig>>> {
  const result = await memcachedProbe(ctx);
  return judgeMeasurement(memcachedSpec.assertions, ctx.config, result);
}

describe("the memcached probe", () => {
  it("reports the version and the counters a healthy server answers with", async () => {
    const server = await openMemcached();
    const result = await memcachedProbe(context(server.port));

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      version: "1.6.21",
      uptimeSeconds: 864_000,
      currentConnections: 12,
      maxConnections: 1024,
      connectionUsagePercent: 1,
    });
    expect(typeof result.responseTimeMs).toBe("number");
    expect(server.received).toEqual(["version", "stats", "stats settings"]);
  });

  it("reassembles a reply that arrives split across packets", async () => {
    // Every write is cut in half mid-line. A parser that decoded each
    // packet on its own would see `VERSIO` and call this "not memcached".
    const server = await openMemcached({ splitReplies: true });
    const outcome = await check(context(server.port));

    expect(outcome.verdict).toBe("up");
    expect(outcome.facts.version).toBe("1.6.21");
    expect(outcome.facts.maxConnections).toBe(1024);
  });

  it("never offers a credential to a server that did not ask for one", async () => {
    // The reason this probe asks `version` first. memcached's ASCII
    // authentication *is* a `set`, so on a server without an auth file
    // the same bytes store the password in the cache under a key named
    // after the user, where any client can read it back.
    const server = await openMemcached();
    const outcome = await check(
      context(server.port, {
        config: config({ username: "vigil", password: "hunter2" }),
      }),
    );

    expect(outcome.verdict).toBe("up");
    expect(server.received.some((line) => line.startsWith("set "))).toBe(false);
  });

  it("signs in when the server asks for a credential, and then measures", async () => {
    const server = await openMemcached({
      auth: { username: "vigil", password: "hunter 2" },
    });
    const outcome = await check(
      context(server.port, {
        // A space inside the password, which is why the data block is
        // length-prefixed rather than delimited.
        config: config({ username: "vigil", password: "hunter 2" }),
      }),
    );

    expect(outcome.verdict).toBe("up");
    expect(outcome.facts.version).toBe("1.6.21");
    expect(server.received[0]).toBe("version");
    expect(server.received[1]).toBe("set vigil 0 0 8");
  });

  it("reports a rejected credential as misconfigured, never as down", async () => {
    // The server is up and answering. A wrong password is an operator
    // error, and an operator error that reads as an outage is the one
    // failure a monitoring product may not have.
    const server = await openMemcached({
      auth: { username: "vigil", password: "hunter2" },
    });
    const outcome = await check(
      context(server.port, {
        config: config({ username: "vigil", password: "wrong" }),
      }),
    );

    expect(outcome.verdict).toBe("indeterminate");
    expect(outcome.failureClass).toBe("misconfigured");
    expect(outcome.error).toContain("refused the stored credentials");
    expect(outcome.facts.serverError).toBe(
      "CLIENT_ERROR authentication failure",
    );
  });

  it("reports a server that wants a credential this monitor has not got as misconfigured", async () => {
    const server = await openMemcached({
      auth: { username: "vigil", password: "hunter2" },
    });
    const outcome = await check(context(server.port));

    expect(outcome.verdict).toBe("indeterminate");
    expect(outcome.failureClass).toBe("misconfigured");
    expect(outcome.error).toContain("requires authentication");
  });

  it("calls whatever answers without a VERSION line down, and not unreachable", async () => {
    // A proxy, a TLS terminator, the wrong service after a compose file
    // was edited: the socket opens, so a `tcp` monitor on 11211 would
    // be green. The distinction lives in the failure class — this is an
    // assertion failing, not the network eating anything.
    const server = await openMemcached({ versionReply: "ERROR\r\n" });
    const outcome = await check(context(server.port));

    expect(outcome.verdict).toBe("down");
    expect(outcome.failureClass).toBe("assertion");
    expect(outcome.error).toBe("The server did not answer VERSION");
    expect(outcome.facts.serverError).toBe("ERROR");
  });

  it("still measures when the server refuses stats settings", async () => {
    // Some hosted memcacheds restrict it. The connection limit is then
    // unknown, so the saturation assertion has nothing to say — and
    // saying it anyway would report a missing counter as saturation.
    const server = await openMemcached({ settings: null });
    const outcome = await check(context(server.port));

    expect(outcome.verdict).toBe("up");
    expect(outcome.facts.version).toBe("1.6.21");
    expect(outcome.facts.currentConnections).toBe(12);
    expect(outcome.facts.maxConnections).toBeUndefined();
    expect(outcome.facts.connectionUsagePercent).toBeUndefined();
  });

  it("reports a server that hangs up without a word as a transport failure", async () => {
    const server = await openMemcached({ hangUp: true });
    const outcome = await check(context(server.port));

    expect(outcome.verdict).toBe("down");
    expect(outcome.failureClass).toBe("transport");
    expect(outcome.error).toBe(
      "The server closed the connection without replying",
    );
  });

  it("gives up on a server that accepts the connection and says nothing", async () => {
    const server = await openMemcached({ mute: true });
    const outcome = await check(
      context(server.port, { timeoutMs: 300, config: config() }),
    );

    expect(outcome.verdict).toBe("down");
    expect(outcome.failureClass).toBe("transport");
    expect(outcome.error).toBe("Timed out after 300ms");
  });

  it("reports a refused connection as a transport failure", async () => {
    const closed = await openMemcached();
    await closed.close();
    const outcome = await check(context(closed.port));

    expect(outcome.verdict).toBe("down");
    expect(outcome.failureClass).toBe("transport");
    expect(outcome.error).toBeTruthy();
  });

  it("refuses a target that resolves into private space", async () => {
    const result = await memcachedProbe(
      context(11_211, { target: "localhost", allowPrivateTargets: false }),
    );

    expect(result.error).toBe("Target resolves to a private address");
    expect(result.facts).toEqual({});
  });
});

describe("what the memcached facts mean", () => {
  it("reports the share of the connection limit in use", () => {
    const facts = memcachedFacts(
      {
        version: "1.6.21",
        stats: new Map([["curr_connections", "990"]]),
        settings: new Map([["maxconns", "1024"]]),
        serverError: null,
      },
      12,
    );
    expect(facts.connectionUsagePercent).toBe(97);
  });

  it("records no counter it could not read as a number", () => {
    // The values arrive as text from a host we do not control. A NaN on
    // the timeline is unreadable, and the saturation assertion cannot
    // compare it to anything.
    const facts = memcachedFacts(
      {
        version: null,
        stats: new Map([["curr_connections", "lots"]]),
        settings: new Map([["maxconns", "1024"]]),
        serverError: null,
      },
      12,
    );
    expect(facts.currentConnections).toBeUndefined();
    expect(facts.connectionUsagePercent).toBeUndefined();
    expect(facts.maxConnections).toBe(1024);
  });

  it("recognises the wording memcached uses when it wants a credential", () => {
    expect(isAuthError("CLIENT_ERROR authentication required")).toBe(true);
    expect(isAuthError("CLIENT_ERROR authentication failure")).toBe(true);
    expect(isAuthError("SERVER_ERROR object too large for cache")).toBe(false);
    expect(isAuthError("ERROR")).toBe(false);
  });
});

describe("what the memcached type asserts", () => {
  it("calls a cache over its connection threshold degraded, not down", async () => {
    const server = await openMemcached({
      stats: { ...STATS, curr_connections: "990" },
    });
    const outcome = await check(context(server.port));

    expect(outcome.verdict).toBe("degraded");
    // Degraded is still passing: this colours the monitor amber and
    // opens no incident.
    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBe(
      "97% of the connection limit is in use, over the 90% threshold",
    );
    expect(outcome.failedAssertions).toEqual(["connection-headroom"]);
  });

  it("says nothing about the connection limit when the operator turned it off", async () => {
    const server = await openMemcached({
      stats: { ...STATS, curr_connections: "1020" },
    });
    const outcome = await check(
      context(server.port, {
        config: config({ maxConnectionUsagePercent: null }),
      }),
    );

    expect(outcome.verdict).toBe("up");
    expect(outcome.facts.connectionUsagePercent).toBe(100);
  });

  it("reports a server slower than the threshold as degraded", async () => {
    // The server is made slow rather than assumed to be: a 40ms reply
    // against a 5ms threshold is over it on any machine, where the old
    // 0.5ms threshold against an ordinary loopback round trip was a bet
    // on the runner being slow and lost that bet in CI.
    const server = await openMemcached({ replyDelayMs: 40 });
    const outcome = await check(
      context(server.port, { config: config({ degradedThresholdMs: 5 }) }),
    );

    expect(outcome.verdict).toBe("degraded");
    expect(outcome.error).toContain("over the 5ms threshold");
    expect(outcome.failedAssertions).toEqual(["latency"]);
  });
});

describe("what a memcached monitor is allowed to store", () => {
  it("accepts an empty submission and takes the shipped threshold", () => {
    const parsed = memcachedStoredSchema.parse({});
    expect(parsed).toEqual({
      username: null,
      password: null,
      maxConnectionUsagePercent: DEFAULT_MAX_CONNECTION_USAGE_PERCENT,
    });
  });

  it("keeps an explicit null as the operator's way of turning the threshold off", () => {
    expect(
      memcachedStoredSchema.parse({ maxConnectionUsagePercent: null })
        .maxConnectionUsagePercent,
    ).toBeNull();
  });

  it("refuses a user name that would be parsed as more than one argument", () => {
    // The ASCII protocol is space-delimited, so `set alice smith 0 0 7`
    // is a different command with different arguments — command
    // injection wearing a credential's clothes.
    const parsed = memcachedStoredSchema.safeParse({
      username: "alice smith",
      password: "hunter2",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain(
      "cannot contain a space",
    );
  });

  it("refuses a password with nobody to authenticate as", () => {
    const parsed = memcachedStoredSchema.safeParse({ password: "hunter2" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["password"]);
  });

  it("keeps a password exactly as typed, spaces included", () => {
    expect(
      memcachedStoredSchema.parse({ username: "vigil", password: "  pad  " })
        .password,
    ).toBe("  pad  ");
  });

  it("survives a config blob written by a build that had other ideas", () => {
    // Rows predate the blob and a downgrade can leave a shape this build
    // does not know. Neither may throw on the worker's hot path.
    for (const stored of [null, undefined, {}, { nonsense: true }, 42]) {
      expect(() =>
        memcachedSpec.fromRow({
          checkType: "memcached",
          url: "cache.example.com",
          port: 11_211,
          method: "GET",
          intervalSeconds: 60,
          timeoutMs: 10_000,
          degradedThresholdMs: 3_000,
          expectedStatusCode: null,
          bodyKeyword: null,
          keywordAbsent: false,
          tlsCheck: false,
          tlsWarnDays: 14,
          config: stored,
        }),
      ).not.toThrow();
    }
  });
});

describe("what a memcached monitor shows a human", () => {
  it("masks the password on the way to a browser", () => {
    const redacted = redactConfig(memcachedSpec, {
      username: "vigil",
      password: "hunter2",
      maxConnectionUsagePercent: 90,
    }) as Record<string, unknown>;

    expect(redacted.password).toBe(SECRET_MASK);
    expect(redacted.username).toBe("vigil");
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
  });

  it("names the host and the port, because two caches share a machine", () => {
    expect(
      memcachedSpec.describeTarget("cache.example.com", null, config()),
    ).toBe("cache.example.com:11211");
    expect(
      memcachedSpec.describeTarget("cache.example.com", 11_212, config()),
    ).toBe("cache.example.com:11212");
  });

  it("never prints the credential it was configured with", () => {
    const described = memcachedSpec.describeTarget(
      "cache.example.com",
      11_211,
      config({ username: "vigil", password: "hunter2" }),
    );
    expect(described).not.toContain("hunter2");
  });
});
