// @covers-type: smtp, mqtt, mysql, mongodb
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { mongodbProbe } from "@/modules/monitors/types/probes/mongodb";
import { mqttProbe, readConnack } from "@/modules/monitors/types/probes/mqtt";
import {
  mysqlProbe,
  readHandshake,
} from "@/modules/monitors/types/probes/mysql";
import { readReply, smtpProbe } from "@/modules/monitors/types/probes/smtp";
import { mqttSpec } from "@/modules/monitors/types/specs/mqtt";

import { publicLookup } from "../probe-lookup";

/**
 * The four types that open a socket and read a greeting.
 *
 * They shipped with no tests at all, which the Definition-of-Done matrix
 * is what surfaced. Each exports a pure function where its comment says
 * the whole decision lives — `readReply`, `readConnack`, `readHandshake`
 * — and each of those is worth testing directly. But the failures these
 * probes actually meet are on the wire, and no pure-function test
 * reaches them: a server that sends its greeting in two packets, one
 * that answers on the right port with the wrong protocol, one that
 * accepts the connection and then says nothing at all.
 *
 * So every type here also dials a real server. The server is the point.
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

/** A TCP server that runs `speak` for each connection. */
async function serve(speak: (socket: net.Socket) => void): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on("error", () => undefined);
    speak(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

/**
 * The fixture listens on loopback, so the target is loopback. A hostname
 * would be resolved and dialled elsewhere, and the test would be
 * measuring a timeout rather than a protocol.
 */
function context<Config>(port: number, config: Config) {
  return {
    target: "127.0.0.1",
    port,
    config,
    timeoutMs: 2_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
    lookup: publicLookup,
  };
}

const smtpConfig = { security: "plain" as const, degradedThresholdMs: 3_000 };
const mqttConfig = {
  username: null,
  password: null,
  degradedThresholdMs: 3_000,
};
const sqlConfig = { degradedThresholdMs: 3_000 };

describe("smtp", () => {
  it("reads a single-line greeting", () => {
    const read = readReply("220 mail.example.com ESMTP\r\n");
    expect(read?.reply.code).toBe(220);
  });

  it("waits rather than guessing when the line is incomplete", () => {
    // No terminator yet. Returning a reply here would invent a greeting
    // out of half of one.
    expect(readReply("220 mail.exam")).toBeNull();
  });

  it("reads a multi-line greeting as one reply", () => {
    const read = readReply("220-first line\r\n220 last line\r\n");
    expect(read?.reply.code).toBe(220);
    expect(read?.rest).toBe("");
  });

  it("treats something that is not an SMTP reply as evidence, not a wait", () => {
    // An HTTP server on port 25, or SSH. Waiting for a terminator that
    // will never come would burn the whole timeout and report nothing.
    const read = readReply("SSH-2.0-OpenSSH_9.6\r\n");
    expect(read).not.toBeNull();
    expect(read?.reply.code).toBeNull();
  });

  /**
   * A server that greets and then answers EHLO, which is the whole
   * conversation this probe has. A fixture that greets and then goes
   * quiet is not a lenient version of this — it is a different scenario,
   * and it has its own test below.
   */
  async function smtpServer(greeting: string, ehlo = "250 ok\r\n") {
    return serve((socket) => {
      socket.write(greeting);
      socket.on("data", (chunk: Buffer) => {
        if (/^EHLO/i.test(chunk.toString("utf8"))) socket.write(ehlo);
      });
    });
  }

  it("reports the greeting from a real server", async () => {
    const port = await smtpServer("220 mail.example.com ESMTP Postfix\r\n");

    const result = await smtpProbe(context(port, smtpConfig));

    expect(result.error).toBeNull();
    expect(result.facts.greetingCode).toBe(220);
    expect(result.facts.ehloAccepted).toBe(true);
  });

  it("survives a greeting split across packets", async () => {
    const port = await serve((socket) => {
      socket.write("220 mail.exa");
      setTimeout(() => socket.write("mple.com ESMTP\r\n"), 20);
      socket.on("data", (chunk: Buffer) => {
        if (/^EHLO/i.test(chunk.toString("utf8"))) socket.write("250 ok\r\n");
      });
    });

    const result = await smtpProbe(context(port, smtpConfig));

    expect(result.facts.greetingCode).toBe(220);
  });

  it("reports a server that refuses in its greeting", async () => {
    // Not 220, so the probe never says EHLO — and `ehloAccepted` stays
    // absent rather than false, because a fact it did not observe is not
    // one it may report.
    const port = await smtpServer("554 no service here\r\n");

    const result = await smtpProbe(context(port, smtpConfig));

    expect(result.facts.greetingCode).toBe(554);
    expect(result.facts.ehloAccepted).toBeUndefined();
  });

  it("reports a connection that is accepted and then silent", async () => {
    const port = await serve(() => undefined);
    const result = await smtpProbe({
      ...context(port, smtpConfig),
      timeoutMs: 300,
    });
    expect(result.error).toBeTruthy();
  });
});

describe("mqtt", () => {
  it("reads an accepted CONNACK", () => {
    expect(readConnack(Buffer.from([0x20, 0x02, 0x00, 0x00]))).toEqual({
      state: "connack",
      returnCode: 0,
    });
  });

  it("waits for the rest of a partial packet", () => {
    expect(readConnack(Buffer.from([0x20]))).toEqual({ state: "partial" });
  });

  it("reads a 5.0 broker's longer CONNACK rather than calling it foreign", () => {
    // A 5.0 broker declining a 3.1.1 CONNECT appends properties. The
    // reason code is still where we look, and reading it beats reporting
    // a silence the broker never gave us.
    const read = readConnack(
      Buffer.from([0x20, 0x08, 0x00, 0x84, 0, 0, 0, 0, 0, 0]),
    );
    expect(read).toEqual({ state: "connack", returnCode: 0x84 });
  });

  it("refuses a first byte that is not a CONNACK", () => {
    expect(readConnack(Buffer.from([0x48, 0x54, 0x54, 0x50]))).toEqual({
      state: "not-mqtt",
    });
  });

  it("reports a broker that accepts the connection", async () => {
    const port = await serve((socket) => {
      socket.on("data", () =>
        socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00])),
      );
    });

    const result = await mqttProbe(context(port, mqttConfig));

    expect(result.error).toBeNull();
    expect(result.facts.connack).toBe(true);
    expect(result.facts.returnCode).toBe(0);
  });

  it("reports a broker that refuses the credentials", async () => {
    const port = await serve((socket) => {
      // 0x05 is "not authorised" in 3.1.1.
      socket.on("data", () =>
        socket.write(Buffer.from([0x20, 0x02, 0x00, 0x05])),
      );
    });

    const result = await mqttProbe(
      context(port, { ...mqttConfig, username: "u", password: "p" }),
    );

    // `connack` records that the broker answered with one, which it
    // did; the reason code is what says it refused.
    expect(result.facts.returnCode).toBe(5);
    expect(result.facts.returnMessage).toBeTruthy();
  });

  it("reports an HTTP server answering on the broker's port", async () => {
    const port = await serve((socket) => {
      socket.on("data", () => socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"));
    });

    const result = await mqttProbe(context(port, mqttConfig));

    // Whatever else it says, it must not say the broker accepted.
    expect(result.facts.connack).not.toBe(true);
  });

  it("declares its password as a secret", () => {
    expect(mqttSpec.secretFields).toContain("password");
  });
});

describe("mysql", () => {
  /** A protocol-10 handshake packet, as a server would send it. */
  function handshake(version: string): Buffer {
    const payload = Buffer.concat([
      Buffer.from([10]),
      Buffer.from(`${version}\0`, "latin1"),
      Buffer.alloc(44),
    ]);
    const header = Buffer.alloc(4);
    header.writeUIntLE(payload.length, 0, 3);
    header[3] = 0;
    return Buffer.concat([header, payload]);
  }

  it("waits until the whole packet has arrived", () => {
    expect(readHandshake(Buffer.from([10, 0]), 5)).toBeNull();
  });

  it("reads the server version out of the handshake", () => {
    const result = readHandshake(handshake("8.4.2"), 5);
    expect(result?.facts.serverVersion).toBe("8.4.2");
  });

  it("refuses a payload length no handshake would declare", () => {
    // The length is the first thing read, so a wrong-protocol server
    // whose first bytes happen to be large would otherwise make the
    // probe wait for a packet that never comes.
    const absurd = Buffer.from([0xff, 0xff, 0xff, 0x00, 10]);
    // Recorded as a fact rather than a transport error: the socket
    // worked, the bytes were wrong. Judging that is the runner's job.
    expect(readHandshake(absurd, 5)?.facts.handshakeOk).toBe(false);
  });

  it("reports the version from a real server", async () => {
    const port = await serve((socket) => {
      socket.write(handshake("8.4.2"));
    });

    const result = await mysqlProbe(context(port, sqlConfig));

    expect(result.error).toBeNull();
    expect(result.facts.serverVersion).toBe("8.4.2");
  });

  it("survives a handshake split across packets", async () => {
    const whole = handshake("8.4.2");
    const port = await serve((socket) => {
      socket.write(whole.subarray(0, 6));
      setTimeout(() => socket.write(whole.subarray(6)), 20);
    });

    const result = await mysqlProbe(context(port, sqlConfig));

    expect(result.facts.serverVersion).toBe("8.4.2");
  });

  it("reports a server speaking something else entirely", async () => {
    const port = await serve((socket) => {
      socket.write("HTTP/1.1 200 OK\r\n\r\n");
    });

    const result = await mysqlProbe(context(port, sqlConfig));

    expect(result.facts.handshakeOk).toBe(false);
  });
});

describe("mongodb", () => {
  it("reports a server that closes without a reply", async () => {
    const port = await serve((socket) => {
      socket.on("data", () => socket.destroy());
    });

    const result = await mongodbProbe(context(port, sqlConfig));

    expect(result.error).toBeTruthy();
  });

  it("reports a server answering with the wrong protocol", async () => {
    const port = await serve((socket) => {
      socket.on("data", () => socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"));
    });

    const result = await mongodbProbe(context(port, sqlConfig));

    expect(result.facts.helloOk).not.toBe(true);
  });

  it("reports a closed port rather than hanging", async () => {
    const result = await mongodbProbe({
      ...context(1, sqlConfig),
      timeoutMs: 500,
    });
    expect(result.error).toBeTruthy();
  });
});
