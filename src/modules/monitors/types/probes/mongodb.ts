import net from "node:net";

import type { ProbeContext, ProbeResult } from "../contract";
import { DEFAULT_MONGODB_PORT } from "../catalog";
import { type MongodbConfig } from "../specs/mongodb";
import { elapsedSince, refusesPrivate, connectionErrorMessage } from "./guard";

/**
 * A MongoDB `hello` handshake, spoken by hand.
 *
 * No driver. `mongodb` is roughly ten megabytes of connection pooling,
 * retryable writes and a full BSON codec to ask one question that needs
 * no credentials at all — `hello` is what a driver sends *before* it
 * authenticates, so a monitor never needs a database user.
 *
 * The message is OP_QUERY (opcode 2004) rather than OP_MSG. MongoDB 5.1
 * removed OP_QUERY for everything except this handshake, and kept it
 * here precisely because a client that does not yet know the server's
 * wire version has nothing else it can send. That makes it the one
 * opcode every server still answers, and it is a header and four fields
 * rather than OP_MSG's sections and checksums.
 *
 * Known limit: `hello` is a 5.0 command, backported to 4.4.2, 4.2.10,
 * 4.0.21 and 3.6.21 — so every supported release and most unsupported
 * ones answer it (4.0.28 does). A server older than those patch releases
 * replies `ok: 0`, CommandNotFound, which this type reads as down. Point
 * one of those at a `tcp` monitor: falling back to the legacy `isMaster`
 * alias would cost a second round trip on every check to cover releases
 * that left support in 2023.
 */

const OP_QUERY = 2004;
const OP_REPLY = 1;

/** messageLength, requestID, responseTo, opCode. */
const HEADER_BYTES = 16;
/** responseFlags, cursorID, startingFrom, numberReturned. */
const REPLY_PREAMBLE_BYTES = 20;
/** An OP_REPLY carrying no documents at all. */
const MIN_REPLY_BYTES = HEADER_BYTES + REPLY_PREAMBLE_BYTES;
/**
 * A hello reply is a few kilobytes. The cap is protection against a peer
 * that declares a length it will never fill, not a limit any real server
 * approaches — without it the worker buffers whatever it is sent for as
 * long as the check window allows.
 */
const MAX_REPLY_BYTES = 4 * 1024 * 1024;

/** One message per connection, so a fixed id is unambiguous. */
const REQUEST_ID = 1;

export async function mongodbProbe(
  ctx: ProbeContext<MongodbConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(ctx.target, ctx.allowPrivateTargets);
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_MONGODB_PORT;
  const startedAt = performance.now();

  return new Promise<ProbeResult>((resolve) => {
    const socket = net.connect({ host: ctx.target, port });
    let buffered: Buffer = Buffer.alloc(0);
    let settled = false;

    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(result);
    };

    const failed = (error: string) => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error,
      });
    };

    const answered = (reply: HelloReply) => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: {
          responseTimeMs,
          helloOk: reply.ok,
          maxWireVersion: reply.maxWireVersion,
          isPrimary: reply.isPrimary,
          replicaSet: reply.replicaSet,
        },
        responseTimeMs,
        statusCode: null,
        error: null,
      });
    };

    // `socket.setTimeout` is an *idle* timer: every byte resets it, so a
    // peer that dribbles one byte at a time holds the worker open long
    // past the check window without ever going idle. tcp.ts can rely on
    // the idle timer because it waits for a single event; this probe
    // waits for a reply that legitimately arrives in pieces, so it needs
    // a deadline over the whole exchange as well.
    const deadline = setTimeout(
      () => failed(`Timed out after ${ctx.timeoutMs}ms`),
      ctx.timeoutMs,
    );
    socket.setTimeout(ctx.timeoutMs);

    socket.once("connect", () => {
      socket.write(encodeHelloQuery());
    });

    socket.on("data", (chunk: Buffer) => {
      buffered =
        buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);

      // A `data` event is not a message. The reply is framed by the
      // length in its first four bytes and TCP is free to split it
      // anywhere, including inside that length.
      if (buffered.length < 4) return;
      const declared = buffered.readInt32LE(0);
      if (declared < MIN_REPLY_BYTES || declared > MAX_REPLY_BYTES) {
        // Whatever is listening framed its answer as something that is
        // not a MongoDB message, so there is no length to wait for. That
        // is an observation about the port, not a transport failure.
        answered(UNREADABLE);
        return;
      }
      if (buffered.length < declared) return;
      answered(readHelloReply(buffered.subarray(0, declared)));
    });

    socket.once("end", () =>
      failed("The server closed the connection before replying"),
    );
    socket.once("timeout", () => failed(`Timed out after ${ctx.timeoutMs}ms`));
    socket.once("error", (error: Error) =>
      failed(connectionErrorMessage(error, "Connection failed")),
    );
  });
}

/* ------------------------------------------------------------------ *
 * Encoding
 * ------------------------------------------------------------------ */

const BSON_DOUBLE = 0x01;
const BSON_STRING = 0x02;
const BSON_DOCUMENT = 0x03;
const BSON_ARRAY = 0x04;
const BSON_BINARY = 0x05;
const BSON_UNDEFINED = 0x06;
const BSON_OBJECT_ID = 0x07;
const BSON_BOOLEAN = 0x08;
const BSON_DATE = 0x09;
const BSON_NULL = 0x0a;
const BSON_REGEX = 0x0b;
const BSON_DB_POINTER = 0x0c;
const BSON_JAVASCRIPT = 0x0d;
const BSON_SYMBOL = 0x0e;
const BSON_CODE_WITH_SCOPE = 0x0f;
const BSON_INT32 = 0x10;
const BSON_TIMESTAMP = 0x11;
const BSON_INT64 = 0x12;
const BSON_DECIMAL128 = 0x13;
const BSON_MIN_KEY = 0xff;
const BSON_MAX_KEY = 0x7f;

function int32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeInt32LE(value, 0);
  return buffer;
}

/** A BSON element: type byte, NUL-terminated name, then the value. */
function element(type: number, name: string, value: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([type]),
    Buffer.from(`${name}\0`, "utf8"),
    value,
  ]);
}

/**
 * `{ hello: 1, helloOk: true }`.
 *
 * Two fields, so it is encoded here rather than by a BSON package. The
 * command name has to come first — OP_QUERY takes the document's first
 * key as the command being run.
 */
export function encodeHelloDocument(): Buffer {
  const elements = Buffer.concat([
    element(BSON_INT32, "hello", int32(1)),
    element(BSON_BOOLEAN, "helloOk", Buffer.from([1])),
  ]);
  // A document is its own length (which counts these four bytes), its
  // elements, then a terminating NUL.
  return Buffer.concat([
    int32(elements.length + 5),
    elements,
    Buffer.from([0]),
  ]);
}

/** The whole OP_QUERY message, ready to write. */
export function encodeHelloQuery(): Buffer {
  const body = Buffer.concat([
    // Flags stay 0. secondaryOk buys nothing here: the handshake is
    // answered by primaries and secondaries alike, which is what lets a
    // single monitor watch any member of a set.
    int32(0),
    Buffer.from("admin.$cmd\0", "utf8"),
    int32(0), // numberToSkip
    int32(-1), // numberToReturn: one document, no cursor left behind
    encodeHelloDocument(),
  ]);
  const header = Buffer.concat([
    int32(HEADER_BYTES + body.length), // messageLength counts the header
    int32(REQUEST_ID),
    int32(0), // responseTo
    int32(OP_QUERY),
  ]);
  return Buffer.concat([header, body]);
}

/* ------------------------------------------------------------------ *
 * Decoding
 * ------------------------------------------------------------------ */

export interface HelloReply {
  /** The reply's `ok` — did a MongoDB server answer the handshake. */
  ok: boolean;
  maxWireVersion: number | null;
  isPrimary: boolean | null;
  replicaSet: string | null;
}

/** Something answered, and none of it could be read as a hello. */
const UNREADABLE: HelloReply = {
  ok: false,
  maxWireVersion: null,
  isPrimary: null,
  replicaSet: null,
};

/**
 * Pulls the handshake out of an OP_REPLY. Pure, and exported, because
 * this is where every decision about the reply lives — the socket around
 * it is plumbing.
 */
export function readHelloReply(message: Buffer): HelloReply {
  if (message.length < MIN_REPLY_BYTES + 5) return UNREADABLE;
  if (message.readInt32LE(12) !== OP_REPLY) return UNREADABLE;
  // numberReturned. A reply carrying no document has nothing to read.
  if (message.readInt32LE(HEADER_BYTES + 16) < 1) return UNREADABLE;

  const at = MIN_REPLY_BYTES;
  const length = message.readInt32LE(at);
  if (length < 5 || at + length > message.length) return UNREADABLE;
  return readHelloDocument(message.subarray(at, at + length));
}

/**
 * Walks a BSON document's top-level fields and keeps the four that
 * matter.
 *
 * Tolerant on purpose. A hello reply carries a few dozen fields and
 * gains more with every server release, so this skips what it does not
 * recognise by length rather than decoding it. The type table below is
 * complete for that reason and not for elegance: `ok` is the *last*
 * field a MongoDB reply writes, so a walk that gives up early loses it,
 * and an unfamiliar field type would then read as an outage.
 *
 * When the walk cannot continue it stops and returns what it has. It
 * never throws — a partial read is still an observation, and the
 * `hello` assertion turns a missing `ok` into the verdict.
 */
function readHelloDocument(document: Buffer): HelloReply {
  const reply: HelloReply = { ...UNREADABLE };
  // Past the document's own int32 length; the trailing NUL ends the walk.
  let offset = 4;

  while (offset < document.length) {
    const type = document.readUInt8(offset);
    if (type === 0x00) break;

    const nameEnd = document.indexOf(0x00, offset + 1);
    if (nameEnd < 0) break;
    const name = document.toString("utf8", offset + 1, nameEnd);

    const valueAt = nameEnd + 1;
    const size = valueSize(document, type, valueAt);
    if (size === null || valueAt + size > document.length) break;

    switch (name) {
      case "ok":
        // Servers send a double; some proxies in front of one send an
        // int32, and both mean the same thing.
        if (type === BSON_DOUBLE) {
          reply.ok = document.readDoubleLE(valueAt) === 1;
        } else if (type === BSON_INT32) {
          reply.ok = document.readInt32LE(valueAt) === 1;
        }
        break;
      case "maxWireVersion":
        if (type === BSON_INT32) {
          reply.maxWireVersion = document.readInt32LE(valueAt);
        }
        break;
      // `ismaster` is what a server answers before 5.0 renamed the
      // field; both carry the same boolean.
      case "isWritablePrimary":
      case "ismaster":
        if (type === BSON_BOOLEAN) {
          reply.isPrimary = document.readUInt8(valueAt) === 1;
        }
        break;
      case "setName":
        if (type === BSON_STRING) {
          reply.replicaSet = readString(document, valueAt);
        }
        break;
    }

    offset = valueAt + size;
  }

  return reply;
}

/** A BSON string: int32 length, then that many bytes ending in a NUL. */
function readString(document: Buffer, at: number): string | null {
  const length = document.readInt32LE(at);
  if (length < 1 || at + 4 + length > document.length) return null;
  return document.toString("utf8", at + 4, at + 4 + length - 1);
}

/**
 * How many bytes a value of this type occupies, or null when that cannot
 * be worked out — which is the signal to stop walking rather than to
 * throw.
 */
function valueSize(document: Buffer, type: number, at: number): number | null {
  const declared = (): number | null =>
    at + 4 <= document.length ? document.readInt32LE(at) : null;

  switch (type) {
    case BSON_UNDEFINED:
    case BSON_NULL:
    case BSON_MIN_KEY:
    case BSON_MAX_KEY:
      return 0;
    case BSON_BOOLEAN:
      return 1;
    case BSON_INT32:
      return 4;
    case BSON_DOUBLE:
    case BSON_DATE:
    case BSON_TIMESTAMP:
    case BSON_INT64:
      return 8;
    case BSON_OBJECT_ID:
      return 12;
    case BSON_DECIMAL128:
      return 16;
    case BSON_STRING:
    case BSON_JAVASCRIPT:
    case BSON_SYMBOL: {
      // The length counts the trailing NUL but not itself.
      const length = declared();
      return length === null || length < 1 ? null : 4 + length;
    }
    case BSON_DOCUMENT:
    case BSON_ARRAY:
    case BSON_CODE_WITH_SCOPE: {
      // A nested document's length counts itself, so it is the size.
      const length = declared();
      return length === null || length < 5 ? null : length;
    }
    case BSON_BINARY: {
      const length = declared();
      return length === null || length < 0 ? null : 5 + length;
    }
    case BSON_DB_POINTER: {
      const length = declared();
      return length === null || length < 1 ? null : 4 + length + 12;
    }
    case BSON_REGEX: {
      // Two NUL-terminated strings back to back, with no length in front.
      const pattern = document.indexOf(0x00, at);
      if (pattern < 0) return null;
      const flags = document.indexOf(0x00, pattern + 1);
      return flags < 0 ? null : flags + 1 - at;
    }
    default:
      return null;
  }
}
