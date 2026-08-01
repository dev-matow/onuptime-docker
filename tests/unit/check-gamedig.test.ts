// @covers-type: gamedig
import dgram from "node:dgram";

import { afterEach, describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import { monitorColumnsFor } from "@/modules/monitors/types/persist";
import { mergeConfig } from "@/modules/monitors/types/config";
import {
  gamedigProbe,
  readBasicStat,
  readStatusResponse,
} from "@/modules/monitors/types/probes/gamedig";
import {
  gamedigSpec,
  gamedigStoredSchema,
  type GamedigConfig,
} from "@/modules/monitors/types/specs/gamedig";

/**
 * Three query protocols, each exercised against a real UDP server that
 * speaks it.
 *
 * The fixtures below are sockets, not stubs, and they answer from the
 * protocol descriptions rather than by calling the production readers —
 * a decoder tested against its own encoder proves only that it is
 * self-consistent. What that buys is coverage of the parts a mocked
 * transport cannot reach: the Minecraft handshake's session id, the
 * challenge token echo, the retransmit, and the deadline that has to
 * cover two round trips rather than one each.
 */

interface FakeServer {
  port: number;
  requests: Buffer[];
  close: () => Promise<void>;
}

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
  config: Partial<GamedigConfig> = {},
  overrides: Partial<ProbeContext<GamedigConfig>> = {},
): ProbeContext<GamedigConfig> {
  return {
    target: "127.0.0.1",
    port,
    config: { protocol: "source", degradedThresholdMs: 3_000, ...config },
    timeoutMs: 1_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Fixture: Source (A2S_INFO)                                          */
/* ------------------------------------------------------------------ */

function cstring(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
}

function a2sInfoReply(players = 7, maxPlayers = 24): Buffer {
  const appId = Buffer.alloc(2);
  appId.writeUInt16LE(4000);
  return Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]),
    cstring("Sandbox"),
    cstring("gm_flatgrass"),
    cstring("garrysmod"),
    cstring("Garry's Mod"),
    appId,
    Buffer.from([players, maxPlayers, 0, 0x64, 0x6c, 0, 1]),
    cstring("2024.10.29"),
  ]);
}

/* ------------------------------------------------------------------ */
/* Fixture: Minecraft (GameSpy4 query)                                 */
/* ------------------------------------------------------------------ */

const TOKEN = 9513307;

/**
 * A Minecraft server with `enable-query=true`: a handshake that hands
 * out a token as decimal text, and a basic stat that refuses to answer
 * without it.
 */
function minecraftServer(): (request: Buffer, index: number) => Buffer | null {
  return (request) => {
    const session = request.subarray(3, 7);
    if (request.readUInt8(2) === 0x09) {
      return Buffer.concat([
        Buffer.from([0x09]),
        session,
        cstring(String(TOKEN)),
      ]);
    }
    // The token the server issued, echoed back as a signed 32-bit
    // integer. A stat request carrying the wrong one is ignored, which
    // is what the real server does.
    if (request.length < 11 || request.readInt32BE(7) !== TOKEN) return null;
    const hostPort = Buffer.alloc(2);
    hostPort.writeUInt16LE(25565);
    return Buffer.concat([
      Buffer.from([0x00]),
      session,
      cstring("A Vigil Minecraft Server"),
      cstring("SMP"),
      cstring("world"),
      cstring("3"),
      cstring("20"),
      hostPort,
      cstring("127.0.0.1"),
    ]);
  };
}

/* ------------------------------------------------------------------ */
/* Fixture: id Tech 3 (getstatus)                                      */
/* ------------------------------------------------------------------ */

function quake3Reply(playerLines: string[] = ['12 45 "racer"']): Buffer {
  const body = [
    "statusResponse",
    "\\sv_maxclients\\16\\mapname\\q3dm17\\sv_hostname\\Vigil Arena\\g_gametype\\0",
    ...playerLines,
    "",
  ].join("\n");
  return Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from(body, "utf8"),
  ]);
}

/* ------------------------------------------------------------------ */
/* The probe, per protocol                                             */
/* ------------------------------------------------------------------ */

describe("gamedigProbe over the Source protocol", () => {
  it("reports what an A2S_INFO reply said", async () => {
    const server = await serving(() => a2sInfoReply());

    const result = await gamedigProbe(context(server.port));

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      answered: true,
      serverName: "Sandbox",
      map: "gm_flatgrass",
      players: 7,
      maxPlayers: 24,
    });
  });

  it("speaks the same wire as the steam type, challenge included", async () => {
    // The two types share one codec on purpose: a second copy is a
    // second chance for them to disagree about what a server said.
    const challenge = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const server = await serving((request) =>
      request.length > 25
        ? a2sInfoReply()
        : Buffer.concat([
            Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41]),
            challenge,
          ]),
    );

    const result = await gamedigProbe(context(server.port));

    expect(result.facts.answered).toBe(true);
    expect(server.requests[1]?.subarray(25)).toEqual(challenge);
  });
});

describe("gamedigProbe over the Minecraft query protocol", () => {
  it("completes the handshake and reports the stat reply", async () => {
    const server = await serving(minecraftServer());

    const result = await gamedigProbe(
      context(server.port, { protocol: "minecraft" }),
    );

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      answered: true,
      serverName: "A Vigil Minecraft Server",
      map: "world",
      players: 3,
      maxPlayers: 20,
    });
  });

  it("carries the token the server issued into the stat request", async () => {
    const server = await serving(minecraftServer());

    await gamedigProbe(context(server.port, { protocol: "minecraft" }));

    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.readInt32BE(7)).toBe(TOKEN);
    // The session id has to survive the round trip, or a reply meant for
    // somebody else's query would be read as ours.
    expect(server.requests[1]?.subarray(3, 7)).toEqual(
      server.requests[0]?.subarray(3, 7),
    );
  });

  it("uses only the low nibble of each session byte", async () => {
    // The reference implementation masks the session id with
    // 0x0f0f0f0f and mangles anything else, so an id that used the whole
    // byte would come back changed and look like a stranger's reply.
    const server = await serving(minecraftServer());

    await gamedigProbe(context(server.port, { protocol: "minecraft" }));

    for (const byte of server.requests[0]?.subarray(3, 7) ?? []) {
      expect(byte & 0xf0).toBe(0);
    }
  });

  it("reports a server with the query port disabled as a transport failure", async () => {
    // `enable-query=false` is the common case, and the server simply
    // never answers. That is silence, not a wrong answer.
    const server = await serving(() => null);

    const result = await gamedigProbe(
      context(server.port, { protocol: "minecraft" }, { timeoutMs: 250 }),
    );

    expect(result.error).toBe("No reply within 250ms");
  });

  it("refuses a stat reply whose session id is not the one it sent", async () => {
    const server = await serving((request) =>
      request.readUInt8(2) === 0x09
        ? Buffer.concat([
            Buffer.from([0x09]),
            request.subarray(3, 7),
            cstring(String(TOKEN)),
          ])
        : Buffer.concat([
            Buffer.from([0x00, 0x0e, 0x0e, 0x0e, 0x0e]),
            cstring("Impostor"),
            cstring("SMP"),
            cstring("world"),
            cstring("1"),
            cstring("2"),
            Buffer.alloc(2),
            cstring("127.0.0.1"),
          ]),
    );

    const result = await gamedigProbe(
      context(server.port, { protocol: "minecraft" }),
    );

    // A reply that is not ours tells us nothing about our server.
    expect(result.facts.answered).toBe(false);
    expect(result.facts.serverName).toBeNull();
  });
});

describe("gamedigProbe over the id Tech 3 protocol", () => {
  it("reads the info string and counts the player lines", async () => {
    const server = await serving(() =>
      quake3Reply(['12 45 "racer"', '3 88 "sarge"']),
    );

    const result = await gamedigProbe(
      context(server.port, { protocol: "quake3" }),
    );

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      answered: true,
      serverName: "Vigil Arena",
      map: "q3dm17",
      // The info string carries the limit; occupancy is the number of
      // player lines, which is the only place it appears.
      players: 2,
      maxPlayers: 16,
    });
  });

  it("sends getstatus with the connectionless header", async () => {
    const server = await serving(() => quake3Reply());

    await gamedigProbe(context(server.port, { protocol: "quake3" }));

    expect(server.requests[0]?.subarray(0, 4)).toEqual(
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
    );
    expect(server.requests[0]?.subarray(4).toString("ascii")).toBe(
      "getstatus\n",
    );
  });

  it("reports an empty server as answered with nobody on it", async () => {
    const server = await serving(() => quake3Reply([]));

    const result = await gamedigProbe(
      context(server.port, { protocol: "quake3" }),
    );

    expect(result.facts).toMatchObject({ answered: true, players: 0 });
  });
});

/* ------------------------------------------------------------------ */
/* What every protocol shares                                          */
/* ------------------------------------------------------------------ */

describe("gamedigProbe, whatever the protocol", () => {
  it("reports the wrong protocol on a live port as an assertion failure", async () => {
    // An id Tech 3 server queried as if it were Source. Something is
    // listening and it answered, so this is an observation about the
    // port and not about the network — and the operator has to be sent
    // to the protocol picker rather than to the firewall.
    const server = await serving(() => quake3Reply());

    const result = await gamedigProbe(
      context(server.port, { protocol: "source" }),
    );
    const verdict = judge(gamedigSpec.assertions, context(0).config, result);

    expect(result.error).toBeNull();
    expect(result.facts.answered).toBe(false);
    expect(verdict.verdict).toBe("down");
    expect(verdict.failureClass).toBe("assertion");
    expect(verdict.error).toContain("this protocol could read");
  });

  it("retransmits once, so a lost datagram is not an outage", async () => {
    const server = await serving((_request, index) =>
      index === 0 ? null : quake3Reply(),
    );

    const result = await gamedigProbe(
      context(server.port, { protocol: "quake3" }, { timeoutMs: 400 }),
    );

    expect(result.facts.answered).toBe(true);
  });

  it("keeps both Minecraft round trips inside one timeout", async () => {
    // Each exchange gets what is left of the budget, not a fresh copy of
    // it: a server that stalls on the second must not double the time
    // the worker spends on this monitor.
    const server = await serving((request) =>
      request.readUInt8(2) === 0x09
        ? Buffer.concat([
            Buffer.from([0x09]),
            request.subarray(3, 7),
            cstring(String(TOKEN)),
          ])
        : null,
    );

    const startedAt = Date.now();
    const result = await gamedigProbe(
      context(server.port, { protocol: "minecraft" }, { timeoutMs: 300 }),
    );

    expect(result.error).toBe("No reply within 300ms");
    expect(Date.now() - startedAt).toBeLessThan(600);
  });

  it("judges a slow answer degraded once it passes the threshold", async () => {
    const server = await serving(() => quake3Reply());

    const result = await gamedigProbe(
      context(server.port, { protocol: "quake3" }),
    );
    const verdict = judge(
      gamedigSpec.assertions,
      { protocol: "quake3", degradedThresholdMs: 50 },
      { ...result, facts: { ...result.facts, responseTimeMs: 120 } },
    );

    expect(verdict.verdict).toBe("degraded");
    expect(verdict.error).toContain("120ms");
  });

  it("refuses a target that resolves into private space", async () => {
    const result = await gamedigProbe(
      context(27015, {}, { target: "localhost", allowPrivateTargets: false }),
    );

    expect(result).toMatchObject({
      error: "Target resolves to a private address",
      responseTimeMs: null,
    });
  });

  it("never dials the metadata endpoint, whatever the setting says", async () => {
    const result = await gamedigProbe(
      context(
        27015,
        {},
        { target: "metadata.google.internal", allowPrivateTargets: true },
      ),
    );

    expect(result.error).toBeTruthy();
    expect(result.facts.answered).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* The readers                                                         */
/* ------------------------------------------------------------------ */

describe("readBasicStat", () => {
  const session = [0x01, 0x02, 0x03, 0x04];

  it("stops rather than inventing fields when the reply is truncated", () => {
    const full = Buffer.concat([
      Buffer.from([0x00, ...session]),
      cstring("MOTD"),
      cstring("SMP"),
      cstring("world"),
      cstring("3"),
      cstring("20"),
    ]);
    for (let length = 5; length < full.length; length += 2) {
      expect(readBasicStat(full.subarray(0, length), session)).toBeNull();
    }
    expect(readBasicStat(full, session)).not.toBeNull();
  });

  it("refuses a count that is not a count", () => {
    const reply = Buffer.concat([
      Buffer.from([0x00, ...session]),
      cstring("MOTD"),
      cstring("SMP"),
      cstring("world"),
      cstring("many"),
      cstring("20"),
    ]);
    // Reported as unknown rather than as zero: a monitor that invents a
    // player count is worse than one that admits it did not get one.
    expect(readBasicStat(reply, session)?.players).toBeNull();
  });
});

describe("readStatusResponse", () => {
  it("refuses a datagram without the connectionless header", () => {
    expect(
      readStatusResponse(Buffer.from("statusResponse\n\\a\\b")),
    ).toBeNull();
  });

  it("refuses a reply to a command nobody sent", () => {
    const other = Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      Buffer.from("infoResponse\n\\sv_hostname\\x", "ascii"),
    ]);
    expect(readStatusResponse(other)).toBeNull();
  });

  it("reads the hostname key the older engines use instead", () => {
    const reply = Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      Buffer.from(
        "statusResponse\n\\hostname\\Old Engine\\mapname\\dm1\n",
        "ascii",
      ),
    ]);
    expect(readStatusResponse(reply)?.name).toBe("Old Engine");
  });

  it("tolerates an info string with a trailing key and no value", () => {
    const reply = Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      Buffer.from("statusResponse\n\\mapname\\dm1\\truncated\n", "ascii"),
    ]);
    expect(readStatusResponse(reply)).toMatchObject({ map: "dm1" });
  });
});

/* ------------------------------------------------------------------ */
/* The spec                                                            */
/* ------------------------------------------------------------------ */

describe("the gamedig spec", () => {
  it("holds no credential, because none of these queries authenticates", () => {
    expect(gamedigSpec.secretFields).toBeUndefined();
  });

  it("defaults an empty submission to the protocol most servers speak", () => {
    expect(gamedigStoredSchema.parse({})).toEqual({ protocol: "source" });
  });

  it("names the protocols it speaks when it is handed one it does not", () => {
    // The operator who reads this got here through an import or an API
    // call, so the message has to say what to put there instead.
    const parsed = gamedigStoredSchema.safeParse({ protocol: "teamspeak3" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("source");
    expect(parsed.error?.issues[0]?.message).toContain("minecraft");
    expect(parsed.error?.issues[0]?.message).toContain("quake3");
  });

  it("keeps the protocol across an edit that does not mention it", () => {
    // The data-loss shape 1.13.0 shipped: a form that renders none of a
    // type's fields sends `config: null`, and a writer that rebuilt the
    // blob from the submission would reset the protocol to Source.
    const stored = { protocol: "minecraft" };
    expect(mergeConfig(gamedigSpec, stored, undefined)).toEqual(stored);
    expect(
      monitorColumnsFor(
        gamedigSpec,
        { config: null, port: 25565 },
        { checkType: "gamedig", config: stored },
      ).config,
    ).toEqual(stored);
  });

  it("replaces the protocol when the operator changes it", () => {
    expect(
      mergeConfig(
        gamedigSpec,
        { protocol: "minecraft" },
        { protocol: "quake3" },
      ),
    ).toEqual({ protocol: "quake3" });
  });

  it("drops the blob when the monitor becomes a different type", () => {
    // A config belongs to the type that wrote it.
    expect(
      mergeConfig(gamedigSpec, { protocol: "quake3" }, undefined, "redis"),
    ).toEqual({ protocol: "source" });
  });

  it("falls back to a runnable check when the blob cannot be read", () => {
    for (const config of [null, undefined, {}, { protocol: 9 }, 42]) {
      const parsed = gamedigSpec.fromRow({
        checkType: "gamedig",
        url: "mc.example.com",
        port: 25565,
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
      });
      expect(parsed.protocol).toBe("source");
    }
  });

  it("reads the stored protocol back out of the row", () => {
    const config = gamedigSpec.fromRow({
      checkType: "gamedig",
      url: "mc.example.com",
      port: 25565,
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 10_000,
      degradedThresholdMs: 3_000,
      expectedStatusCode: null,
      bodyKeyword: null,
      keywordAbsent: false,
      tlsCheck: false,
      tlsWarnDays: 14,
      config: { protocol: "minecraft" },
    });
    expect(config).toEqual({
      protocol: "minecraft",
      degradedThresholdMs: 3_000,
    });
  });

  it("names the protocol in the target it prints", () => {
    // Two monitors on one host and port differ by nothing else, and this
    // string is what an incident email calls the thing that broke.
    expect(
      gamedigSpec.describeTarget("mc.example.com", 25565, {
        protocol: "minecraft",
        degradedThresholdMs: 3_000,
      }),
    ).toBe("mc.example.com:25565 (Minecraft (query))");
  });

  it("falls back to the protocol's conventional port when a row has none", () => {
    expect(
      gamedigSpec.describeTarget("q3.example.com", null, {
        protocol: "quake3",
        degradedThresholdMs: 3_000,
      }),
    ).toContain(":27960");
  });

  it("insists on a port, because the right one depends on the game", () => {
    expect(gamedigSpec.descriptor.port).toEqual({
      required: true,
      default: null,
    });
    // A required port with no default has to be asked for in the form,
    // or the type is uncreatable.
    expect(gamedigSpec.descriptor.form).toContain("port");
  });
});

/**
 * What the operator sees when they get the target field wrong.
 *
 * `schemas.ts` validates a target by delegating to exactly this schema,
 * so the message asserted here is the message the field shows.
 */
describe("the target field's validation and error state", () => {
  it("accepts a bare hostname", () => {
    expect(gamedigSpec.targetSchema.safeParse("mc.example.com").success).toBe(
      true,
    );
  });

  it("tells the operator to drop the scheme when they paste a URL", () => {
    const parsed = gamedigSpec.targetSchema.safeParse(
      "minecraft://mc.example.com",
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("hostname");
  });

  it("refuses a host with the port typed into it", () => {
    expect(
      gamedigSpec.targetSchema.safeParse("mc.example.com:25565").success,
    ).toBe(false);
  });

  it("still refuses the metadata endpoint", () => {
    expect(
      gamedigSpec.targetSchema.safeParse("metadata.google.internal").success,
    ).toBe(false);
  });
});
