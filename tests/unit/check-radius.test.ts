// @covers-type: radius
import { createHash, createHmac } from "node:crypto";
import dgram from "node:dgram";

import { afterEach, describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import { radiusProbe } from "@/modules/monitors/types/probes/radius";
import {
  radiusSpec,
  radiusStoredSchema,
} from "@/modules/monitors/types/specs/radius";
import type { RadiusConfig } from "@/modules/monitors/types/specs/radius";

/**
 * The `radius` check, against a real RADIUS server.
 *
 * The fixture below is a server, not a stub: it parses the
 * Access-Request, verifies the Message-Authenticator over it, decrypts
 * the User-Password with the shared secret it holds, and signs its
 * answer the way RFC 2865 §3 says to. That is the only way to prove the
 * two things this check is for — that the password cipher is right, and
 * that a reply signed with the wrong secret is caught.
 */

const SHARED_SECRET = "testing123";
const HEADER_BYTES = 20;
const BLOCK = 16;

interface ReceivedRequest {
  code: number;
  identifier: number;
  authenticator: Buffer;
  username: string;
  /** The password as the server decrypted it. */
  password: string;
  nasIdentifier: string;
  /** Whether the request's HMAC verifies under the server's secret. */
  messageAuthenticatorValid: boolean;
  raw: Buffer;
}

interface ServerOptions {
  /** The secret the *server* holds. Differs from the monitor's on purpose. */
  secret?: string;
  /** The code to answer with. Default: Access-Accept. */
  code?: number;
  /** Answer under a different identifier, as a stale reply would. */
  identifierShift?: number;
  /** Bytes appended past the packet's own Length field. */
  paddingBytes?: number;
  silent?: boolean;
}

interface Fixture {
  port: number;
  received: ReceivedRequest[];
  close: () => Promise<void>;
}

/** RFC 2865 §5.2, run backwards. */
function decryptPassword(
  cipher: Buffer,
  secret: string,
  authenticator: Buffer,
): string {
  const plain = Buffer.alloc(cipher.length);
  let previous = authenticator;
  for (let offset = 0; offset < cipher.length; offset += BLOCK) {
    const keystream = createHash("md5")
      .update(secret, "utf8")
      .update(previous)
      .digest();
    for (let i = 0; i < BLOCK; i += 1) {
      plain.writeUInt8(
        cipher.readUInt8(offset + i) ^ keystream.readUInt8(i),
        offset + i,
      );
    }
    previous = cipher.subarray(offset, offset + BLOCK);
  }
  return plain.toString("utf8").replace(/\0+$/, "");
}

function parseAttributes(packet: Buffer): Map<number, Buffer> {
  const attributes = new Map<number, Buffer>();
  const declared = packet.readUInt16BE(2);
  let offset = HEADER_BYTES;
  while (offset + 2 <= declared) {
    const type = packet.readUInt8(offset);
    const length = packet.readUInt8(offset + 1);
    if (length < 2 || offset + length > declared) break;
    attributes.set(type, packet.subarray(offset + 2, offset + length));
    offset += length;
  }
  return attributes;
}

/** The HMAC the client should have written, per RFC 3579 §3.2. */
function messageAuthenticatorHolds(packet: Buffer, secret: string): boolean {
  const attributes = parseAttributes(packet);
  const carried = attributes.get(80);
  if (!carried || carried.length !== BLOCK) return false;
  const zeroed = Buffer.from(packet);
  const at = packet.indexOf(carried, HEADER_BYTES);
  Buffer.alloc(BLOCK).copy(zeroed, at);
  return createHmac("md5", secret).update(zeroed).digest().equals(carried);
}

async function radiusServer(options: ServerOptions = {}): Promise<Fixture> {
  const secret = options.secret ?? SHARED_SECRET;
  const socket = dgram.createSocket("udp4");
  const received: ReceivedRequest[] = [];

  socket.on("message", (message, from) => {
    const authenticator = Buffer.from(message.subarray(4, HEADER_BYTES));
    const attributes = parseAttributes(message);
    received.push({
      code: message.readUInt8(0),
      identifier: message.readUInt8(1),
      authenticator,
      username: attributes.get(1)?.toString("utf8") ?? "",
      password: decryptPassword(
        attributes.get(2) ?? Buffer.alloc(0),
        secret,
        authenticator,
      ),
      nasIdentifier: attributes.get(32)?.toString("utf8") ?? "",
      messageAuthenticatorValid: messageAuthenticatorHolds(message, secret),
      raw: Buffer.from(message),
    });
    if (options.silent) return;

    const reply = Buffer.alloc(HEADER_BYTES);
    reply.writeUInt8(options.code ?? 2, 0);
    reply.writeUInt8(
      (message.readUInt8(1) + (options.identifierShift ?? 0)) % 256,
      1,
    );
    reply.writeUInt16BE(HEADER_BYTES, 2);
    createHash("md5")
      .update(reply.subarray(0, 4))
      .update(authenticator)
      .update(secret, "utf8")
      .digest()
      .copy(reply, 4);

    const padding = options.paddingBytes ?? 0;
    socket.send(
      padding > 0 ? Buffer.concat([reply, Buffer.alloc(padding, 0xaa)]) : reply,
      from.port,
      from.address,
    );
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
  const fixture = await radiusServer(options);
  fixtures.push(fixture);
  return fixture;
}

function configFor(overrides: Partial<RadiusConfig> = {}): RadiusConfig {
  return {
    secret: SHARED_SECRET,
    username: "monitor@example.com",
    password: "s3cret-account-pw",
    nasIdentifier: "vigil",
    expectAccept: false,
    degradedThresholdMs: 3_000,
    ...overrides,
  };
}

function context(
  port: number,
  config: RadiusConfig = configFor(),
  overrides: Partial<ProbeContext<RadiusConfig>> = {},
): ProbeContext<RadiusConfig> {
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

describe("the radius probe", () => {
  it("authenticates as the configured account", async () => {
    const server = await serve();

    const result = await radiusProbe(context(server.port));

    expect(server.received[0]).toMatchObject({
      code: 1,
      username: "monitor@example.com",
      password: "s3cret-account-pw",
      nasIdentifier: "vigil",
    });
    expect(result.error).toBeNull();
  });

  it("never puts the account password on the wire in the clear", async () => {
    // The whole point of §5.2. A packet carrying the plaintext would be
    // a credential on every switch between here and the server.
    const server = await serve();

    await radiusProbe(context(server.port));

    expect(server.received[0]?.raw.toString("latin1")).not.toContain(
      "s3cret-account-pw",
    );
  });

  it("signs the request so a server that demands a Message-Authenticator answers it", async () => {
    // FreeRADIUS 3.2.5 and later can refuse a request without one — the
    // BlastRADIUS mitigation — by dropping it, which arrives here as an
    // outage that is not one.
    const server = await serve();

    await radiusProbe(context(server.port));

    expect(server.received[0]?.messageAuthenticatorValid).toBe(true);
  });

  it("uses a fresh authenticator on every check, so a captured reply cannot be replayed", async () => {
    const server = await serve();

    await radiusProbe(context(server.port));
    await radiusProbe(context(server.port));

    const [first, second] = server.received;
    expect(
      first?.authenticator.equals(second?.authenticator ?? Buffer.alloc(0)),
    ).toBe(false);
  });

  it("reports an Access-Accept as up", async () => {
    const server = await serve({ code: 2 });

    const result = await radiusProbe(context(server.port));

    expect(result.facts).toMatchObject({
      replyCode: 2,
      replyType: "Access-Accept",
      authenticatorValid: true,
    });
    expect(judge(radiusSpec.assertions, configFor(), result).verdict).toBe(
      "up",
    );
  });

  it("treats a signed Access-Reject as proof the server is answering", async () => {
    // The usual way to monitor RADIUS is with credentials meant to fail:
    // a rejection means the server, its secret and its user store all
    // worked.
    const server = await serve({ code: 3 });
    const config = configFor();

    const result = await radiusProbe(context(server.port, config));

    expect(result.facts.replyType).toBe("Access-Reject");
    expect(judge(radiusSpec.assertions, config, result).verdict).toBe("up");
  });

  it("reports an Access-Reject as down when the operator monitors a real account", async () => {
    const server = await serve({ code: 3 });
    const config = configFor({ expectAccept: true });

    const result = await radiusProbe(context(server.port, config));

    expect(judge(radiusSpec.assertions, config, result)).toMatchObject({
      verdict: "down",
      failureClass: "assertion",
      error: "The server answered Access-Reject",
    });
  });

  it("reports an answer that is not a RADIUS response as down", async () => {
    const server = await serve({ code: 44 });
    const config = configFor();

    const result = await radiusProbe(context(server.port, config));

    expect(judge(radiusSpec.assertions, config, result)).toMatchObject({
      verdict: "down",
      error: "The server answered with an unrecognised RADIUS code (44)",
    });
  });

  it("reports a reply signed with a different secret as misconfigured, not as an outage", async () => {
    // The server is plainly alive — it answered. What is wrong is the
    // stored secret, and an operator error that reads as `down` is
    // indistinguishable from the service being gone.
    const server = await serve({ secret: "a-different-secret" });
    const config = configFor();

    const result = await radiusProbe(context(server.port, config));

    expect(result.facts.authenticatorValid).toBe(false);
    expect(judge(radiusSpec.assertions, config, result)).toMatchObject({
      verdict: "indeterminate",
      failureClass: "misconfigured",
    });
    expect(result.unavailable).toContain(
      "not signed with the stored shared secret",
    );
  });

  it("ignores whatever a server pads its datagram with past the packet length", async () => {
    // §3: the Length field delimits the packet, and the signature is
    // computed over that and not over the datagram. Hashing the padding
    // would report every padded reply as forged.
    const server = await serve({ paddingBytes: 12 });

    const result = await radiusProbe(context(server.port));

    expect(result.facts.authenticatorValid).toBe(true);
  });

  it("ignores a reply carrying another request's identifier", async () => {
    const server = await serve({ identifierShift: 1 });

    const result = await radiusProbe(
      context(server.port, configFor(), { timeoutMs: 300 }),
    );

    expect(result.error).toBe("No reply within 300ms");
  });

  it("reports silence as no reply", async () => {
    const server = await serve({ silent: true });

    const result = await radiusProbe(
      context(server.port, configFor(), { timeoutMs: 250 }),
    );

    expect(result).toMatchObject({
      error: "No reply within 250ms",
      responseTimeMs: null,
    });
  });

  it("sends nothing at all when no shared secret is stored", async () => {
    const server = await serve();
    const config = configFor({ secret: null });

    const result = await radiusProbe(context(server.port, config));

    expect(server.received).toEqual([]);
    expect(result.unavailable).toBe(
      "This monitor has no RADIUS shared secret configured",
    );
    expect(judge(radiusSpec.assertions, config, result)).toMatchObject({
      verdict: "indeterminate",
      failureClass: "misconfigured",
    });
  });

  it("refuses a target that resolves to a private address", async () => {
    const result = await radiusProbe(
      context(1812, configFor(), {
        target: "localhost",
        allowPrivateTargets: false,
      }),
    );

    expect(result.error).toBe("Target resolves to a private address");
  });
});

describe("the radius check's configuration", () => {
  it("declares both credentials as secrets", () => {
    // A field missed here is serialised into a browser. The account
    // password is a working login on whatever the server authenticates
    // against, which makes it exactly as sensitive as the secret.
    expect(radiusSpec.secretFields).toEqual(["secret", "password"]);
  });

  it("accepts an empty submission, so the form can create one", () => {
    expect(radiusStoredSchema.parse({})).toEqual({
      secret: null,
      username: "vigil-monitor",
      password: "",
      nasIdentifier: "vigil",
      expectAccept: false,
    });
  });

  it("keeps the whitespace a shared secret was typed with", () => {
    // Compared byte for byte at the far end. Trimming it turns a working
    // secret into replies that never verify, with nothing saying why.
    expect(radiusStoredSchema.parse({ secret: " padded " }).secret).toBe(
      " padded ",
    );
  });

  it("refuses a user name too long for a RADIUS attribute", () => {
    const parsed = radiusStoredSchema.safeParse({ username: "x".repeat(254) });
    expect(parsed.success).toBe(false);
  });

  it("describes the target without either credential", () => {
    // This string is printed in incident emails, webhook bodies and on
    // public status pages.
    const described = radiusSpec.describeTarget(
      "radius.example.com",
      null,
      configFor(),
    );
    expect(described).toBe("radius.example.com:1812");
    expect(described).not.toContain(SHARED_SECRET);
  });

  it("survives a config blob written by an older build", () => {
    expect(
      radiusSpec.fromRow({
        checkType: "radius",
        url: "radius.example.com",
        port: 1812,
        method: "GET",
        intervalSeconds: 60,
        timeoutMs: 10_000,
        degradedThresholdMs: 2_500,
        expectedStatusCode: null,
        bodyKeyword: null,
        keywordAbsent: false,
        tlsCheck: false,
        tlsWarnDays: 14,
        config: 42,
      }),
    ).toEqual({
      secret: null,
      username: "vigil-monitor",
      password: "",
      nasIdentifier: "vigil",
      expectAccept: false,
      degradedThresholdMs: 2_500,
    });
  });
});
