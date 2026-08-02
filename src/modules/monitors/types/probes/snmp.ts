import dgram from "node:dgram";
import dns from "node:dns/promises";
import { randomBytes, randomInt } from "node:crypto";

import { egressBlockReason } from "../../egress";
import { classifyAddress } from "../../net";
import { DEFAULT_SNMP_PORT } from "../catalog";
import type { FactBag, ProbeContext, ProbeResult } from "../contract";
import type { SnmpConfig } from "../specs/snmp";
import { elapsedSince, refusesPrivate } from "./guard";
import {
  AUTH_PARAM_LENGTH,
  FLAG,
  SnmpDecodeError,
  SnmpEncodeError,
  TAG,
  WIRE_VERSION,
  authenticateMessage,
  decodeCommunityMessage,
  decodeScopedPdu,
  decodeV3Message,
  decryptScopedPdu,
  encodeCommunityMessage,
  encodeEmptyGetRequestPdu,
  encodeGetRequestPdu,
  encodeScopedPdu,
  encodeV3Message,
  encryptScopedPdu,
  errorStatusName,
  passwordToKey,
  reportReason,
  verifyMessage,
  type DecodedPdu,
  type DecodedVarbind,
} from "./snmp-codec";

/**
 * One SNMP GET, over UDP, in whichever version the monitor is set to.
 *
 * Three things about this probe are decisions rather than mechanics.
 *
 * **One request, no retries.** SNMP libraries retry by default because
 * UDP loses packets, and a lost packet would otherwise be an outage.
 * Vigil already has that mechanism and it is a better one: the failure
 * window. A dropped datagram fails one check, the window keeps the
 * incident closed, and the next check clears it — with the loss visible
 * on the timeline instead of hidden inside a probe that quietly asked
 * three times.
 *
 * **The socket is connected.** `dgram` can send to an address without
 * connecting, and then a host that answers with an ICMP port-unreachable
 * says nothing at all: the check waits out its whole timeout to learn
 * what the kernel already knew. A connected socket surfaces that as
 * `ECONNREFUSED`, and it also pins the peer, so a datagram from anywhere
 * else cannot be read as the agent's answer.
 *
 * **What the agent refuses is a fact.** `noSuchName`, `authorizationError`
 * and every v3 `usmStats` report mean the agent received the request,
 * understood it and declined — so they are recorded and judged, never
 * returned as a transport error. An operator whose community string is
 * wrong must not be told their switch is unreachable.
 */

/** RFC 3412 §6.4: we are prepared to receive a Report about this message. */
const REPORTABLE = FLAG.REPORTABLE;

/** How much of the check's timeout engine discovery may spend. */
const DISCOVERY_SHARE = 0.5;

/**
 * The floor under either half of a v3 exchange. A timeout so short that
 * a LAN round trip cannot fit inside it would report an outage for a
 * device that answered — better to overrun a badly-set timeout by a
 * fraction of a second than to invent a failure.
 */
const MINIMUM_EXCHANGE_MS = 250;

export async function snmpProbe(
  ctx: ProbeContext<SnmpConfig>,
): Promise<ProbeResult> {
  const guard = await refusesPrivate(
    ctx.target,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) return transportFailure(guard, null);

  let peer: { address: string; family: number };
  try {
    peer = await resolvePeer(ctx);
  } catch (error) {
    return error instanceof BlockedAddressError
      ? transportFailure(error.message, null)
      : transportFailure("DNS resolution failed", null);
  }

  const port = ctx.port ?? DEFAULT_SNMP_PORT;
  const socket = dgram.createSocket({
    type: peer.family === 6 ? "udp6" : "udp4",
  });
  const conversation = new Conversation(socket);

  try {
    await conversation.connect(peer.address, port, ctx.timeoutMs);
    return ctx.config.version === "3"
      ? await probeV3(conversation, ctx)
      : await probeCommunity(conversation, ctx);
  } catch (error) {
    return failureFor(error, ctx.timeoutMs);
  } finally {
    conversation.close();
  }
}

// ------------------------------------------------------------ v1 / v2c

async function probeCommunity(
  conversation: Conversation,
  ctx: ProbeContext<SnmpConfig>,
): Promise<ProbeResult> {
  const { community, oid, version } = ctx.config;
  if (community === null) {
    // Cleared by an operator, or never set on a row written by hand.
    // There is no anonymous mode in v1 or v2c, so this is a monitor that
    // cannot ask its question — an operator problem, and one that must
    // not read as an outage of the device.
    return unavailable(
      `SNMP ${version} authenticates with a community string, and this monitor has none.`,
    );
  }

  const requestId = newRequestId();
  const message = encodeCommunityMessage(
    WIRE_VERSION[version],
    community,
    encodeGetRequestPdu(requestId, oid),
  );

  const startedAt = performance.now();
  const reply = await conversation.exchange(
    message,
    ctx.timeoutMs,
    (datagram) => {
      const decoded = decodeCommunityMessage(datagram);
      // A late answer to an earlier request would otherwise be read as
      // this one's. Rare on a fresh socket, and free to rule out.
      return decoded.pdu.requestId === requestId ? decoded.pdu : null;
    },
  );

  return factsFor(reply, elapsedSince(startedAt), ctx.config);
}

// ------------------------------------------------------------------ v3

async function probeV3(
  conversation: Conversation,
  ctx: ProbeContext<SnmpConfig>,
): Promise<ProbeResult> {
  const config = ctx.config;
  const userName = config.v3Username;
  if (userName === null) {
    return unavailable(
      "SNMP v3 identifies the caller by user name, and this monitor has none.",
    );
  }
  // The stored schema refuses both of these, so reaching them means a
  // config blob written past it — by an import, or by hand. Sending the
  // request anyway would quietly downgrade the monitor to a security
  // level the operator did not choose, which is the one silent failure
  // a credential must never have.
  if (config.v3AuthProtocol !== null && config.v3AuthPassword === null) {
    return unavailable(
      `This monitor is set to authenticate with ${config.v3AuthProtocol} but has no pass phrase.`,
    );
  }
  if (config.v3PrivProtocol !== null && config.v3PrivPassword === null) {
    return unavailable(
      `This monitor is set to encrypt with ${config.v3PrivProtocol} but has no privacy pass phrase.`,
    );
  }

  const deadline = performance.now() + ctx.timeoutMs;

  // Engine discovery (RFC 3414 §4). Every v3 exchange needs the
  // authoritative engine's id, boot count and clock before it can be
  // authenticated, and only the engine can supply them — so the first
  // datagram is always this one, even at noAuthNoPriv.
  const discoveryMsgId = newRequestId();
  const discovery = encodeV3Message({
    msgId: discoveryMsgId,
    flags: REPORTABLE,
    usm: {
      engineId: Buffer.alloc(0),
      engineBoots: 0,
      engineTime: 0,
      userName: "",
      authParams: Buffer.alloc(0),
      privParams: Buffer.alloc(0),
    },
    scopedPdu: encodeScopedPdu(
      Buffer.alloc(0),
      "",
      encodeEmptyGetRequestPdu(newRequestId()),
    ),
    encrypted: false,
  });

  // Both exchanges share the monitor's one timeout, rather than each
  // getting the whole of it. A v3 check that could take twice as long
  // as its configured timeout would blow the worker's slot budget for a
  // reason no operator could see in the settings.
  const engine = await conversation.exchange(
    discovery.message,
    Math.max(MINIMUM_EXCHANGE_MS, Math.round(ctx.timeoutMs * DISCOVERY_SHARE)),
    (datagram) => {
      const decoded = decodeV3Message(datagram);
      return decoded.msgId === discoveryMsgId ? decoded : null;
    },
  );

  if (engine.usm.engineId.length === 0) {
    // A v3 engine that will not name itself cannot be spoken to at all;
    // this is what a v1-only agent answers when it is asked for v3.
    return unavailable(
      "The agent answered engine discovery without an engine id, so it is not speaking SNMPv3.",
    );
  }

  const authProtocol = config.v3AuthProtocol;
  const authKey =
    authProtocol === null || config.v3AuthPassword === null
      ? null
      : passwordToKey(config.v3AuthPassword, engine.usm.engineId, authProtocol);
  const privKey =
    config.v3PrivProtocol === null ||
    config.v3PrivPassword === null ||
    authProtocol === null
      ? null
      : passwordToKey(config.v3PrivPassword, engine.usm.engineId, authProtocol);

  let flags = REPORTABLE;
  if (authKey !== null) flags |= FLAG.AUTH;
  if (privKey !== null) flags |= FLAG.PRIV;

  const msgId = newRequestId();
  const requestId = newRequestId();
  const scopedPdu = encodeScopedPdu(
    engine.usm.engineId,
    "",
    encodeGetRequestPdu(requestId, config.oid),
  );
  const salt = randomBytes(8);
  const payload =
    privKey === null
      ? scopedPdu
      : encryptScopedPdu(
          scopedPdu,
          privKey,
          engine.usm.engineBoots,
          engine.usm.engineTime,
          salt,
        );

  const encoded = encodeV3Message({
    msgId,
    flags,
    usm: {
      engineId: engine.usm.engineId,
      // The engine's own numbers, echoed back. An agent rejects a
      // message whose clock is more than 150 seconds from its own
      // (RFC 3414 §3.2), which is why these are discovered per check
      // rather than remembered: a Vigil that slept through a device's
      // reboot would otherwise authenticate against a boot count that
      // no longer exists and be told `notInTimeWindow` for ever.
      engineBoots: engine.usm.engineBoots,
      engineTime: engine.usm.engineTime,
      userName,
      authParams:
        authKey === null ? Buffer.alloc(0) : Buffer.alloc(AUTH_PARAM_LENGTH),
      privParams: privKey === null ? Buffer.alloc(0) : salt,
    },
    scopedPdu: payload,
    encrypted: privKey !== null,
  });

  const message =
    authKey === null || authProtocol === null
      ? encoded.message
      : authenticateMessage(encoded, authKey, authProtocol);

  // Measured from here rather than from discovery, so the fact means
  // "how long the agent took to answer a GET" in every version. A v3
  // monitor whose latency silently included a second round trip would
  // not be comparable with the v2c monitor next to it.
  const startedAt = performance.now();
  const reply = await conversation.exchange(
    message,
    Math.max(MINIMUM_EXCHANGE_MS, Math.round(deadline - startedAt)),
    (datagram) => {
      const decoded = decodeV3Message(datagram);
      return decoded.msgId === msgId ? decoded : null;
    },
  );
  const responseTimeMs = elapsedSince(startedAt);

  // Only verify what claims to be authenticated. An engine that
  // objects to our security parameters answers with an unauthenticated
  // Report — it has nothing to authenticate with — and refusing to read
  // that would replace the one message that says *why* the credentials
  // were rejected with a timeout.
  if ((reply.flags & FLAG.AUTH) !== 0) {
    if (
      authKey === null ||
      authProtocol === null ||
      !verifyMessage(reply, authKey, authProtocol)
    ) {
      return transportFailure(
        "The agent's reply did not authenticate. The digest does not match this user's credentials.",
        responseTimeMs,
      );
    }
  }

  let scoped = reply.scopedPdu;
  if (reply.encrypted) {
    if (privKey === null) {
      return transportFailure(
        "The agent encrypted its reply, but this monitor has no privacy pass phrase to read it with.",
        responseTimeMs,
      );
    }
    scoped = decryptScopedPdu(
      scoped,
      privKey,
      reply.usm.engineBoots,
      reply.usm.engineTime,
      reply.usm.privParams,
    );
  }

  const pdu = decodeScopedPdu(scoped);
  if (pdu.tag === TAG.REPORT) {
    // The engine declining, in its own words: `unknownUserName`,
    // `wrongDigest`, `notInTimeWindow`. It answered, so this is a
    // measurement with an error status, exactly like a v1 `noSuchName`.
    return {
      facts: {
        oidFound: null,
        value: null,
        valueType: null,
        numericValue: null,
        errorStatus: reportReason(pdu),
        responseTimeMs,
      },
      responseTimeMs,
      statusCode: null,
      error: null,
    };
  }

  return factsFor(pdu, responseTimeMs, ctx.config);
}

// ------------------------------------------------------------- facts

/**
 * One decoded PDU as facts. Exported because this is where the wire
 * stops and the judgement starts, and it is the part worth testing
 * without a socket.
 */
export function factsFor(
  pdu: DecodedPdu,
  responseTimeMs: number,
  config: SnmpConfig,
): ProbeResult {
  const facts: FactBag = {
    oidFound: null,
    value: null,
    valueType: null,
    numericValue: null,
    errorStatus: null,
    responseTimeMs,
  };

  if (pdu.errorStatus !== 0) {
    // `oidFound` stays null rather than false: the agent said nothing
    // about the object, and "no value" would be a different claim from
    // "I will not tell you". The assertions read the two apart.
    facts.errorStatus = errorStatusName(pdu.errorStatus);
    return { facts, responseTimeMs, statusCode: null, error: null };
  }

  const varbind = matchingVarbind(pdu.varbinds, config.oid);
  if (varbind === undefined) {
    facts.oidFound = false;
    return { facts, responseTimeMs, statusCode: null, error: null };
  }

  if (varbind.exception !== null) {
    // v2c's answer for an object this device does not implement. The
    // exception name is the value type so the timeline says which of
    // the three it was.
    facts.oidFound = false;
    facts.valueType = varbind.exception;
    return { facts, responseTimeMs, statusCode: null, error: null };
  }

  facts.oidFound = true;
  facts.value = varbind.value;
  facts.valueType = varbind.type;
  facts.numericValue = varbind.numericValue;
  return { facts, responseTimeMs, statusCode: null, error: null };
}

/**
 * The varbind for the OID that was asked for.
 *
 * A conforming agent echoes it, so this all but always picks the first
 * one. It is checked because a GET whose answer is about a *different*
 * object is an answer to a different question — some agents treat an
 * unimplemented leaf as a GETNEXT — and letting that value through
 * would have an `expectedValue` assertion comparing against whatever
 * happened to sit next to it in the MIB.
 */
function matchingVarbind(
  varbinds: readonly DecodedVarbind[],
  oid: string,
): DecodedVarbind | undefined {
  return varbinds.find((varbind) => varbind.oid === oid);
}

// ------------------------------------------------------------- plumbing

class BlockedAddressError extends Error {}

/**
 * The address this probe will actually send to.
 *
 * `refusesPrivate` has already run, and this is not a second copy of
 * it: the guard resolves a name to decide policy and then hands the
 * *name* to whatever dials, which resolves again. Here the address that
 * came back is the address the datagram goes to, so the check and the
 * send cannot disagree — which is the residual `guard.ts` documents,
 * closed for this one probe because `dgram` lets us hold the address.
 */
async function resolvePeer(
  ctx: ProbeContext<SnmpConfig>,
): Promise<{ address: string; family: number }> {
  const lookup =
    ctx.lookup ?? ((host: string) => dns.lookup(host, { all: true }));
  const addresses = await lookup(ctx.target);
  const first = addresses[0];
  if (first === undefined) throw new Error("No addresses");
  if (!ctx.allowPrivateTargets) {
    const classification = classifyAddress(first.address) ?? "reserved";
    if (classification !== "public") {
      throw new BlockedAddressError(egressBlockReason(classification));
    }
  }
  return first;
}

class TimeoutError extends Error {}

/**
 * One UDP conversation: connect, send, wait for an answer that matches.
 *
 * Datagrams that do not match are dropped and the wait continues,
 * because a UDP socket is entitled to receive anything the peer sends
 * — including the answer to a request that had already timed out. The
 * alternative, taking the first datagram as the answer, is how a check
 * reports the wrong OID's value once in a blue moon.
 */
class Conversation {
  private readonly socket: dgram.Socket;
  private closed = false;

  constructor(socket: dgram.Socket) {
    this.socket = socket;
    // Errors arrive asynchronously and unattached to any send. Without a
    // permanent listener an ICMP port-unreachable becomes an unhandled
    // `error` event, which takes the worker down rather than the check.
    this.socket.on("error", () => undefined);
  }

  connect(address: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
      const onError = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.socket.once("error", onError);
      // Connecting a datagram socket sends nothing: it fixes the peer,
      // so `send` needs no address and anything arriving from elsewhere
      // is dropped by the kernel rather than parsed as an answer.
      this.socket.connect(port, address, () => {
        clearTimeout(timer);
        this.socket.removeListener("error", onError);
        resolve();
      });
    });
  }

  exchange<T>(
    message: Buffer,
    timeoutMs: number,
    match: (datagram: Buffer) => T | null,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket.removeListener("message", onMessage);
        this.socket.removeListener("error", onError);
        settle();
      };
      const timer = setTimeout(
        () => finish(() => reject(new TimeoutError())),
        timeoutMs,
      );
      const onMessage = (datagram: Buffer) => {
        let matched: T | null;
        try {
          matched = match(datagram);
        } catch (error) {
          // Undecodable: something on this port is not an agent. That is
          // a verdict about the port, so it ends the exchange rather
          // than being ignored like a mismatched request id.
          finish(() => reject(error));
          return;
        }
        if (matched === null) return;
        finish(() => resolve(matched));
      };
      const onError = (error: Error) => finish(() => reject(error));

      this.socket.on("message", onMessage);
      this.socket.once("error", onError);
      this.socket.send(message, (error) => {
        if (error) finish(() => reject(error));
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      // Already closed by an error on the socket. Nothing to do, and
      // certainly nothing worth replacing a measurement with.
    }
  }
}

function newRequestId(): number {
  // Positive and inside 31 bits: a request-id is a signed 32-bit
  // INTEGER, and a negative one is legal but reads as a bug in every
  // packet capture anyone will ever take of this.
  return randomInt(1, 0x7fffffff);
}

function failureFor(error: unknown, timeoutMs: number): ProbeResult {
  if (error instanceof TimeoutError) {
    return transportFailure(`No answer within ${timeoutMs}ms`, null);
  }
  if (error instanceof SnmpDecodeError) {
    return transportFailure(
      `The answer was not SNMP: ${error.message.toLowerCase()}`,
      null,
    );
  }
  if (error instanceof SnmpEncodeError) {
    // A stored config this build cannot put on the wire — an OID that
    // no encoder can represent, most likely written by an import. The
    // operator has to fix it; nothing about the device is known.
    return unavailable(error.message);
  }
  return transportFailure(error instanceof Error ? error.message : "", null);
}

function transportFailure(
  error: string,
  responseTimeMs: number | null,
): ProbeResult {
  return {
    facts: responseTimeMs === null ? {} : { responseTimeMs },
    responseTimeMs,
    statusCode: null,
    // Never the empty string: `judge` reads a falsy error as "no
    // transport failure" and would go on to judge the check by its
    // assertions, every one of which skips a fact that is not there.
    error: error.length > 0 ? error : "The request failed",
  };
}

/** Vigil could not ask — never `down`, always the operator's cue. */
function unavailable(reason: string): ProbeResult {
  return {
    facts: {},
    responseTimeMs: null,
    statusCode: null,
    error: null,
    unavailable: reason,
  };
}
