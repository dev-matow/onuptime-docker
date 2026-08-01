// @covers-type: steam
import dgram from "node:dgram";

import { afterEach, describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import { monitorColumnsFor } from "@/modules/monitors/types/persist";
import {
  infoRequest,
  printableText,
  readA2sReply,
  steamProbe,
} from "@/modules/monitors/types/probes/steam";
import {
  steamSpec,
  type SteamConfig,
} from "@/modules/monitors/types/specs/steam";

/**
 * The A2S_INFO check, exercised against a real UDP server.
 *
 * The fixture below is a socket that binds a port and answers datagrams,
 * not a stubbed function: everything between `steamProbe` and the wire —
 * the connected socket, the retransmit, the deadline, the challenge
 * round trip — is the part most likely to be wrong, and a mocked
 * transport is exactly the thing that cannot catch it. The reply bytes
 * are built here from the protocol description rather than from the
 * production encoder, so a parser that agrees with itself and with
 * nothing else fails.
 */

interface FakeServer {
  port: number;
  /** Every datagram the server was sent, in order. */
  requests: Buffer[];
  close: () => Promise<void>;
}

/**
 * A UDP server that answers each request with whatever the handler
 * returns, and stays silent when it returns null.
 */
function startServer(
  reply: (request: Buffer, index: number) => Buffer | null,
): Promise<FakeServer> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const requests: Buffer[] = [];

    socket.on("message", (request, from) => {
      const answer = reply(request, requests.length);
      requests.push(Buffer.from(request));
      if (answer !== null) socket.send(answer, from.port, from.address);
    });

    socket.bind(0, "127.0.0.1", () => {
      resolve({
        port: socket.address().port,
        requests,
        close: () =>
          new Promise<void>((done) => {
            socket.close(() => done());
          }),
      });
    });
  });
}

const servers: FakeServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

async function serving(
  reply: (request: Buffer, index: number) => Buffer | null,
): Promise<FakeServer> {
  const server = await startServer(reply);
  servers.push(server);
  return server;
}

function context(
  port: number,
  overrides: Partial<ProbeContext<SteamConfig>> = {},
): ProbeContext<SteamConfig> {
  return {
    target: "127.0.0.1",
    port,
    config: { degradedThresholdMs: 3_000 },
    timeoutMs: 1_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* The fixture's half of the protocol                                  */
/* ------------------------------------------------------------------ */

function cstring(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
}

interface FakeInfo {
  name: string;
  map: string;
  folder: string;
  game: string;
  appId: number;
  players: number;
  maxPlayers: number;
  bots: number;
  vac: number;
}

const DEFAULT_INFO: FakeInfo = {
  name: "Vigil Test Server",
  map: "de_dust2",
  folder: "cstrike",
  game: "Counter-Strike: Source",
  appId: 240,
  players: 12,
  maxPlayers: 32,
  bots: 2,
  vac: 1,
};

/** An S2A_INFO reply, laid out as the A2S specification describes it. */
function infoReply(overrides: Partial<FakeInfo> = {}): Buffer {
  const info = { ...DEFAULT_INFO, ...overrides };
  const appId = Buffer.alloc(2);
  appId.writeUInt16LE(info.appId);
  return Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]),
    cstring(info.name),
    cstring(info.map),
    cstring(info.folder),
    cstring(info.game),
    appId,
    Buffer.from([
      info.players,
      info.maxPlayers,
      info.bots,
      "d".charCodeAt(0),
      "l".charCodeAt(0),
      0,
      info.vac,
    ]),
    // Everything past the VAC byte is deliberately not read by the
    // probe; it is here because a real server sends it.
    cstring("1.38.7.2"),
  ]);
}

const CHALLENGE = Buffer.from([0x11, 0x22, 0x33, 0x44]);

/** The S2C_CHALLENGE a Source server has answered with since 2020. */
function challengeReply(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41]),
    CHALLENGE,
  ]);
}

/* ------------------------------------------------------------------ */
/* The probe                                                           */
/* ------------------------------------------------------------------ */

describe("steamProbe", () => {
  it("reports the server's name, map and player counts from an A2S_INFO reply", async () => {
    const server = await serving(() => infoReply());

    const result = await steamProbe(context(server.port));

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      answered: true,
      serverName: "Vigil Test Server",
      map: "de_dust2",
      game: "Counter-Strike: Source",
      players: 12,
      maxPlayers: 32,
      bots: 2,
      vacSecured: true,
    });
    expect(typeof result.responseTimeMs).toBe("number");
  });

  it("sends the query a Steam client sends", async () => {
    const server = await serving(() => infoReply());

    await steamProbe(context(server.port));

    expect(server.requests[0]?.subarray(0, 5)).toEqual(
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
    );
    expect(server.requests[0]?.subarray(5).toString("ascii")).toBe(
      "Source Engine Query\0",
    );
  });

  it("echoes the challenge back when the server demands one", async () => {
    // Since December 2020 this is the normal path: an unchallenged
    // A2S_INFO gets a token, and only the second query is answered.
    const server = await serving((request) =>
      request.length > 25 ? infoReply() : challengeReply(),
    );

    const result = await steamProbe(context(server.port));

    expect(result.facts.answered).toBe(true);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.subarray(25)).toEqual(CHALLENGE);
  });

  it("reads a GoldSrc server that answers the first query outright", async () => {
    const server = await serving(() => infoReply({ folder: "valve" }));

    const result = await steamProbe(context(server.port));

    expect(result.facts.answered).toBe(true);
    expect(server.requests).toHaveLength(1);
  });

  it("retransmits once, so a single lost datagram is not an outage", async () => {
    // The loss the internet is entitled to. Without the retransmit this
    // is a monitor that reports ordinary packet loss as downtime.
    const server = await serving((_request, index) =>
      index === 0 ? null : infoReply(),
    );

    const result = await steamProbe(context(server.port, { timeoutMs: 400 }));

    expect(result.error).toBeNull();
    expect(result.facts.answered).toBe(true);
    expect(server.requests.length).toBeGreaterThan(1);
  });

  it("reports silence as a transport failure, never as an assertion failure", async () => {
    const server = await serving(() => null);

    const result = await steamProbe(context(server.port, { timeoutMs: 250 }));

    expect(result.error).toBe("No reply within 250ms");
    // The distinction the ledger keeps: nothing was measured, so no
    // assertion is entitled to an opinion about it.
    const verdict = judge(steamSpec.assertions, context(0).config, result);
    expect(verdict.verdict).toBe("down");
    expect(verdict.failureClass).toBe("transport");
  });

  it("reports a port answering with something else as answered, not measured", async () => {
    const server = await serving(() => Buffer.from("HTTP/1.1 400 Bad Request"));

    const result = await steamProbe(context(server.port));

    expect(result.error).toBeNull();
    expect(result.facts.answered).toBe(false);
    const verdict = judge(steamSpec.assertions, context(0).config, result);
    expect(verdict.verdict).toBe("down");
    // An assertion, not a transport error: the datagram arrived. What is
    // wrong is the port, and the message has to send the operator there.
    expect(verdict.failureClass).toBe("assertion");
    expect(verdict.error).toContain("not with an A2S_INFO reply");
  });

  it("reports a multi-packet reply as indeterminate rather than as an outage", async () => {
    // Vigil does not reassemble split replies. That is Vigil's
    // limitation, and a limitation that reads as `down` is a page at 3am
    // for a server that is running perfectly.
    const server = await serving(() =>
      Buffer.concat([Buffer.from([0xfe, 0xff, 0xff, 0xff]), Buffer.alloc(20)]),
    );

    const result = await steamProbe(context(server.port));

    expect(result.unavailable).toContain("multi-packet");
    const verdict = judge(steamSpec.assertions, context(0).config, result);
    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.failureClass).toBe("misconfigured");
  });

  it("calls a slow server degraded once it passes the threshold", async () => {
    const server = await serving(() => infoReply());

    const result = await steamProbe(context(server.port));
    const verdict = judge(
      steamSpec.assertions,
      { degradedThresholdMs: 100 },
      { ...result, facts: { ...result.facts, responseTimeMs: 240 } },
    );

    expect(verdict.verdict).toBe("degraded");
    expect(verdict.error).toContain("240ms");
  });

  it("reports a closed port rather than waiting out the timeout", async () => {
    const server = await serving(() => null);
    const port = server.port;
    await server.close();
    servers.pop();

    const result = await steamProbe(context(port, { timeoutMs: 400 }));

    // ICMP port-unreachable on a connected socket, or silence where a
    // firewall swallows it. Either way it is a transport failure with a
    // sentence in it, never a passing check.
    expect(result.error).toBeTruthy();
    expect(result.facts.answered).toBeUndefined();
  });

  it("refuses a target that resolves into private space", async () => {
    const result = await steamProbe(
      context(27015, { target: "localhost", allowPrivateTargets: false }),
    );

    expect(result).toMatchObject({
      error: "Target resolves to a private address",
      responseTimeMs: null,
    });
  });

  it("never dials the metadata endpoint, whatever the setting says", async () => {
    const result = await steamProbe(
      context(27015, {
        target: "metadata.google.internal",
        allowPrivateTargets: true,
      }),
    );

    expect(result.error).toBeTruthy();
    expect(result.facts.answered).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* The codec                                                           */
/* ------------------------------------------------------------------ */

describe("readA2sReply", () => {
  it("reads a well-formed reply", () => {
    const reply = readA2sReply(infoReply());
    expect(reply).toMatchObject({ state: "info" });
  });

  it("treats a payload truncated inside a field as unreadable, never as half a server", () => {
    // A datagram that stops in the middle of a string must not take the
    // worker down, and must not produce a partly-built server either.
    const full = infoReply();
    // The version string is the first field the probe does not read, so
    // it is also the point after which a truncation costs nothing. Every
    // byte before it is load-bearing.
    const lastFieldRead = full.length - cstring("1.38.7.2").length;
    for (let length = 5; length < lastFieldRead; length += 1) {
      expect({
        length,
        state: readA2sReply(full.subarray(0, length)).state,
      }).toEqual({ length, state: "unreadable" });
    }
    // And a reply that stops right after the VAC byte is still a reply:
    // the fields past it are read by nothing.
    expect(readA2sReply(full.subarray(0, lastFieldRead)).state).toBe("info");
  });

  it("reads the challenge token as four opaque bytes", () => {
    const reply = readA2sReply(challengeReply());
    expect(reply).toEqual({ state: "challenge", challenge: CHALLENGE });
  });

  it("refuses a challenge that is missing its token", () => {
    const short = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 0x11]);
    expect(readA2sReply(short).state).toBe("unreadable");
  });

  it("recognises a split reply, so it is never read as a broken one", () => {
    const split = Buffer.concat([
      Buffer.from([0xfe, 0xff, 0xff, 0xff]),
      Buffer.alloc(10),
    ]);
    expect(readA2sReply(split).state).toBe("split");
  });

  it("rejects a datagram that is not an A2S reply at all", () => {
    expect(readA2sReply(Buffer.from("hello")).state).toBe("unreadable");
    expect(readA2sReply(Buffer.alloc(0)).state).toBe("unreadable");
  });

  it("appends the challenge to the request and changes nothing else", () => {
    const plain = infoRequest(null);
    const challenged = infoRequest(CHALLENGE);
    expect(challenged.subarray(0, plain.length)).toEqual(plain);
    expect(challenged.subarray(plain.length)).toEqual(CHALLENGE);
  });
});

describe("printableText", () => {
  it("strips the control characters a server name can carry", () => {
    // This string reaches incident emails, a CSV export and a public
    // status page, and the far end chose every byte of it.
    const decorated = "Vigil\u001b[31m\u0007 Server\u0000";
    expect(printableText(decorated)).toBe("Vigil [31m Server");
  });

  it("keeps a non-Latin name intact", () => {
    const name = "Кафе сервер";
    expect(printableText(name)).toBe(name);
  });

  it("truncates a name long enough to bury a log line", () => {
    const long = printableText("x".repeat(500));
    expect(long).toHaveLength(81);
    expect(long.endsWith("…")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The spec                                                            */
/* ------------------------------------------------------------------ */

describe("the steam spec", () => {
  it("holds no credential, because A2S authenticates nobody", () => {
    // Stated as a test rather than as a comment: the day this type grows
    // a stored secret, `secretFields` has to grow with it or the value is
    // serialised into a browser the moment somebody opens the edit form.
    expect(steamSpec.secretFields).toBeUndefined();
    expect(steamSpec.storedSchema.parse({})).toBeNull();
  });

  it("keeps its settings in the flat columns, so there is no blob to lose", () => {
    expect(steamSpec.storedSchema.parse({ anything: true })).toBeNull();
  });

  it("survives a config blob written by a build that knew something else", () => {
    for (const config of [null, undefined, {}, { nonsense: true }, 42]) {
      expect(() =>
        steamSpec.fromRow({
          checkType: "steam",
          url: "cs.example.com",
          port: 27015,
          method: "GET",
          intervalSeconds: 60,
          timeoutMs: 10_000,
          degradedThresholdMs: 3_000,
          expectedStatusCode: null,
          bodyKeyword: null,
          keywordAbsent: false,
          tlsCheck: false,
          tlsWarnDays: 14,
          config,
        }),
      ).not.toThrow();
    }
  });

  it("names the port it watched, because one host runs four servers", () => {
    const config = { degradedThresholdMs: 3_000 };
    expect(steamSpec.describeTarget("cs.example.com", 27016, config)).toBe(
      "cs.example.com:27016",
    );
    expect(steamSpec.describeTarget("cs.example.com", null, config)).toBe(
      "cs.example.com:27015",
    );
  });

  it("defaults the port to the query port a Source server uses", () => {
    expect(monitorColumnsFor(steamSpec, {}).port).toBe(27015);
    expect(monitorColumnsFor(steamSpec, { port: 27045 }).port).toBe(27045);
  });
});

/**
 * What the operator sees when they get the target field wrong.
 *
 * The monitor form renders `descriptor.target` and reports whatever the type
 * refuses, and `schemas.ts` refuses by delegating to exactly these schemas
 * — so the message asserted here is the message the field shows.
 */
describe("the target field's validation and error state", () => {
  it("accepts a bare hostname", () => {
    expect(steamSpec.targetSchema.safeParse("cs.example.com").success).toBe(
      true,
    );
  });

  it("tells the operator to drop the scheme when they paste a URL", () => {
    const parsed = steamSpec.targetSchema.safeParse("steam://cs.example.com");
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("hostname");
  });

  it("refuses a host and port typed into the host field", () => {
    // The port has its own field, and a target carrying one would be
    // dialled as a hostname that does not resolve.
    expect(
      steamSpec.targetSchema.safeParse("cs.example.com:27015").success,
    ).toBe(false);
  });

  it("still refuses the metadata endpoint", () => {
    expect(
      steamSpec.targetSchema.safeParse("metadata.google.internal").success,
    ).toBe(false);
  });
});
