// @covers-type: redis
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  encodeCommand,
  isAuthError,
  pingResult,
  redisProbe,
} from "@/modules/monitors/types/probes/redis";
import { redisSpec } from "@/modules/monitors/types/specs/redis";
import type { RedisConfig } from "@/modules/monitors/types/specs/redis";

import { publicLookup } from "../probe-lookup";

/**
 * Redis, against a real socket speaking RESP.
 *
 * The probe's own comments say the decision lives in `pingResult` and
 * `isAuthError`, so those are tested directly — but a pure-function test
 * cannot catch the failures that actually happen here, which are all
 * about the wire: a server that answers `-NOAUTH`, one that closes
 * mid-reply, one that sends `+PONG` split across two packets. So there
 * is a real server too, and the probe dials it.
 */

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/**
 * A minimal RESP server. `reply` decides what to send for each inbound
 * command, which is enough to stand in for every Redis behaviour this
 * probe has an opinion about.
 */
async function redisServer(
  reply: (command: string, socket: net.Socket) => void,
): Promise<number> {
  const server = net.createServer((socket) => {
    let buffered = "";
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      // RESP arrays end with the last argument's trailing CRLF; for the
      // two commands this probe sends, a complete frame always ends in
      // one, so splitting on it is enough for a fixture.
      let index = buffered.indexOf("\r\n");
      while (index !== -1) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 2);
        if (/^(PING|AUTH|[A-Z]+)$/i.test(line))
          reply(line.toUpperCase(), socket);
        index = buffered.indexOf("\r\n");
      }
    });
    socket.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

function context(port: number, config: Partial<RedisConfig> = {}) {
  return {
    // The fixture listens on loopback, so the target is loopback. A
    // hostname here would be resolved and dialled somewhere else, and
    // the test would measure a timeout rather than the protocol.
    target: "127.0.0.1",
    port,
    config: { password: null, degradedThresholdMs: 3_000, ...config },
    timeoutMs: 2_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
    lookup: publicLookup,
  };
}

describe("encodeCommand", () => {
  it("writes a RESP array the server can parse", () => {
    expect(encodeCommand("PING").toString("utf8")).toBe("*1\r\n$4\r\nPING\r\n");
  });

  it("counts bytes, not characters, in the length prefix", () => {
    // A password with a multi-byte character would otherwise declare a
    // length shorter than what it sends, and the server would read the
    // remainder as the start of the next command.
    expect(encodeCommand("AUTH", "pé").toString("utf8")).toContain(
      "$3\r\npé\r\n",
    );
  });
});

describe("isAuthError", () => {
  // Takes the message, not the RESP line: the leading `-` is stripped by
  // the caller before this ever sees it.
  it.each([
    ["NOAUTH Authentication required.", true],
    ["WRONGPASS invalid username-password pair", true],
    ["NOPERM this user has no permissions", true],
    ["ERR unknown command", false],
  ])("%s -> %s", (message, expected) => {
    expect(isAuthError(message)).toBe(expected);
  });
});

describe("pingResult", () => {
  it("reads PONG as a pong", () => {
    expect(pingResult("+PONG", 12, false).facts.pong).toBe(true);
  });

  it("reads any other simple string as not a pong", () => {
    expect(pingResult("+OK", 12, false).facts.pong).toBe(false);
  });

  it("reports null rather than false for an error reply", () => {
    // A server that answered `-NOAUTH` said nothing at all about PING.
    // Reporting false would be Vigil claiming the server is broken when
    // what actually happened is that it refused to talk.
    const result = pingResult("-NOAUTH Authentication required.", 12, false);
    expect(result.facts.pong).toBeNull();
    expect(result.facts.authRequired).toBe(true);
    expect(result.error).toBeNull();
  });

  it("reports a reply that is not RESP at all as a transport error", () => {
    const result = pingResult("HTTP/1.1 400 Bad Request", 12, false);
    expect(result.error).toContain("Not a RESP reply");
  });
});

describe("redisProbe against a real server", () => {
  it("reports PONG from a server that answers it", async () => {
    const port = await redisServer((_command, socket) => {
      socket.write("+PONG\r\n");
    });

    const result = await redisProbe(context(port));

    expect(result.error).toBeNull();
    expect(result.facts.pong).toBe(true);
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("sends AUTH before PING when a password is configured", async () => {
    const seen: string[] = [];
    const port = await redisServer((command, socket) => {
      seen.push(command);
      socket.write("+OK\r\n");
      if (command === "PING") socket.write("+PONG\r\n");
    });

    await redisProbe(context(port, { password: "hunter2" }));

    expect(seen[0]).toBe("AUTH");
    expect(seen).toContain("PING");
  });

  it("does not send AUTH when no password is configured", async () => {
    const seen: string[] = [];
    const port = await redisServer((command, socket) => {
      seen.push(command);
      socket.write("+PONG\r\n");
    });

    await redisProbe(context(port));

    expect(seen).not.toContain("AUTH");
  });

  it("records a refused credential as facts, not as a transport error", async () => {
    // The socket worked; the server declined. That is not a transport
    // failure and the probe does not report one — it reports `pong:
    // null` and `authRequired: true`, and the type's own assertion
    // decides what that means. A probe that returned an error here would
    // be judging, which is the runner's job.
    const port = await redisServer((_command, socket) => {
      socket.write("-NOAUTH Authentication required.\r\n");
    });

    const result = await redisProbe(context(port, { password: "wrong" }));

    // AUTH is refused before PING is ever sent, so there is no `pong`
    // fact at all — absent, rather than false. The type's assertion has
    // no opinion without a boolean, which is what stops a refused
    // credential being reported as "the server said the wrong thing".
    expect(result.error).toBeNull();
    expect(result.facts.pong).not.toBe(true);
    expect(result.facts.authRequired).toBe(true);
  });

  it("survives a reply split across packets", async () => {
    // TCP does not preserve write boundaries. A probe that assumed one
    // `data` event per reply would read `+PO` and decide nothing.
    const port = await redisServer((_command, socket) => {
      socket.write("+PO");
      setTimeout(() => socket.write("NG\r\n"), 20);
    });

    const result = await redisProbe(context(port));

    expect(result.facts.pong).toBe(true);
  });

  it("reports a server that closes without answering", async () => {
    const port = await redisServer((_command, socket) => {
      socket.destroy();
    });

    const result = await redisProbe(context(port));

    expect(result.error).toBeTruthy();
    expect(result.facts.pong).not.toBe(true);
  });

  it("reports a closed port rather than hanging", async () => {
    const result = await redisProbe(context(1));
    expect(result.error).toBeTruthy();
  });
});

describe("the redis spec", () => {
  it("declares its password as a secret", () => {
    // Undeclared, it would be serialised into the browser with the rest
    // of the config.
    expect(redisSpec.secretFields).toContain("password");
  });

  it("keeps the credential out of the description a status page renders", () => {
    const described = redisSpec.describeTarget("cache.example.com", 6379, {
      password: "hunter2",
      degradedThresholdMs: 3_000,
    });
    expect(described).not.toContain("hunter2");
  });
});
