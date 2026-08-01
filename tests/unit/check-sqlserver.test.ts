// @covers-type: sqlserver
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import {
  ENCRYPT_NOT_SUPPORTED,
  ENCRYPT_OFF,
  ENCRYPT_REQUIRED,
  sqlserverProbe,
} from "@/modules/monitors/types/probes/sqlserver";
import {
  parseSqlServerConnection,
  sqlserverSpec,
  type SqlServerConfig,
} from "@/modules/monitors/types/specs/sqlserver";

/**
 * A SQL Server that exists only on loopback.
 *
 * The fixture speaks TDS rather than standing in for it: it frames real
 * packets, parses the PRELOGIN option table, decodes the LOGIN7 offsets
 * and reverses the password obfuscation, and answers with a real token
 * stream. That is the point — a mocked `sqlserverProbe` would prove the
 * probe's own beliefs about the protocol, and the credential this thing
 * reads back is the credential the wire actually carried.
 */

/** Type, status, length (BE), SPID, packet id, window. */
const PACKET_HEADER_BYTES = 8;
const PACKET_SQL_BATCH = 0x01;
const PACKET_TABULAR_RESULT = 0x04;
const PACKET_LOGIN7 = 0x10;
const PACKET_PRELOGIN = 0x12;
const PRELOGIN_TERMINATOR = 0xff;

interface Observed {
  username: string;
  password: string;
  database: string;
  appName: string;
  statements: string[];
  /** What the client asked for in the PRELOGIN ENCRYPTION option. */
  encryptionOffered: number | null;
}

interface FakeServer {
  port: number;
  observed: Observed;
  close: () => Promise<void>;
}

interface FakeOptions {
  /** What PRELOGIN answers. */
  encryption?: number;
  /** The credential the server will accept. */
  password?: string;
  /** Answer the batch with an error instead of a row. */
  failQuery?: boolean;
  /** Accept the socket and then say nothing at all. */
  silent?: boolean;
  /** Answer with bytes that are not TDS. */
  gibberish?: boolean;
}

const servers: FakeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startServer(options: FakeOptions = {}): Promise<FakeServer> {
  const observed: Observed = {
    username: "",
    password: "",
    database: "",
    appName: "",
    statements: [],
    encryptionOffered: null,
  };

  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    // A probe that has seen enough destroys its socket, which arrives
    // here as ECONNRESET. Without a listener that is an unhandled error
    // event, and the fixture takes the test run down with it.
    socket.on("error", () => undefined);
    socket.on("close", () => connections.delete(socket));

    let buffered: Buffer = Buffer.alloc(0);
    if (options.gibberish) {
      socket.end(Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n", "latin1"));
      return;
    }
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < PACKET_HEADER_BYTES) return;
        const type = buffered.readUInt8(0);
        const length = buffered.readUInt16BE(2);
        if (buffered.length < length) return;
        const payload = buffered.subarray(PACKET_HEADER_BYTES, length);
        buffered = buffered.subarray(length);
        if (options.silent) continue;
        handle(socket, type, payload, observed, options);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const fake: FakeServer = {
    port,
    observed,
    close: () =>
      new Promise<void>((resolve) => {
        // `close` waits for open connections, and a probe that timed out
        // deliberately left one open. Dropping them is what makes the
        // teardown finish rather than hang for the hook's whole budget.
        for (const socket of connections) socket.destroy();
        server.close(() => resolve());
      }),
  };
  servers.push(fake);
  return fake;
}

function handle(
  socket: net.Socket,
  type: number,
  payload: Buffer,
  observed: Observed,
  options: FakeOptions,
): void {
  if (type === PACKET_PRELOGIN) {
    observed.encryptionOffered = readOfferedEncryption(payload);
    socket.write(
      respond(preloginAnswer(options.encryption ?? ENCRYPT_NOT_SUPPORTED)),
    );
    return;
  }

  if (type === PACKET_LOGIN7) {
    readLogin(payload, observed);
    const expected = options.password ?? observed.password;
    if (observed.password !== expected) {
      socket.write(
        respond(
          Buffer.concat([
            errorToken(18456, `Login failed for user '${observed.username}'.`),
            doneToken(0x0002, 0),
          ]),
        ),
      );
      return;
    }
    socket.write(respond(Buffer.concat([loginAck(), doneToken(0x0000, 0)])));
    return;
  }

  if (type === PACKET_SQL_BATCH) {
    // The transaction-descriptor header comes first and declares its own
    // total length; the statement is everything after it.
    const headerBytes = payload.readUInt32LE(0);
    observed.statements.push(payload.toString("ucs2", headerBytes));
    if (options.failQuery) {
      socket.write(
        respond(
          Buffer.concat([
            errorToken(945, "Database 'app' cannot be opened."),
            doneToken(0x0002, 0),
          ]),
        ),
      );
      return;
    }
    socket.write(
      respond(
        Buffer.concat([columnMetadata(), rowToken(1), doneToken(0x0010, 1)]),
      ),
    );
  }
}

/** Wraps a payload in the one packet type a server ever sends. */
function respond(payload: Buffer): Buffer {
  const packet = Buffer.alloc(PACKET_HEADER_BYTES + payload.length);
  packet.writeUInt8(PACKET_TABULAR_RESULT, 0);
  packet.writeUInt8(0x01, 1);
  packet.writeUInt16BE(packet.length, 2);
  payload.copy(packet, PACKET_HEADER_BYTES);
  return packet;
}

function readOfferedEncryption(payload: Buffer): number | null {
  let cursor = 0;
  while (cursor < payload.length) {
    const token = payload.readUInt8(cursor);
    if (token === PRELOGIN_TERMINATOR) return null;
    const offset = payload.readUInt16BE(cursor + 1);
    cursor += 5;
    if (token === 0x01) return payload.readUInt8(offset);
  }
  return null;
}

/** VERSION 16.0.4085 and the negotiated encryption byte. */
function preloginAnswer(encryption: number): Buffer {
  const version = Buffer.alloc(6);
  version.writeUInt8(16, 0);
  version.writeUInt8(0, 1);
  version.writeUInt16BE(4085, 2);
  const table = Buffer.alloc(11);
  table.writeUInt8(0x00, 0);
  table.writeUInt16BE(11, 1);
  table.writeUInt16BE(6, 3);
  table.writeUInt8(0x01, 5);
  table.writeUInt16BE(17, 6);
  table.writeUInt16BE(1, 8);
  table.writeUInt8(PRELOGIN_TERMINATOR, 10);
  return Buffer.concat([table, version, Buffer.from([encryption])]);
}

/** Reads the LOGIN7 offset table and un-obfuscates the password. */
function readLogin(payload: Buffer, observed: Observed): void {
  const field = (position: number): string => {
    const offset = payload.readUInt16LE(position);
    const characters = payload.readUInt16LE(position + 2);
    return payload.toString("ucs2", offset, offset + characters * 2);
  };
  observed.username = field(40);
  observed.appName = field(48);
  observed.database = field(68);

  const passwordOffset = payload.readUInt16LE(44);
  const passwordChars = payload.readUInt16LE(46);
  const scrambled = payload.subarray(
    passwordOffset,
    passwordOffset + passwordChars * 2,
  );
  const plain = Buffer.alloc(scrambled.length);
  for (let index = 0; index < scrambled.length; index += 1) {
    const byte = scrambled.readUInt8(index) ^ 0xa5;
    plain.writeUInt8(((byte << 4) | (byte >> 4)) & 0xff, index);
  }
  observed.password = plain.toString("ucs2");
}

function loginAck(): Buffer {
  const name = Buffer.from("Microsoft SQL Server", "ucs2");
  const body = Buffer.alloc(6 + 1 + name.length + 4);
  body.writeUInt8(1, 0); // Interface.
  body.writeUInt32BE(0x74000004, 1);
  body.writeUInt8(name.length / 2, 5);
  name.copy(body, 6);
  body.writeUInt8(16, 6 + name.length); // Major version.
  return token(0xad, body);
}

function errorToken(number: number, message: string): Buffer {
  const text = Buffer.from(message, "ucs2");
  const server = Buffer.from("fixture", "ucs2");
  const body = Buffer.alloc(8 + text.length + 1 + server.length + 1 + 4);
  body.writeUInt32LE(number, 0);
  body.writeUInt8(1, 4); // State.
  body.writeUInt8(14, 5); // Class.
  body.writeUInt16LE(text.length / 2, 6);
  text.copy(body, 8);
  let cursor = 8 + text.length;
  body.writeUInt8(server.length / 2, cursor);
  cursor += 1;
  server.copy(body, cursor);
  cursor += server.length;
  body.writeUInt8(0, cursor); // Empty procedure name.
  return token(0xaa, body);
}

function columnMetadata(): Buffer {
  const name = Buffer.from("c", "ucs2");
  const body = Buffer.alloc(2 + 4 + 2 + 2 + 1 + name.length);
  body.writeUInt16LE(1, 0); // One column.
  body.writeUInt32LE(0, 2); // User type.
  body.writeUInt16LE(0, 6); // Flags.
  body.writeUInt8(0x26, 8); // INTNTYPE.
  body.writeUInt8(4, 9); // Four bytes wide.
  body.writeUInt8(name.length / 2, 10);
  name.copy(body, 11);
  return Buffer.concat([Buffer.from([0x81]), body]);
}

function rowToken(value: number): Buffer {
  const body = Buffer.alloc(5);
  body.writeUInt8(4, 0);
  body.writeInt32LE(value, 1);
  return Buffer.concat([Buffer.from([0xd1]), body]);
}

function doneToken(status: number, rowCount: number): Buffer {
  const body = Buffer.alloc(13);
  body.writeUInt8(0xfd, 0);
  body.writeUInt16LE(status, 1);
  body.writeUInt16LE(0xc1, 3);
  body.writeBigUInt64LE(BigInt(rowCount), 5);
  return body;
}

/** A variable-length token: type, length in bytes, body. */
function token(type: number, body: Buffer): Buffer {
  const header = Buffer.alloc(3);
  header.writeUInt8(type, 0);
  header.writeUInt16LE(body.length, 1);
  return Buffer.concat([header, body]);
}

const CONFIG: SqlServerConfig = { degradedThresholdMs: 3_000 };

function contextFor(
  target: string,
  overrides: Partial<ProbeContext<SqlServerConfig>> = {},
): ProbeContext<SqlServerConfig> {
  return {
    target,
    port: null,
    config: CONFIG,
    timeoutMs: 3_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
    ...overrides,
  };
}

describe("the SQL Server probe against a server that speaks TDS", () => {
  it("reports the version, the login and the query the server answered", async () => {
    const server = await startServer();
    const result = await sqlserverProbe(
      contextFor(`sqlserver://sa:pw@127.0.0.1:${server.port}/app`),
    );

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      preloginOk: true,
      serverVersion: "16.0.4085",
      encryptionRequired: false,
      loginOk: true,
      queryOk: true,
      serverError: null,
    });
    expect(typeof result.responseTimeMs).toBe("number");
  });

  it("sends the login, the password and the database from the connection string", async () => {
    // The percent escapes matter: a SQL Server password is exactly the
    // kind of string that contains an @ and a /, and sending it still
    // encoded would fail authentication with a message that says "wrong
    // password" and means "wrong parser".
    const server = await startServer({ password: "p@ss/w0rd" });
    await sqlserverProbe(
      contextFor(
        `sqlserver://vigil:p%40ss%2Fw0rd@127.0.0.1:${server.port}/app`,
      ),
    );

    expect(server.observed).toMatchObject({
      username: "vigil",
      password: "p@ss/w0rd",
      database: "app",
    });
  });

  it("names itself to the server so a DBA can see what keeps connecting", async () => {
    const server = await startServer();
    await sqlserverProbe(
      contextFor(`sqlserver://sa:pw@127.0.0.1:${server.port}/app`),
    );

    expect(server.observed.appName).toBe("vigil");
  });

  it("runs the smallest query there is", async () => {
    const server = await startServer();
    await sqlserverProbe(
      contextFor(`sqlserver://sa:pw@127.0.0.1:${server.port}/app`),
    );

    expect(server.observed.statements).toEqual(["SELECT 1"]);
  });

  it("asks for an unencrypted login, because it cannot speak the other kind", async () => {
    const server = await startServer();
    await sqlserverProbe(
      contextFor(`sqlserver://sa:pw@127.0.0.1:${server.port}/app`),
    );

    expect(server.observed.encryptionOffered).toBe(ENCRYPT_NOT_SUPPORTED);
  });

  it("reports a refused login as an answer, not as a transport failure", async () => {
    const server = await startServer({ password: "the-right-one" });
    const result = await sqlserverProbe(
      contextFor(`sqlserver://sa:the-wrong-one@127.0.0.1:${server.port}/app`),
    );

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      preloginOk: true,
      loginOk: false,
      queryOk: null,
    });
    expect(String(result.facts.serverError)).toContain("Login failed");
  });

  it("reports a query the server refused to run after signing the check in", async () => {
    const server = await startServer({ failQuery: true });
    const result = await sqlserverProbe(
      contextFor(`sqlserver://sa:pw@127.0.0.1:${server.port}/app`),
    );

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({ loginOk: true, queryOk: false });
    expect(String(result.facts.serverError)).toContain("cannot be opened");
  });

  it.each([
    ["demands encryption outright", ENCRYPT_REQUIRED],
    ["will only encrypt the login packet", ENCRYPT_OFF],
  ])(
    "stops after the greeting when the server %s",
    async (_name, encryption) => {
      // ENCRYPT_OFF does not mean "off" — it means "encrypt the login and
      // nothing after it", which needs the same TLS handshake. Both have
      // to leave `loginOk` unknown rather than false: the credential was
      // never sent, so nothing refused it.
      const server = await startServer({ encryption });
      const result = await sqlserverProbe(
        contextFor(`sqlserver://sa:pw@127.0.0.1:${server.port}/app`),
      );

      expect(result.error).toBeNull();
      expect(result.facts).toMatchObject({
        preloginOk: true,
        serverVersion: "16.0.4085",
        encryptionRequired: true,
        loginOk: null,
        queryOk: null,
      });
      expect(server.observed.username).toBe("");
    },
  );

  it("never sends the password to a server that asked for it encrypted", async () => {
    const server = await startServer({ encryption: ENCRYPT_REQUIRED });
    await sqlserverProbe(
      contextFor(`sqlserver://sa:hunter2@127.0.0.1:${server.port}/app`),
    );

    expect(server.observed.password).toBe("");
  });
});

describe("the SQL Server probe against something that is not one", () => {
  it("reports a peer that answers on 1433 without speaking TDS", async () => {
    const server = await startServer({ gibberish: true });
    const result = await sqlserverProbe(
      contextFor(`sqlserver://sa:pw@127.0.0.1:${server.port}/app`),
    );

    // The connection worked, so this is an observation and not a
    // transport error. The type's own assertion turns it into a verdict.
    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      preloginOk: false,
      loginOk: null,
      queryOk: null,
    });
  });

  it("reports a refused connection as a transport failure", async () => {
    const closed = await startServer();
    await closed.close();
    const result = await sqlserverProbe(
      contextFor(`sqlserver://sa:pw@127.0.0.1:${closed.port}/app`),
    );

    expect(result.error).toBeTruthy();
    expect(result.facts.preloginOk).toBeUndefined();
  });

  it("gives up on a server that accepts the socket and then says nothing", async () => {
    const server = await startServer({ silent: true });
    const result = await sqlserverProbe(
      contextFor(`sqlserver://sa:pw@127.0.0.1:${server.port}/app`, {
        timeoutMs: 300,
      }),
    );

    expect(result.error).toBe("Timed out after 300ms");
  });

  it("refuses a private address unless private targets are allowed", async () => {
    const result = await sqlserverProbe(
      contextFor("sqlserver://sa:pw@localhost:1433/app", {
        allowPrivateTargets: false,
      }),
    );

    expect(result).toMatchObject({
      error: "Target resolves to a private address",
      responseTimeMs: null,
    });
  });

  it("refuses a target that is not a connection string at all", async () => {
    // The schema rejects this, but a row can predate the schema or
    // survive a downgrade, and the worker's hot path must not throw.
    const result = await sqlserverProbe(contextFor("db.example.com"));
    expect(result.error).toBe("Not a SQL Server connection string");
  });
});

describe("the SQL Server type's judgment", () => {
  const config = CONFIG;
  const assertion = (id: string) => {
    const found = sqlserverSpec.assertions.find((entry) => entry.id === id);
    if (!found) throw new Error(`No assertion ${id}`);
    return found;
  };

  it("calls a server that is not speaking TDS down", () => {
    expect(assertion("prelogin").evaluate(false, config)).toContain("TDS");
  });

  it("calls a refused login down", () => {
    expect(assertion("login").evaluate(false, config)).toBe(
      "The server refused the login",
    );
  });

  it("has no opinion on a login it was never allowed to attempt", () => {
    // The encryption case. A monitor that read down here would be
    // reporting on Vigil rather than on the server.
    expect(assertion("login").evaluate(null, config)).toBeNull();
    expect(assertion("query").evaluate(null, config)).toBeNull();
  });

  it("reports the server's answer as degraded when it is slower than the threshold", () => {
    expect(
      assertion("latency").evaluate(4_000, { degradedThresholdMs: 3_000 }),
    ).toBe("Answered in 4000ms, over the 3000ms threshold");
  });

  it("judges a healthy server up, and one it could not sign in to up as well", async () => {
    const server = await startServer();
    const healthy = await sqlserverProbe(
      contextFor(`sqlserver://sa:pw@127.0.0.1:${server.port}/app`),
    );
    expect(judge(sqlserverSpec.assertions, config, healthy).verdict).toBe("up");

    // The encryption case again, this time through the engine that
    // actually decides: every assertion with no boolean to read stays
    // quiet, and what is left is a server that greeted us on time.
    const encrypted = await startServer({ encryption: ENCRYPT_REQUIRED });
    const greeted = await sqlserverProbe(
      contextFor(`sqlserver://sa:pw@127.0.0.1:${encrypted.port}/app`),
    );
    expect(judge(sqlserverSpec.assertions, config, greeted).verdict).toBe("up");
  });

  it("judges a server that refuses the login down", async () => {
    const server = await startServer({ password: "the-right-one" });
    const result = await sqlserverProbe(
      contextFor(`sqlserver://sa:nope@127.0.0.1:${server.port}/app`),
    );
    const verdict = judge(sqlserverSpec.assertions, config, result);

    expect(verdict.verdict).toBe("down");
    expect(verdict.failedAssertions).toContain("login");
  });

  it("judges a peer that is not speaking TDS down", async () => {
    const server = await startServer({ gibberish: true });
    const result = await sqlserverProbe(
      contextFor(`sqlserver://sa:pw@127.0.0.1:${server.port}/app`),
    );

    expect(judge(sqlserverSpec.assertions, config, result).verdict).toBe(
      "down",
    );
  });
});

describe("the SQL Server connection string", () => {
  it("accepts both spellings an operator is likely to reach for", () => {
    for (const target of [
      "sqlserver://sa:pw@db.example.com:1433/app",
      "mssql://sa:pw@db.example.com/app",
    ]) {
      expect(sqlserverSpec.targetSchema.safeParse(target).success).toBe(true);
    }
  });

  it("defaults to 1433 when the string omits the port", () => {
    expect(
      parseSqlServerConnection("sqlserver://sa:pw@db.example.com/app"),
    ).toMatchObject({ port: 1433, database: "app" });
  });

  it("refuses a string with no login, and says what is missing", () => {
    const parsed = sqlserverSpec.targetSchema.safeParse(
      "sqlserver://db.example.com:1433/app",
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("with a login");
  });

  it("refuses a postgres connection string pasted into the wrong field", () => {
    expect(
      sqlserverSpec.targetSchema.safeParse(
        "postgres://sa:pw@db.example.com:5432/app",
      ).success,
    ).toBe(false);
  });

  it("keeps the password out of everything that describes the monitor", () => {
    // `describeTarget` is what an incident email, a webhook body and a
    // public status page print.
    const described = sqlserverSpec.describeTarget(
      "sqlserver://sa:hunter2@db.example.com:1433/app",
      null,
      CONFIG,
    );
    expect(described).toBe("db.example.com:1433/app");
    expect(described).not.toContain("hunter2");
  });

  it("redacts even a target it cannot parse", () => {
    expect(
      sqlserverSpec.describeTarget(
        "sqlserver:/broken@db.example.com",
        null,
        CONFIG,
      ),
    ).toBe("db.example.com");
  });

  it("keeps no secret in the config, because the credential is in the target", () => {
    // Stated as a test because the alternative — a password field in the
    // config blob that nobody declared in `secretFields` — is how a
    // credential reaches a browser.
    expect(sqlserverSpec.secretFields).toBeUndefined();
    expect(sqlserverSpec.storedSchema.parse({ password: "x" })).toBeNull();
  });

  it("survives a row whose config blob is junk", () => {
    for (const config of [null, undefined, {}, { nonsense: true }, 42]) {
      expect(() =>
        sqlserverSpec.fromRow({
          checkType: "sqlserver",
          url: "sqlserver://sa:pw@db.example.com:1433/app",
          port: null,
          method: "GET",
          intervalSeconds: 60,
          timeoutMs: 10_000,
          degradedThresholdMs: 2_500,
          expectedStatusCode: null,
          bodyKeyword: null,
          keywordAbsent: false,
          tlsCheck: false,
          tlsWarnDays: 14,
          config,
        }),
      ).not.toThrow();
    }
  });
});
