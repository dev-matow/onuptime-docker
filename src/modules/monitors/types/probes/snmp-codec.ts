import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

/**
 * SNMP on the wire: BER, the v1/v2c community message, and the v3 USM
 * message with its key derivation.
 *
 * Hand-rolled, like the MQTT and MySQL probes and for the same reason.
 * A check sends one GetRequest and reads one answer; `net-snmp` brings a
 * MIB compiler, a trap receiver, an agent and a table walker to do it,
 * none of which a monitor has any use for, and all of which would then
 * be in the image. What is left once those are gone is this file.
 *
 * Split out of `snmp.ts` because it is pure: no socket, no clock, no
 * randomness that is not passed in. Everything the check decides about
 * bytes is decided here and can be tested against a captured datagram,
 * which is a stronger test than any amount of round-tripping our own
 * encoder against our own decoder.
 *
 * Reference: RFC 1157 (v1), RFC 3416 (v2c PDUs), RFC 3412/3414 (v3
 * message and USM), RFC 3826 (AES).
 */

/** BER tags this codec knows, universal and SNMP-specific alike. */
export const TAG = {
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQUENCE: 0x30,
  IP_ADDRESS: 0x40,
  COUNTER32: 0x41,
  GAUGE32: 0x42,
  TIME_TICKS: 0x43,
  OPAQUE: 0x44,
  COUNTER64: 0x46,
  NO_SUCH_OBJECT: 0x80,
  NO_SUCH_INSTANCE: 0x81,
  END_OF_MIB_VIEW: 0x82,
  GET_REQUEST: 0xa0,
  GET_RESPONSE: 0xa2,
  REPORT: 0xa8,
} as const;

/** msgVersion on the wire. "2c" is 1: the c is the security model, not the number. */
export const WIRE_VERSION = { "1": 0, "2c": 1, "3": 3 } as const;

/** msgFlags (RFC 3412 §6.4). */
export const FLAG = { AUTH: 0x01, PRIV: 0x02, REPORTABLE: 0x04 } as const;

/** The USM security model number (RFC 3411 §5). */
export const USM_SECURITY_MODEL = 3;

/**
 * A datagram Vigil could not read as SNMP. Thrown rather than returned
 * because it can surface from a dozen places inside one parse, and the
 * probe's answer to all of them is the same: whatever answered on this
 * port was not an agent.
 */
export class SnmpDecodeError extends Error {}

/** A value this codec cannot put on the wire — a malformed OID, mostly. */
export class SnmpEncodeError extends Error {}

// ---------------------------------------------------------------- BER

/** How many bytes a tag-and-length header takes for a given content length. */
export function tlvHeaderLength(contentLength: number): number {
  if (contentLength < 0x80) return 2;
  if (contentLength <= 0xff) return 3;
  if (contentLength <= 0xffff) return 4;
  return 5;
}

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length <= 0xff) return Buffer.from([0x81, length]);
  if (length <= 0xffff) {
    return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
  }
  return Buffer.from([
    0x83,
    (length >> 16) & 0xff,
    (length >> 8) & 0xff,
    length & 0xff,
  ]);
}

export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([tag]),
    encodeLength(content.length),
    content,
  ]);
}

/**
 * A BER INTEGER: minimal two's complement, sign bit forced.
 *
 * The padding byte is not decoration. A request-id of 0x80000000 with
 * its top bit set and no leading zero is a *negative* integer to every
 * agent that reads it, and the reply then carries a request-id that
 * does not match the one we sent — a check that times out against a
 * healthy agent, roughly half the time, depending on the random id.
 */
export function encodeInteger(value: number): Buffer {
  // SNMP's INTEGER is 32 bits signed (RFC 2578 §7.1.1), and so is every
  // field this codec puts one in. The bound is checked rather than
  // assumed because the arithmetic below is bitwise, and a value past
  // 2^31 would be silently truncated into a different number.
  if (!Number.isInteger(value) || value > 0x7fffffff || value < -0x80000000) {
    throw new SnmpEncodeError(`Not a 32-bit integer: ${value}`);
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
    if (value < 0 && remaining === -1) break;
  } while (remaining !== 0 && remaining !== -1);
  const first = bytes[0] ?? 0;
  if (value >= 0 && (first & 0x80) !== 0) bytes.unshift(0x00);
  if (value < 0 && (first & 0x80) === 0) bytes.unshift(0xff);
  return tlv(TAG.INTEGER, Buffer.from(bytes));
}

export function encodeOctetString(value: Buffer | string): Buffer {
  return tlv(
    TAG.OCTET_STRING,
    typeof value === "string" ? Buffer.from(value, "utf8") : value,
  );
}

export function encodeNull(): Buffer {
  return tlv(TAG.NULL, Buffer.alloc(0));
}

export function encodeSequence(...parts: Buffer[]): Buffer {
  return tlv(TAG.SEQUENCE, Buffer.concat(parts));
}

/**
 * A dotted OID as BER: the first two arcs share a byte, the rest are
 * base-128 with a continuation bit.
 *
 * Sub-identifiers are read as `BigInt` because they are 32-bit unsigned
 * on the wire and some vendors use the full range in an index — an
 * enterprise OID carrying a serial number, say — which `1 << 31` in
 * JavaScript would turn negative.
 */
export function encodeOid(oid: string): Buffer {
  const arcs = oid.split(".");
  if (arcs.length < 2) {
    throw new SnmpEncodeError(`An OID needs at least two arcs: ${oid}`);
  }
  const numbers = arcs.map((arc) => {
    if (!/^\d+$/.test(arc)) throw new SnmpEncodeError(`Not an OID: ${oid}`);
    return BigInt(arc);
  });
  const first = numbers[0]!;
  const second = numbers[1]!;
  if (first > 2n || (first < 2n && second >= 40n)) {
    throw new SnmpEncodeError(`Not a legal OID prefix: ${oid}`);
  }
  const bytes: number[] = [];
  pushBase128(bytes, first * 40n + second);
  for (const arc of numbers.slice(2)) pushBase128(bytes, arc);
  return tlv(TAG.OID, Buffer.from(bytes));
}

function pushBase128(bytes: number[], value: bigint): void {
  const septets: number[] = [];
  let remaining = value;
  do {
    septets.unshift(Number(remaining & 0x7fn));
    remaining >>= 7n;
  } while (remaining > 0n);
  for (let index = 0; index < septets.length; index += 1) {
    const last = index === septets.length - 1;
    bytes.push(last ? septets[index]! : septets[index]! | 0x80);
  }
}

export interface Tlv {
  tag: number;
  content: Buffer;
  /** Offset just past this element, for the caller's cursor. */
  end: number;
}

/**
 * One tag-length-value at `offset`.
 *
 * Every bound is checked. The input is a datagram from an unauthenticated
 * source that says it is an agent, so a length field claiming four
 * kilobytes inside a sixty-byte packet is a thing that will arrive, and
 * `Buffer.subarray` would answer it with a short buffer rather than an
 * error — leaving the parse to fail somewhere further on, or not at all.
 */
export function readTlv(buffer: Buffer, offset: number): Tlv {
  if (offset + 2 > buffer.length)
    throw new SnmpDecodeError("Truncated element");
  const tag = buffer[offset]!;
  const lengthByte = buffer[offset + 1]!;
  let length = lengthByte;
  let cursor = offset + 2;
  if ((lengthByte & 0x80) !== 0) {
    const lengthBytes = lengthByte & 0x7f;
    // Indefinite length (0x80) is legal BER and illegal SNMP, and the
    // long form above four bytes cannot describe anything that fits in
    // a datagram. Both are refused rather than guessed at.
    if (lengthBytes === 0 || lengthBytes > 4) {
      throw new SnmpDecodeError("Unsupported BER length");
    }
    if (cursor + lengthBytes > buffer.length) {
      throw new SnmpDecodeError("Truncated length");
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = length * 256 + buffer[cursor + index]!;
    }
    cursor += lengthBytes;
  }
  if (cursor + length > buffer.length) {
    throw new SnmpDecodeError("Element runs past the end of the datagram");
  }
  return {
    tag,
    content: buffer.subarray(cursor, cursor + length),
    end: cursor + length,
  };
}

/** Reads a TLV and insists on the tag it must have. */
export function expectTlv(buffer: Buffer, offset: number, tag: number): Tlv {
  const element = readTlv(buffer, offset);
  if (element.tag !== tag) {
    throw new SnmpDecodeError(
      `Expected 0x${tag.toString(16)}, found 0x${element.tag.toString(16)}`,
    );
  }
  return element;
}

export function readSignedInteger(content: Buffer): number {
  if (content.length === 0) throw new SnmpDecodeError("Empty INTEGER");
  let value = 0n;
  for (const byte of content) value = (value << 8n) | BigInt(byte);
  if ((content[0]! & 0x80) !== 0) value -= 1n << BigInt(8 * content.length);
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new SnmpDecodeError("INTEGER out of range");
  }
  return Number(value);
}

export function readUnsignedInteger(content: Buffer): bigint {
  let value = 0n;
  for (const byte of content) value = (value << 8n) | BigInt(byte);
  return value;
}

export function readOid(content: Buffer): string {
  if (content.length === 0) throw new SnmpDecodeError("Empty OID");
  const arcs: bigint[] = [];
  let accumulator = 0n;
  let started = false;
  for (const byte of content) {
    accumulator = (accumulator << 7n) | BigInt(byte & 0x7f);
    started = true;
    if ((byte & 0x80) === 0) {
      arcs.push(accumulator);
      accumulator = 0n;
      started = false;
    }
  }
  if (started) throw new SnmpDecodeError("OID ends mid-arc");
  const first = arcs.shift()!;
  // The inverse of the shared first byte: arcs 0 and 1 hold at most 40
  // second-level arcs each, so anything at or above 80 belongs to arc 2.
  const head =
    first < 40n
      ? [0n, first]
      : first < 80n
        ? [1n, first - 40n]
        : [2n, first - 80n];
  return [...head, ...arcs].join(".");
}

// -------------------------------------------------------------- values

/** A varbind, as the facts want it rather than as BER left it. */
export interface DecodedVarbind {
  oid: string;
  /** The SNMP type name, for the timeline: "TimeTicks", "OctetString". */
  type: string;
  /** Printable form of the value, or null for a NULL / an exception. */
  value: string | null;
  /** The value as a number when it is one and fits; null otherwise. */
  numericValue: number | null;
  /**
   * The v2c "no value here" answers — `noSuchObject`, `noSuchInstance`,
   * `endOfMibView`. An agent that returns one of these is *answering*:
   * it is up, it understood, and it is telling us the object is not
   * there. That is a fact for the assertions to judge, not a failure to
   * measure.
   */
  exception: string | null;
}

const EXCEPTIONS: Readonly<Record<number, string>> = {
  [TAG.NO_SUCH_OBJECT]: "noSuchObject",
  [TAG.NO_SUCH_INSTANCE]: "noSuchInstance",
  [TAG.END_OF_MIB_VIEW]: "endOfMibView",
};

const TYPE_NAMES: Readonly<Record<number, string>> = {
  [TAG.INTEGER]: "Integer",
  [TAG.OCTET_STRING]: "OctetString",
  [TAG.NULL]: "Null",
  [TAG.OID]: "OID",
  [TAG.IP_ADDRESS]: "IpAddress",
  [TAG.COUNTER32]: "Counter32",
  [TAG.GAUGE32]: "Gauge32",
  [TAG.TIME_TICKS]: "TimeTicks",
  [TAG.OPAQUE]: "Opaque",
  [TAG.COUNTER64]: "Counter64",
};

/** Printable text, or hex when it is not text at all. */
function readOctetString(content: Buffer): string {
  // An OCTET STRING is bytes, and plenty of them are: a MAC address, a
  // sensor reading, an ifPhysAddress. Rendering those as UTF-8 produces
  // replacement characters that compare equal to each other, so an
  // `expectedValue` assertion on two different MACs would pass. Hex is
  // lossless and comparable.
  const printable = content.every(
    (byte) =>
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0d ||
      (byte >= 0x20 && byte < 0x7f),
  );
  if (printable) return content.toString("utf8");
  return `0x${content.toString("hex")}`;
}

function decodeValue(element: Tlv): Omit<DecodedVarbind, "oid"> {
  const exception = EXCEPTIONS[element.tag];
  if (exception !== undefined) {
    return { type: exception, value: null, numericValue: null, exception };
  }
  const type =
    TYPE_NAMES[element.tag] ?? `Unknown(0x${element.tag.toString(16)})`;
  switch (element.tag) {
    case TAG.INTEGER: {
      const value = readSignedInteger(element.content);
      return {
        type,
        value: String(value),
        numericValue: value,
        exception: null,
      };
    }
    case TAG.COUNTER32:
    case TAG.GAUGE32:
    case TAG.TIME_TICKS:
    case TAG.COUNTER64: {
      const value = readUnsignedInteger(element.content);
      return {
        type,
        value: value.toString(),
        // A Counter64 can exceed what a double represents exactly. The
        // string keeps the true value; the numeric fact declines rather
        // than reporting a rounded one that a threshold would then
        // compare against.
        numericValue:
          value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null,
        exception: null,
      };
    }
    case TAG.IP_ADDRESS: {
      if (element.content.length !== 4) {
        throw new SnmpDecodeError("IpAddress is not four bytes");
      }
      return {
        type,
        value: Array.from(element.content).join("."),
        numericValue: null,
        exception: null,
      };
    }
    case TAG.OID:
      return {
        type,
        value: readOid(element.content),
        numericValue: null,
        exception: null,
      };
    case TAG.NULL:
      return { type, value: null, numericValue: null, exception: null };
    default:
      return {
        type,
        value: readOctetString(element.content),
        numericValue: null,
        exception: null,
      };
  }
}

// ---------------------------------------------------------------- PDUs

export interface DecodedPdu {
  tag: number;
  requestId: number;
  /** `error-status` for a request PDU; for a Report it is always 0. */
  errorStatus: number;
  errorIndex: number;
  varbinds: DecodedVarbind[];
}

/** RFC 3416 §3. Named so an incident says what the agent actually refused. */
export const ERROR_STATUS: Readonly<Record<number, string>> = {
  0: "noError",
  1: "tooBig",
  2: "noSuchName",
  3: "badValue",
  4: "readOnly",
  5: "genErr",
  6: "noAccess",
  7: "wrongType",
  8: "wrongLength",
  9: "wrongEncoding",
  10: "wrongValue",
  11: "noCreation",
  12: "inconsistentValue",
  13: "resourceUnavailable",
  14: "commitFailed",
  15: "undoFailed",
  16: "authorizationError",
  17: "notWritable",
  18: "inconsistentName",
};

export function errorStatusName(status: number): string {
  return ERROR_STATUS[status] ?? `error-status ${status}`;
}

/** A GetRequest for exactly one OID, with a NULL value as the placeholder. */
export function encodeGetRequestPdu(requestId: number, oid: string): Buffer {
  return tlv(
    TAG.GET_REQUEST,
    Buffer.concat([
      encodeInteger(requestId),
      encodeInteger(0), // error-status: zero in a request (RFC 3416 §4.2.1)
      encodeInteger(0), // error-index
      encodeSequence(encodeSequence(encodeOid(oid), encodeNull())),
    ]),
  );
}

/** A PDU with no varbinds — what engine discovery sends (RFC 5343 §3.1). */
export function encodeEmptyGetRequestPdu(requestId: number): Buffer {
  return tlv(
    TAG.GET_REQUEST,
    Buffer.concat([
      encodeInteger(requestId),
      encodeInteger(0),
      encodeInteger(0),
      encodeSequence(),
    ]),
  );
}

/** A response PDU, for the test agent and for symmetry with the decoder. */
export function encodeResponsePdu(
  requestId: number,
  errorStatus: number,
  varbinds: readonly { oid: string; value: Buffer }[],
  tag: number = TAG.GET_RESPONSE,
): Buffer {
  return tlv(
    tag,
    Buffer.concat([
      encodeInteger(requestId),
      encodeInteger(errorStatus),
      encodeInteger(0),
      encodeSequence(
        ...varbinds.map((varbind) =>
          encodeSequence(encodeOid(varbind.oid), varbind.value),
        ),
      ),
    ]),
  );
}

export function decodePdu(buffer: Buffer, offset = 0): DecodedPdu {
  const pdu = readTlv(buffer, offset);
  // Any context-specific constructed tag: 0xa2 is the response every
  // agent sends, 0xa8 is the Report a v3 engine sends instead when it
  // will not process the request. Both are read the same way.
  if ((pdu.tag & 0xe0) !== 0xa0) {
    throw new SnmpDecodeError(`Not a PDU: 0x${pdu.tag.toString(16)}`);
  }
  const requestId = expectTlv(pdu.content, 0, TAG.INTEGER);
  const errorStatus = expectTlv(pdu.content, requestId.end, TAG.INTEGER);
  const errorIndex = expectTlv(pdu.content, errorStatus.end, TAG.INTEGER);
  const list = expectTlv(pdu.content, errorIndex.end, TAG.SEQUENCE);

  const varbinds: DecodedVarbind[] = [];
  let cursor = 0;
  while (cursor < list.content.length) {
    const entry = expectTlv(list.content, cursor, TAG.SEQUENCE);
    const oid = expectTlv(entry.content, 0, TAG.OID);
    const value = readTlv(entry.content, oid.end);
    varbinds.push({ oid: readOid(oid.content), ...decodeValue(value) });
    cursor = entry.end;
  }

  return {
    tag: pdu.tag,
    requestId: readSignedInteger(requestId.content),
    errorStatus: readSignedInteger(errorStatus.content),
    errorIndex: readSignedInteger(errorIndex.content),
    varbinds,
  };
}

// ------------------------------------------------------- v1/v2c message

export function encodeCommunityMessage(
  wireVersion: number,
  community: string,
  pdu: Buffer,
): Buffer {
  return encodeSequence(
    encodeInteger(wireVersion),
    encodeOctetString(community),
    pdu,
  );
}

export interface CommunityMessage {
  wireVersion: number;
  community: string;
  pdu: DecodedPdu;
}

export function decodeCommunityMessage(datagram: Buffer): CommunityMessage {
  const message = expectTlv(datagram, 0, TAG.SEQUENCE);
  const version = expectTlv(message.content, 0, TAG.INTEGER);
  const community = expectTlv(message.content, version.end, TAG.OCTET_STRING);
  return {
    wireVersion: readSignedInteger(version.content),
    community: community.content.toString("utf8"),
    pdu: decodePdu(message.content, community.end),
  };
}

/** The version an incoming datagram claims, without parsing the rest. */
export function peekVersion(datagram: Buffer): number {
  const message = expectTlv(datagram, 0, TAG.SEQUENCE);
  return readSignedInteger(expectTlv(message.content, 0, TAG.INTEGER).content);
}

// --------------------------------------------------------- v3 (RFC 3412)

export interface UsmParameters {
  engineId: Buffer;
  engineBoots: number;
  engineTime: number;
  userName: string;
  authParams: Buffer;
  privParams: Buffer;
}

export interface V3MessageParts {
  msgId: number;
  flags: number;
  usm: UsmParameters;
  /** Plaintext ScopedPDU, or the ciphertext when `encrypted` is set. */
  scopedPdu: Buffer;
  encrypted: boolean;
}

/**
 * The largest response Vigil will accept, in the field that tells the
 * agent so. One varbind never approaches it; the number is here because
 * the field is not optional and an agent may legitimately fragment its
 * answer to fit whatever we claim.
 */
export const MAX_MESSAGE_SIZE = 65507;

export interface EncodedV3Message {
  message: Buffer;
  /**
   * Where `msgAuthenticationParameters` starts inside `message`.
   *
   * Computed rather than searched for. The digest is taken over the
   * whole message with this field zeroed and then written back into it
   * (RFC 3414 §6.3.1), so something has to know the offset; finding it
   * with `indexOf` would work until the day a scoped PDU happens to
   * contain twelve zero bytes, and then it would corrupt the message
   * instead of failing.
   */
  authParamsOffset: number;
}

export function encodeV3Message(parts: V3MessageParts): EncodedV3Message {
  const version = encodeInteger(3);
  const globalData = encodeSequence(
    encodeInteger(parts.msgId),
    encodeInteger(MAX_MESSAGE_SIZE),
    encodeOctetString(Buffer.from([parts.flags])),
    encodeInteger(USM_SECURITY_MODEL),
  );

  const before = [
    encodeOctetString(parts.usm.engineId),
    encodeInteger(parts.usm.engineBoots),
    encodeInteger(parts.usm.engineTime),
    encodeOctetString(parts.usm.userName),
  ];
  const authField = encodeOctetString(parts.usm.authParams);
  const usmContent = Buffer.concat([
    ...before,
    authField,
    encodeOctetString(parts.usm.privParams),
  ]);
  const usmParameters = tlv(TAG.SEQUENCE, usmContent);
  const securityParameters = encodeOctetString(usmParameters);
  const payload = parts.encrypted
    ? encodeOctetString(parts.scopedPdu)
    : parts.scopedPdu;

  const body = Buffer.concat([
    version,
    globalData,
    securityParameters,
    payload,
  ]);
  const message = tlv(TAG.SEQUENCE, body);

  const beforeLength = before.reduce((total, part) => total + part.length, 0);
  const authParamsOffset =
    tlvHeaderLength(body.length) +
    version.length +
    globalData.length +
    tlvHeaderLength(usmParameters.length) +
    tlvHeaderLength(usmContent.length) +
    beforeLength +
    tlvHeaderLength(parts.usm.authParams.length);

  return { message, authParamsOffset };
}

export interface DecodedV3Message extends V3MessageParts {
  /** Where the digest sits in the datagram, for verification in place. */
  authParamsOffset: number;
  raw: Buffer;
}

export function decodeV3Message(datagram: Buffer): DecodedV3Message {
  const message = expectTlv(datagram, 0, TAG.SEQUENCE);
  // Offsets are tracked against the datagram rather than against the
  // SEQUENCE content, because the digest is computed over the whole
  // datagram and the verifier needs an absolute position.
  const base = message.end - message.content.length;
  const version = expectTlv(message.content, 0, TAG.INTEGER);
  if (readSignedInteger(version.content) !== 3) {
    throw new SnmpDecodeError("Not an SNMPv3 message");
  }
  const globalData = expectTlv(message.content, version.end, TAG.SEQUENCE);
  const msgId = expectTlv(globalData.content, 0, TAG.INTEGER);
  const maxSize = expectTlv(globalData.content, msgId.end, TAG.INTEGER);
  const flags = expectTlv(globalData.content, maxSize.end, TAG.OCTET_STRING);
  if (flags.content.length !== 1) {
    throw new SnmpDecodeError("msgFlags is not one byte");
  }

  const securityParameters = expectTlv(
    message.content,
    globalData.end,
    TAG.OCTET_STRING,
  );
  const usmStart =
    base + securityParameters.end - securityParameters.content.length;
  const usm = expectTlv(securityParameters.content, 0, TAG.SEQUENCE);
  const usmBase = usmStart + (usm.end - usm.content.length);

  const engineId = expectTlv(usm.content, 0, TAG.OCTET_STRING);
  const boots = expectTlv(usm.content, engineId.end, TAG.INTEGER);
  const time = expectTlv(usm.content, boots.end, TAG.INTEGER);
  const userName = expectTlv(usm.content, time.end, TAG.OCTET_STRING);
  const authParams = expectTlv(usm.content, userName.end, TAG.OCTET_STRING);
  const privParams = expectTlv(usm.content, authParams.end, TAG.OCTET_STRING);

  const flagByte = flags.content[0]!;
  const encrypted = (flagByte & FLAG.PRIV) !== 0;
  const payload = readTlv(message.content, securityParameters.end);
  if (encrypted && payload.tag !== TAG.OCTET_STRING) {
    throw new SnmpDecodeError("An encrypted ScopedPDU must be an OCTET STRING");
  }

  return {
    msgId: readSignedInteger(msgId.content),
    flags: flagByte,
    usm: {
      engineId: engineId.content,
      engineBoots: readSignedInteger(boots.content),
      engineTime: readSignedInteger(time.content),
      userName: userName.content.toString("utf8"),
      authParams: authParams.content,
      privParams: privParams.content,
    },
    // The plaintext case keeps the whole element — a ScopedPDU is a
    // SEQUENCE and the decoder below reads it as one.
    scopedPdu: encrypted
      ? payload.content
      : message.content.subarray(securityParameters.end, payload.end),
    encrypted,
    authParamsOffset: usmBase + (authParams.end - authParams.content.length),
    raw: datagram,
  };
}

export function encodeScopedPdu(
  contextEngineId: Buffer,
  contextName: string,
  pdu: Buffer,
): Buffer {
  return encodeSequence(
    encodeOctetString(contextEngineId),
    encodeOctetString(contextName),
    pdu,
  );
}

export function decodeScopedPdu(buffer: Buffer): DecodedPdu {
  const scoped = expectTlv(buffer, 0, TAG.SEQUENCE);
  const contextEngineId = expectTlv(scoped.content, 0, TAG.OCTET_STRING);
  const contextName = expectTlv(
    scoped.content,
    contextEngineId.end,
    TAG.OCTET_STRING,
  );
  return decodePdu(scoped.content, contextName.end);
}

// ------------------------------------------------------- USM (RFC 3414)

export type AuthProtocol = "MD5" | "SHA";
export type PrivProtocol = "AES";

const DIGESTS: Readonly<Record<AuthProtocol, string>> = {
  MD5: "md5",
  SHA: "sha1",
};

/** Digest length on the wire — both of these are truncated to 96 bits. */
export const AUTH_PARAM_LENGTH = 12;

/**
 * Password to key, then key to engine (RFC 3414 §A.2).
 *
 * The megabyte of repeated password is the specification, not a
 * mistake: hashing 2^20 bytes is what makes a dictionary attack on a
 * captured digest expensive. It costs a few milliseconds per check,
 * which is why the result is cached by the probe for the life of one
 * check rather than recomputed per message.
 */
export function passwordToKey(
  password: string,
  engineId: Buffer,
  protocol: AuthProtocol,
): Buffer {
  const algorithm = DIGESTS[protocol];
  const source = Buffer.from(password, "utf8");
  if (source.length === 0) {
    throw new SnmpEncodeError("An SNMPv3 password cannot be empty");
  }
  const expanded = createHash(algorithm);
  // Sixty-four bytes at a time, with the password wrapping across the
  // boundary — which is the whole reason this is a byte loop and not a
  // prebuilt block hashed sixteen times. A block that does not divide
  // by the password length restarts the password at every block, and
  // the key that comes out is subtly wrong: it round-trips perfectly
  // against another copy of the same bug, and authenticates against no
  // real agent in the world.
  const block = Buffer.alloc(64);
  let cursor = 0;
  for (let written = 0; written < 1048576; written += block.length) {
    for (let index = 0; index < block.length; index += 1) {
      block[index] = source[cursor % source.length]!;
      cursor += 1;
    }
    expanded.update(block);
  }
  const ku = expanded.digest();
  return createHash(algorithm)
    .update(Buffer.concat([ku, engineId, ku]))
    .digest();
}

/** The digest over a message whose auth field is already zeroed. */
export function digestFor(
  message: Buffer,
  key: Buffer,
  protocol: AuthProtocol,
): Buffer {
  return createHmac(DIGESTS[protocol], key)
    .update(message)
    .digest()
    .subarray(0, AUTH_PARAM_LENGTH);
}

/** Writes the digest into the message, in place. */
export function authenticateMessage(
  encoded: EncodedV3Message,
  key: Buffer,
  protocol: AuthProtocol,
): Buffer {
  const digest = digestFor(encoded.message, key, protocol);
  digest.copy(encoded.message, encoded.authParamsOffset);
  return encoded.message;
}

/**
 * Is this datagram's digest the one our key produces?
 *
 * Constant-time comparison is deliberate overkill — the attacker would
 * need to be the agent — but the alternative is a timing oracle written
 * into a security check, and there is no reason to leave one there.
 */
export function verifyMessage(
  decoded: DecodedV3Message,
  key: Buffer,
  protocol: AuthProtocol,
): boolean {
  if (decoded.usm.authParams.length !== AUTH_PARAM_LENGTH) return false;
  const zeroed = Buffer.from(decoded.raw);
  zeroed.fill(
    0,
    decoded.authParamsOffset,
    decoded.authParamsOffset + AUTH_PARAM_LENGTH,
  );
  const expected = digestFor(zeroed, key, protocol);
  let difference = 0;
  for (let index = 0; index < AUTH_PARAM_LENGTH; index += 1) {
    difference |= expected[index]! ^ decoded.usm.authParams[index]!;
  }
  return difference === 0;
}

/**
 * AES-128-CFB, keyed and IV'd as RFC 3826 §3.1 says.
 *
 * DES is the other privacy protocol USM defines and Vigil does not
 * offer it: OpenSSL 3 moved single DES to the legacy provider, so
 * `createCipheriv("des-cbc")` throws on a default Node build. Shipping
 * a selector for a protocol that cannot run would be worse than saying
 * so — see the spec, where the limitation is written down.
 */
export function privacyKey(localizedKey: Buffer): Buffer {
  if (localizedKey.length < 16) {
    throw new SnmpEncodeError("Localized key is too short for AES-128");
  }
  return localizedKey.subarray(0, 16);
}

function aesIv(boots: number, time: number, salt: Buffer): Buffer {
  if (salt.length !== 8)
    throw new SnmpDecodeError("Privacy salt is not eight bytes");
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(boots >>> 0, 0);
  iv.writeUInt32BE(time >>> 0, 4);
  salt.copy(iv, 8);
  return iv;
}

export function encryptScopedPdu(
  scopedPdu: Buffer,
  key: Buffer,
  boots: number,
  time: number,
  salt: Buffer,
): Buffer {
  const cipher = createCipheriv(
    "aes-128-cfb",
    privacyKey(key),
    aesIv(boots, time, salt),
  );
  // CFB is a stream mode, so the ciphertext is exactly as long as the
  // plaintext and there is no padding to strip on the way back.
  return Buffer.concat([cipher.update(scopedPdu), cipher.final()]);
}

export function decryptScopedPdu(
  ciphertext: Buffer,
  key: Buffer,
  boots: number,
  time: number,
  salt: Buffer,
): Buffer {
  const decipher = createDecipheriv(
    "aes-128-cfb",
    privacyKey(key),
    aesIv(boots, time, salt),
  );
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * The usmStats counters an engine reports instead of an answer
 * (RFC 3414 §5). Every one of them is the agent talking — it received
 * the message, decoded enough of it to object, and said which objection
 * — so they are recorded as facts and judged, never returned as a
 * failure to reach anything.
 */
export const USM_STATS: Readonly<Record<string, string>> = {
  "1.3.6.1.6.3.15.1.1.1.0": "unsupportedSecurityLevel",
  "1.3.6.1.6.3.15.1.1.2.0": "notInTimeWindow",
  "1.3.6.1.6.3.15.1.1.3.0": "unknownUserName",
  "1.3.6.1.6.3.15.1.1.4.0": "unknownEngineID",
  "1.3.6.1.6.3.15.1.1.5.0": "wrongDigest",
  "1.3.6.1.6.3.15.1.1.6.0": "decryptionError",
};

/** What a Report PDU is complaining about, in words. */
export function reportReason(pdu: DecodedPdu): string {
  const varbind = pdu.varbinds[0];
  if (varbind === undefined) return "an unspecified report";
  return USM_STATS[varbind.oid] ?? varbind.oid;
}
