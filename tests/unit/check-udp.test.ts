// @covers-type: udp
import dgram from "node:dgram";

import { afterEach, describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import { udpProbe } from "@/modules/monitors/types/probes/udp";
import { udpSpec, udpStoredSchema } from "@/modules/monitors/types/specs/udp";
import type { UdpConfig } from "@/modules/monitors/types/specs/udp";

/**
 * The `udp` check, against a real datagram server.
 *
 * Every test here dials a socket this file binds. A mocked `dgram`
 * would prove that the probe calls the functions the probe calls; what
 * needs proving is that a payload leaves this process, a reply comes
 * back, and the bytes on the wire are the ones the operator asked for.
 */

interface Fixture {
  port: number;
  /** Every datagram the server received, in arrival order. */
  received: Buffer[];
  close: () => Promise<void>;
}

/**
 * A UDP server on loopback. `answer` returns the datagram to send back,
 * or null to stay silent — which is a service's most common answer to a
 * payload it does not recognise, and the case UDP checks exist to
 * survive.
 */
async function udpServer(
  answer: (message: Buffer) => Buffer | null,
): Promise<Fixture> {
  const socket = dgram.createSocket("udp4");
  const received: Buffer[] = [];

  socket.on("message", (message, from) => {
    received.push(Buffer.from(message));
    const reply = answer(message);
    if (reply !== null) socket.send(reply, from.port, from.address);
  });

  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const address = socket.address();

  return {
    port: address.port,
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

async function serve(
  answer: (message: Buffer) => Buffer | null,
): Promise<Fixture> {
  const fixture = await udpServer(answer);
  fixtures.push(fixture);
  return fixture;
}

function configFor(overrides: Partial<UdpConfig> = {}): UdpConfig {
  return {
    payload: "",
    payloadEncoding: "text",
    expectedResponse: null,
    degradedThresholdMs: 3_000,
    ...overrides,
  };
}

function context(
  port: number | null,
  config: UdpConfig,
  overrides: Partial<ProbeContext<UdpConfig>> = {},
): ProbeContext<UdpConfig> {
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

describe("the udp probe", () => {
  it("sends the configured payload and reports the reply it gets back", async () => {
    const server = await serve((message) =>
      Buffer.from(`echo:${message.toString("utf8")}`, "utf8"),
    );
    const config = configFor({ payload: "STATUS\n" });

    const result = await udpProbe(context(server.port, config));

    expect(
      server.received.map((datagram) => datagram.toString("utf8")),
    ).toEqual(["STATUS\n"]);
    expect(result.error).toBeNull();
    expect(result.facts.replyPreview).toBe("echo:STATUS.");
    expect(result.facts.replyBytes).toBe(12);
    expect(typeof result.responseTimeMs).toBe("number");
  });

  it("says nothing about a matching reply when the operator asked for no content", async () => {
    // The fact and its assertion switch on together. A `responseMatches`
    // of `true` on a check that has no expectation would read as a
    // comparison somebody made.
    const server = await serve(() => Buffer.from("anything", "utf8"));

    const result = await udpProbe(context(server.port, configFor()));

    expect("responseMatches" in result.facts).toBe(false);
  });

  it("reports the reply as matching when it carries the expected text", async () => {
    const server = await serve(() => Buffer.from("+OK ready", "utf8"));
    const config = configFor({ payload: "PING", expectedResponse: "ready" });

    const result = await udpProbe(context(server.port, config));

    expect(result.facts.responseMatches).toBe(true);
    expect(judge(udpSpec.assertions, config, result).verdict).toBe("up");
  });

  it("judges a monitor down when the reply does not carry the expected text", async () => {
    const server = await serve(() => Buffer.from("-ERR busy", "utf8"));
    const config = configFor({ payload: "PING", expectedResponse: "ready" });

    const result = await udpProbe(context(server.port, config));
    const verdict = judge(udpSpec.assertions, config, result);

    expect(result.facts.responseMatches).toBe(false);
    expect(verdict.verdict).toBe("down");
    expect(verdict.failureClass).toBe("assertion");
    expect(verdict.error).toBe('The reply did not contain "ready"');
  });

  it("sends a hex payload as bytes and matches the reply as hex", async () => {
    // The case the encoding setting exists for: a binary protocol, where
    // neither the question nor the answer is text.
    const server = await serve((message) =>
      message.equals(Buffer.from([0x00, 0xff, 0x2a]))
        ? Buffer.from([0xde, 0xad, 0xbe, 0xef])
        : Buffer.from([0x00]),
    );
    const config = configFor({
      payload: "00 ff 2a",
      payloadEncoding: "hex",
      expectedResponse: "DEADBEEF",
    });

    const result = await udpProbe(context(server.port, config));

    expect(result.facts.responseMatches).toBe(true);
    expect(result.facts.replyBytes).toBe(4);
  });

  it("keeps a binary reply printable rather than mangling it into replacement characters", async () => {
    const server = await serve(() =>
      Buffer.from([0x01, 0x41, 0x00, 0x42, 0xff]),
    );

    const result = await udpProbe(context(server.port, configFor()));

    expect(result.facts.replyPreview).toBe(".A.B.");
  });

  it("reports silence as no reply, with no measurement to judge", async () => {
    // A service that will not answer this payload, a firewall that drops
    // rather than rejects, and a lost datagram are indistinguishable
    // from here. Reporting a response time for any of them would be
    // inventing one.
    const server = await serve(() => null);
    const config = configFor({ payload: "hello" });

    const result = await udpProbe(
      context(server.port, config, { timeoutMs: 300 }),
    );

    expect(result.error).toBe("No reply within 300ms");
    expect(result.responseTimeMs).toBeNull();
    expect(result.facts).toEqual({});
    expect(judge(udpSpec.assertions, config, result)).toMatchObject({
      verdict: "down",
      failureClass: "transport",
    });
  });

  it("reports a port nothing is bound to as nothing listening", async () => {
    const server = await udpServer(() => null);
    const port = server.port;
    await server.close();

    const result = await udpProbe(context(port, configFor()));

    expect(result.error).toBe(
      `Nothing is listening on ${port}/udp (ICMP port unreachable)`,
    );
  });

  it("refuses a target that resolves to a private address", async () => {
    const result = await udpProbe(
      context(53, configFor(), {
        target: "localhost",
        allowPrivateTargets: false,
      }),
    );

    expect(result.error).toBe("Target resolves to a private address");
  });

  it("reports a monitor with no port as misconfigured rather than down", async () => {
    const result = await udpProbe(context(null, configFor()));

    expect(result.unavailable).toBe("This monitor has no UDP port configured");
    expect(judge(udpSpec.assertions, configFor(), result)).toMatchObject({
      verdict: "indeterminate",
      failureClass: "misconfigured",
    });
  });

  it("reports a stored payload over the datagram limit as misconfigured", async () => {
    // The schema refuses this, so it can only come from a row written by
    // hand — and a fragmented probe measures the network's reassembly
    // rather than the service.
    const server = await serve(() => Buffer.from("pong"));
    const config = configFor({ payload: "x".repeat(2_000) });

    const result = await udpProbe(context(server.port, config));

    expect(result.unavailable).toContain("over the 1024-byte limit");
    expect(server.received).toEqual([]);
  });
});

describe("the udp check's configuration", () => {
  it("accepts an empty submission, so the form can create one", () => {
    const parsed = udpStoredSchema.parse({});
    expect(parsed).toEqual({
      payload: "",
      payloadEncoding: "text",
      expectedResponse: null,
    });
  });

  it("refuses a hex payload that is not whole bytes", () => {
    const parsed = udpStoredSchema.safeParse({
      payload: "00f",
      payloadEncoding: "hex",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      "Enter the payload as pairs of hex digits, like 00ff2a.",
    );
  });

  it("refuses a payload larger than one datagram should carry", () => {
    const parsed = udpStoredSchema.safeParse({ payload: "x".repeat(2_000) });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      "The payload cannot exceed 1024 bytes.",
    );
  });

  it("keeps the whitespace a text payload ends with", () => {
    // A trailing newline is the terminator half the text protocols on
    // this planet use; trimming it produces a probe the server waits
    // forever to finish.
    expect(udpStoredSchema.parse({ payload: "STATUS\n" }).payload).toBe(
      "STATUS\n",
    );
  });

  it("reads an empty expected response as no expectation at all", () => {
    expect(
      udpStoredSchema.parse({ expectedResponse: "" }).expectedResponse,
    ).toBe(null);
  });

  it("names the transport when it describes the target", () => {
    // "dns.example.com:53" reads as TCP to anyone who has written a
    // firewall rule, and this string goes into incident emails.
    expect(udpSpec.describeTarget("dns.example.com", 53, configFor())).toBe(
      "dns.example.com:53/udp",
    );
  });

  it("survives a config blob written by an older build", () => {
    const config = udpSpec.fromRow({
      checkType: "udp",
      url: "dns.example.com",
      port: 53,
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 10_000,
      degradedThresholdMs: 2_500,
      expectedStatusCode: null,
      bodyKeyword: null,
      keywordAbsent: false,
      tlsCheck: false,
      tlsWarnDays: 14,
      config: { nonsense: true },
    });

    expect(config).toEqual({
      payload: "",
      payloadEncoding: "text",
      expectedResponse: null,
      degradedThresholdMs: 2_500,
    });
  });
});
