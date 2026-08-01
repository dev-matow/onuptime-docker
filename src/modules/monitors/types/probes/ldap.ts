import net from "node:net";

import { DEFAULT_LDAP_PORT } from "../catalog";
import type { FactBag, ProbeContext, ProbeResult } from "../contract";
import { ldapResultMessage, type LdapConfig } from "../specs/ldap";
import { connectionErrorMessage, elapsedSince, refusesPrivate } from "./guard";

/**
 * One LDAP simple bind, and the result the directory answers with.
 *
 * Spoken by hand rather than through a client library. A BindRequest is
 * four BER elements out and one message back; an LDAP client would bring
 * a connection pool, a schema cache, a search DSL and a SASL stack along
 * for it, none of which a check has any use for.
 *
 * A TCP check on 389 only proves something is listening. A directory
 * that has lost its database backend, is mid-replication, or no longer
 * knows the account the application binds as accepts the socket and
 * fails here — which is the outage an operator wants paged. A bind is
 * the smallest observation that separates the two, and deliberately the
 * smallest: no search follows it, so this costs the directory one
 * authentication and no index work.
 *
 * The result code is a fact, not an error. A directory that refuses our
 * credentials is a directory that is running, and reporting that as a
 * transport failure would tell an operator their server is unreachable
 * at the moment it is answering them.
 *
 * Plaintext throughout: no StartTLS, no LDAPS. What this reports is that
 * the directory is answering, not that its TLS is healthy — a
 * `tls-expiry` monitor on port 636 answers that. The consequence an
 * operator meets is 636 in the port field, which expects a TLS handshake
 * before a single BER byte and so never answers this probe.
 */

/** LDAPv3 (RFC 4511). No server worth monitoring still speaks v2. */
const LDAP_VERSION = 3;

const TAG_SEQUENCE = 0x30;
const TAG_INTEGER = 0x02;
const TAG_ENUMERATED = 0x0a;
const TAG_OCTET_STRING = 0x04;
/** BindRequest — [APPLICATION 0], constructed (RFC 4511 §4.2). */
const TAG_BIND_REQUEST = 0x60;
/** BindResponse — [APPLICATION 1], constructed (§4.2.2). */
const TAG_BIND_RESPONSE = 0x61;
/** UnbindRequest — [APPLICATION 2], a primitive NULL (§4.3). */
const TAG_UNBIND_REQUEST = 0x42;
/** simple [0] OCTET STRING inside AuthenticationChoice (§4.2). */
const TAG_SIMPLE_CREDENTIALS = 0x80;

/**
 * Message ids. Both are below 128 on purpose: the INTEGER encoder here
 * writes exactly one content byte, which is correct for 1..127 and
 * silently wrong above it. A check sends two messages on a connection it
 * then closes, so it never needs a third id.
 */
const BIND_MESSAGE_ID = 1;
const UNBIND_MESSAGE_ID = 2;

/**
 * A ceiling on one response. A BindResponse is a few dozen bytes; a peer
 * declaring more than this is not a directory, and the buffer it is
 * filling lives in the worker's heap. It also bounds the buffering
 * below: the declared length is known from the first few bytes, so
 * nothing accumulates past it.
 */
const MAX_MESSAGE = 64 * 1024;

/**
 * The diagnostic message is stored on every check, so it is truncated.
 * Its job is letting an operator recognise *why* a bind was refused —
 * Active Directory writes its real reason there, `data 532` for an
 * expired password against `data 52e` for a wrong one — and that is
 * legible well inside this.
 */
const MAX_DIAGNOSTIC = 200;

export async function ldapProbe(
  ctx: ProbeContext<LdapConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(
    ctx.target,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_LDAP_PORT;
  const bind = encodeBindRequest(ctx.config);
  const startedAt = performance.now();

  return new Promise<ProbeResult>((resolve) => {
    const socket = net.connect({ host: ctx.target, port });
    let settled = false;
    let buffered = Buffer.alloc(0);

    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const measured = (facts: FactBag, responseTimeMs: number) => {
      if (settled) return;
      settled = true;
      // UnbindRequest rather than a reset. The measurement is already
      // made so the FIN is not waited for, but a connection dropped
      // mid-session is what a directory logs as an error — and what
      // Active Directory counts against the client that keeps doing it,
      // every interval, for ever.
      socket.end(encodeUnbindRequest());
      resolve({ facts, responseTimeMs, statusCode: null, error: null });
    };

    socket.setTimeout(ctx.timeoutMs);
    socket.once("connect", () => {
      socket.write(bind);
    });

    socket.on("data", (chunk: Buffer) => {
      // TCP is a stream, so a BindResponse is entitled to arrive in
      // pieces; a message split across segments is not a malformed one.
      buffered = Buffer.concat([buffered, chunk]);
      const read = readBindResponse(buffered);
      if (read.state === "partial") return;
      const responseTimeMs = elapsedSince(startedAt);
      measured(
        read.state === "bind"
          ? {
              bindResponse: true,
              resultCode: read.resultCode,
              resultMessage: ldapResultMessage(read.resultCode),
              diagnosticMessage:
                read.diagnosticMessage.length > 0
                  ? read.diagnosticMessage
                  : null,
              responseTimeMs,
            }
          : noBindResponse(responseTimeMs),
        responseTimeMs,
      );
    });

    // A server that takes the connection and then hangs up without
    // answering has still told us something. Handled rather than left to
    // the timeout because the inactivity timer stops with the socket:
    // without this the promise never settles and the worker slot leaks.
    socket.once("close", () => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: noBindResponse(responseTimeMs),
        responseTimeMs,
        statusCode: null,
        error: null,
      });
    });

    socket.once("timeout", () => {
      // Destroyed unconditionally: this also fires after a successful
      // measurement, and it is what closes the socket when the server
      // never answers the unbind. `settle` is a no-op by then.
      socket.destroy();
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: `Timed out after ${ctx.timeoutMs}ms`,
      });
    });

    // `on`, not `once`: this probe writes to the socket, so a peer that
    // resets can produce a second error event, and an unhandled error on
    // a stream takes the worker down with it.
    socket.on("error", (error: Error) => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: connectionErrorMessage(error, "Connection failed"),
      });
    });
  });
}

/**
 * Something answered on the port, but not with a bind response — or it
 * closed before it got round to one. Facts rather than an error: the
 * connection itself worked, so this is an observation about what is
 * listening, and the `bind-response` assertion is what turns it into a
 * verdict.
 */
function noBindResponse(responseTimeMs: number): FactBag {
  return {
    bindResponse: false,
    resultCode: null,
    resultMessage: null,
    diagnosticMessage: null,
    responseTimeMs,
  };
}

/** A BER length: short form below 128, long form above it (X.690 §8.1.3). */
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

/** Tag, length, value — the only shape BER has. */
function berElement(tag: number, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([tag]),
    berLength(content.length),
    content,
  ]);
}

/**
 * The BindRequest, as bytes. Pure and exported, because this and
 * {@link readBindResponse} are every decision this check makes about the
 * wire; the socket around them is plumbing.
 *
 * The DN and the password are sent exactly as configured, including the
 * case where a DN carries an empty password. That combination is the
 * "unauthenticated bind" RFC 4513 §5.1.2 tells servers to refuse, and
 * `ldapStoredSchema` refuses it too — but if one reaches here from a
 * hand-written row, sending it and reporting the refusal is the honest
 * answer. Quietly dropping the name to make the request legal, which is
 * what the MQTT probe does with a password that has no user name, would
 * bind anonymously and report a green check for an authentication that
 * never happened.
 */
export function encodeBindRequest(
  config: Pick<LdapConfig, "bindDn" | "bindPassword">,
  messageId: number = BIND_MESSAGE_ID,
): Buffer {
  const request = berElement(
    TAG_BIND_REQUEST,
    Buffer.concat([
      berElement(TAG_INTEGER, Buffer.from([LDAP_VERSION])),
      berElement(TAG_OCTET_STRING, Buffer.from(config.bindDn ?? "", "utf8")),
      berElement(
        TAG_SIMPLE_CREDENTIALS,
        Buffer.from(config.bindPassword ?? "", "utf8"),
      ),
    ]),
  );
  return berElement(
    TAG_SEQUENCE,
    Buffer.concat([berElement(TAG_INTEGER, Buffer.from([messageId])), request]),
  );
}

/** UnbindRequest: "I am leaving", and the server may close (§4.3). */
export function encodeUnbindRequest(
  messageId: number = UNBIND_MESSAGE_ID,
): Buffer {
  return berElement(
    TAG_SEQUENCE,
    Buffer.concat([
      berElement(TAG_INTEGER, Buffer.from([messageId])),
      berElement(TAG_UNBIND_REQUEST, Buffer.alloc(0)),
    ]),
  );
}

type BerRead =
  | { state: "ok"; tag: number; start: number; end: number }
  | { state: "partial" }
  | { state: "malformed" };

/**
 * Reads one tag-length-value header at `offset`.
 *
 * `end` is where the element's content stops, which may be past what has
 * arrived — the caller checks that, because for the outer message
 * "past what has arrived" means *wait* and for an inner one it means
 * *malformed*.
 */
function readElement(buffer: Buffer, offset: number): BerRead {
  if (offset + 2 > buffer.length) return { state: "partial" };
  const tag = buffer[offset]!;
  const first = buffer[offset + 1]!;

  if (first < 0x80) {
    const start = offset + 2;
    return { state: "ok", tag, start, end: start + first };
  }
  // 0x80 is the indefinite form: legal BER, forbidden by LDAP — RFC 4511
  // §5.1 mandates DER lengths — and unbounded, so it is refused rather
  // than chased. Over four length bytes describes more than 4GB, which
  // no directory is about to send in answer to a bind.
  const count = first & 0x7f;
  if (count === 0 || count > 4) return { state: "malformed" };
  if (offset + 2 + count > buffer.length) return { state: "partial" };

  let length = 0;
  for (let index = 0; index < count; index += 1) {
    // Multiplied rather than shifted: `<<` is a 32-bit *signed*
    // operation in JavaScript, so a four-byte length with the top bit
    // set would come back negative and every bounds check below it
    // would pass.
    length = length * 256 + buffer[offset + 2 + index]!;
  }
  const start = offset + 2 + count;
  return { state: "ok", tag, start, end: start + length };
}

export type BindRead =
  | { state: "partial" }
  | { state: "no-bind" }
  | { state: "bind"; resultCode: number; diagnosticMessage: string };

/**
 * Reads a BindResponse out of whatever has arrived so far.
 *
 * ```
 * LDAPMessage ::= SEQUENCE { messageID INTEGER, protocolOp CHOICE { ... } }
 * BindResponse ::= [APPLICATION 1] SEQUENCE {
 *   resultCode ENUMERATED, matchedDN LDAPDN, diagnosticMessage LDAPString, ... }
 * ```
 *
 * Anything that is not that shape is `no-bind` rather than an error: a
 * TLS alert (port 636), an HTTP response (port 80 behind a load
 * balancer) and the unsolicited "notice of disconnection" a shutting-down
 * directory sends are all things that are *there* and not answering a
 * bind, which is exactly what the assertion says.
 */
export function readBindResponse(buffer: Buffer): BindRead {
  const message = readElement(buffer, 0);
  if (message.state === "partial") return { state: "partial" };
  if (message.state === "malformed" || message.tag !== TAG_SEQUENCE) {
    return { state: "no-bind" };
  }
  // Checked before waiting for the bytes, so a peer that claims a
  // gigabyte is refused now rather than buffered until the timeout.
  if (message.end > MAX_MESSAGE) return { state: "no-bind" };
  if (buffer.length < message.end) return { state: "partial" };

  const messageId = readElement(buffer, message.start);
  if (messageId.state !== "ok" || messageId.tag !== TAG_INTEGER) {
    return { state: "no-bind" };
  }

  const operation = readElement(buffer, messageId.end);
  if (operation.state !== "ok" || operation.tag !== TAG_BIND_RESPONSE) {
    return { state: "no-bind" };
  }

  const code = readElement(buffer, operation.start);
  if (
    code.state !== "ok" ||
    code.tag !== TAG_ENUMERATED ||
    code.end > buffer.length ||
    code.end === code.start ||
    code.end - code.start > 4
  ) {
    return { state: "no-bind" };
  }
  let resultCode = 0;
  for (let index = code.start; index < code.end; index += 1) {
    resultCode = resultCode * 256 + buffer[index]!;
  }

  // matchedDN, which a bind never populates with anything an operator
  // needs, and then the diagnostic, which is the part they read.
  const matchedDn = readElement(buffer, code.end);
  if (matchedDn.state !== "ok" || matchedDn.tag !== TAG_OCTET_STRING) {
    return { state: "bind", resultCode, diagnosticMessage: "" };
  }
  const diagnostic = readElement(buffer, matchedDn.end);
  const diagnosticMessage =
    diagnostic.state === "ok" &&
    diagnostic.tag === TAG_OCTET_STRING &&
    diagnostic.end <= buffer.length
      ? buffer
          .toString("utf8", diagnostic.start, diagnostic.end)
          .slice(0, MAX_DIAGNOSTIC)
      : "";

  return { state: "bind", resultCode, diagnosticMessage };
}
