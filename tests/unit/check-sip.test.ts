// @covers-type: sip
import dgram from "node:dgram";
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import {
  buildOptionsRequest,
  readSipResponse,
  sipProbe,
} from "@/modules/monitors/types/probes/sip";
import {
  sipSpec,
  sipStoredSchema,
  type SipConfig,
} from "@/modules/monitors/types/specs/sip";

/**
 * SIP, against real SIP servers.
 *
 * Both fixtures below bind a real socket and speak the protocol: they
 * parse the OPTIONS request Vigil sends, echo the Via, From, To,
 * Call-ID and CSeq it carried — as RFC 3261 §8.2.6 requires of any UAS —
 * and answer with a status line. Nothing in the probe is stubbed, so a
 * change that breaks the framing, the retransmission schedule or the
 * request syntax fails here rather than against a customer's SBC.
 */

interface FakeSip {
  port: number;
  /** Every request the fixture received, in order. */
  requests: string[];
  close: () => Promise<void>;
}

const running: FakeSip[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

/** The headers a UAS has to copy back for a response to be well formed. */
function echoedHeaders(request: string): string[] {
  const wanted = ["via", "from", "to", "call-id", "cseq"];
  const lines = request.split(/\r?\n/);
  return lines.filter((line) => {
    const name = line.slice(0, line.indexOf(":")).trim().toLowerCase();
    return wanted.includes(name);
  });
}

/** A complete SIP response to `request`, with `status` as its status line. */
function respond(request: string, status: string, body = ""): string {
  return [
    `SIP/2.0 ${status}`,
    ...echoedHeaders(request),
    "Server: vigil-test-sip/1.0",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
}

/**
 * A UDP SIP endpoint. `reply` returns the datagrams to send back — an
 * empty array is a dropped request, which is what makes the
 * retransmission schedule observable.
 */
async function startUdpSip(
  reply: (request: string, index: number) => string[],
): Promise<FakeSip> {
  const socket = dgram.createSocket("udp4");
  const requests: string[] = [];
  socket.on("message", (message, remote) => {
    const text = message.toString("utf8");
    const index = requests.length;
    requests.push(text);
    for (const datagram of reply(text, index)) {
      // Back to the source address, which is what `rport` asks for.
      socket.send(datagram, remote.port, remote.address);
    }
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const address = socket.address();
  const server: FakeSip = {
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        socket.close(() => resolve());
      }),
  };
  running.push(server);
  return server;
}

/** A TCP SIP endpoint. The handler owns the socket, so it can stall or hang up. */
async function startTcpSip(
  handle: (request: string, socket: net.Socket) => void,
): Promise<FakeSip> {
  const requests: string[] = [];
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      requests.push(text);
      handle(text, socket);
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  const fake: FakeSip = {
    port: typeof address === "object" && address ? address.port : 0,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  running.push(fake);
  return fake;
}

function context(
  port: number,
  config: Partial<SipConfig> = {},
  timeoutMs = 3_000,
): ProbeContext<SipConfig> {
  return {
    target: "127.0.0.1",
    port,
    config: {
      transport: "udp",
      requestUser: null,
      expectedStatusCode: null,
      degradedThresholdMs: 3_000,
      ...config,
    },
    timeoutMs,
    allowPrivateTargets: true,
    fetchImpl: fetch,
  };
}

function verdict(result: Awaited<ReturnType<typeof sipProbe>>, ctx: SipConfig) {
  return judge(sipSpec.assertions, ctx, result);
}

describe("sipProbe over UDP", () => {
  it("reports the status line the server answered with", async () => {
    const server = await startUdpSip((request) => [respond(request, "200 OK")]);
    const ctx = context(server.port);

    const result = await sipProbe(ctx);

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      answered: true,
      statusCode: 200,
      statusText: "OK",
      server: "vigil-test-sip/1.0",
      requestsSent: 1,
    });
    expect(verdict(result, ctx.config).verdict).toBe("up");
  });

  it("sends an OPTIONS request a strict UAS would accept", async () => {
    const server = await startUdpSip((request) => [respond(request, "200 OK")]);

    await sipProbe(context(server.port));

    const request = server.requests[0] ?? "";
    expect(request.split("\r\n")[0]).toBe(
      `OPTIONS sip:127.0.0.1:${server.port} SIP/2.0`,
    );
    // The pieces RFC 3261 §8.1.1 makes mandatory, plus the branch magic
    // cookie and the rport that gets the answer back through NAT.
    expect(request).toMatch(
      /^Via: SIP\/2\.0\/UDP [\d.]+:\d+;branch=z9hG4bK[0-9a-f]+;rport$/m,
    );
    expect(request).toMatch(/^Max-Forwards: 70$/m);
    expect(request).toMatch(/^CSeq: 1 OPTIONS$/m);
    expect(request).toMatch(/^Call-ID: [0-9a-f]+@vigil\.invalid$/m);
    expect(request).toMatch(
      /^From: <sip:vigil@vigil\.invalid>;tag=[0-9a-f]+$/m,
    );
    expect(request).toMatch(/^Content-Length: 0$/m);
    // Headers end with a blank line; without it a UAS waits for more.
    expect(request.endsWith("\r\n\r\n")).toBe(true);
  });

  it("reports a refusal as down, naming the code the server sent", async () => {
    const server = await startUdpSip((request) => [
      respond(request, "404 Not Found"),
    ]);
    const ctx = context(server.port);

    const result = await sipProbe(ctx);

    // The code is a measurement — the server answered, so nothing about
    // the transport failed.
    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({ answered: true, statusCode: 404 });
    expect(verdict(result, ctx.config)).toMatchObject({
      verdict: "down",
      failureClass: "assertion",
      error: "Answered 404",
    });
  });

  it("accepts the status the operator said to expect", async () => {
    // A gateway that answers 405 to OPTIONS is a working gateway, and
    // the shared expected-status column is how an operator says so.
    const server = await startUdpSip((request) => [
      respond(request, "405 Method Not Allowed"),
    ]);
    const ctx = context(server.port, { expectedStatusCode: 405 });

    const result = await sipProbe(ctx);

    expect(verdict(result, ctx.config).verdict).toBe("up");
  });

  it("keeps waiting for the final response after a provisional one", async () => {
    // A proxy that is still working answers 100 Trying first. Reporting
    // that as the result would call a proxy healthy on the strength of
    // it having read the request.
    const server = await startUdpSip((request) => [
      respond(request, "100 Trying"),
      respond(request, "200 OK"),
    ]);
    const ctx = context(server.port);

    const result = await sipProbe(ctx);

    expect(result.facts.statusCode).toBe(200);
    expect(verdict(result, ctx.config).verdict).toBe("up");
  });

  it("retransmits when the first request is lost", async () => {
    // One dropped datagram on an otherwise healthy link must not open an
    // incident — which is the whole reason RFC 3261 gives a non-INVITE
    // transaction a retransmission timer.
    const server = await startUdpSip((request, index) =>
      index === 0 ? [] : [respond(request, "200 OK")],
    );
    const ctx = context(server.port);

    const result = await sipProbe(ctx);

    expect(result.facts).toMatchObject({ answered: true, statusCode: 200 });
    expect(result.facts.requestsSent).toBe(2);
    expect(verdict(result, ctx.config).verdict).toBe("up");
  });

  it("reports a reply that is not SIP without inventing a status code", async () => {
    const server = await startUdpSip(() => ["nothing to see here\r\n\r\n"]);
    const ctx = context(server.port);

    const result = await sipProbe(ctx);

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({ answered: false, statusCode: null });
    expect(verdict(result, ctx.config)).toMatchObject({
      verdict: "down",
      error: "Something answered on this port, but not with a SIP response",
    });
  });

  it("times out when nothing answers, and says how many requests it sent", async () => {
    const server = await startUdpSip(() => []);
    const ctx = context(server.port, {}, 1_200);

    const result = await sipProbe(ctx);

    expect(result.error).toMatch(
      /^Timed out after 1200ms \(\d+ requests sent\)$/,
    );
    expect(verdict(result, ctx.config)).toMatchObject({
      verdict: "down",
      failureClass: "transport",
    });
  });

  it("refuses a private target when the policy does not allow one", async () => {
    const result = await sipProbe({
      ...context(5060),
      target: "localhost",
      allowPrivateTargets: false,
    });

    expect(result.error).toBe("Target resolves to a private address");
    expect(result.facts).toEqual({});
  });
});

describe("sipProbe over TCP", () => {
  it("reads the status line over a stream transport", async () => {
    const server = await startTcpSip((request, socket) => {
      socket.write(respond(request, "200 OK"));
    });
    const ctx = context(server.port, { transport: "tcp" });

    const result = await sipProbe(ctx);

    expect(result.facts).toMatchObject({ answered: true, statusCode: 200 });
    expect(verdict(result, ctx.config).verdict).toBe("up");
    // The transport belongs in the Request-URI, which is how the far end
    // knows which listener to answer on.
    expect(server.requests[0]).toContain(
      `OPTIONS sip:127.0.0.1:${server.port};transport=tcp SIP/2.0`,
    );
    expect(server.requests[0]).toMatch(/^Via: SIP\/2\.0\/TCP /m);
  });

  it("reassembles a response split across segments", async () => {
    // TCP is a stream: a status line is entitled to arrive without its
    // headers, and a reader that parsed the first chunk alone would call
    // a healthy server unreachable.
    const server = await startTcpSip((request, socket) => {
      const message = respond(request, "200 OK");
      socket.write(message.slice(0, 12));
      setTimeout(() => socket.write(message.slice(12)), 20);
    });
    const ctx = context(server.port, { transport: "tcp" });

    const result = await sipProbe(ctx);

    expect(result.facts).toMatchObject({ answered: true, statusCode: 200 });
  });

  it("skips a provisional response that shares a segment with the final one", async () => {
    const server = await startTcpSip((request, socket) => {
      socket.write(respond(request, "100 Trying") + respond(request, "200 OK"));
    });
    const ctx = context(server.port, { transport: "tcp" });

    const result = await sipProbe(ctx);

    expect(result.facts.statusCode).toBe(200);
  });

  it("advances past a provisional response that carries a body", async () => {
    // Content-Length is what frames a message on a stream. Ignoring it
    // would leave the body of the 100 in front of the 200 and parse the
    // wrong bytes as a status line.
    const server = await startTcpSip((request, socket) => {
      socket.write(
        respond(request, "100 Trying", "still working on it") +
          respond(request, "200 OK"),
      );
    });
    const ctx = context(server.port, { transport: "tcp" });

    const result = await sipProbe(ctx);

    expect(result.facts.statusCode).toBe(200);
  });

  it("reports a server that takes the connection and hangs up", async () => {
    const server = await startTcpSip((_request, socket) => socket.destroy());
    const ctx = context(server.port, { transport: "tcp" });

    const result = await sipProbe(ctx);

    expect(result.error).toBeNull();
    expect(result.facts.answered).toBe(false);
    expect(verdict(result, ctx.config).verdict).toBe("down");
  });

  it("reports a refused connection as a transport failure", async () => {
    const server = await startTcpSip(() => undefined);
    const port = server.port;
    await server.close();
    running.splice(running.indexOf(server), 1);

    const result = await sipProbe(context(port, { transport: "tcp" }));

    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});

describe("readSipResponse", () => {
  it("waits for the rest of a message that is still arriving on a stream", () => {
    expect(
      readSipResponse(Buffer.from("SIP/2.0 200 OK\r\nVia: x"), true),
    ).toEqual({ state: "partial" });
  });

  it("waits for a body the headers promised", () => {
    const head = "SIP/2.0 200 OK\r\nContent-Length: 10\r\n\r\n";
    expect(readSipResponse(Buffer.from(head), true)).toEqual({
      state: "partial",
    });
    expect(
      readSipResponse(Buffer.from(`${head}0123456789`), true),
    ).toMatchObject({ state: "response", statusCode: 200 });
  });

  it("reports the length of the message it read, so a reader can advance", () => {
    const message = "SIP/2.0 180 Ringing\r\nContent-Length: 3\r\n\r\nabc";
    const read = readSipResponse(Buffer.from(message), true);
    expect(read).toMatchObject({ state: "response", length: message.length });
  });

  it("refuses to read a datagram as SIP when it is not", () => {
    // An HTTP server on 5060 is a real and confusing configuration; it
    // must not be reported as a SIP element answering strangely.
    expect(
      readSipResponse(Buffer.from("HTTP/1.1 200 OK\r\n\r\n"), false),
    ).toEqual({ state: "not-sip" });
  });

  it("does not wait forever for a datagram that will never grow", () => {
    // A datagram is the whole message. Answering `partial` here would
    // mean waiting for a continuation that UDP cannot deliver.
    expect(readSipResponse(Buffer.from("SIP/2.0 200 OK"), false)).toEqual({
      state: "not-sip",
    });
  });

  it("tolerates the bare LF that real stacks emit", () => {
    expect(
      readSipResponse(
        Buffer.from("SIP/2.0 200 OK\nServer: asterisk\n\n"),
        false,
      ),
    ).toMatchObject({ state: "response", statusCode: 200, server: "asterisk" });
  });

  it("reads a User-Agent when there is no Server header", () => {
    // Gateways answer OPTIONS with one or the other; reading only one
    // leaves the fact empty for half the estate.
    expect(
      readSipResponse(
        Buffer.from("SIP/2.0 200 OK\r\nUser-Agent: FPBX-16\r\n\r\n"),
        false,
      ),
    ).toMatchObject({ server: "FPBX-16" });
  });

  it("frames on the first Content-Length when a peer sends two", () => {
    const message =
      "SIP/2.0 200 OK\r\nContent-Length: 0\r\nContent-Length: 99\r\n\r\n";
    expect(readSipResponse(Buffer.from(message), true)).toMatchObject({
      state: "response",
      length: message.length,
    });
  });
});

describe("buildOptionsRequest", () => {
  it("brackets an IPv6 sent-by, which an unbracketed one would make ambiguous", () => {
    const request = buildOptionsRequest({
      host: "sip.example.com",
      port: 5060,
      config: { requestUser: null, transport: "udp" },
      localHost: "2001:db8::5",
      localPort: 41234,
    });
    expect(request).toContain("Via: SIP/2.0/UDP [2001:db8::5]:41234;");
  });

  it("addresses the user the monitor names", () => {
    const request = buildOptionsRequest({
      host: "sip.example.com",
      port: 5060,
      config: { requestUser: "pstn", transport: "udp" },
      localHost: "192.0.2.9",
      localPort: 5060,
    });
    expect(request.split("\r\n")[0]).toBe(
      "OPTIONS sip:pstn@sip.example.com:5060 SIP/2.0",
    );
  });
});

describe("sip spec", () => {
  it("names the transport in the line an incident email prints", () => {
    const config = sipSpec.fromRow({
      checkType: "sip",
      url: "sip.example.com",
      port: 5060,
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 10_000,
      degradedThresholdMs: 3_000,
      expectedStatusCode: null,
      bodyKeyword: null,
      keywordAbsent: false,
      tlsCheck: false,
      tlsWarnDays: 14,
      config: { transport: "tcp", requestUser: "pstn" },
    });
    expect(sipSpec.describeTarget("sip.example.com", 5060, config)).toBe(
      "sip:pstn@sip.example.com:5060;transport=tcp over TCP",
    );
  });

  it("takes the expected status from the shared column, not the blob", () => {
    const config = sipSpec.fromRow({
      checkType: "sip",
      url: "sip.example.com",
      port: 5060,
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 10_000,
      degradedThresholdMs: 3_000,
      expectedStatusCode: 486,
      bodyKeyword: null,
      keywordAbsent: false,
      tlsCheck: false,
      tlsWarnDays: 14,
      config: null,
    });
    expect(config).toMatchObject({
      expectedStatusCode: 486,
      transport: "udp",
      requestUser: null,
    });
  });

  it("refuses a user part that would inject headers into the request", () => {
    // The value is interpolated into a CRLF-terminated request line. A
    // user containing one would append headers of its own choosing.
    expect(
      sipStoredSchema.safeParse({ requestUser: "bob\r\nSubject: hi" }).success,
    ).toBe(false);
    expect(
      sipStoredSchema.safeParse({ requestUser: "bob smith" }).success,
    ).toBe(false);
    expect(sipStoredSchema.safeParse({ requestUser: "pstn-1" }).success).toBe(
      true,
    );
  });

  it("refuses a transport it cannot speak", () => {
    expect(sipStoredSchema.safeParse({ transport: "tls" }).success).toBe(false);
  });
});
