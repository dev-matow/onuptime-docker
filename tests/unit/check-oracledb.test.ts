// @covers-type: oracledb
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import {
  decodeVersion,
  oracledbProbe,
} from "@/modules/monitors/types/probes/oracledb";
import {
  oracledbSpec,
  parseOracleConnection,
  type OracleConfig,
} from "@/modules/monitors/types/specs/oracledb";

/**
 * An Oracle listener that exists only on loopback.
 *
 * The fixture speaks TNS rather than standing in for it: it reads the
 * connect packet's header, takes the connect descriptor from the offset
 * and length that header declares, and answers ACCEPT or REFUSE
 * depending on the service name it finds inside. A mocked probe would
 * only prove the probe's own beliefs about the protocol; this proves the
 * bytes.
 */

const HEADER_BYTES = 8;
const PACKET_CONNECT = 1;
const PACKET_ACCEPT = 2;
const PACKET_REFUSE = 4;
const PACKET_REDIRECT = 5;
const PACKET_RESEND = 11;

interface Observed {
  /** Every connect descriptor the listener was sent, in order. */
  descriptors: string[];
}

interface FakeListener {
  port: number;
  observed: Observed;
  close: () => Promise<void>;
}

interface FakeOptions {
  /** The service this listener knows about. */
  serviceName?: string;
  /** Hand the connection on instead of accepting it outright. */
  redirect?: boolean;
  /** Ask for the connect packet once before answering. */
  askForResend?: boolean;
  /** Accept the socket and then say nothing at all. */
  silent?: boolean;
  /** Answer with bytes that are not TNS. */
  gibberish?: boolean;
}

const listeners: FakeListener[] = [];

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
});

async function startListener(options: FakeOptions = {}): Promise<FakeListener> {
  const observed: Observed = { descriptors: [] };
  const known = options.serviceName ?? "ORCLPDB1";
  const connections = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    connections.add(socket);
    // A probe that has seen enough destroys its socket, which arrives
    // here as ECONNRESET. Without a listener that is an unhandled error
    // event, and the fixture takes the test run down with it.
    socket.on("error", () => undefined);
    socket.on("close", () => connections.delete(socket));

    let buffered: Buffer = Buffer.alloc(0);
    let asked = false;
    if (options.gibberish) {
      // A length no TNS packet can have, so the probe's framing refuses
      // it rather than waiting for bytes that will never come.
      socket.end(Buffer.from([0xff, 0xff, 0, 0, 6, 0, 0, 0]));
      return;
    }

    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < HEADER_BYTES) return;
      const length = buffered.readUInt16BE(0);
      if (buffered.length < length) return;
      const packet = buffered.subarray(0, length);
      buffered = buffered.subarray(length);
      if (options.silent) return;
      if (packet.readUInt8(4) !== PACKET_CONNECT) return;

      const dataLength = packet.readUInt16BE(24);
      const dataOffset = packet.readUInt16BE(26);
      observed.descriptors.push(
        packet.toString("latin1", dataOffset, dataOffset + dataLength),
      );

      if (options.askForResend && !asked) {
        asked = true;
        socket.write(barePacket(PACKET_RESEND));
        return;
      }

      const descriptor = observed.descriptors[observed.descriptors.length - 1];
      if (descriptor?.includes(`(SERVICE_NAME=${known})`)) {
        socket.write(options.redirect ? redirectPacket() : acceptPacket());
        return;
      }
      socket.write(refusePacket(12514));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const fake: FakeListener = {
    port,
    observed,
    close: () =>
      new Promise<void>((resolve) => {
        // `close` waits for open connections, and a probe that timed out
        // deliberately left one open.
        for (const socket of connections) socket.destroy();
        server.close(() => resolve());
      }),
  };
  listeners.push(fake);
  return fake;
}

function header(type: number, length: number): Buffer {
  const packet = Buffer.alloc(length);
  packet.writeUInt16BE(length, 0);
  packet.writeUInt8(type, 4);
  return packet;
}

/** Version, options, SDU, TDU, hardware, data length and offset. */
function acceptPacket(): Buffer {
  const packet = header(PACKET_ACCEPT, 32);
  packet.writeUInt16BE(313, 8);
  packet.writeUInt16BE(0, 10);
  packet.writeUInt16BE(8192, 12);
  packet.writeUInt16BE(32767, 14);
  packet.writeUInt16BE(1, 16);
  packet.writeUInt16BE(0, 18);
  packet.writeUInt16BE(32, 20);
  return packet;
}

/** A listener handing the connection to a dedicated server process. */
function redirectPacket(): Buffer {
  const address = Buffer.from(
    "(ADDRESS=(PROTOCOL=TCP)(HOST=10.0.0.9)(PORT=41234))",
    "latin1",
  );
  const packet = header(PACKET_REDIRECT, 10 + address.length);
  packet.writeUInt16BE(address.length, 8);
  address.copy(packet, 10);
  return packet;
}

function refusePacket(code: number): Buffer {
  // The shape a real listener sends: a reason pair, a length, and a TNS
  // descriptor carrying the error stack and the server's version.
  const data = Buffer.from(
    `(DESCRIPTION=(TMP=)(VSNNUM=318767104)(ERR=${code})(ERROR_STACK=(ERROR=(CODE=${code})(EMFI=4))))`,
    "latin1",
  );
  const packet = header(PACKET_REFUSE, 12 + data.length);
  packet.writeUInt8(1, 8); // User reason.
  packet.writeUInt8(0, 9); // System reason.
  packet.writeUInt16BE(data.length, 10);
  data.copy(packet, 12);
  return packet;
}

function barePacket(type: number): Buffer {
  return header(type, HEADER_BYTES);
}

const CONFIG: OracleConfig = { degradedThresholdMs: 3_000 };

function contextFor(
  target: string,
  overrides: Partial<ProbeContext<OracleConfig>> = {},
): ProbeContext<OracleConfig> {
  return {
    target,
    port: null,
    config: CONFIG,
    timeoutMs: 3_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
    ...overrides,
  };
}

describe("the Oracle probe against a listener that speaks TNS", () => {
  it("reports a listener that accepts a connection for the service", async () => {
    const listener = await startListener();
    const result = await oracledbProbe(
      contextFor(`oracle://127.0.0.1:${listener.port}/ORCLPDB1`),
    );

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      listenerAnswered: true,
      accepted: true,
      listenerResponse: "accept",
      serviceError: null,
    });
    expect(typeof result.responseTimeMs).toBe("number");
  });

  it("asks for the service in the target and names itself while doing it", async () => {
    const listener = await startListener();
    await oracledbProbe(
      contextFor(`oracle://127.0.0.1:${listener.port}/ORCLPDB1`),
    );

    const [descriptor] = listener.observed.descriptors;
    expect(descriptor).toContain("(SERVICE_NAME=ORCLPDB1)");
    expect(descriptor).toContain("(PROGRAM=vigil)");
    expect(descriptor).toContain(`(PORT=${listener.port})`);
  });

  it("counts a hand-off to a server process as an accepted connection", async () => {
    // A REDIRECT is the listener saying "yes, and here is where to go" —
    // and the address in it comes from the far end, so the probe reads it
    // as evidence and never dials it.
    const listener = await startListener({ redirect: true });
    const result = await oracledbProbe(
      contextFor(`oracle://127.0.0.1:${listener.port}/ORCLPDB1`),
    );

    expect(result.facts).toMatchObject({
      accepted: true,
      listenerResponse: "redirect",
    });
  });

  it("sends the request again when the listener asks for it", async () => {
    const listener = await startListener({ askForResend: true });
    const result = await oracledbProbe(
      contextFor(`oracle://127.0.0.1:${listener.port}/ORCLPDB1`),
    );

    expect(listener.observed.descriptors).toHaveLength(2);
    expect(result.facts.accepted).toBe(true);
  });

  it("reports an unregistered service as the listener's own error code", async () => {
    // ORA-12514 is the everyday Oracle outage: the listener is up, the
    // instance behind it is not, and a TCP check on 1521 sees nothing
    // wrong at all.
    const listener = await startListener({ serviceName: "OTHERDB" });
    const result = await oracledbProbe(
      contextFor(`oracle://127.0.0.1:${listener.port}/ORCLPDB1`),
    );

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      listenerAnswered: true,
      accepted: false,
      listenerResponse: "refuse",
      serviceError:
        "ORA-12514: listener does not currently know of service requested in connect descriptor",
      serverVersion: "19.0.0.0.0",
    });
  });
});

describe("the Oracle probe against something that is not a listener", () => {
  it("reports a peer that answers on 1521 without speaking TNS", async () => {
    const listener = await startListener({ gibberish: true });
    const result = await oracledbProbe(
      contextFor(`oracle://127.0.0.1:${listener.port}/ORCLPDB1`),
    );

    // The connection worked, so this is an observation and not a
    // transport error. The type's own assertion turns it into a verdict.
    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      listenerAnswered: false,
      accepted: false,
    });
  });

  it("reports a refused connection as a transport failure", async () => {
    const closed = await startListener();
    await closed.close();
    const result = await oracledbProbe(
      contextFor(`oracle://127.0.0.1:${closed.port}/ORCLPDB1`),
    );

    expect(result.error).toBeTruthy();
    expect(result.facts.listenerAnswered).toBeUndefined();
  });

  it("gives up on a listener that accepts the socket and then says nothing", async () => {
    const listener = await startListener({ silent: true });
    const result = await oracledbProbe(
      contextFor(`oracle://127.0.0.1:${listener.port}/ORCLPDB1`, {
        timeoutMs: 300,
      }),
    );

    expect(result.error).toBe("Timed out after 300ms");
  });

  it("refuses a private address unless private targets are allowed", async () => {
    const result = await oracledbProbe(
      contextFor("oracle://localhost:1521/ORCLPDB1", {
        allowPrivateTargets: false,
      }),
    );

    expect(result).toMatchObject({
      error: "Target resolves to a private address",
      responseTimeMs: null,
    });
  });

  it("refuses a target that is not a connection string at all", async () => {
    // The schema rejects this, but a row can predate the schema or
    // survive a downgrade, and the worker's hot path must not throw.
    const result = await oracledbProbe(contextFor("db.example.com"));
    expect(result.error).toBe("Not an Oracle connection string");
  });
});

describe("the Oracle type's judgment", () => {
  const assertion = (id: string) => {
    const found = oracledbSpec.assertions.find((entry) => entry.id === id);
    if (!found) throw new Error(`No assertion ${id}`);
    return found;
  };

  it("calls a peer that is not an Oracle listener down", () => {
    expect(assertion("listener").evaluate(false, CONFIG)).toContain(
      "Oracle listener",
    );
  });

  it("calls a refused connection down", () => {
    expect(assertion("accepted").evaluate(false, CONFIG)).toBe(
      "The listener would not accept a connection",
    );
  });

  it("reports the listener's answer as degraded when it is slower than the threshold", () => {
    expect(assertion("latency").evaluate(4_000, CONFIG)).toBe(
      "Answered in 4000ms, over the 3000ms threshold",
    );
  });

  it("judges a listener that knows the service up", async () => {
    const listener = await startListener();
    const result = await oracledbProbe(
      contextFor(`oracle://127.0.0.1:${listener.port}/ORCLPDB1`),
    );

    expect(judge(oracledbSpec.assertions, CONFIG, result).verdict).toBe("up");
  });

  it("judges a listener that refuses the service down", async () => {
    const listener = await startListener({ serviceName: "OTHERDB" });
    const result = await oracledbProbe(
      contextFor(`oracle://127.0.0.1:${listener.port}/ORCLPDB1`),
    );
    const verdict = judge(oracledbSpec.assertions, CONFIG, result);

    expect(verdict.verdict).toBe("down");
    expect(verdict.failedAssertions).toContain("accepted");
  });

  it("judges a peer that is not speaking TNS down", async () => {
    const listener = await startListener({ gibberish: true });
    const result = await oracledbProbe(
      contextFor(`oracle://127.0.0.1:${listener.port}/ORCLPDB1`),
    );

    expect(judge(oracledbSpec.assertions, CONFIG, result).verdict).toBe("down");
  });
});

describe("the Oracle connection string", () => {
  it("accepts both spellings an operator is likely to reach for", () => {
    for (const target of [
      "oracle://db.example.com:1521/ORCLPDB1",
      "oracledb://db.example.com/ORCL",
    ]) {
      expect(oracledbSpec.targetSchema.safeParse(target).success).toBe(true);
    }
  });

  it("defaults to 1521 when the string omits the port", () => {
    expect(parseOracleConnection("oracle://db.example.com/ORCL")).toEqual({
      hostname: "db.example.com",
      port: 1521,
      serviceName: "ORCL",
    });
  });

  it("refuses a string with no service name, and says what is missing", () => {
    const parsed = oracledbSpec.targetSchema.safeParse(
      "oracle://db.example.com:1521",
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("service name");
  });

  it("refuses credentials rather than storing one it will never send", () => {
    const parsed = oracledbSpec.targetSchema.safeParse(
      "oracle://system:hunter2@db.example.com:1521/ORCLPDB1",
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain(
      "Remove the credentials",
    );
  });

  it("refuses a service name that would rewrite the connect descriptor", () => {
    // The name is interpolated into `(SERVICE_NAME=...)`, so a
    // parenthesis in it would not be a bad name — it would be a
    // different request.
    for (const target of [
      "oracle://db.example.com:1521/ORCL)(SERVER=DEDICATED",
      "oracle://db.example.com:1521/ORCL=X",
      "oracle://db.example.com:1521/ORCL%20DB",
    ]) {
      expect(oracledbSpec.targetSchema.safeParse(target).success).toBe(false);
    }
  });

  it("still redacts a credential that reached the row some other way", () => {
    // The schema refuses these, but `describeTarget` is the last thing
    // between a target and an incident email and must not depend on a
    // rule that lives in another function.
    expect(
      oracledbSpec.describeTarget(
        "oracle://system:hunter2@db.example.com:1521/ORCLPDB1",
        null,
        CONFIG,
      ),
    ).toBe("db.example.com:1521/ORCLPDB1");
  });

  it("keeps no secret in the config, because there is no credential at all", () => {
    expect(oracledbSpec.secretFields).toBeUndefined();
    expect(oracledbSpec.storedSchema.parse({ password: "x" })).toBeNull();
  });

  it("survives a row whose config blob is junk", () => {
    for (const config of [null, undefined, {}, { nonsense: true }, 42]) {
      expect(() =>
        oracledbSpec.fromRow({
          checkType: "oracledb",
          url: "oracle://db.example.com:1521/ORCLPDB1",
          port: null,
          method: "GET",
          intervalSeconds: 60,
          timeoutMs: 10_000,
          degradedThresholdMs: 2_500,
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
});

describe("the version a listener volunteers when it refuses", () => {
  it.each([
    [318767104, "19.0.0.0.0"],
    [186647552, "11.2.0.4.0"],
    [352321536, "21.0.0.0.0"],
  ])("reads %i as %s", (vsnnum, expected) => {
    expect(decodeVersion(vsnnum)).toBe(expected);
  });

  it("reports nothing rather than a nonsense version", () => {
    expect(decodeVersion(0)).toBeNull();
  });
});
