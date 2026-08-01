// @covers-type: ldap
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import {
  encodeBindRequest,
  encodeUnbindRequest,
  ldapProbe,
  readBindResponse,
} from "@/modules/monitors/types/probes/ldap";
import { ldapSpec, type LdapConfig } from "@/modules/monitors/types/specs/ldap";

/**
 * A directory server, in as much of LDAP as a bind needs.
 *
 * A real socket speaking real BER rather than a stubbed function:
 * everything this check can get wrong — a length in the long form, a
 * response split across segments, a peer that is not a directory at all
 * — is a property of bytes on a wire, and a mocked probe would only
 * prove that the code calls itself the way the test expects.
 */

const TAG_SEQUENCE = 0x30;
const TAG_INTEGER = 0x02;
const TAG_ENUMERATED = 0x0a;
const TAG_OCTET_STRING = 0x04;
const TAG_BIND_REQUEST = 0x60;
const TAG_BIND_RESPONSE = 0x61;
const TAG_UNBIND_REQUEST = 0x42;
const TAG_SIMPLE_CREDENTIALS = 0x80;

function berLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function element(tag: number, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([tag]),
    berLength(content.length),
    content,
  ]);
}

/** A BindResponse as a directory puts it on the wire. */
function bindResponse(
  resultCode: number,
  diagnostic = "",
  messageId = 1,
): Buffer {
  return element(
    TAG_SEQUENCE,
    Buffer.concat([
      element(TAG_INTEGER, Buffer.from([messageId])),
      element(
        TAG_BIND_RESPONSE,
        Buffer.concat([
          element(TAG_ENUMERATED, Buffer.from([resultCode])),
          element(TAG_OCTET_STRING, Buffer.alloc(0)), // matchedDN
          element(TAG_OCTET_STRING, Buffer.from(diagnostic, "utf8")),
        ]),
      ),
    ]),
  );
}

interface Tlv {
  tag: number;
  start: number;
  end: number;
}

/** Enough BER reading for the fixture to prove what it was sent. */
function readTlv(buffer: Buffer, offset: number): Tlv | null {
  if (offset + 2 > buffer.length) return null;
  const tag = buffer[offset]!;
  const first = buffer[offset + 1]!;
  if (first < 0x80) {
    const start = offset + 2;
    return { tag, start, end: start + first };
  }
  const count = first & 0x7f;
  if (offset + 2 + count > buffer.length) return null;
  let length = 0;
  for (let index = 0; index < count; index += 1) {
    length = length * 256 + buffer[offset + 2 + index]!;
  }
  const start = offset + 2 + count;
  return { tag, start, end: start + length };
}

/** What the fixture decoded out of the bind request it was sent. */
interface SeenBind {
  version: number;
  name: string;
  password: string;
}

function decodeBind(buffer: Buffer): SeenBind | null {
  const message = readTlv(buffer, 0);
  if (!message || buffer.length < message.end) return null;
  const messageId = readTlv(buffer, message.start);
  if (!messageId) return null;
  const request = readTlv(buffer, messageId.end);
  if (!request || request.tag !== TAG_BIND_REQUEST) return null;
  const version = readTlv(buffer, request.start);
  if (!version) return null;
  const name = readTlv(buffer, version.end);
  if (!name) return null;
  const password = readTlv(buffer, name.end);
  if (!password || password.tag !== TAG_SIMPLE_CREDENTIALS) return null;
  return {
    version: buffer[version.start]!,
    name: buffer.toString("utf8", name.start, name.end),
    password: buffer.toString("utf8", password.start, password.end),
  };
}

interface Fixture {
  port: number;
  /** The bind the server decoded. */
  received: Promise<SeenBind>;
  /** Resolves when the client says goodbye instead of vanishing. */
  unbound: Promise<boolean>;
  close: () => void;
}

const UNBIND_BYTES = Buffer.from([
  TAG_SEQUENCE,
  0x05,
  TAG_INTEGER,
  0x01,
  0x02,
  TAG_UNBIND_REQUEST,
  0x00,
]);

/**
 * A server that decodes the bind it is sent and answers with `respond`.
 * Returning null accepts the connection and says nothing, which is what
 * a directory whose backend has gone does.
 */
function startDirectory(
  respond: (bind: SeenBind) => Buffer | null,
  options: { closeAfterBind?: boolean; chunkSize?: number } = {},
): Promise<Fixture> {
  return new Promise((resolve) => {
    let announce: (bind: SeenBind) => void = () => undefined;
    const received = new Promise<SeenBind>((settle) => {
      announce = settle;
    });
    let announceUnbind: (seen: boolean) => void = () => undefined;
    const unbound = new Promise<boolean>((settle) => {
      announceUnbind = settle;
    });

    const server = net.createServer((socket) => {
      let buffered = Buffer.alloc(0);
      let bound = false;

      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (bound) {
          if (buffered.includes(UNBIND_BYTES)) announceUnbind(true);
          return;
        }
        const bind = decodeBind(buffered);
        if (!bind) return;
        bound = true;
        announce(bind);

        const answer = respond(bind);
        if (answer === null) {
          // Silence, and then the hang-up if this fixture was asked for
          // one — a directory that took the bind and lost its backend.
          if (options.closeAfterBind) socket.end();
          return;
        }
        const size = options.chunkSize ?? answer.length;
        // Written with a gap between segments, because a single burst of
        // small writes is coalesced into one TCP segment and would prove
        // nothing about reassembly.
        const writeFrom = (at: number) => {
          if (socket.destroyed || at >= answer.length) {
            if (options.closeAfterBind) socket.end();
            return;
          }
          socket.write(answer.subarray(at, at + size));
          if (at + size >= answer.length) {
            if (options.closeAfterBind) socket.end();
            return;
          }
          setTimeout(() => writeFrom(at + size), 2);
        };
        writeFrom(0);
      });
      socket.on("error", () => undefined);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      let closed = false;
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        received,
        unbound,
        close: () => {
          // Idempotent: a test that closes the server to make a port
          // refuse connections must not make the teardown throw.
          if (closed) return;
          closed = true;
          server.close();
        },
      });
    });
  });
}

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

async function directory(
  respond: (bind: SeenBind) => Buffer | null,
  options: { closeAfterBind?: boolean; chunkSize?: number } = {},
): Promise<Fixture> {
  const fixture = await startDirectory(respond, options);
  fixtures.push(fixture);
  return fixture;
}

function context(
  port: number,
  config: Partial<LdapConfig> = {},
): ProbeContext<LdapConfig> {
  return {
    target: "127.0.0.1",
    port,
    config: {
      bindDn: null,
      bindPassword: null,
      degradedThresholdMs: 3_000,
      ...config,
    },
    timeoutMs: 2_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
  };
}

describe("ldapProbe against a directory that answers", () => {
  it("reports a successful bind as up", async () => {
    const server = await directory(() => bindResponse(0));
    const ctx = context(server.port);

    const result = await ldapProbe(ctx);

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      bindResponse: true,
      resultCode: 0,
      resultMessage: "Bind accepted",
    });
    expect(judge(ldapSpec.assertions, ctx.config, result).verdict).toBe("up");
  });

  it("sends the DN and password the operator configured", async () => {
    // The credential has to reach the wire intact and unaltered: a bind
    // that quietly dropped it would authenticate anonymously and report
    // green for an authentication that never happened.
    const server = await directory(() => bindResponse(0));
    await ldapProbe(
      context(server.port, {
        bindDn: "cn=vigil,ou=service,dc=example,dc=com",
        bindPassword: "  spaces matter  ",
      }),
    );

    await expect(server.received).resolves.toEqual({
      version: 3,
      name: "cn=vigil,ou=service,dc=example,dc=com",
      password: "  spaces matter  ",
    });
  });

  it("sends the DN even when the password is missing, rather than binding anonymously", async () => {
    // The shape an imported monitor arrives in, its credential stripped.
    // Sending the name with an empty password is the unauthenticated
    // bind of RFC 4513 §5.1.2 and the directory refuses it, which is the
    // honest report. Dropping the name to make the request legal — what
    // the MQTT probe does with a password that has no user name — would
    // bind anonymously and report green for authentication that never
    // happened.
    const server = await directory(() => bindResponse(49));
    const ctx = context(server.port, {
      bindDn: "cn=vigil,dc=example,dc=com",
      bindPassword: null,
    });

    const result = await ldapProbe(ctx);

    await expect(server.received).resolves.toEqual({
      version: 3,
      name: "cn=vigil,dc=example,dc=com",
      password: "",
    });
    expect(judge(ldapSpec.assertions, ctx.config, result).error).toBe(
      "The directory refused the bind: Invalid credentials",
    );
  });

  it("binds anonymously when no DN is configured", async () => {
    const server = await directory(() => bindResponse(0));
    await ldapProbe(context(server.port));

    await expect(server.received).resolves.toEqual({
      version: 3,
      name: "",
      password: "",
    });
  });

  it("says goodbye instead of dropping the connection", async () => {
    // A directory logs a session dropped without an unbind as an error,
    // and this check reconnects every interval for ever.
    const server = await directory(() => bindResponse(0));
    await ldapProbe(context(server.port));
    await expect(server.unbound).resolves.toBe(true);
  });

  it("reports a refused bind as down, and says which refusal it was", async () => {
    const server = await directory(() =>
      bindResponse(49, "80090308: LdapErr: DSID-0C09044E, data 52e"),
    );
    const ctx = context(server.port, {
      bindDn: "cn=vigil,dc=example,dc=com",
      bindPassword: "wrong",
    });

    const result = await ldapProbe(ctx);
    const verdict = judge(ldapSpec.assertions, ctx.config, result);

    // A directory that refuses credentials is a directory that is
    // running. The refusal is a fact judged by an assertion, never a
    // transport error — "wrong password" must not be indistinguishable
    // from "unreachable".
    expect(result.error).toBeNull();
    expect(result.facts.diagnosticMessage).toContain("data 52e");
    expect(verdict.failureClass).toBe("assertion");
    expect(verdict.error).toBe(
      "The directory refused the bind: Invalid credentials",
    );
  });

  it("names a result code it has never heard of rather than hiding it", async () => {
    const server = await directory(() => bindResponse(123));
    const ctx = context(server.port);

    const verdict = judge(
      ldapSpec.assertions,
      ctx.config,
      await ldapProbe(ctx),
    );
    expect(verdict.error).toContain("Unrecognised result code 123");
  });

  it("reassembles a response that arrives in fragments", async () => {
    // A read boundary is not a message boundary. A parser that decided
    // on the first chunk would read a two-byte header as a whole
    // message and report a directory that answered as silent.
    const server = await directory(() => bindResponse(0, "welcome"), {
      chunkSize: 3,
    });
    const result = await ldapProbe(context(server.port));

    expect(result.facts).toMatchObject({ bindResponse: true, resultCode: 0 });
    expect(result.facts.diagnosticMessage).toBe("welcome");
  });

  it("reads a response whose length needs the long form", async () => {
    // Past 127 bytes the length stops fitting in one byte. A parser that
    // assumed the short form reads the first length byte as the whole
    // length and then waits for a message that has already arrived.
    const server = await directory(() => bindResponse(0, "x".repeat(400)));

    const result = await ldapProbe(context(server.port));
    expect(result.facts.bindResponse).toBe(true);
    // Truncated for storage: this string is written on every check.
    expect(String(result.facts.diagnosticMessage)).toHaveLength(200);
  });

  it("measures how long the bind took", async () => {
    const server = await directory(() => bindResponse(0));
    const result = await ldapProbe(context(server.port));

    expect(typeof result.responseTimeMs).toBe("number");
    expect(result.facts.responseTimeMs).toBe(result.responseTimeMs);
  });

  it("reports the directory's answer as degraded when it is slower than the threshold", async () => {
    const server = await directory(() => bindResponse(0));
    const ctx = context(server.port, { degradedThresholdMs: 100 });
    const result = await ldapProbe(ctx);

    // The fixture answers in single-digit milliseconds on loopback; what
    // is under test is the threshold, not how fast the kernel is today.
    const verdict = judge(ldapSpec.assertions, ctx.config, {
      ...result,
      facts: { ...result.facts, responseTimeMs: 900 },
    });
    expect(verdict.verdict).toBe("degraded");
    expect(verdict.error).toContain("over the 100ms threshold");
  });
});

describe("ldapProbe against something that is not a directory", () => {
  it("reports a peer answering with garbage as not answering a bind", async () => {
    const server = await directory(() => Buffer.from("HTTP/1.1 400\r\n\r\n"));
    const ctx = context(server.port);

    const result = await ldapProbe(ctx);
    const verdict = judge(ldapSpec.assertions, ctx.config, result);

    // The connection worked, so this is an observation about what is on
    // the port rather than a transport failure.
    expect(result.error).toBeNull();
    expect(result.facts.bindResponse).toBe(false);
    expect(verdict.failureClass).toBe("assertion");
    expect(verdict.error).toBe("The server sent no LDAP bind response");
  });

  it("reports a server that accepts the bind and then hangs up", async () => {
    const server = await directory(() => null, { closeAfterBind: true });
    const ctx = context(server.port);

    // Without the close handler this would sit until the timeout and
    // then report the wrong reason for a server that answered at once.
    const result = await ldapProbe(ctx);
    expect(result.error).toBeNull();
    expect(result.facts.bindResponse).toBe(false);
    expect(judge(ldapSpec.assertions, ctx.config, result).error).toBe(
      "The server sent no LDAP bind response",
    );
  });

  it("reports a refused connection as a transport failure", async () => {
    const server = await directory(() => bindResponse(0));
    const port = server.port;
    server.close();

    const ctx = context(port);
    const result = await ldapProbe(ctx);
    expect(result.error).toBeTruthy();
    expect(judge(ldapSpec.assertions, ctx.config, result).failureClass).toBe(
      "transport",
    );
  });

  it("times out rather than waiting on a directory that never answers", async () => {
    const server = await directory(() => null);
    const result = await ldapProbe({ ...context(server.port), timeoutMs: 250 });

    expect(result.error).toBe("Timed out after 250ms");
  });

  it("refuses a target that resolves into private space", async () => {
    // The bind is never sent: a hostname that passes the form can still
    // resolve to 10.0.0.1 by the time the worker dials it.
    const result = await ldapProbe({
      ...context(389),
      target: "localhost",
      allowPrivateTargets: false,
    });
    expect(result.error).toBe("Target resolves to a private address");
    expect(result.facts).toEqual({});
  });
});

describe("readBindResponse", () => {
  it("waits for the rest of a message it has only part of", () => {
    const whole = bindResponse(0, "hello");
    for (let cut = 1; cut < whole.length; cut += 1) {
      expect(readBindResponse(whole.subarray(0, cut))).toEqual({
        state: "partial",
      });
    }
    expect(readBindResponse(whole)).toEqual({
      state: "bind",
      resultCode: 0,
      diagnosticMessage: "hello",
    });
  });

  it("refuses a message that declares more than a bind could ever be", () => {
    // Otherwise a hostile peer names two gigabytes and the worker
    // buffers towards it until the timeout, holding the heap meanwhile.
    const enormous = Buffer.concat([
      Buffer.from([TAG_SEQUENCE, 0x84, 0x7f, 0xff, 0xff, 0xff]),
      Buffer.from("junk"),
    ]);
    expect(readBindResponse(enormous)).toEqual({ state: "no-bind" });
  });

  it("refuses the indefinite length form LDAP forbids", () => {
    // Legal BER, forbidden by RFC 4511 §5.1, and unbounded — a parser
    // that chased it would never decide anything.
    const indefinite = Buffer.from([TAG_SEQUENCE, 0x80, 0x00, 0x00]);
    expect(readBindResponse(indefinite)).toEqual({ state: "no-bind" });
  });

  it("treats an unsolicited notice as no bind response", () => {
    // A shutting-down directory sends an extendedResp (application 23)
    // with message id 0. It is LDAP, and it is not an answer to a bind.
    const notice = element(
      TAG_SEQUENCE,
      Buffer.concat([
        element(TAG_INTEGER, Buffer.from([0])),
        element(0x78, element(TAG_ENUMERATED, Buffer.from([0]))),
      ]),
    );
    expect(readBindResponse(notice)).toEqual({ state: "no-bind" });
  });

  it("reads a result code that arrived with no diagnostic at all", () => {
    const truncated = element(
      TAG_SEQUENCE,
      Buffer.concat([
        element(TAG_INTEGER, Buffer.from([1])),
        element(TAG_BIND_RESPONSE, element(TAG_ENUMERATED, Buffer.from([53]))),
      ]),
    );
    expect(readBindResponse(truncated)).toEqual({
      state: "bind",
      resultCode: 53,
      diagnosticMessage: "",
    });
  });
});

describe("encodeBindRequest", () => {
  it("encodes an anonymous simple bind exactly as RFC 4511 states it", () => {
    // 30 0c LDAPMessage of 12 bytes | 02 01 01 messageID 1 |
    // 60 07 BindRequest of 7 | 02 01 03 version 3 | 04 00 empty name |
    // 80 00 empty simple credentials.
    expect(
      encodeBindRequest({ bindDn: null, bindPassword: null }).toString("hex"),
    ).toBe("300c020101600702010304008000");
  });

  it("switches to the long length form when a DN outgrows one byte", () => {
    const long = `cn=${"a".repeat(200)},dc=example,dc=com`;
    const encoded = encodeBindRequest({ bindDn: long, bindPassword: "pw" });

    // 0x81 says "one length byte follows". A short-form encoder would
    // have written 237 as a tag and produced a packet no directory can
    // parse — which reads to an operator as a directory that ignores it.
    expect(encoded[1]).toBe(0x81);
    expect(encoded.length).toBe(3 + encoded[2]!);
    expect(encoded.includes(Buffer.from(long, "utf8"))).toBe(true);
  });

  it("carries a password that is only whitespace", () => {
    const encoded = encodeBindRequest({ bindDn: "cn=x", bindPassword: "  " });
    expect(
      encoded.includes(Buffer.from([TAG_SIMPLE_CREDENTIALS, 2, 32, 32])),
    ).toBe(true);
  });
});

describe("encodeUnbindRequest", () => {
  it("is the seven-byte message RFC 4511 §4.3 describes", () => {
    // 30 05 LDAPMessage | 02 01 02 messageID 2 | 42 00 UnbindRequest,
    // which carries no content at all.
    expect(encodeUnbindRequest().toString("hex")).toBe("30050201024200");
  });
});

describe("the ldap spec", () => {
  function fromConfig(config: unknown): LdapConfig {
    return ldapSpec.fromRow({
      checkType: "ldap",
      url: "ldap.example.com",
      port: 389,
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
  }

  it("keeps the bind credentials out of the string incidents print", () => {
    const config = fromConfig({
      bindDn: "cn=vigil,dc=example,dc=com",
      bindPassword: "hunter2",
    });

    const described = ldapSpec.describeTarget("ldap.example.com", 389, config);
    expect(described).toBe("ldap.example.com:389");
    expect(described).not.toContain("hunter2");
    // The DN is an identity rather than a secret, but a public status
    // page is no place to name the account Vigil authenticates with.
    expect(described).not.toContain("cn=vigil");
  });

  it("declares the bind password as a secret", () => {
    // Without this the credential is serialised into the browser of
    // anyone who can open the edit dialog.
    expect(ldapSpec.secretFields).toContain("bindPassword");
  });

  it("refuses a password with no DN to authenticate", () => {
    // The directory would compare it against an anonymous bind and
    // answer success — a monitor reporting green while the credential it
    // was given is being ignored.
    const refused = ldapSpec.storedSchema.safeParse({
      bindDn: null,
      bindPassword: "pw",
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe(
      "A bind password needs a bind DN.",
    );
  });

  it("allows a DN with no password, because that is what an import lands", () => {
    // An export masks the credential and the importer strips the mask
    // rather than writing it. A schema that refused this shape would
    // make the importer drop the monitor entirely — trading a check that
    // fails loudly for one that does not exist.
    expect(
      ldapSpec.storedSchema.safeParse({ bindDn: "cn=x", bindPassword: null })
        .success,
    ).toBe(true);
    expect(
      ldapSpec.storedSchema.safeParse({ bindDn: null, bindPassword: null })
        .success,
    ).toBe(true);
  });

  it("keeps the whitespace inside a password", () => {
    // Trimming a credential turns a working bind into invalidCredentials
    // with nothing anywhere to point at.
    expect(
      ldapSpec.storedSchema.parse({
        bindDn: "  cn=x  ",
        bindPassword: " pad ",
      }),
    ).toEqual({ bindDn: "cn=x", bindPassword: " pad " });
  });

  it("falls back to an anonymous bind when the stored config is junk", () => {
    // A row can predate the schema or survive a downgrade, and the
    // worker's hot path must not throw on it.
    expect(fromConfig({ bindDn: 42 })).toEqual({
      bindDn: null,
      bindPassword: null,
      degradedThresholdMs: 3_000,
    });
  });
});
