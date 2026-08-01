// @covers-type: snmp
import dgram from "node:dgram";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type {
  ProbeContext,
  ProbeResult,
} from "@/modules/monitors/types/contract";
import { snmpProbe } from "@/modules/monitors/types/probes/snmp";
import {
  TAG,
  authenticateMessage,
  decodeCommunityMessage,
  decodeScopedPdu,
  decodeV3Message,
  decryptScopedPdu,
  encodeCommunityMessage,
  encodeGetRequestPdu,
  encodeInteger,
  encodeOid,
  encodeResponsePdu,
  encodeScopedPdu,
  encodeV3Message,
  encryptScopedPdu,
  passwordToKey,
  peekVersion,
  readOid,
  tlv,
  verifyMessage,
  type AuthProtocol,
} from "@/modules/monitors/types/probes/snmp-codec";
import {
  isEncodableOid,
  snmpSpec,
  snmpStoredSchema,
  type SnmpConfig,
} from "@/modules/monitors/types/specs/snmp";

/**
 * The fixture is a real SNMP agent: a UDP socket on loopback that
 * decodes the datagrams this probe sends and answers them in BER,
 * including the whole v3 USM exchange — engine discovery, digest
 * verification, AES privacy. The probe dials it through its own socket
 * with nothing stubbed.
 *
 * That matters more here than anywhere else in this codebase, because
 * SNMP's failure modes are all *on the wire*: an agent that stays
 * silent, one that answers a different request id, one that reports
 * instead of replying. None of those are reachable through a mocked
 * function, and every one of them is a way this check could quietly
 * report the wrong thing about a device.
 */

const SYS_UPTIME = "1.3.6.1.2.1.1.3.0";
const SYS_NAME = "1.3.6.1.2.1.1.5.0";
const IF_PHYS_ADDRESS = "1.3.6.1.2.1.2.2.1.6.1";
const SLOW_OID = "1.3.6.1.4.1.99999.1.0";
const UNKNOWN_OID = "1.3.6.1.4.1.99999.404.0";

/** A net-snmp style engine id: the enterprise-number format of RFC 3411. */
const ENGINE_ID = Buffer.from("80001f8880deadbeef0102030405", "hex");
const ENGINE_BOOTS = 12;
const ENGINE_TIME = 34_567;

const USM_UNKNOWN_ENGINE_IDS = "1.3.6.1.6.3.15.1.1.4.0";
const USM_UNKNOWN_USER_NAMES = "1.3.6.1.6.3.15.1.1.3.0";
const USM_WRONG_DIGESTS = "1.3.6.1.6.3.15.1.1.5.0";

/** An unsigned application-typed value, encoded the way an agent does. */
function unsigned(tag: number, value: number): Buffer {
  const digits: number[] = [];
  let remaining = value;
  do {
    digits.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  // A leading zero when the top bit is set: an agent reuses its INTEGER
  // encoder for these, so Counter32 12345678 goes out as 00 bc 61 4e.
  if ((digits[0]! & 0x80) !== 0) digits.unshift(0);
  return tlv(tag, Buffer.from(digits));
}

const VALUES: Readonly<Record<string, Buffer>> = {
  [SYS_UPTIME]: unsigned(TAG.TIME_TICKS, 12_345_678),
  [SYS_NAME]: tlv(TAG.OCTET_STRING, Buffer.from("core-switch-1", "utf8")),
  // Six raw bytes: a MAC address is the classic OCTET STRING that is
  // not text at all.
  [IF_PHYS_ADDRESS]: tlv(TAG.OCTET_STRING, Buffer.from("00250e1a2b3c", "hex")),
  [SLOW_OID]: unsigned(TAG.GAUGE32, 42),
};

interface AgentOptions {
  community: string;
  user: string;
  authProtocol: AuthProtocol;
  authPassword: string;
  privPassword: string;
  /** A user whose replies are signed with the wrong key, on purpose. */
  liar: string;
}

/**
 * A fake SNMP agent. It speaks v1, v2c and v3 well enough to be wrong
 * in the ways a real agent is wrong.
 */
class FakeAgent {
  readonly socket = dgram.createSocket("udp4");
  port = 0;
  /** What the last request said it was, so a version test can prove it. */
  lastWireVersion: number | null = null;
  /** Whether the last v3 request arrived encrypted. */
  lastEncrypted = false;
  private authKey: Buffer | null = null;
  private privKey: Buffer | null = null;

  constructor(private readonly options: AgentOptions) {}

  keys(): { auth: Buffer; priv: Buffer } {
    // Derived once: password-to-key hashes a megabyte per call by
    // design, and this fixture would otherwise spend seconds on it.
    this.authKey ??= passwordToKey(
      this.options.authPassword,
      ENGINE_ID,
      this.options.authProtocol,
    );
    this.privKey ??= passwordToKey(
      this.options.privPassword,
      ENGINE_ID,
      this.options.authProtocol,
    );
    return { auth: this.authKey, priv: this.privKey };
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.on("message", (datagram, rinfo) => {
        this.handle(datagram, rinfo);
      });
      this.socket.bind(0, "127.0.0.1", () => {
        this.port = this.socket.address().port;
        resolve();
      });
    });
  }

  close(): void {
    this.socket.close();
  }

  private reply(datagram: Buffer, rinfo: dgram.RemoteInfo, delayMs = 0): void {
    const send = () =>
      this.socket.send(datagram, rinfo.port, rinfo.address, () => undefined);
    if (delayMs === 0) send();
    else setTimeout(send, delayMs);
  }

  private handle(datagram: Buffer, rinfo: dgram.RemoteInfo): void {
    if (peekVersion(datagram) === 3) {
      this.handleV3(datagram, rinfo);
      return;
    }
    const request = decodeCommunityMessage(datagram);
    this.lastWireVersion = request.wireVersion;
    if (request.community !== this.options.community) {
      // What a real agent does with a bad community: nothing. There is
      // no "wrong password" reply in v1 or v2c.
      return;
    }
    const oid = request.pdu.varbinds[0]?.oid ?? "";
    const value = VALUES[oid];
    const pdu =
      value !== undefined
        ? encodeResponsePdu(request.pdu.requestId, 0, [{ oid, value }])
        : request.wireVersion === 0
          ? // v1 has no exception values, so a missing object is an
            // error-status on the whole PDU.
            encodeResponsePdu(request.pdu.requestId, 2, [
              { oid, value: tlv(TAG.NULL, Buffer.alloc(0)) },
            ])
          : encodeResponsePdu(request.pdu.requestId, 0, [
              { oid, value: tlv(TAG.NO_SUCH_OBJECT, Buffer.alloc(0)) },
            ]);

    this.reply(
      encodeCommunityMessage(request.wireVersion, request.community, pdu),
      rinfo,
      oid === SLOW_OID ? 300 : 0,
    );
  }

  private handleV3(datagram: Buffer, rinfo: dgram.RemoteInfo): void {
    const message = decodeV3Message(datagram);
    this.lastWireVersion = 3;

    if (message.usm.engineId.length === 0) {
      this.reply(this.report(message.msgId, USM_UNKNOWN_ENGINE_IDS), rinfo);
      return;
    }
    if (
      message.usm.userName !== this.options.user &&
      message.usm.userName !== this.options.liar
    ) {
      this.reply(this.report(message.msgId, USM_UNKNOWN_USER_NAMES), rinfo);
      return;
    }

    const { auth, priv } = this.keys();
    const authenticated = (message.flags & 0x01) !== 0;
    if (
      authenticated &&
      !verifyMessage(message, auth, this.options.authProtocol)
    ) {
      this.reply(this.report(message.msgId, USM_WRONG_DIGESTS), rinfo);
      return;
    }

    this.lastEncrypted = message.encrypted;
    const scoped = message.encrypted
      ? decryptScopedPdu(
          message.scopedPdu,
          priv,
          message.usm.engineBoots,
          message.usm.engineTime,
          message.usm.privParams,
        )
      : message.scopedPdu;
    const pdu = decodeScopedPdu(scoped);
    const oid = pdu.varbinds[0]?.oid ?? "";
    const value = VALUES[oid];
    const responsePdu =
      value !== undefined
        ? encodeResponsePdu(pdu.requestId, 0, [{ oid, value }])
        : encodeResponsePdu(pdu.requestId, 0, [
            { oid, value: tlv(TAG.NO_SUCH_OBJECT, Buffer.alloc(0)) },
          ]);

    // The liar signs with a key nobody has, which is what a spoofed
    // reply looks like from the probe's side.
    const signingKey =
      message.usm.userName === this.options.liar
        ? Buffer.alloc(auth.length, 0xff)
        : auth;

    this.reply(
      this.secure(
        message.msgId,
        message.usm.userName,
        responsePdu,
        authenticated,
        message.encrypted,
        signingKey,
        priv,
      ),
      rinfo,
    );
  }

  /** An unauthenticated Report, which is how an engine says "no". */
  private report(msgId: number, statOid: string): Buffer {
    const pdu = encodeResponsePdu(
      msgId,
      0,
      [{ oid: statOid, value: unsigned(TAG.COUNTER32, 1) }],
      TAG.REPORT,
    );
    return encodeV3Message({
      msgId,
      flags: 0,
      usm: {
        engineId: ENGINE_ID,
        engineBoots: ENGINE_BOOTS,
        engineTime: ENGINE_TIME,
        userName: "",
        authParams: Buffer.alloc(0),
        privParams: Buffer.alloc(0),
      },
      scopedPdu: encodeScopedPdu(ENGINE_ID, "", pdu),
      encrypted: false,
    }).message;
  }

  private secure(
    msgId: number,
    userName: string,
    pdu: Buffer,
    authenticated: boolean,
    encrypted: boolean,
    authKey: Buffer,
    privKey: Buffer,
  ): Buffer {
    const scoped = encodeScopedPdu(ENGINE_ID, "", pdu);
    const salt = Buffer.from("0011223344556677", "hex");
    const payload = encrypted
      ? encryptScopedPdu(scoped, privKey, ENGINE_BOOTS, ENGINE_TIME, salt)
      : scoped;
    const encoded = encodeV3Message({
      msgId,
      flags: (authenticated ? 0x01 : 0) | (encrypted ? 0x02 : 0),
      usm: {
        engineId: ENGINE_ID,
        engineBoots: ENGINE_BOOTS,
        engineTime: ENGINE_TIME,
        userName,
        authParams: authenticated ? Buffer.alloc(12) : Buffer.alloc(0),
        privParams: encrypted ? salt : Buffer.alloc(0),
      },
      scopedPdu: payload,
      encrypted,
    });
    return authenticated
      ? authenticateMessage(encoded, authKey, this.options.authProtocol)
      : encoded.message;
  }
}

const AGENT: AgentOptions = {
  community: "s3cret-community",
  user: "vigil-monitor",
  authProtocol: "SHA",
  authPassword: "maplesyrup-auth",
  privPassword: "maplesyrup-priv",
  liar: "impostor",
};

let agent: FakeAgent;

beforeAll(async () => {
  agent = new FakeAgent(AGENT);
  await agent.listen();
});

afterAll(() => {
  agent.close();
});

const BASE_CONFIG: SnmpConfig = {
  oid: SYS_UPTIME,
  version: "2c",
  community: AGENT.community,
  v3Username: null,
  v3AuthProtocol: null,
  v3AuthPassword: null,
  v3PrivProtocol: null,
  v3PrivPassword: null,
  expectedValue: null,
  degradedThresholdMs: 3_000,
};

function contextFor(
  overrides: Partial<SnmpConfig> = {},
  timeoutMs = 2_000,
): ProbeContext<SnmpConfig> {
  return {
    target: "127.0.0.1",
    port: agent.port,
    config: { ...BASE_CONFIG, ...overrides },
    timeoutMs,
    // Loopback: the egress guard would refuse it otherwise, which is
    // exactly what it is for.
    allowPrivateTargets: true,
    fetchImpl: (() => {
      throw new Error("an SNMP check must never make an HTTP request");
    }) as unknown as typeof fetch,
  };
}

function probe(
  overrides: Partial<SnmpConfig> = {},
  timeoutMs?: number,
): Promise<ProbeResult> {
  return snmpProbe(contextFor(overrides, timeoutMs));
}

function verdictFor(result: ProbeResult, config: Partial<SnmpConfig> = {}) {
  return judge(snmpSpec.assertions, { ...BASE_CONFIG, ...config }, result);
}

describe("asking an agent for one OID over v1 and v2c", () => {
  it("reports the value the agent returned, with its SNMP type", async () => {
    const result = await probe();

    expect(result.facts).toMatchObject({
      oidFound: true,
      value: "12345678",
      valueType: "TimeTicks",
      numericValue: 12_345_678,
      errorStatus: null,
    });
    expect(result.error).toBeNull();
    expect(typeof result.responseTimeMs).toBe("number");
    expect(verdictFor(result).verdict).toBe("up");
  });

  it("sends v1 on the wire when the monitor is set to v1", async () => {
    // "2c" is 1 and "1" is 0, and getting that mapping backwards is a
    // check that silently talks to the wrong protocol version.
    await probe({ version: "1" });
    expect(agent.lastWireVersion).toBe(0);
    await probe({ version: "2c" });
    expect(agent.lastWireVersion).toBe(1);
  });

  it("reads a text-valued object as text", async () => {
    const result = await probe({ oid: SYS_NAME });
    expect(result.facts).toMatchObject({
      value: "core-switch-1",
      valueType: "OctetString",
      numericValue: null,
    });
  });

  it("renders a binary-valued object as hex rather than mangled text", async () => {
    // A MAC address through a UTF-8 decoder becomes replacement
    // characters, and two different addresses then compare equal — so
    // an `expectedValue` assertion would pass on the wrong hardware.
    const result = await probe({ oid: IF_PHYS_ADDRESS });
    expect(result.facts.value).toBe("0x00250e1a2b3c");
  });

  it("measures how long the agent took to answer", async () => {
    const result = await probe({ oid: SLOW_OID });
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(250);
  });

  it("reports the agent's answer as degraded when it is slower than the threshold", async () => {
    const result = await probe({ oid: SLOW_OID });
    const judgment = verdictFor(result, { degradedThresholdMs: 100 });
    expect(judgment.verdict).toBe("degraded");
    expect(judgment.error).toContain("over the 100ms threshold");
  });
});

describe("an agent that answers, but not with a value", () => {
  it("judges a v1 noSuchName as the agent refusing, not as an unreachable device", async () => {
    const result = await probe({ version: "1", oid: UNKNOWN_OID });

    // The agent spoke to us, so this is never a transport failure.
    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      errorStatus: "noSuchName",
      oidFound: null,
    });

    const judgment = verdictFor(result, { version: "1", oid: UNKNOWN_OID });
    expect(judgment.verdict).toBe("down");
    expect(judgment.failureClass).toBe("assertion");
    expect(judgment.error).toBe("The agent refused the request: noSuchName");
  });

  it("judges a v2c noSuchObject as the OID being absent from this device", async () => {
    const result = await probe({ oid: UNKNOWN_OID });
    expect(result.facts).toMatchObject({
      oidFound: false,
      valueType: "noSuchObject",
      errorStatus: null,
    });

    const judgment = verdictFor(result, { oid: UNKNOWN_OID });
    expect(judgment.verdict).toBe("down");
    expect(judgment.error).toBe(
      "The agent has no value for this OID on this device",
    );
  });

  it("times out rather than inventing an answer when the community is wrong", async () => {
    // A real agent drops a request whose community it does not accept.
    // There is no reply to read, and the check must not pretend there
    // was one.
    const result = await probe({ community: "wrong" }, 700);
    expect(result.error).toBe("No answer within 700ms");
    expect(verdictFor(result).failureClass).toBe("transport");
  });

  it("refuses to run at all when the community string has been cleared", async () => {
    // An operator problem, not an outage: v1 and v2c have no anonymous
    // mode, so there is no request to send.
    const result = await probe({ community: null });
    expect(result.error).toBeNull();
    expect(result.unavailable).toContain("community string");
    expect(verdictFor(result, { community: null }).failureClass).toBe(
      "misconfigured",
    );
  });
});

describe("asserting on the value itself", () => {
  it("passes when the value is the one the operator expects", async () => {
    const result = await probe({
      oid: SYS_NAME,
      expectedValue: "core-switch-1",
    });
    const judgment = verdictFor(result, {
      oid: SYS_NAME,
      expectedValue: "core-switch-1",
    });
    expect(judgment.verdict).toBe("up");
  });

  it("goes down and says both values when the value has changed", async () => {
    const result = await probe({
      oid: SYS_NAME,
      expectedValue: "core-switch-2",
    });
    const judgment = verdictFor(result, {
      oid: SYS_NAME,
      expectedValue: "core-switch-2",
    });
    expect(judgment.verdict).toBe("down");
    expect(judgment.error).toBe(
      "The value is core-switch-1, expected core-switch-2",
    );
  });

  it("says nothing about the value when no expectation was set", async () => {
    const result = await probe({ oid: SYS_NAME });
    expect(verdictFor(result, { oid: SYS_NAME }).failedAssertions).toEqual([]);
  });
});

describe("SNMPv3", () => {
  const v3 = {
    version: "3" as const,
    v3Username: AGENT.user,
    community: null,
  };

  it("discovers the engine and reads a value with no authentication at all", async () => {
    const result = await probe(v3);
    expect(result.facts).toMatchObject({ oidFound: true, value: "12345678" });
    expect(agent.lastEncrypted).toBe(false);
  });

  it("authenticates the request, and the agent verifies the digest", async () => {
    // The fixture answers with a Report unless the HMAC checks out, so
    // a value coming back is proof the digest was right.
    const result = await probe({
      ...v3,
      v3AuthProtocol: "SHA",
      v3AuthPassword: AGENT.authPassword,
    });
    expect(result.facts).toMatchObject({ oidFound: true, value: "12345678" });
    expect(result.error).toBeNull();
  });

  it("encrypts the request when a privacy pass phrase is set", async () => {
    const result = await probe({
      ...v3,
      v3AuthProtocol: "SHA",
      v3AuthPassword: AGENT.authPassword,
      v3PrivProtocol: "AES",
      v3PrivPassword: AGENT.privPassword,
    });
    expect(result.facts).toMatchObject({ oidFound: true, value: "12345678" });
    // Proof it was not quietly downgraded: the agent saw ciphertext and
    // had to decrypt it to find the OID at all.
    expect(agent.lastEncrypted).toBe(true);
  });

  it("reports a wrong pass phrase as the engine refusing, not as an outage", async () => {
    const result = await probe({
      ...v3,
      v3AuthProtocol: "SHA",
      v3AuthPassword: "not-the-right-pass-phrase",
    });

    expect(result.error).toBeNull();
    expect(result.facts.errorStatus).toBe("wrongDigest");

    const judgment = verdictFor(result, { ...v3, expectedValue: null });
    expect(judgment.verdict).toBe("down");
    expect(judgment.failureClass).toBe("assertion");
    expect(judgment.error).toBe("The agent refused the request: wrongDigest");
  });

  it("reports an unknown user name the same way", async () => {
    const result = await probe({ ...v3, v3Username: "nobody" });
    expect(result.facts.errorStatus).toBe("unknownUserName");
    expect(result.error).toBeNull();
  });

  it("refuses a reply whose digest does not match the credentials", async () => {
    // The fixture's "impostor" user signs with a key nobody has, which
    // is what a forged reply looks like. Accepting it would make
    // authentication decorative.
    const result = await probe({
      ...v3,
      v3Username: AGENT.liar,
      v3AuthProtocol: "SHA",
      v3AuthPassword: AGENT.authPassword,
    });
    expect(result.error).toContain("did not authenticate");
  });

  it("will not send a request for a user it has no pass phrase for", async () => {
    const result = await probe({ ...v3, v3AuthProtocol: "MD5" });
    expect(result.unavailable).toContain("no pass phrase");
  });

  it("refuses to run without a user name", async () => {
    const result = await probe({ ...v3, v3Username: null });
    expect(result.unavailable).toContain("user name");
  });
});

describe("something on the port that is not an agent", () => {
  let noise: dgram.Socket;
  let noisePort = 0;

  beforeAll(async () => {
    noise = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => {
      noise.on("message", (_datagram, rinfo) => {
        noise.send(Buffer.from("this is not BER"), rinfo.port, rinfo.address);
      });
      noise.bind(0, "127.0.0.1", () => {
        noisePort = noise.address().port;
        resolve();
      });
    });
  });

  afterAll(() => noise.close());

  it("reports what answered as not being SNMP", async () => {
    const result = await snmpProbe({
      ...contextFor(),
      port: noisePort,
    });
    expect(result.error).toContain("not SNMP");
    expect(verdictFor(result).failureClass).toBe("transport");
  });

  it("reports a refused port rather than waiting out the timeout", async () => {
    // A connected UDP socket surfaces the ICMP port-unreachable, so a
    // closed port is known in milliseconds instead of at the deadline.
    const closed = dgram.createSocket("udp4");
    const port = await new Promise<number>((resolve) => {
      closed.bind(0, "127.0.0.1", () => {
        const bound = closed.address().port;
        closed.close(() => resolve(bound));
      });
    });

    const started = Date.now();
    const result = await snmpProbe({ ...contextFor({}, 5_000), port });
    expect(result.error).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

describe("the egress guard", () => {
  it("refuses a target that resolves to a private address", async () => {
    const result = await snmpProbe({
      ...contextFor(),
      target: "localhost",
      allowPrivateTargets: false,
    });
    expect(result.error).toContain("private address");
  });
});

describe("the bytes on the wire", () => {
  /**
   * Golden datagrams, written by hand from RFC 1157 §4.1 rather than
   * produced by this codec. Round-tripping an encoder through its own
   * decoder proves the two agree; only a captured-shape datagram proves
   * they agree with the rest of the world.
   */
  const REQUEST_HEX =
    "302902010104067075626c6963a01c020412345678020100020100300e300c06082b060102010103000500";

  const RESPONSE_HEX =
    "302d02010104067075626c6963a2200204123456780201000201003012301006082b06010201010300430400bc614e";

  it("encodes a v2c GetRequest exactly as an agent expects to receive one", () => {
    const message = encodeCommunityMessage(
      1,
      "public",
      encodeGetRequestPdu(0x12345678, "1.3.6.1.2.1.1.3.0"),
    );
    expect(message.toString("hex")).toBe(REQUEST_HEX);
  });

  it("decodes a GetResponse captured from a device", () => {
    const decoded = decodeCommunityMessage(Buffer.from(RESPONSE_HEX, "hex"));
    expect(decoded.wireVersion).toBe(1);
    expect(decoded.community).toBe("public");
    expect(decoded.pdu.requestId).toBe(0x12345678);
    expect(decoded.pdu.varbinds[0]).toMatchObject({
      oid: "1.3.6.1.2.1.1.3.0",
      type: "TimeTicks",
      value: "12345678",
      numericValue: 12_345_678,
    });
  });

  it("pads an integer whose top bit is set, so it is not read as negative", () => {
    // A request id of 0x80000000 encoded without the leading zero is a
    // negative integer to the agent, and the reply then carries an id
    // that never matches — a check that times out against a healthy
    // device, at random.
    expect(encodeInteger(0x7fffffff).toString("hex")).toBe("02047fffffff");
    expect(encodeInteger(128).toString("hex")).toBe("02020080");
    expect(encodeInteger(0).toString("hex")).toBe("020100");
    expect(encodeInteger(-1).toString("hex")).toBe("0201ff");
  });

  it("packs the first two arcs of an OID into one byte, both ways", () => {
    expect(encodeOid("1.3.6.1.2.1.1.3.0").subarray(2).toString("hex")).toBe(
      "2b06010201010300",
    );
    expect(readOid(Buffer.from("2b06010201010300", "hex"))).toBe(
      "1.3.6.1.2.1.1.3.0",
    );
    // An arc above 127 needs the continuation bit, and enterprise OIDs
    // are full of them.
    expect(readOid(encodeOid("1.3.6.1.4.1.9999.1").subarray(2))).toBe(
      "1.3.6.1.4.1.9999.1",
    );
    expect(readOid(encodeOid("2.999.1").subarray(2))).toBe("2.999.1");
  });

  it("refuses a truncated datagram rather than reading past the end", () => {
    const truncated = Buffer.from(RESPONSE_HEX, "hex").subarray(0, 20);
    expect(() => decodeCommunityMessage(truncated)).toThrow();
  });

  it("refuses a length field that claims more than the datagram holds", () => {
    // The shape of a hostile answer: a valid header with a length that
    // would run off the end of the buffer.
    expect(() =>
      decodeCommunityMessage(Buffer.from("30ff0201", "hex")),
    ).toThrow();
  });
});

describe("USM key derivation", () => {
  /**
   * The published test vectors from RFC 3414 appendix A.3. They are the
   * only way to know this key derivation agrees with every agent in the
   * world rather than only with itself — the megabyte of repeated
   * password wraps across a 64-byte boundary, and an implementation
   * that restarts the password at each block round-trips perfectly
   * against a copy of the same mistake.
   */
  const RFC_ENGINE_ID = Buffer.from("000000000000000000000002", "hex");

  it("derives the RFC's MD5 key for the RFC's password", () => {
    expect(
      passwordToKey("maplesyrup", RFC_ENGINE_ID, "MD5").toString("hex"),
    ).toBe("526f5eed9fcce26f8964c2930787d82b");
  });

  it("derives the RFC's SHA key for the RFC's password", () => {
    expect(
      passwordToKey("maplesyrup", RFC_ENGINE_ID, "SHA").toString("hex"),
    ).toBe("6695febc9288e36282235fc7151f128497b38f3f");
  });

  it("localises the key to the engine, so one password is two keys on two devices", () => {
    const one = passwordToKey("maplesyrup", RFC_ENGINE_ID, "MD5");
    const other = passwordToKey("maplesyrup", ENGINE_ID, "MD5");
    expect(one.toString("hex")).not.toBe(other.toString("hex"));
  });
});

describe("the settings a monitor stores", () => {
  it("gives a monitor created with nothing but a hostname a working configuration", () => {
    // The form has no SNMP section yet, so this is the shape every
    // monitor created through the UI arrives with. It has to be one
    // that works against a default-configured device.
    const parsed = snmpStoredSchema.parse({});
    expect(parsed).toMatchObject({
      oid: "1.3.6.1.2.1.1.3.0",
      version: "2c",
      community: "public",
    });
  });

  it("keeps a community string an operator cleared, rather than restoring the default", () => {
    // On v3 the community is genuinely optional, so clearing it means
    // what clearing any secret means and must not silently come back as
    // `public` — which is what a plain `.default()` would have done.
    const parsed = snmpStoredSchema.parse({
      version: "3",
      v3Username: "monitor",
      community: null,
    });
    expect(parsed.community).toBeNull();
  });

  it("refuses to clear the community on v2c, where it is the only credential", () => {
    // The counterpart to the case above, and the reason it is scoped to
    // v3: v1 and v2c authenticate with nothing else, so a monitor whose
    // community was cleared is a monitor that cannot work. Telling the
    // operator at the point they are standing is better than storing it
    // and letting the device answer with silence.
    expect(() => snmpStoredSchema.parse({ community: null })).toThrow(
      /needs a community string/,
    );
  });

  it("does not trim a pass phrase, because the spaces are part of it", () => {
    const parsed = snmpStoredSchema.parse({
      version: "3",
      v3Username: "monitor",
      v3AuthProtocol: "SHA",
      v3AuthPassword: " pass phrase ",
    });
    expect(parsed.v3AuthPassword).toBe(" pass phrase ");
  });

  it("refuses an OID no encoder could put on the wire, while the operator can still fix it", () => {
    const parsed = snmpStoredSchema.safeParse({ oid: "3.1.1" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("1.3.6.1.2.1.1.3.0");
    expect(isEncodableOid("1.3.6.1.2.1.1.3.0")).toBe(true);
    expect(isEncodableOid("1.40.1")).toBe(false);
    expect(isEncodableOid("sysUpTime.0")).toBe(false);
  });

  it("insists on a user name for v3, where there is no community to fall back on", () => {
    const parsed = snmpStoredSchema.safeParse({ version: "3" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["v3Username"]);
  });

  it("refuses to encrypt without authenticating, because USM has no such level", () => {
    const parsed = snmpStoredSchema.safeParse({
      version: "3",
      v3Username: "monitor",
      v3PrivProtocol: "AES",
      v3PrivPassword: "secret",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path[0])).toContain(
      "v3PrivProtocol",
    );
  });

  it("refuses a protocol with no pass phrase behind it", () => {
    const parsed = snmpStoredSchema.safeParse({
      version: "3",
      v3Username: "monitor",
      v3AuthProtocol: "SHA",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("SHA pass phrase");
  });

  it("declares every credential it stores as a secret", () => {
    // A field that holds a credential and is not declared here is
    // serialised into a browser by the next render.
    expect(snmpSpec.secretFields).toEqual([
      "community",
      "v3AuthPassword",
      "v3PrivPassword",
    ]);
  });

  it("never puts the community string into the text incidents and status pages print", () => {
    const config = snmpSpec.fromRow({
      checkType: "snmp",
      url: "switch.example.com",
      port: 161,
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 10_000,
      degradedThresholdMs: 3_000,
      expectedStatusCode: null,
      bodyKeyword: null,
      keywordAbsent: false,
      tlsCheck: false,
      tlsWarnDays: 14,
      config: { community: "s3cret-community", oid: SYS_NAME },
    });
    const described = snmpSpec.describeTarget(
      "switch.example.com",
      161,
      config,
    );
    expect(described).toBe(`switch.example.com:161 ${SYS_NAME}`);
    expect(described).not.toContain("s3cret");
  });

  it("falls back to a usable configuration when the stored blob is junk", () => {
    // Rows predate the blob and survive downgrades; neither may throw
    // on the worker's hot path.
    for (const config of [null, undefined, {}, { nonsense: true }, 42]) {
      const built = snmpSpec.fromRow({
        checkType: "snmp",
        url: "switch.example.com",
        port: 161,
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
      expect(built.oid).toBe("1.3.6.1.2.1.1.3.0");
      expect(built.version).toBe("2c");
    }
  });

  it("declares every fact its assertions read", () => {
    const declared = new Set(snmpSpec.descriptor.facts.map((fact) => fact.key));
    for (const assertion of snmpSpec.assertions) {
      expect(declared).toContain(assertion.fact);
    }
  });
});
