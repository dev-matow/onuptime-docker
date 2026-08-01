// @covers-type: imap
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import {
  imapProbe,
  parseCapabilities,
  parseGreeting,
  parseTagged,
  readLine,
} from "@/modules/monitors/types/probes/imap";
import { imapSpec, type ImapConfig } from "@/modules/monitors/types/specs/imap";

/**
 * A real IMAP server on loopback, scripted line by line.
 *
 * The probe dials it over TCP and speaks the protocol to it, so what
 * these tests exercise is the thing that runs in production: the socket,
 * the read boundaries, the parse and the hang-ups. A stubbed function
 * returning a fabricated fact bag would pass while the probe could not
 * read a response split across two packets — which is the bug this kind
 * of code actually has.
 */
interface ImapScript {
  /** Sent as soon as the connection opens. Omit for a server that says nothing. */
  greeting?: string;
  /** Sent in answer to CAPABILITY. */
  capability?: string;
  /** Hold the greeting back this long, to make the check slow. */
  greetingDelayMs?: number;
  /** Split the capability response into two writes at this index. */
  splitCapabilityAt?: number;
  /** Hang up the moment the connection opens. */
  closeImmediately?: boolean;
}

interface Fixture {
  port: number;
  /** Every command line the server received, in order. */
  commands: string[];
  close: () => Promise<void>;
}

async function startImapServer(script: ImapScript): Promise<Fixture> {
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
    const greet = () => {
      if (script.greeting !== undefined) socket.write(script.greeting);
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

        const answer = script.capability;
        if (/\bCAPABILITY\b/i.test(line) && answer !== undefined) {
          const split = script.splitCapabilityAt;
          if (split === undefined) {
            socket.write(answer);
          } else {
            socket.write(answer.slice(0, split));
            setTimeout(() => socket.write(answer.slice(split)), 10);
          }
        }
        if (/\bLOGOUT\b/i.test(line)) {
          socket.end("* BYE Logging out\r\nv2 OK LOGOUT completed.\r\n");
        }
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

async function serve(script: ImapScript): Promise<Fixture> {
  const fixture = await startImapServer(script);
  running.push(fixture);
  return fixture;
}

function config(overrides: Partial<ImapConfig> = {}): ImapConfig {
  return {
    requiredCapability: null,
    degradedThresholdMs: 3_000,
    ...overrides,
  };
}

function context(
  port: number,
  overrides: Partial<ImapConfig> = {},
  timeoutMs = 2_000,
): ProbeContext<ImapConfig> {
  return {
    target: "127.0.0.1",
    port,
    config: config(overrides),
    timeoutMs,
    allowPrivateTargets: true,
    fetchImpl: fetch,
  };
}

const HEALTHY: ImapScript = {
  greeting: "* OK [CAPABILITY IMAP4rev1] Dovecot ready.\r\n",
  capability:
    "* CAPABILITY IMAP4rev1 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE STARTTLS LOGINDISABLED\r\n" +
    "v1 OK Pre-login capabilities listed, post-login capabilities have more.\r\n",
};

describe("imapProbe", () => {
  it("reports the capabilities a healthy mail store advertises", async () => {
    const server = await serve(HEALTHY);
    const result = await imapProbe(context(server.port));

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      greetingStatus: "OK",
      capabilityAccepted: true,
    });
    expect(result.facts.capabilities).toContain("STARTTLS");
    expect(judge(imapSpec.assertions, config(), result).verdict).toBe("up");
  });

  it("asks the server for its capabilities instead of believing the greeting", async () => {
    // The greeting advertises STARTTLS; the CAPABILITY response does not.
    // A probe that read the greeting's list would call this healthy while
    // every client that requires encryption has stopped working.
    const server = await serve({
      greeting: "* OK [CAPABILITY IMAP4rev1 STARTTLS] ready\r\n",
      capability: "* CAPABILITY IMAP4rev1 IDLE\r\nv1 OK done\r\n",
    });
    const wanted = config({ requiredCapability: "STARTTLS" });

    const result = await imapProbe(context(server.port, wanted));
    const verdict = judge(imapSpec.assertions, wanted, result);

    expect(server.commands).toContain("v1 CAPABILITY");
    expect(verdict.verdict).toBe("down");
    expect(verdict.error).toBe("The server no longer advertises STARTTLS");
  });

  it("matches a required capability whatever case it is written in", async () => {
    const server = await serve(HEALTHY);
    const wanted = config({ requiredCapability: "starttls" });

    const result = await imapProbe(context(server.port, wanted));

    expect(judge(imapSpec.assertions, wanted, result).verdict).toBe("up");
  });

  it("reads a capability response that arrives in two TCP reads", async () => {
    // A read boundary is not a line boundary. Splitting mid-atom is the
    // case that breaks a parser which assumes one packet is one response.
    const server = await serve({ ...HEALTHY, splitCapabilityAt: 30 });

    const result = await imapProbe(context(server.port));

    expect(result.facts.capabilities).toContain("IMAP4rev1");
    expect(judge(imapSpec.assertions, config(), result).verdict).toBe("up");
  });

  it("keeps reading past untagged chatter the server sends first", async () => {
    const server = await serve({
      greeting: "* OK ready\r\n",
      capability:
        "* OK [ALERT] Mailbox quota is nearly full\r\n" +
        "* CAPABILITY IMAP4rev2 IDLE\r\n" +
        "v1 OK done\r\n",
    });

    const result = await imapProbe(context(server.port));

    expect(result.facts.capabilities).toEqual(["IMAP4rev2", "IDLE"]);
    expect(judge(imapSpec.assertions, config(), result).verdict).toBe("up");
  });

  it("reports a server that greets with BYE as down rather than unreachable", async () => {
    // Dovecot's answer when a host is over its connection limit. The
    // socket opens, so a TCP check on 143 sees a healthy server.
    const server = await serve({
      greeting: "* BYE Too many connections from this IP\r\n",
    });

    const result = await imapProbe(context(server.port));
    const verdict = judge(imapSpec.assertions, config(), result);

    expect(result.error).toBeNull();
    expect(result.facts.capabilityAccepted).toBeUndefined();
    expect(verdict.failureClass).toBe("assertion");
    expect(verdict.error).toBe("The server refused the connection");
  });

  it("records what answered on the port when it is not speaking IMAP", async () => {
    const server = await serve({
      greeting: "HTTP/1.1 400 Bad Request\r\n\r\n",
    });

    const result = await imapProbe(context(server.port));
    const verdict = judge(imapSpec.assertions, config(), result);

    expect(result.facts.banner).toBe("HTTP/1.1 400 Bad Request");
    expect(verdict.error).toBe("The greeting was not an IMAP response");
  });

  it("reports a rejected CAPABILITY without inventing a capability list", async () => {
    const server = await serve({
      greeting: "* OK ready\r\n",
      capability: "v1 NO Command not available in this state\r\n",
    });

    const result = await imapProbe(context(server.port));
    const verdict = judge(imapSpec.assertions, config(), result);

    expect(result.facts.capabilityAccepted).toBe(false);
    // Absent, not empty: nothing was advertised because nothing was
    // answered, and the two must not read the same way.
    expect(result.facts.capabilities).toBeUndefined();
    expect(verdict.error).toBe("The server rejected CAPABILITY");
  });

  it("goes down when a server answers OK and names no IMAP4 revision", async () => {
    const server = await serve({
      greeting: "* OK ready\r\n",
      capability: "* CAPABILITY XPROXY\r\nv1 OK done\r\n",
    });

    const result = await imapProbe(context(server.port));

    expect(judge(imapSpec.assertions, config(), result).error).toBe(
      "The server did not advertise IMAP4rev1",
    );
  });

  it("reports the exchange as degraded when it is slower than the threshold", async () => {
    const server = await serve({ ...HEALTHY, greetingDelayMs: 250 });
    const slow = config({ degradedThresholdMs: 100 });

    const result = await imapProbe(context(server.port, slow));
    const verdict = judge(imapSpec.assertions, slow, result);

    expect(verdict.verdict).toBe("degraded");
    expect(verdict.error).toMatch(/over the 100ms threshold/);
  });

  it("gives up on a server that accepts the connection and says nothing", async () => {
    const server = await serve({});

    const result = await imapProbe(context(server.port, {}, 300));

    expect(result.error).toBe("Timed out after 300ms");
    expect(judge(imapSpec.assertions, config(), result).failureClass).toBe(
      "transport",
    );
  });

  it("reports a server that hangs up before greeting as a transport failure", async () => {
    const server = await serve({ closeImmediately: true });

    const result = await imapProbe(context(server.port));

    expect(result.error).toBe(
      "The server closed the connection without greeting",
    );
  });

  it("logs out instead of dropping the connection", async () => {
    // A mail store counts aborted sessions; a monitor that leaves one
    // behind every interval is a monitor that gets throttled.
    const server = await serve(HEALTHY);

    await imapProbe(context(server.port));
    // The LOGOUT is written after the measurement settles, so the
    // assertion waits for the server to see it.
    await expect
      .poll(() => server.commands.some((line) => /LOGOUT/.test(line)))
      .toBe(true);
  });

  it("refuses a target that resolves to a private address", async () => {
    const result = await imapProbe({
      target: "localhost",
      port: 143,
      config: config(),
      timeoutMs: 1_000,
      allowPrivateTargets: false,
      fetchImpl: fetch,
    });

    expect(result.error).toBe("Target resolves to a private address");
    expect(result.facts).toEqual({});
  });
});

describe("reading the wire", () => {
  it("waits for the rest of a line that has not arrived", () => {
    expect(readLine("* OK part")).toBeNull();
  });

  it("strips the CR of a CRLF and leaves what follows in the buffer", () => {
    expect(readLine("* OK ready\r\nv1 OK done\r\n")).toEqual({
      line: "* OK ready",
      rest: "v1 OK done\r\n",
    });
  });

  it("recognises each greeting the protocol allows, in any case", () => {
    expect(parseGreeting("* ok ready")).toBe("OK");
    expect(parseGreeting("* PREAUTH already authenticated")).toBe("PREAUTH");
    expect(parseGreeting("* BYE go away")).toBe("BYE");
  });

  it("refuses to read a greeting out of something that is not one", () => {
    expect(parseGreeting("SSH-2.0-OpenSSH_9.6")).toBeNull();
    expect(parseGreeting("* SEARCH 1 2 3")).toBeNull();
    expect(parseGreeting("v1 OK done")).toBeNull();
  });

  it("splits a capability line into atoms and nothing else", () => {
    expect(
      parseCapabilities("* CAPABILITY IMAP4rev1  IDLE AUTH=PLAIN"),
    ).toEqual(["IMAP4rev1", "IDLE", "AUTH=PLAIN"]);
    expect(parseCapabilities("* CAPABILITY")).toEqual([]);
    expect(parseCapabilities("* OK [ALERT] hello")).toBeNull();
  });

  it("only reads a completion for the tag it was given", () => {
    expect(parseTagged("v1 OK done", "v1")).toBe("OK");
    expect(parseTagged("V1 no denied", "v1")).toBe("NO");
    expect(parseTagged("v2 OK done", "v1")).toBeNull();
    expect(parseTagged("* OK unrelated", "v1")).toBeNull();
  });
});

describe("imap spec", () => {
  const row = {
    checkType: "imap",
    url: "imap.example.com",
    port: 143,
    method: "GET" as const,
    intervalSeconds: 60,
    timeoutMs: 10_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    tlsCheck: false,
    tlsWarnDays: 14,
    config: { requiredCapability: "IDLE" },
  };

  it("reads its required capability back off the row", () => {
    expect(imapSpec.fromRow(row).requiredCapability).toBe("IDLE");
  });

  it("falls back to no requirement when the stored blob is junk", () => {
    expect(
      imapSpec.fromRow({ ...row, config: { requiredCapability: 42 } })
        .requiredCapability,
    ).toBeNull();
  });

  it("names the port in the target it prints, even the default one", () => {
    expect(imapSpec.describeTarget("imap.example.com", null, config())).toBe(
      "imap.example.com:143",
    );
  });

  it("refuses a capability that is really two, and says why", () => {
    const parsed = imapSpec.storedSchema.safeParse({
      requiredCapability: "STARTTLS IDLE",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      "A capability is one word, like STARTTLS.",
    );
  });

  it("treats an empty capability box as no requirement at all", () => {
    expect(imapSpec.storedSchema.parse({ requiredCapability: "  " })).toEqual({
      requiredCapability: null,
    });
  });

  it("refuses a target with a scheme or a port in it", () => {
    for (const target of ["imaps://imap.example.com", "imap.example.com:143"]) {
      const parsed = imapSpec.targetSchema.safeParse(target);
      expect({ target, ok: parsed.success }).toEqual({ target, ok: false });
    }
    expect(imapSpec.targetSchema.safeParse("imap.example.com").success).toBe(
      true,
    );
  });
});
