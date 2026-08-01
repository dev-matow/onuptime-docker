import { createHash, createHmac, randomBytes } from "node:crypto";

import { DEFAULT_RADIUS_PORT } from "../catalog";
import type { ProbeContext, ProbeResult } from "../contract";
import {
  MAX_RADIUS_ATTRIBUTE_BYTES,
  RADIUS_ACCESS_REQUEST,
  radiusCodeName,
} from "../specs/radius";
import type { RadiusConfig } from "../specs/radius";
import { refusesPrivate } from "./guard";
import { datagramFailure, exchangeDatagram, resolveDatagramHost } from "./udp";

/**
 * One Access-Request, and the answer it is signed with.
 *
 * A TCP or UDP port check on 1812 proves nothing at all here: RADIUS
 * servers do not accept connections, and an open UDP port cannot be
 * observed without sending something the server will answer. Worse, a
 * server whose shared secret no longer matches its clients', or whose
 * user directory has stopped answering, is *listening* the entire time.
 * An Access-Request is the smallest thing that separates those from a
 * healthy server, and its reply is authenticated, so it also proves the
 * answer came from the server and not from something on the path.
 *
 * Spoken by hand rather than through a library: the request is four
 * attributes and a hash, and every RADIUS package on npm brings a
 * dictionary of several thousand vendor attributes that nothing here
 * would read.
 *
 * The MD5 is not a choice. RFC 2865 §5.2 defines the password cipher and
 * the reply signature in terms of it, so a client that used anything
 * else would not be speaking RADIUS. It is also why RADIUS must never
 * cross a network you do not trust — which is a property of the
 * protocol, honestly reported, and not of this check.
 */

/** Attribute types, RFC 2865 §5 and RFC 3579 §3.2. */
const USER_NAME = 1;
const USER_PASSWORD = 2;
const NAS_IDENTIFIER = 32;
const MESSAGE_AUTHENTICATOR = 80;

const HEADER_BYTES = 20;
const AUTHENTICATOR_BYTES = 16;
const AUTHENTICATOR_OFFSET = 4;
/** The password cipher works one 16-octet block at a time. */
const PASSWORD_BLOCK_BYTES = 16;

export async function radiusProbe(
  ctx: ProbeContext<RadiusConfig>,
): Promise<ProbeResult> {
  const secret = ctx.config.secret;
  if (secret === null) {
    // Misconfigured, never down. An Access-Request cannot be built
    // without the shared secret, so nothing was ever sent — and a
    // monitor that reads `down` because a field is empty is an operator
    // error wearing an outage's clothes.
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: null,
      unavailable: "This monitor has no RADIUS shared secret configured",
    };
  }

  const guard = await refusesPrivate(
    ctx.target,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_RADIUS_PORT;
  const identifier = randomBytes(1).readUInt8(0);
  const authenticator = randomBytes(AUTHENTICATOR_BYTES);

  let request: Buffer;
  try {
    request = encodeAccessRequest(
      ctx.config,
      secret,
      identifier,
      authenticator,
    );
  } catch (error) {
    // Two things can land here, and both are "cannot check from here"
    // rather than "the server is down": an OpenSSL that refuses MD5 (a
    // FIPS-mode build does, and RADIUS has no alternative to offer), and
    // a stored config too large to encode, which the schema refuses but
    // a hand-written row can still hold.
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: null,
      unavailable: `The Access-Request could not be built: ${error instanceof Error ? error.message : "unknown reason"}`,
    };
  }

  const endpoint = await resolveDatagramHost(ctx.target);
  if (endpoint === null) {
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: `Could not resolve ${ctx.target}`,
    };
  }

  const exchange = await exchangeDatagram({
    endpoint,
    port,
    payload: request,
    timeoutMs: ctx.timeoutMs,
    // The identifier is what pairs a reply with a request (§3), and it
    // is one byte, so it is a filter and not a guarantee — the
    // authenticator below is the guarantee. Checking it here means a
    // stale reply to the previous check is ignored rather than
    // measured, and the probe keeps waiting for its own.
    accepts: (data) =>
      data.length >= HEADER_BYTES && data.readUInt8(1) === identifier,
  });

  if (exchange.outcome !== "reply") {
    return datagramFailure(exchange, port, ctx.timeoutMs);
  }

  const reply = exchange.data;
  const code = reply.readUInt8(0);
  const authentic = verifyResponse(reply, authenticator, secret);
  const facts = {
    replyCode: code,
    replyType: radiusCodeName(code),
    authenticatorValid: authentic,
    responseTimeMs: exchange.responseTimeMs,
  };

  if (!authentic) {
    // The server answered, so it is alive — but every claim in that
    // answer is unverifiable, because the signature over it was
    // computed with a secret that is not ours. Reporting `down` would
    // say the RADIUS service is gone when the real fault is a stored
    // secret, and reporting `up` would trust a packet anything on the
    // path could have written.
    return {
      facts,
      responseTimeMs: exchange.responseTimeMs,
      statusCode: null,
      error: null,
      unavailable:
        "The reply was not signed with the stored shared secret — check the secret, or whether something else is answering on this port",
    };
  }

  return {
    facts,
    responseTimeMs: exchange.responseTimeMs,
    statusCode: null,
    error: null,
  };
}

/**
 * An Access-Request carrying the configured account.
 *
 * Pure and exported: the packet is the whole check, and a test that
 * cannot build one by hand cannot prove the cipher is right.
 */
export function encodeAccessRequest(
  config: RadiusConfig,
  secret: string,
  identifier: number,
  authenticator: Buffer,
): Buffer {
  const attributes = Buffer.concat([
    attribute(USER_NAME, Buffer.from(config.username, "utf8")),
    attribute(
      USER_PASSWORD,
      encryptPassword(config.password, secret, authenticator),
    ),
    attribute(NAS_IDENTIFIER, Buffer.from(config.nasIdentifier, "utf8")),
    // Last, so its value sits at a known offset from the end and can be
    // patched in once the length is known. RFC 3579 §3.2 requires the
    // field to be zero while the HMAC over the packet is computed.
    attribute(MESSAGE_AUTHENTICATOR, Buffer.alloc(AUTHENTICATOR_BYTES)),
  ]);

  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(RADIUS_ACCESS_REQUEST, 0);
  header.writeUInt8(identifier, 1);
  header.writeUInt16BE(HEADER_BYTES + attributes.length, 2);
  authenticator.copy(header, AUTHENTICATOR_OFFSET);

  const packet = Buffer.concat([header, attributes]);
  // Signed even though RFC 2865 does not ask for it on an
  // Access-Request. FreeRADIUS 3.2.5 and later can refuse a request
  // without one — the BlastRADIUS mitigation, CVE-2024-3596 — and a
  // request refused for that reason is silently dropped, which arrives
  // here as an outage that is not one.
  createHmac("md5", secret)
    .update(packet)
    .digest()
    .copy(packet, packet.length - AUTHENTICATOR_BYTES);
  return packet;
}

/**
 * The User-Password cipher, RFC 2865 §5.2.
 *
 * The password is padded to whole 16-octet blocks and XORed with a
 * keystream of chained MD5 digests: `b1 = MD5(secret + authenticator)`,
 * and every block after that hashes the *ciphertext* of the one before
 * it. Exported because it is the one part of this check that is
 * cryptography rather than framing, and a wrong keystream produces a
 * packet a server rejects for reasons that look like a bad password.
 */
export function encryptPassword(
  password: string,
  secret: string,
  authenticator: Buffer,
): Buffer {
  const plain = Buffer.from(password, "utf8");
  const blocks = Math.max(1, Math.ceil(plain.length / PASSWORD_BLOCK_BYTES));
  const padded = Buffer.alloc(blocks * PASSWORD_BLOCK_BYTES);
  plain.copy(padded);

  const cipher = Buffer.alloc(padded.length);
  let previous = authenticator;
  for (let offset = 0; offset < padded.length; offset += PASSWORD_BLOCK_BYTES) {
    const keystream = createHash("md5")
      .update(secret, "utf8")
      .update(previous)
      .digest();
    for (let i = 0; i < PASSWORD_BLOCK_BYTES; i += 1) {
      cipher.writeUInt8(
        padded.readUInt8(offset + i) ^ keystream.readUInt8(i),
        offset + i,
      );
    }
    previous = cipher.subarray(offset, offset + PASSWORD_BLOCK_BYTES);
  }
  return cipher;
}

/**
 * Whether a reply was written by something holding our shared secret.
 *
 * `MD5(code + id + length + request authenticator + attributes +
 * secret)`, per RFC 2865 §3. This is the only thing that makes the rest
 * of the packet worth reading: UDP has no return address worth trusting,
 * and without the check any host on the path could answer Access-Accept
 * for a server that is switched off.
 */
export function verifyResponse(
  reply: Buffer,
  requestAuthenticator: Buffer,
  secret: string,
): boolean {
  if (reply.length < HEADER_BYTES) return false;
  // §3: the Length field, not the datagram, delimits the packet.
  // Anything beyond it is padding and must be ignored — including by
  // the hash, which is why this cannot just use `reply`.
  const declared = reply.readUInt16BE(2);
  if (declared < HEADER_BYTES || declared > reply.length) return false;

  const expected = createHash("md5")
    .update(reply.subarray(0, AUTHENTICATOR_OFFSET))
    .update(requestAuthenticator)
    .update(reply.subarray(HEADER_BYTES, declared))
    .update(secret, "utf8")
    .digest();
  return expected.equals(
    reply.subarray(
      AUTHENTICATOR_OFFSET,
      AUTHENTICATOR_OFFSET + AUTHENTICATOR_BYTES,
    ),
  );
}

/** Type, length, value — where length counts its own two bytes (§5). */
function attribute(type: number, value: Buffer): Buffer {
  // The length is one byte, so an over-long value would silently wrap
  // into a packet the server discards without a word. Said out loud
  // instead, and caught where the probe can report it as a
  // configuration problem.
  if (value.length > MAX_RADIUS_ATTRIBUTE_BYTES) {
    throw new Error(
      `a RADIUS attribute cannot carry ${value.length} bytes (limit ${MAX_RADIUS_ATTRIBUTE_BYTES})`,
    );
  }
  const encoded = Buffer.alloc(2 + value.length);
  encoded.writeUInt8(type, 0);
  encoded.writeUInt8(2 + value.length, 1);
  value.copy(encoded, 2);
  return encoded;
}
