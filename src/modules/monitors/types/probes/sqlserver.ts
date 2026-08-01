import net from "node:net";

import type { ProbeContext, ProbeResult } from "../contract";
import {
  parseSqlServerConnection,
  type SqlServerConfig,
  type SqlServerConnection,
} from "../specs/sqlserver";
import { connectionErrorMessage, elapsedSince, refusesPrivate } from "./guard";

/**
 * A SQL Server login and one `SELECT 1`, spoken as TDS by hand.
 *
 * No driver, and that is a decision rather than an omission. `tedious`
 * is the only pure-JavaScript one, and it brings a connection pool, a
 * bulk-load implementation, an Azure identity chain and a full type
 * codec in order to ask a question that is three round trips of
 * length-prefixed bytes. Vigil ships one dependency for a database it
 * cannot avoid — its own — and adding a megabyte of client to watch
 * somebody else's is the trade the rest of the `probes/` directory
 * already refused for MySQL, MongoDB, Redis and MQTT.
 *
 * The conversation is the whole check:
 *
 *  1. **PRELOGIN.** The server answers with its version and how it feels
 *     about encryption. Getting a well-formed answer already proves more
 *     than a TCP connect does — something on 1433 is framing TDS.
 *  2. **LOGIN7.** The credentials from the connection string, and the
 *     database from its path. `fDatabase` is set to fatal, so a database
 *     that is offline, suspect or gone fails the login instead of
 *     silently dropping the session into `master` — which is exactly the
 *     outage an operator wants paged, and exactly the one a check that
 *     stopped at the greeting would miss.
 *  3. **SQL batch.** `SELECT 1`, because a server that has run out of
 *     worker threads or is stuck recovering accepts a login and then
 *     answers nothing. It is deliberately the smallest possible query:
 *     this runs against production every interval, so it must cost the
 *     monitored server nothing.
 *
 * **The login is plaintext.** TDS obfuscates the password with a fixed
 * nibble swap and an XOR, which is not encryption and never was; real
 * secrecy comes from TLS negotiated inside the PRELOGIN exchange, and
 * that is a TLS handshake tunnelled through TDS packets — a second
 * transport, not a flag. So this probe declares ENCRYPT_NOT_SUP and, when
 * the server insists on encryption (Force Encryption, or Azure SQL, which
 * always does), stops after the greeting and says so: `encryptionRequired`
 * is a fact, `loginOk` is null, and the login assertion has no opinion.
 * Reporting such a server as down would be reporting on Vigil.
 */

/** Type, status, length (big-endian), SPID, packet id, window. */
const PACKET_HEADER_BYTES = 8;

const PACKET_SQL_BATCH = 0x01;
const PACKET_LOGIN7 = 0x10;
const PACKET_PRELOGIN = 0x12;
/** Everything the server sends back, PRELOGIN response included. */
const PACKET_TABULAR_RESULT = 0x04;

/** Status bit marking the last packet of a message. */
const STATUS_END_OF_MESSAGE = 0x01;

/** The largest packet TDS can frame. A longer one is not TDS. */
const MAX_PACKET_BYTES = 32_767;

/**
 * How much of a message this probe will hold. The answers it expects run
 * to a few hundred bytes; without a ceiling, a peer that keeps sending
 * packets and never sets the end-of-message bit decides how much memory
 * the worker spends.
 */
const MAX_MESSAGE_BYTES = 256 * 1024;

/** Peer-supplied text lands in the ledger, one row per check. */
const MAX_TEXT_CHARS = 200;

const PRELOGIN_VERSION = 0x00;
const PRELOGIN_ENCRYPTION = 0x01;
const PRELOGIN_INSTANCE = 0x02;
const PRELOGIN_THREAD_ID = 0x03;
const PRELOGIN_MARS = 0x04;
const PRELOGIN_TERMINATOR = 0xff;

/** MS-TDS ENCRYPTION values, as sent and as answered. */
export const ENCRYPT_OFF = 0x00;
export const ENCRYPT_ON = 0x01;
export const ENCRYPT_NOT_SUPPORTED = 0x02;
export const ENCRYPT_REQUIRED = 0x03;

const TOKEN_RETURN_STATUS = 0x79;
const TOKEN_COLMETADATA = 0x81;
const TOKEN_ORDER = 0xa9;
const TOKEN_ERROR = 0xaa;
const TOKEN_INFO = 0xab;
const TOKEN_LOGINACK = 0xad;
const TOKEN_ENVCHANGE = 0xe3;
const TOKEN_DONE = 0xfd;
const TOKEN_DONE_PROC = 0xfe;
const TOKEN_DONE_IN_PROC = 0xff;

/** Status (2), current command (2), row count (8). */
const DONE_BODY_BYTES = 12;
const DONE_ERROR = 0x0002;
const DONE_COUNT = 0x0010;

/**
 * What the server records as the application and the host, and what a
 * DBA sees in `sys.dm_exec_sessions.program_name` when they ask who keeps
 * logging in every sixty seconds. Naming ourselves is the difference
 * between a mystery and a monitor.
 */
const CLIENT_NAME = "vigil";

/** TDS 7.4 — SQL Server 2012 and later. */
const TDS_VERSION = 0x74000004;

/** LOGIN7's fixed header, up to the first variable-length field. */
const LOGIN7_FIXED_BYTES = 94;

export async function sqlserverProbe(
  ctx: ProbeContext<SqlServerConfig>,
): Promise<ProbeResult> {
  // The target schema rejects this already, but a row can predate the
  // schema or survive a downgrade, and `new URL` throwing on the
  // worker's hot path would escape the probe entirely.
  const connection = parseSqlServerConnection(ctx.target);
  if (connection === null) {
    return {
      facts: {},
      responseTimeMs: null,
      statusCode: null,
      error: "Not a SQL Server connection string",
    };
  }

  const guard = await refusesPrivate(
    connection.hostname,
    ctx.allowPrivateTargets,
    ctx.lookup,
  );
  if (guard) {
    return { facts: {}, responseTimeMs: null, statusCode: null, error: guard };
  }

  const startedAt = performance.now();
  const socket = net.connect({
    host: connection.hostname,
    port: connection.port,
  });
  // Three round trips of a few hundred bytes each. Nagle would sit on
  // every one of them waiting for a payload that is never coming.
  socket.setNoDelay(true);

  // One deadline over the whole conversation, rather than an idle
  // timeout per read: `socket.setTimeout` is re-armed by every byte, so
  // a server that answers each step slowly could spend three timeouts
  // and still not be called late.
  const deadline = setTimeout(() => {
    socket.destroy(new Error(`Timed out after ${ctx.timeoutMs}ms`));
  }, ctx.timeoutMs);
  const messages = messagePump(socket);

  try {
    await connected(socket);
    return await converse(socket, messages, connection, startedAt);
  } catch (error) {
    const responseTimeMs = elapsedSince(startedAt);
    return {
      facts: { responseTimeMs },
      responseTimeMs,
      statusCode: null,
      // Never the empty string. The condition engine reads a falsy
      // `error` as "no transport failure" and would go on to judge a
      // refused connection by its latency alone — i.e. `up`.
      error: connectionErrorMessage(error, "The connection failed"),
    };
  } finally {
    clearTimeout(deadline);
    socket.destroy();
  }
}

/**
 * PRELOGIN, LOGIN7, `SELECT 1` — and the point at which each of them
 * stops being worth continuing.
 *
 * Every early return here is an *observation*: the connection worked and
 * what came back over it is the finding. Only the caller's catch block
 * reports a transport failure.
 */
async function converse(
  socket: net.Socket,
  messages: MessagePump,
  connection: SqlServerConnection,
  startedAt: number,
): Promise<ProbeResult> {
  socket.write(framePacket(PACKET_PRELOGIN, buildPrelogin()));
  const greeting = await messages.read();
  if (greeting === null) return notSpeakingTds(elapsedSince(startedAt));

  const prelogin = parsePrelogin(greeting);
  if (prelogin === null) return notSpeakingTds(elapsedSince(startedAt));

  const serverVersion = prelogin.version;
  // NOT_SUP is the only answer that permits a plaintext login. ENCRYPT_OFF
  // does not mean "off": it means "encrypt the login packet and nothing
  // after it", which still needs the TLS handshake this probe does not
  // speak. A server that sent no ENCRYPTION option at all has agreed to
  // nothing. All three are the same outcome here, and guessing otherwise
  // would send a credential to a server that asked for it to be
  // protected.
  if (prelogin.encryption !== ENCRYPT_NOT_SUPPORTED) {
    const responseTimeMs = elapsedSince(startedAt);
    return {
      facts: {
        preloginOk: true,
        serverVersion,
        encryptionRequired: true,
        // Null rather than false throughout: nothing was asked, so
        // nothing was refused. The assertions read a missing boolean as
        // "no opinion", which is the only honest verdict here.
        loginOk: null,
        queryOk: null,
        serverError: null,
        responseTimeMs,
      },
      responseTimeMs,
      statusCode: null,
      error: null,
    };
  }

  socket.write(framePacket(PACKET_LOGIN7, buildLogin7(connection)));
  const loginReply = await messages.read();
  if (loginReply === null) return notSpeakingTds(elapsedSince(startedAt));

  const login = scanTokens(loginReply);
  if (!login.loginAck) {
    const responseTimeMs = elapsedSince(startedAt);
    return {
      facts: {
        preloginOk: true,
        serverVersion,
        encryptionRequired: false,
        loginOk: false,
        queryOk: null,
        serverError:
          login.error ?? "The server ended the login without acknowledging it",
        responseTimeMs,
      },
      responseTimeMs,
      statusCode: null,
      error: null,
    };
  }

  socket.write(framePacket(PACKET_SQL_BATCH, buildBatch("SELECT 1")));
  const batchReply = await messages.read();
  if (batchReply === null) return notSpeakingTds(elapsedSince(startedAt));

  const batch = scanTokens(batchReply);
  const done = readTrailingDone(batchReply);
  const responseTimeMs = elapsedSince(startedAt);
  return {
    facts: {
      preloginOk: true,
      serverVersion,
      encryptionRequired: false,
      loginOk: true,
      queryOk: answeredQuery(batch, done),
      serverError: batch.error,
      responseTimeMs,
    },
    responseTimeMs,
    statusCode: null,
    error: null,
  };
}

/**
 * Whether the server actually ran the query.
 *
 * Three things have to hold, and each covers a way the previous one can
 * be true while the server is still broken: no error token (permission
 * revoked, database offline mid-session), column metadata (the batch
 * reached execution rather than being rejected at parse), and a DONE
 * that neither reports an error nor claims to have counted zero rows.
 *
 * The row itself is never decoded. Reading it would mean implementing
 * TDS's TYPE_INFO — a table of forty data types — to learn something the
 * server already stated in the row count of the token that closes every
 * batch.
 */
function answeredQuery(
  batch: TokenScan,
  done: { status: number; rowCount: number } | null,
): boolean {
  if (batch.error !== null || !batch.columns || done === null) return false;
  if ((done.status & DONE_ERROR) !== 0) return false;
  return (done.status & DONE_COUNT) === 0 || done.rowCount >= 1;
}

/**
 * Something is listening on this port and it is not framing TDS. Still
 * not a transport error — the connection worked, and what came back over
 * it is the finding.
 */
function notSpeakingTds(responseTimeMs: number): ProbeResult {
  return {
    facts: {
      preloginOk: false,
      serverVersion: null,
      encryptionRequired: null,
      loginOk: null,
      queryOk: null,
      serverError: null,
      responseTimeMs,
    },
    responseTimeMs,
    statusCode: null,
    error: null,
  };
}

function connected(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
}

interface MessagePump {
  /** The next whole message, or null when the peer is not framing TDS. */
  read(): Promise<Buffer | null>;
}

/**
 * Reassembles TDS messages from a socket, one awaited read at a time.
 *
 * A three-step conversation written as a `data` handler is a state
 * machine whose states are implicit, and the messages arrive split
 * across chunks in whatever way the network chose — so the handler ends
 * up owning both the framing and the protocol. Separating them means the
 * protocol reads as the three writes and three reads that it is.
 *
 * A rejection is a transport failure. A `null` is the peer answering
 * with something that is not TDS at all, which is an observation.
 */
function messagePump(socket: net.Socket): MessagePump {
  let buffered: Buffer = Buffer.alloc(0);
  let waiting: {
    resolve: (message: Buffer | null) => void;
    reject: (error: Error) => void;
  } | null = null;
  let failure: Error | null = null;

  const deliver = () => {
    if (!waiting) return;
    const take = takeMessage(buffered);
    if (take.state === "message") {
      const settle = waiting;
      waiting = null;
      buffered = take.rest;
      settle.resolve(take.payload);
      return;
    }
    if (take.state === "invalid") {
      const settle = waiting;
      waiting = null;
      settle.resolve(null);
      return;
    }
    // A complete message that arrived just before the socket died still
    // counts, which is why the failure is checked last.
    if (failure) {
      const settle = waiting;
      waiting = null;
      settle.reject(failure);
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    deliver();
  });
  socket.on("error", (error: Error) => {
    failure ??= error;
    deliver();
  });
  // Without this, a server that accepts the connection and then hangs up
  // says nothing until the deadline expires, and the operator reads "the
  // network ate it" instead of "the server dropped me".
  socket.on("close", () => {
    failure ??= new Error("The server closed the connection mid-conversation");
    deliver();
  });

  return {
    read(): Promise<Buffer | null> {
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        deliver();
      });
    },
  };
}

type MessageTake =
  | { state: "incomplete" }
  | { state: "invalid" }
  | { state: "message"; payload: Buffer; rest: Buffer };

/**
 * Takes one whole message off the front of a buffer.
 *
 * A message is one or more packets, the last of them carrying the
 * end-of-message bit; a server is free to split a result across packets
 * and SQL Server does exactly that for anything large. Pure, and
 * exported, because the framing is where a hostile peer gets to choose
 * numbers — the socket around it is plumbing.
 */
export function takeMessage(buffer: Buffer): MessageTake {
  const payloads: Buffer[] = [];
  let offset = 0;
  let total = 0;

  for (;;) {
    if (buffer.length - offset < PACKET_HEADER_BYTES) {
      return { state: "incomplete" };
    }
    const type = buffer.readUInt8(offset);
    const status = buffer.readUInt8(offset + 1);
    const length = buffer.readUInt16BE(offset + 2);
    // The only packet type a server sends in this conversation. Anything
    // else on 1433 — an HTTP server, a TLS `ServerHello`, a proxy's
    // error page — fails here rather than being parsed as a greeting.
    if (type !== PACKET_TABULAR_RESULT) return { state: "invalid" };
    if (length < PACKET_HEADER_BYTES || length > MAX_PACKET_BYTES) {
      return { state: "invalid" };
    }
    total += length - PACKET_HEADER_BYTES;
    if (total > MAX_MESSAGE_BYTES) return { state: "invalid" };
    if (buffer.length - offset < length) return { state: "incomplete" };

    payloads.push(
      buffer.subarray(offset + PACKET_HEADER_BYTES, offset + length),
    );
    offset += length;
    if ((status & STATUS_END_OF_MESSAGE) !== 0) {
      return {
        state: "message",
        payload: Buffer.concat(payloads),
        rest: buffer.subarray(offset),
      };
    }
  }
}

/**
 * Wraps a payload in a TDS packet header.
 *
 * Every message this probe sends fits in one packet — the login, the
 * largest, is a few hundred bytes against a 4096-byte negotiated size —
 * so there is no splitting to do and the end-of-message bit is always
 * set. A writer that could split would be code with no caller.
 */
export function framePacket(type: number, payload: Buffer): Buffer {
  const packet = Buffer.alloc(PACKET_HEADER_BYTES + payload.length);
  packet.writeUInt8(type, 0);
  packet.writeUInt8(STATUS_END_OF_MESSAGE, 1);
  packet.writeUInt16BE(packet.length, 2);
  packet.writeUInt16BE(0, 4); // SPID: the server assigns it, clients send 0.
  packet.writeUInt8(1, 6); // Packet id, only meaningful across a split.
  packet.writeUInt8(0, 7); // Window, unused by the protocol.
  payload.copy(packet, PACKET_HEADER_BYTES);
  return packet;
}

/**
 * The PRELOGIN options, as an offset table followed by the data.
 *
 * ENCRYPTION says NOT_SUP, which is the request that gets a plaintext
 * login out of a server that has not been told to force encryption. The
 * rest are the fields every client sends and this one has nothing
 * interesting to put in: no named instance, no MARS, and a version that
 * exists so the server has something to log.
 */
export function buildPrelogin(): Buffer {
  const version = Buffer.alloc(6);
  version.writeUInt8(1, 0);
  version.writeUInt8(0, 1);
  version.writeUInt16BE(0, 2);
  version.writeUInt16BE(0, 4);

  const options: { token: number; data: Buffer }[] = [
    { token: PRELOGIN_VERSION, data: version },
    { token: PRELOGIN_ENCRYPTION, data: Buffer.from([ENCRYPT_NOT_SUPPORTED]) },
    // The default instance, named by the empty string. A named instance
    // is reached through its own port, which is already in the target.
    { token: PRELOGIN_INSTANCE, data: Buffer.from([0x00]) },
    { token: PRELOGIN_THREAD_ID, data: Buffer.alloc(4) },
    { token: PRELOGIN_MARS, data: Buffer.from([0x00]) },
  ];

  const tableBytes = options.length * 5 + 1;
  const table = Buffer.alloc(tableBytes);
  let cursor = 0;
  let dataOffset = tableBytes;
  for (const option of options) {
    table.writeUInt8(option.token, cursor);
    table.writeUInt16BE(dataOffset, cursor + 1);
    table.writeUInt16BE(option.data.length, cursor + 3);
    cursor += 5;
    dataOffset += option.data.length;
  }
  table.writeUInt8(PRELOGIN_TERMINATOR, cursor);

  return Buffer.concat([table, ...options.map((option) => option.data)]);
}

export interface PreloginAnswer {
  /** `major.minor.build`, or null when the server sent no version. */
  version: string | null;
  encryption: number | null;
}

/**
 * Reads the server's PRELOGIN answer, or returns null when the payload
 * is not one.
 *
 * Pure, and exported, because this is where the decision to keep going
 * is made: the version is what the operator sees, and the encryption
 * byte decides whether a login is possible at all.
 */
export function parsePrelogin(payload: Buffer): PreloginAnswer | null {
  let version: string | null = null;
  let encryption: number | null = null;
  let cursor = 0;

  for (;;) {
    if (cursor >= payload.length) return null; // No terminator: not PRELOGIN.
    const token = payload.readUInt8(cursor);
    if (token === PRELOGIN_TERMINATOR) break;
    if (cursor + 5 > payload.length) return null;

    const offset = payload.readUInt16BE(cursor + 1);
    const length = payload.readUInt16BE(cursor + 3);
    cursor += 5;
    if (offset + length > payload.length) return null;

    if (token === PRELOGIN_VERSION && length >= 6) {
      const major = payload.readUInt8(offset);
      const minor = payload.readUInt8(offset + 1);
      const build = payload.readUInt16BE(offset + 2);
      version = `${major}.${minor}.${build}`;
    }
    if (token === PRELOGIN_ENCRYPTION && length >= 1) {
      encryption = payload.readUInt8(offset);
    }
  }

  // A terminator and nothing else is a table this probe cannot use, and
  // treating it as a greeting would report an unknown server as healthy.
  return version === null && encryption === null
    ? null
    : { version, encryption };
}

/**
 * The LOGIN7 message: a 94-byte fixed header of flags and offsets,
 * then the strings it points at in UCS-2.
 *
 * The offsets are why this is written out longhand rather than composed:
 * every one of them is a position in the buffer being built, so the
 * table and the data have to be laid out together or they describe
 * different things.
 */
export function buildLogin7(connection: SqlServerConnection): Buffer {
  const hostName = ucs2(CLIENT_NAME);
  const userName = ucs2(connection.username);
  const password = obfuscatePassword(ucs2(connection.password));
  const appName = ucs2(CLIENT_NAME);
  const serverName = ucs2(connection.hostname);
  const libraryName = ucs2(CLIENT_NAME);
  const database = ucs2(connection.database ?? "");

  const variable = Buffer.concat([
    hostName,
    userName,
    password,
    appName,
    serverName,
    libraryName,
    database,
  ]);
  const login = Buffer.alloc(LOGIN7_FIXED_BYTES + variable.length);

  login.writeUInt32LE(login.length, 0);
  login.writeUInt32LE(TDS_VERSION, 4);
  login.writeUInt32LE(4096, 8); // Packet size we are willing to receive.
  login.writeUInt32LE(0, 12); // Client program version — the server logs it.
  login.writeUInt32LE(0, 16); // Client PID, same.
  login.writeUInt32LE(0, 20); // Connection id, for a client that pools.
  // fUseDB and fSetLang ask the server to warn on a change; fDatabase
  // makes a database it cannot open FATAL rather than a warning, which
  // is what turns "the application's database is offline" into a failed
  // login instead of a session quietly running in master.
  login.writeUInt8(0xe0, 24);
  // fLanguage fatal, fODBC on. fIntSecurity stays clear: this is SQL
  // authentication, the only kind a credential in a connection string
  // can express.
  login.writeUInt8(0x03, 25);
  login.writeUInt8(0x00, 26); // Type flags: not a read-only intent.
  login.writeUInt8(0x00, 27); // Option flags 3: no extension block.
  login.writeInt32LE(0, 28); // Client time zone.
  login.writeUInt32LE(0, 32); // Client LCID.

  let offset = LOGIN7_FIXED_BYTES;
  // Lengths in this table are in CHARACTERS, not bytes — the one place
  // in TDS where they differ, and the reason a password with a non-ASCII
  // character in it would otherwise be sent as twice its length.
  const place = (position: number, value: Buffer) => {
    login.writeUInt16LE(offset, position);
    login.writeUInt16LE(value.length / 2, position + 2);
    value.copy(login, offset);
    offset += value.length;
  };

  place(36, hostName);
  place(40, userName);
  place(44, password);
  place(48, appName);
  place(52, serverName);
  login.writeUInt16LE(0, 56); // Unused/extension offset.
  login.writeUInt16LE(0, 58);
  place(60, libraryName);
  login.writeUInt16LE(0, 64); // Language: the server's default.
  login.writeUInt16LE(0, 66);
  place(68, database);
  // ClientID at 72 is six bytes of MAC address. Zero: it identifies the
  // machine to the server's audit log and Vigil has nothing to prove.
  login.writeUInt16LE(0, 78); // SSPI blob offset — integrated auth only.
  login.writeUInt16LE(0, 80);
  login.writeUInt16LE(0, 82); // AttachDBFile.
  login.writeUInt16LE(0, 84);
  login.writeUInt16LE(0, 86); // ChangePassword.
  login.writeUInt16LE(0, 88);
  login.writeUInt32LE(0, 90); // Long SSPI length.

  return login;
}

/**
 * A SQL batch: the transaction-descriptor header every TDS 7.2+ server
 * requires, then the statement in UCS-2.
 *
 * The header is not optional and carries nothing interesting — a zero
 * descriptor means "no transaction", which is true. Omitting it makes
 * the server reject the batch with a protocol error, and the check would
 * then report a healthy database as unable to answer a query.
 */
export function buildBatch(statement: string): Buffer {
  const headers = Buffer.alloc(22);
  headers.writeUInt32LE(22, 0); // Total length, including this field.
  headers.writeUInt32LE(18, 4); // This header's length.
  headers.writeUInt16LE(0x0002, 8); // Transaction descriptor.
  headers.writeBigUInt64LE(0n, 10);
  headers.writeUInt32LE(1, 18); // Outstanding request count.
  return Buffer.concat([headers, ucs2(statement)]);
}

export interface TokenScan {
  /** The server accepted the login. */
  loginAck: boolean;
  /** The server began returning results — the batch reached execution. */
  columns: boolean;
  /** The first error the server reported, in its own words. */
  error: string | null;
}

/**
 * Walks a token stream far enough to learn whether the server said yes.
 *
 * It stops at the first token whose length it cannot compute — a data
 * row, whose shape is described by the column metadata in front of it.
 * Decoding rows would mean implementing TDS's whole type system to learn
 * nothing this check asks about, so the scan stops and
 * {@link readTrailingDone} reads the outcome off the end instead.
 *
 * Pure, and exported: this is where the server's answer becomes a fact.
 */
export function scanTokens(payload: Buffer): TokenScan {
  const scan: TokenScan = { loginAck: false, columns: false, error: null };
  let cursor = 0;

  while (cursor < payload.length) {
    const token = payload.readUInt8(cursor);
    cursor += 1;

    if (token === TOKEN_COLMETADATA) {
      scan.columns = true;
      return scan;
    }

    if (
      token === TOKEN_DONE ||
      token === TOKEN_DONE_PROC ||
      token === TOKEN_DONE_IN_PROC
    ) {
      cursor += DONE_BODY_BYTES;
      continue;
    }

    if (token === TOKEN_RETURN_STATUS) {
      cursor += 4;
      continue;
    }

    if (
      token !== TOKEN_ERROR &&
      token !== TOKEN_INFO &&
      token !== TOKEN_LOGINACK &&
      token !== TOKEN_ENVCHANGE &&
      token !== TOKEN_ORDER
    ) {
      // A token this scan cannot measure. Stopping is the only safe
      // move: guessing a length would make every following byte a
      // fabricated fact.
      return scan;
    }

    if (cursor + 2 > payload.length) return scan;
    const length = payload.readUInt16LE(cursor);
    cursor += 2;
    if (cursor + length > payload.length) return scan;
    const body = payload.subarray(cursor, cursor + length);
    cursor += length;

    if (token === TOKEN_LOGINACK) scan.loginAck = true;
    if (token === TOKEN_ERROR && scan.error === null) {
      scan.error = errorMessage(body);
    }
  }

  return scan;
}

/**
 * The message out of an ERROR token: number (4), state, class, then the
 * text as a character count and UCS-2.
 */
function errorMessage(body: Buffer): string {
  if (body.length < 9) return "The server reported an error it did not name";
  const number = body.readUInt32LE(0);
  const characters = body.readUInt16LE(6);
  const end = 8 + characters * 2;
  if (end > body.length) return `SQL Server error ${number}`;
  const text = body.toString("ucs2", 8, end).trim();
  return capped(text.length > 0 ? text : `SQL Server error ${number}`);
}

/**
 * The DONE token that closes every batch, read off the end of the
 * message.
 *
 * Reading backwards rather than forwards is what makes the row itself
 * skippable: DONE is fixed at thirteen bytes and is always last, so the
 * row count is reachable without decoding anything in front of it.
 */
export function readTrailingDone(
  payload: Buffer,
): { status: number; rowCount: number } | null {
  const start = payload.length - (1 + DONE_BODY_BYTES);
  if (start < 0) return null;
  const token = payload.readUInt8(start);
  if (
    token !== TOKEN_DONE &&
    token !== TOKEN_DONE_PROC &&
    token !== TOKEN_DONE_IN_PROC
  ) {
    return null;
  }
  return {
    status: payload.readUInt16LE(start + 1),
    // A count that overflows a JS integer is a count no assertion here
    // cares about, and `SELECT 1` returns one row.
    rowCount: Number(payload.readBigUInt64LE(start + 5)),
  };
}

/**
 * TDS's password obfuscation: swap each byte's nibbles, then XOR with
 * 0xA5.
 *
 * Reversible by anyone who has read the specification, which is the
 * whole reason this probe treats the login as plaintext and says so in
 * the type's help text. It is implemented because the server expects it,
 * not because it protects anything.
 */
export function obfuscatePassword(password: Buffer): Buffer {
  const scrambled = Buffer.alloc(password.length);
  for (let index = 0; index < password.length; index += 1) {
    const byte = password.readUInt8(index);
    scrambled.writeUInt8((((byte << 4) | (byte >> 4)) & 0xff) ^ 0xa5, index);
  }
  return scrambled;
}

function ucs2(value: string): Buffer {
  return Buffer.from(value, "ucs2");
}

function capped(value: string): string {
  return value.length > MAX_TEXT_CHARS
    ? `${value.slice(0, MAX_TEXT_CHARS)}…`
    : value;
}
