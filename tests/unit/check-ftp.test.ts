// @covers-type: ftp
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import { SECRET_MASK, redactConfig } from "@/modules/monitors/types/config";
import { ftpProbe, readReply } from "@/modules/monitors/types/probes/ftp";
import { ftpSpec, type FtpConfig } from "@/modules/monitors/types/specs/ftp";

/**
 * A real FTP control server on loopback, scripted reply by reply.
 *
 * The probe dials it over TCP and speaks RFC 959 to it, so these tests
 * exercise what runs in production: the socket, the read boundaries, the
 * multi-line parse and the hang-ups. A stubbed probe function would pass
 * while the real one mis-terminated a multi-line banner — which is the
 * bug this parser actually has.
 */
interface FtpScript {
  /** Sent as soon as the connection opens. Omit for a silent server. */
  greeting?: string;
  /** The answer to FEAT. */
  feat?: string;
  /** The answer to USER. */
  user?: string;
  /** The answer to PASS. */
  pass?: string;
  /** Hold the greeting back this long, to make the check slow. */
  greetingDelayMs?: number;
  /** Split the greeting into two writes at this index. */
  splitGreetingAt?: number;
  /** Hang up the moment the connection opens. */
  closeImmediately?: boolean;
}

interface Fixture {
  port: number;
  /** Every command line the server received, in order. */
  commands: string[];
  close: () => Promise<void>;
}

async function startFtpServer(script: FtpScript): Promise<Fixture> {
  const commands: string[] = [];
  const open = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    open.add(socket);
    // A test that makes the probe give up leaves the server writing into
    // a socket the client has destroyed; that is the scenario, not a
    // failure of the fixture.
    socket.on("error", () => undefined);
    socket.on("close", () => open.delete(socket));

    if (script.closeImmediately) {
      socket.end();
      return;
    }
    const banner = script.greeting;
    const greet = () => {
      if (banner === undefined) return;
      const split = script.splitGreetingAt;
      if (split === undefined) {
        socket.write(banner);
        return;
      }
      socket.write(banner.slice(0, split));
      setTimeout(() => socket.write(banner.slice(split)), 10);
    };
    if (script.greetingDelayMs) {
      setTimeout(greet, script.greetingDelayMs);
    } else {
      greet();
    }

    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const eol = buffer.indexOf("\n");
        if (eol === -1) return;
        const line = buffer.slice(0, eol).replace(/\r$/, "");
        buffer = buffer.slice(eol + 1);
        commands.push(line);

        const verb = line.split(" ")[0]?.toUpperCase();
        if (verb === "FEAT" && script.feat !== undefined) {
          socket.write(script.feat);
        }
        if (verb === "USER" && script.user !== undefined) {
          socket.write(script.user);
        }
        if (verb === "PASS" && script.pass !== undefined) {
          socket.write(script.pass);
        }
        if (verb === "QUIT") socket.end("221 Goodbye.\r\n");
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const running: Fixture[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

async function serve(script: FtpScript): Promise<Fixture> {
  const fixture = await startFtpServer(script);
  running.push(fixture);
  return fixture;
}

function config(overrides: Partial<FtpConfig> = {}): FtpConfig {
  return {
    username: null,
    password: null,
    degradedThresholdMs: 3_000,
    ...overrides,
  };
}

function context(
  port: number,
  overrides: Partial<FtpConfig> = {},
  timeoutMs = 2_000,
): ProbeContext<FtpConfig> {
  return {
    target: "127.0.0.1",
    port,
    config: config(overrides),
    timeoutMs,
    allowPrivateTargets: true,
    fetchImpl: fetch,
  };
}

const FEATURES =
  "211-Features:\r\n UTF8\r\n MDTM\r\n SIZE\r\n AUTH TLS\r\n211 End\r\n";

const HEALTHY: FtpScript = {
  greeting: "220 (vsFTPd 3.0.5)\r\n",
  feat: FEATURES,
  user: "331 Please specify the password.\r\n",
  pass: "230 Login successful.\r\n",
};

describe("ftpProbe", () => {
  it("reports the greeting and the features a healthy server lists", async () => {
    const server = await serve(HEALTHY);

    const result = await ftpProbe(context(server.port));

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      greetingCode: 220,
      banner: "(vsFTPd 3.0.5)",
      featCode: 211,
    });
    expect(result.facts.features).toEqual(["UTF8", "MDTM", "SIZE", "AUTH TLS"]);
    expect(judge(ftpSpec.assertions, config(), result).verdict).toBe("up");
  });

  it("reads a multi-line greeting whose middle lines carry no code", async () => {
    // RFC 959 §4.2 allows it and SMTP does not, so a reply reader
    // borrowed from the SMTP probe ends the greeting on the middle line
    // and then reads the terminator back as the answer to FEAT.
    const server = await serve({
      ...HEALTHY,
      greeting:
        "220-Welcome to files.example.com\r\n" +
        " unauthorised access is logged\r\n" +
        "220 Server ready\r\n",
    });

    const result = await ftpProbe(context(server.port));

    expect(result.facts.greetingCode).toBe(220);
    expect(result.facts.featCode).toBe(211);
    expect(judge(ftpSpec.assertions, config(), result).verdict).toBe("up");
  });

  it("reads a greeting that arrives in two TCP reads", async () => {
    const server = await serve({ ...HEALTHY, splitGreetingAt: 6 });

    const result = await ftpProbe(context(server.port));

    expect(result.facts.greetingCode).toBe(220);
    expect(judge(ftpSpec.assertions, config(), result).verdict).toBe("up");
  });

  it("reports 421 at the connection limit as down rather than unreachable", async () => {
    // The socket opens and the server then refuses everyone, so a TCP
    // check on 21 calls this server healthy for as long as it is not.
    const server = await serve({
      greeting: "421 Too many users are connected, please try later.\r\n",
    });

    const result = await ftpProbe(context(server.port));
    const verdict = judge(ftpSpec.assertions, config(), result);

    expect(result.error).toBeNull();
    expect(result.facts.featCode).toBeUndefined();
    expect(verdict.failureClass).toBe("assertion");
    expect(verdict.error).toBe("Unexpected greeting 421");
  });

  it("stays up against a server too old to implement FEAT", async () => {
    // RFC 2389 is an extension; 500 is the correct answer from a server
    // that predates it, and paging somebody for it would be a bug.
    const server = await serve({
      greeting: "220 wu-ftpd ready\r\n",
      feat: "500 'FEAT': command not understood.\r\n",
    });

    const result = await ftpProbe(context(server.port));

    expect(result.facts.featCode).toBe(500);
    // No feature list at all, rather than an empty one: the server never
    // claimed to have none.
    expect(result.facts.features).toBeUndefined();
    expect(judge(ftpSpec.assertions, config(), result).verdict).toBe("up");
  });

  it("goes down when the server stops speaking FTP after its banner", async () => {
    // What a proxy in front of a dead backend does: a canned banner,
    // then nothing that parses.
    const server = await serve({
      greeting: "220 ProFTPD ready\r\n",
      feat: "<html>502 Bad Gateway</html>\r\n",
    });

    const result = await ftpProbe(context(server.port));
    const verdict = judge(ftpSpec.assertions, config(), result);

    expect(result.facts.featCode).toBeNull();
    expect(verdict.error).toBe(
      "The server stopped speaking FTP after its banner",
    );
  });

  it("logs in when an account is configured", async () => {
    const server = await serve(HEALTHY);
    const account = config({ username: "app", password: "s3cret" });

    const result = await ftpProbe(context(server.port, account));

    expect(server.commands).toContain("USER app");
    expect(server.commands).toContain("PASS s3cret");
    expect(result.facts.loginCode).toBe(230);
    expect(judge(ftpSpec.assertions, account, result).verdict).toBe("up");
  });

  it("reports refused credentials as down without calling the server unreachable", async () => {
    const server = await serve({
      ...HEALTHY,
      pass: "530 Login incorrect.\r\n",
    });
    const account = config({ username: "app", password: "wrong" });

    const result = await ftpProbe(context(server.port, account));
    const verdict = judge(ftpSpec.assertions, account, result);

    expect(result.error).toBeNull();
    expect(verdict.failureClass).toBe("assertion");
    expect(verdict.error).toBe("The server refused the login: reply 530");
  });

  it("never sends a password it does not have", async () => {
    const server = await serve(HEALTHY);
    const account = config({ username: "anonymous" });

    const result = await ftpProbe(context(server.port, account));
    const verdict = judge(ftpSpec.assertions, account, result);

    expect(server.commands.some((line) => line.startsWith("PASS"))).toBe(false);
    expect(verdict.error).toBe(
      "The server asked for a password and none is configured",
    );
  });

  it("counts a login that needs no password as a login", async () => {
    const server = await serve({
      ...HEALTHY,
      user: "230 Anonymous access granted.\r\n",
    });
    const account = config({ username: "anonymous" });

    const result = await ftpProbe(context(server.port, account));

    expect(result.facts.loginCode).toBe(230);
    expect(judge(ftpSpec.assertions, account, result).verdict).toBe("up");
  });

  it("judges nothing about a login the operator did not ask for", async () => {
    const server = await serve(HEALTHY);

    const result = await ftpProbe(context(server.port));

    expect(server.commands).not.toContain("USER anonymous");
    expect(result.facts.loginCode).toBeUndefined();
    expect(
      judge(ftpSpec.assertions, config(), result).failedAssertions,
    ).toEqual([]);
  });

  it("keeps the credential off the wire when the greeting already failed", async () => {
    const server = await serve({ greeting: "421 Service not available\r\n" });
    const account = config({ username: "app", password: "s3cret" });

    await ftpProbe(context(server.port, account));

    expect(server.commands).toEqual([]);
  });

  it("reports the exchange as degraded when it is slower than the threshold", async () => {
    const server = await serve({ ...HEALTHY, greetingDelayMs: 250 });
    const slow = config({ degradedThresholdMs: 100 });

    const result = await ftpProbe(context(server.port, slow));
    const verdict = judge(ftpSpec.assertions, slow, result);

    expect(verdict.verdict).toBe("degraded");
    expect(verdict.error).toMatch(/over the 100ms threshold/);
  });

  it("gives up on a server that accepts the connection and says nothing", async () => {
    const server = await serve({});

    const result = await ftpProbe(context(server.port, {}, 300));

    expect(result.error).toBe("Timed out after 300ms");
    expect(judge(ftpSpec.assertions, config(), result).failureClass).toBe(
      "transport",
    );
  });

  it("reports a server that hangs up before greeting as a transport failure", async () => {
    const server = await serve({ closeImmediately: true });

    const result = await ftpProbe(context(server.port));

    expect(result.error).toBe(
      "The server closed the connection without greeting",
    );
  });

  it("names the command that went unanswered when the server hangs up mid-conversation", async () => {
    // The script answers the greeting and nothing else, so the server is
    // torn down while the probe is waiting on FEAT — which is where a
    // restart of the monitored server leaves it.
    const server = await serve({ greeting: "220 ready\r\n" });
    const probe = ftpProbe(context(server.port, {}, 2_000));
    await expect.poll(() => server.commands.includes("FEAT")).toBe(true);
    await server.close();

    expect((await probe).error).toBe(
      "The server closed the connection without answering FEAT",
    );
  });

  it("quits instead of dropping the control connection", async () => {
    // An FTP server holds an abandoned control connection until its idle
    // timer expires, and that timer is what its connection limit is
    // spent on.
    const server = await serve(HEALTHY);

    await ftpProbe(context(server.port));

    await expect.poll(() => server.commands.includes("QUIT")).toBe(true);
  });

  it("refuses a target that resolves to a private address", async () => {
    const result = await ftpProbe({
      target: "localhost",
      port: 21,
      config: config(),
      timeoutMs: 1_000,
      allowPrivateTargets: false,
      fetchImpl: fetch,
    });

    expect(result.error).toBe("Target resolves to a private address");
    expect(result.facts).toEqual({});
  });
});

describe("reading an FTP reply", () => {
  it("waits for the rest of a reply that has not arrived", () => {
    expect(readReply("220 par")).toBeNull();
    expect(readReply("220-first\r\n")).toBeNull();
  });

  it("reads a single-line reply and leaves the rest in the buffer", () => {
    expect(readReply("220 ready\r\n211 End\r\n")).toEqual({
      reply: { code: 220, text: "ready", lines: [] },
      rest: "211 End\r\n",
    });
  });

  it("ends a multi-line reply only on its own code", () => {
    // A line quoting a different code — a server echoing "230 Login
    // successful" inside its banner — must not terminate the block, or
    // the rest of the banner is read back as the answer to FEAT.
    const taken = readReply(
      "220-Notice:\r\n230 is what you will see next\r\n220 Ready\r\nnext",
    );
    expect(taken?.reply).toEqual({
      code: 220,
      text: "Notice:",
      lines: ["230 is what you will see next"],
    });
    expect(taken?.rest).toBe("next");
  });

  it("collects the feature lines out of a FEAT response", () => {
    expect(readReply(FEATURES)?.reply.lines).toEqual([
      "UTF8",
      "MDTM",
      "SIZE",
      "AUTH TLS",
    ]);
  });

  it("reports a line that is not a reply as one, so the banner carries it", () => {
    expect(readReply("SSH-2.0-OpenSSH_9.6\r\n")?.reply).toEqual({
      code: null,
      text: "SSH-2.0-OpenSSH_9.6",
      lines: [],
    });
  });
});

describe("ftp spec", () => {
  const row = {
    checkType: "ftp",
    url: "files.example.com",
    port: 21,
    method: "GET" as const,
    intervalSeconds: 60,
    timeoutMs: 10_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    tlsCheck: false,
    tlsWarnDays: 14,
    config: { username: "app", password: "s3cret" },
  };

  it("reads the account back off the row", () => {
    expect(ftpSpec.fromRow(row)).toMatchObject({
      username: "app",
      password: "s3cret",
    });
  });

  it("keeps the whitespace inside a password", () => {
    // Trimming a password turns a working credential into a 530 nobody
    // can account for.
    expect(
      ftpSpec.fromRow({ ...row, config: { username: "a", password: " pw " } })
        .password,
    ).toBe(" pw ");
  });

  it("falls back to no credentials when the stored blob is junk", () => {
    expect(ftpSpec.fromRow({ ...row, config: 42 })).toMatchObject({
      username: null,
      password: null,
    });
  });

  it("declares the password a secret, so it never reaches a browser", () => {
    expect(ftpSpec.secretFields).toContain("password");
    const redacted = redactConfig(ftpSpec, {
      username: "app",
      password: "s3cret",
    }) as Record<string, unknown>;
    expect(redacted).toEqual({ username: "app", password: SECRET_MASK });
    expect(JSON.stringify(redacted)).not.toContain("s3cret");
  });

  it("never puts the account into the target it prints", () => {
    // This string goes into incident emails, webhook bodies and the
    // public status page.
    const described = ftpSpec.describeTarget(
      "files.example.com",
      21,
      ftpSpec.fromRow(row),
    );
    expect(described).toBe("files.example.com:21");
  });

  it("refuses a password with no username, and says why", () => {
    const parsed = ftpSpec.storedSchema.safeParse({ password: "s3cret" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      "A password needs a username.",
    );
  });

  it("refuses a credential that could smuggle an FTP command", () => {
    // USER and PASS are written onto a line-oriented protocol verbatim,
    // so a line break inside either value appends a command of the
    // author's choosing to the session.
    for (const config of [
      { username: "app\r\nDELE /etc/passwd" },
      { username: "app", password: "pw\nSITE CHMOD 777 /" },
    ]) {
      expect({
        config,
        ok: ftpSpec.storedSchema.safeParse(config).success,
      }).toEqual({ config, ok: false });
    }
  });

  it("treats empty credential boxes as no account at all", () => {
    expect(ftpSpec.storedSchema.parse({ username: " ", password: "" })).toEqual(
      {
        username: null,
        password: null,
      },
    );
  });

  it("refuses a target with a scheme or a port in it", () => {
    for (const target of ["ftp://files.example.com", "files.example.com:21"]) {
      const parsed = ftpSpec.targetSchema.safeParse(target);
      expect({ target, ok: parsed.success }).toEqual({ target, ok: false });
    }
    expect(ftpSpec.targetSchema.safeParse("files.example.com").success).toBe(
      true,
    );
  });
});
