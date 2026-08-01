// @covers-type: ntp
import dgram from "node:dgram";

import { afterEach, describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import { ntpProbe } from "@/modules/monitors/types/probes/ntp";
import { ntpSpec, ntpStoredSchema } from "@/modules/monitors/types/specs/ntp";
import type { NtpConfig } from "@/modules/monitors/types/specs/ntp";

/**
 * The `ntp` check, against a real time server.
 *
 * The fixture below writes NTP packets byte by byte rather than reusing
 * the probe's own encoder: a check that decodes its own encoder proves
 * only that the two agree. What has to hold is that the probe reads a
 * packet built the way RFC 5905 §7.3 describes one — the timestamps in
 * particular, which are a 1900 epoch and a binary fraction, and are the
 * one place a monitor can be confidently, silently wrong by 70 years.
 */

const NTP_PACKET_BYTES = 48;
const NTP_EPOCH_OFFSET_SECONDS = 2_208_988_800;
const FRACTION_SCALE = 4_294_967_296;
const ORIGIN_OFFSET = 24;
const RECEIVE_OFFSET = 32;
const TRANSMIT_OFFSET = 40;

function writeNtpTimestamp(
  packet: Buffer,
  offset: number,
  unixMs: number,
): void {
  const seconds = Math.floor(unixMs / 1000);
  packet.writeUInt32BE(seconds + NTP_EPOCH_OFFSET_SECONDS, offset);
  packet.writeUInt32BE(
    Math.round(((unixMs - seconds * 1000) / 1000) * FRACTION_SCALE),
    offset + 4,
  );
}

interface ServerOptions {
  stratum?: number;
  leapIndicator?: number;
  mode?: number;
  version?: number;
  referenceId?: string;
  /** How far the server's clock is ahead of this machine's, in ms. */
  clockSkewMs?: number;
  /** Answer with something that is not a 48-byte packet. */
  replyWith?: Buffer;
  /** Answer without echoing the client's transmit timestamp. */
  breakOriginEcho?: boolean;
  /** Answer nothing at all. */
  silent?: boolean;
}

interface Fixture {
  port: number;
  received: Buffer[];
  close: () => Promise<void>;
}

async function ntpServer(options: ServerOptions = {}): Promise<Fixture> {
  const socket = dgram.createSocket("udp4");
  const received: Buffer[] = [];

  socket.on("message", (message, from) => {
    received.push(Buffer.from(message));
    if (options.silent) return;
    if (options.replyWith) {
      socket.send(options.replyWith, from.port, from.address);
      return;
    }

    const skew = options.clockSkewMs ?? 0;
    const reply = Buffer.alloc(NTP_PACKET_BYTES);
    reply.writeUInt8(
      ((options.leapIndicator ?? 0) << 6) |
        ((options.version ?? 4) << 3) |
        (options.mode ?? 4),
      0,
    );
    reply.writeUInt8(options.stratum ?? 2, 1);
    // Poll and precision, as a server that has been running a while
    // reports them: 2^6 seconds and 2^-20 of one.
    reply.writeUInt8(6, 2);
    reply.writeInt8(-20, 3);
    Buffer.from(
      (options.referenceId ?? "\x7f\x00\x00\x01").padEnd(4, "\0"),
      "latin1",
    ).copy(reply, 12);

    // The origin timestamp is a verbatim copy of what the client sent.
    if (options.breakOriginEcho) {
      writeNtpTimestamp(reply, ORIGIN_OFFSET, Date.now() - 60_000);
    } else {
      message.copy(reply, ORIGIN_OFFSET, TRANSMIT_OFFSET, TRANSMIT_OFFSET + 8);
    }
    writeNtpTimestamp(reply, RECEIVE_OFFSET, Date.now() + skew);
    writeNtpTimestamp(reply, TRANSMIT_OFFSET, Date.now() + skew);
    socket.send(reply, from.port, from.address);
  });

  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return {
    port: socket.address().port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        socket.close(() => resolve());
      }),
  };
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function serve(options: ServerOptions = {}): Promise<Fixture> {
  const fixture = await ntpServer(options);
  fixtures.push(fixture);
  return fixture;
}

function configFor(overrides: Partial<NtpConfig> = {}): NtpConfig {
  return { maxOffsetMs: 1_000, degradedThresholdMs: 3_000, ...overrides };
}

function context(
  port: number,
  config: NtpConfig = configFor(),
  overrides: Partial<ProbeContext<NtpConfig>> = {},
): ProbeContext<NtpConfig> {
  return {
    target: "127.0.0.1",
    port,
    config,
    timeoutMs: 2_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
    ...overrides,
  };
}

describe("the ntp probe", () => {
  it("asks as a version 4 client and reports what the server answers", async () => {
    const server = await serve({ stratum: 1, referenceId: "GPS" });

    const result = await ntpProbe(context(server.port));

    const request = server.received[0];
    expect(request?.length).toBe(NTP_PACKET_BYTES);
    // Leap 0, version 4, mode 3 — the only thing a client is supposed
    // to send, and the byte a server checks first.
    expect(request?.readUInt8(0)).toBe(0x23);
    expect(result.error).toBeNull();
    expect(result.facts.stratum).toBe(1);
    expect(result.facts.referenceId).toBe("GPS");
    expect(result.facts.leapIndicator).toBe(0);
    expect(judge(ntpSpec.assertions, configFor(), result).verdict).toBe("up");
  });

  it("reads the upstream address a secondary server is following", async () => {
    const server = await serve({ stratum: 3, referenceId: "\x0a\x01\x02\x03" });

    const result = await ntpProbe(context(server.port));

    expect(result.facts.referenceId).toBe("10.1.2.3");
  });

  it("measures a server whose clock is ahead as a positive offset", async () => {
    const server = await serve({ clockSkewMs: 5_000 });

    const result = await ntpProbe(context(server.port));
    const offset = result.facts.offsetMs;

    // Loopback, so the round trip is a millisecond or two; the tolerance
    // here is for the scheduler, not for the arithmetic.
    expect(typeof offset).toBe("number");
    expect(Math.abs(Number(offset) - 5_000)).toBeLessThan(200);
    expect(Number(result.facts.delayMs)).toBeGreaterThanOrEqual(0);
  });

  it("reports a clock outside the tolerance as degraded, never as down", async () => {
    // Whose clock is wrong is exactly what this check cannot tell, since
    // the reference is the machine Vigil runs on. Paging for it would
    // page for every time server at once the day this host drifts.
    const server = await serve({ clockSkewMs: 5_000 });

    const result = await ntpProbe(context(server.port));
    const verdict = judge(ntpSpec.assertions, configFor(), result);

    expect(verdict.verdict).toBe("degraded");
    expect(verdict.error).toMatch(
      /The server's clock is \d+ms ahead of Vigil's, over the 1000ms tolerance/,
    );
  });

  it("accepts a clock inside the operator's own tolerance", async () => {
    const server = await serve({ clockSkewMs: 5_000 });
    const config = configFor({ maxOffsetMs: 30_000 });

    const result = await ntpProbe(context(server.port, config));

    expect(judge(ntpSpec.assertions, config, result).verdict).toBe("up");
  });

  it("reports a server that is not synchronised to a reference clock as down", async () => {
    const server = await serve({ stratum: 16 });

    const result = await ntpProbe(context(server.port));
    const verdict = judge(ntpSpec.assertions, configFor(), result);

    expect(verdict).toMatchObject({
      verdict: "down",
      failureClass: "assertion",
      error: "The server is not synchronised to a reference clock (stratum 16)",
    });
  });

  it("reports a server raising the leap alarm as down", async () => {
    const server = await serve({ leapIndicator: 3 });

    const result = await ntpProbe(context(server.port));

    expect(judge(ntpSpec.assertions, configFor(), result)).toMatchObject({
      verdict: "down",
      error: "The server reports its own clock as unsynchronised",
    });
  });

  it("reports a kiss-o'-death as misconfigured rather than as an outage", async () => {
    // `RATE` means the check interval is too aggressive for this
    // server's policy. The server is working perfectly, and paging for
    // it would page for a setting.
    const server = await serve({ stratum: 0, referenceId: "RATE" });

    const result = await ntpProbe(context(server.port));

    expect(result.unavailable).toBe(
      "The server sent a kiss-o'-death (RATE): it is refusing to answer this client",
    );
    expect(judge(ntpSpec.assertions, configFor(), result)).toMatchObject({
      verdict: "indeterminate",
      failureClass: "misconfigured",
    });
  });

  it("ignores a reply that does not echo the timestamp it was sent", async () => {
    // On a protocol with no sequence numbers the echoed timestamp is the
    // only thing tying a datagram to this request. Measuring a stale one
    // would report a clock offset the size of the check interval.
    const server = await serve({ breakOriginEcho: true });

    const result = await ntpProbe(
      context(server.port, configFor(), {
        timeoutMs: 300,
      }),
    );

    expect(result.error).toBe("No reply within 300ms");
  });

  it("ignores a datagram too short to be an NTP packet", async () => {
    const server = await serve({ replyWith: Buffer.from("nope", "utf8") });

    const result = await ntpProbe(
      context(server.port, configFor(), {
        timeoutMs: 300,
      }),
    );

    expect(result.error).toBe("No reply within 300ms");
  });

  it("refuses to read another association's packet as an answer", async () => {
    // Mode 3 is a client, not a server: this is someone else's request
    // arriving from the address we are watching, and its timestamps
    // describe a conversation Vigil is not part of.
    const server = await serve({ mode: 3 });

    const result = await ntpProbe(context(server.port));

    expect(result.error).toBe(
      "The reply was not an NTP server packet (48 bytes)",
    );
  });

  it("reports silence as no reply", async () => {
    const server = await serve({ silent: true });

    const result = await ntpProbe(
      context(server.port, configFor(), {
        timeoutMs: 250,
      }),
    );

    expect(result).toMatchObject({
      error: "No reply within 250ms",
      responseTimeMs: null,
    });
  });

  it("refuses a target that resolves to a private address", async () => {
    const result = await ntpProbe(
      context(123, configFor(), {
        target: "localhost",
        allowPrivateTargets: false,
      }),
    );

    expect(result.error).toBe("Target resolves to a private address");
  });
});

describe("the ntp check's configuration", () => {
  it("accepts an empty submission and defaults the tolerance to a second", () => {
    expect(ntpStoredSchema.parse({})).toEqual({ maxOffsetMs: 1_000 });
  });

  it("refuses a tolerance of nothing", () => {
    expect(ntpStoredSchema.safeParse({ maxOffsetMs: 0 }).success).toBe(false);
  });

  it("names the port it watched, default included", () => {
    // An estate running a second time service on 1123 is common enough
    // that an incident email without the port gets replied to.
    expect(ntpSpec.describeTarget("time.example.com", null, configFor())).toBe(
      "time.example.com:123",
    );
  });

  it("survives a config blob written by an older build", () => {
    expect(
      ntpSpec.fromRow({
        checkType: "ntp",
        url: "time.example.com",
        port: 123,
        method: "GET",
        intervalSeconds: 60,
        timeoutMs: 10_000,
        degradedThresholdMs: 2_500,
        expectedStatusCode: null,
        bodyKeyword: null,
        keywordAbsent: false,
        tlsCheck: false,
        tlsWarnDays: 14,
        config: null,
      }),
    ).toEqual({ maxOffsetMs: 1_000, degradedThresholdMs: 2_500 });
  });
});
