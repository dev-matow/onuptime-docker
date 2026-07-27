import { randomBytes } from "node:crypto";
import net from "node:net";

import type { ProbeContext, ProbeResult } from "../contract";
import { DEFAULT_MQTT_PORT } from "../catalog";
import { connackMessage, type MqttConfig } from "../specs/mqtt";
import { elapsedSince, refusesPrivate } from "./guard";

/**
 * One MQTT CONNECT, and the CONNACK the broker answers with.
 *
 * Spoken by hand rather than through a client library. The exchange is a
 * few dozen bytes out and four back, and this never publishes,
 * subscribes, or keeps a session alive — a driver would cost megabytes
 * of reconnect, queueing and session state that a check has no use for.
 *
 * The return code is a fact, not an error. A broker that refuses our
 * credentials is a broker that is running, and reporting that as a
 * transport failure would tell an operator their broker is unreachable
 * at the moment it is answering them.
 */

/** CONNECT (§3.1.1). The low nibble is reserved and must be zero. */
const CONNECT = 0x10;
/** CONNACK (§3.2.1) — by the spec, the first packet a broker sends. */
const CONNACK = 0x20;
/** MQTT 3.1.1 (§3.1.2.2). A 5.0 broker still accepts a 3.1.1 client. */
const PROTOCOL_LEVEL = 0x04;
/**
 * Clean session (§3.1.2.4), so the broker keeps nothing once we hang
 * up. A monitor must not leave subscriptions or queued messages
 * accumulating on the thing it is watching.
 */
const CLEAN_SESSION = 0x02;
const USERNAME_FLAG = 0x80;
const PASSWORD_FLAG = 0x40;
/**
 * Keep-alive in seconds (§3.1.2.10). Non-zero deliberately: the socket
 * is destroyed the moment CONNACK lands, but if the worker dies in
 * between, this is what gives the broker grounds to reap the half-open
 * session instead of holding it open indefinitely.
 */
const KEEP_ALIVE_SECONDS = 60;
const CLIENT_ID_PREFIX = "vigil-monitor-";

export async function mqttProbe(
  ctx: ProbeContext<MqttConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(ctx.target, ctx.allowPrivateTargets);
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const port = ctx.port ?? DEFAULT_MQTT_PORT;
  const connect = encodeConnect(ctx.config);
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
    socket.setTimeout(ctx.timeoutMs);
    socket.once("connect", () => {
      socket.write(connect);
    });
    socket.on("data", (chunk: Buffer) => {
      // TCP is a stream, so a four-byte CONNACK is entitled to arrive in
      // four events; a fixed header split across segments is not a
      // malformed packet. The buffer needs no cap — anything that is not
      // a CONNACK settles on the second byte, and a CONNACK settles on
      // the fourth, so there is nothing here for a peer to grow.
      buffered = Buffer.concat([buffered, chunk]);
      const read = readConnack(buffered);
      if (read.state === "partial") return;
      const responseTimeMs = elapsedSince(startedAt);
      settle(
        read.state === "connack"
          ? {
              facts: {
                connack: true,
                returnCode: read.returnCode,
                returnMessage: connackMessage(read.returnCode),
                responseTimeMs,
              },
              responseTimeMs,
              statusCode: null,
              error: null,
            }
          : noConnack(responseTimeMs),
      );
    });
    // A broker that takes the connection and then hangs up without
    // answering has still told us something. Handled rather than left to
    // the timeout because the inactivity timer stops with the socket:
    // without this the promise never settles and the worker slot leaks.
    socket.once("close", () => settle(noConnack(elapsedSince(startedAt))));
    socket.once("timeout", () => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: `Timed out after ${ctx.timeoutMs}ms`,
      });
    });
    socket.once("error", (error: Error) => {
      const responseTimeMs = elapsedSince(startedAt);
      settle({
        facts: { responseTimeMs },
        responseTimeMs,
        statusCode: null,
        error: error.message,
      });
    });
  });
}

/**
 * Something answered on the port, but not as a broker — or it closed
 * before it got round to it. Facts rather than an error: the connection
 * itself worked, so this is an observation about what is listening, and
 * the `connack` assertion is what turns it into a verdict.
 */
function noConnack(responseTimeMs: number): ProbeResult {
  return {
    facts: {
      connack: false,
      returnCode: null,
      returnMessage: null,
      responseTimeMs,
    },
    responseTimeMs,
    statusCode: null,
    error: null,
  };
}

export type ConnackRead =
  | { state: "partial" }
  | { state: "not-mqtt" }
  | { state: "connack"; returnCode: number };

/**
 * Reads a CONNACK out of whatever has arrived so far. Pure and exported,
 * because every decision this check makes about the wire lives here and
 * the socket around it is plumbing.
 */
export function readConnack(buffer: Buffer): ConnackRead {
  if (buffer.length < 2) return { state: "partial" };
  const remainingLength = buffer[1]!;
  // A 3.1.1 CONNACK has a remaining length of exactly 2, but a 5.0
  // broker declining a 3.1.1 CONNECT answers with properties appended
  // and a longer packet. The reason code still sits where we look for
  // it, and reading it out beats reporting a silence the broker never
  // gave us. Over 127 means a continuation bit, which no CONNACK has.
  if (buffer[0] !== CONNACK || remainingLength < 2 || remainingLength > 127) {
    return { state: "not-mqtt" };
  }
  if (buffer.length < 4) return { state: "partial" };
  // buffer[2] is session-present, which a clean session pins to zero.
  return { state: "connack", returnCode: buffer[3]! };
}

/**
 * A fresh client id per connection.
 *
 * A broker treats the client id as an identity and disconnects the
 * existing session when a second CONNECT arrives bearing the same one
 * (§3.1.4). A fixed id would have two monitors on one broker — or the
 * recovery loop re-probing while a scheduled check is still in flight —
 * take turns cutting each other off, and a probe cut off before its
 * CONNACK reports a broker outage that never happened. Twenty-two
 * characters, inside the 23 every broker must accept (§3.1.3.1).
 */
function newClientId(): string {
  return `${CLIENT_ID_PREFIX}${randomBytes(4).toString("hex")}`;
}

export function encodeConnect(
  config: MqttConfig,
  clientId: string = newClientId(),
): Buffer {
  const username = config.username;
  // §3.1.2.9 forbids a password without a user name. `mqttStoredSchema`
  // already refuses that pairing, so this is the second line: a config
  // blob written by hand must not be able to put a packet on the wire
  // that the broker is obliged to reject on our behalf.
  const password = username === null ? null : config.password;

  let flags = CLEAN_SESSION;
  if (username !== null) flags |= USERNAME_FLAG;
  if (password !== null) flags |= PASSWORD_FLAG;

  const keepAlive = Buffer.alloc(2);
  keepAlive.writeUInt16BE(KEEP_ALIVE_SECONDS, 0);

  const body = Buffer.concat([
    encodeString("MQTT"),
    Buffer.from([PROTOCOL_LEVEL, flags]),
    keepAlive,
    encodeString(clientId),
    ...(username === null ? [] : [encodeString(username)]),
    ...(password === null ? [] : [encodeString(password)]),
  ]);

  return Buffer.concat([
    Buffer.from([CONNECT]),
    encodeRemainingLength(body.length),
    body,
  ]);
}

/** A two-byte-length-prefixed string — how MQTT carries all of them (§1.5.3). */
function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const framed = Buffer.alloc(2 + bytes.length);
  framed.writeUInt16BE(bytes.length, 0);
  bytes.copy(framed, 2);
  return framed;
}

/**
 * Remaining Length (§2.2.3): seven bits of length per byte, top bit set
 * on every byte but the last. The loop earns its keep — a client id, a
 * user name and a password together outrun the 127 bytes one byte can
 * describe, and a CONNECT truncated at that boundary is a packet the
 * broker would refuse for reasons that have nothing to do with it.
 */
function encodeRemainingLength(length: number): Buffer {
  const bytes: number[] = [];
  let remaining = length;
  do {
    const septet = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(remaining > 0 ? septet | 0x80 : septet);
  } while (remaining > 0);
  return Buffer.from(bytes);
}
