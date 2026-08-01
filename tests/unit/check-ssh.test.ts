// @covers-type: ssh
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import {
  readIdentification,
  sshProbe,
} from "@/modules/monitors/types/probes/ssh";
import { sshSpec, type SshConfig } from "@/modules/monitors/types/specs/ssh";

/**
 * An SSH daemon, in as much of the protocol as a banner check needs.
 *
 * A real socket rather than a stubbed function: what this check has to
 * get right is a line arriving in pieces, a bastion that prints a legal
 * notice first, and a peer that is not SSH at all — none of which a
 * mocked transport would exercise. The fixture also records every byte
 * the probe sends, because "sends nothing" is the security property this
 * type is built around.
 */

interface Fixture {
  port: number;
  /** Everything the client sent. Must stay empty: see the top of this file. */
  sent: () => string;
  close: () => void;
}

interface Behaviour {
  /** Written in order, with a gap between each, to force real segments. */
  writes?: readonly string[];
  /** Hang up once everything has been written. */
  closeAfter?: boolean;
}

function startDaemon(behaviour: Behaviour): Promise<Fixture> {
  return new Promise((resolve) => {
    let sent = "";

    const server = net.createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        sent += chunk.toString("utf8");
      });
      socket.on("error", () => undefined);

      const writes = behaviour.writes ?? [];
      const writeFrom = (index: number) => {
        if (socket.destroyed) return;
        if (index >= writes.length) {
          if (behaviour.closeAfter) socket.end();
          return;
        }
        socket.write(writes[index]!);
        setTimeout(() => writeFrom(index + 1), 2);
      };
      writeFrom(0);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      let closed = false;
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        sent: () => sent,
        close: () => {
          if (closed) return;
          closed = true;
          server.close();
        },
      });
    });
  });
}

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

async function daemon(behaviour: Behaviour): Promise<Fixture> {
  const fixture = await startDaemon(behaviour);
  fixtures.push(fixture);
  return fixture;
}

function context(
  port: number,
  config: Partial<SshConfig> = {},
): ProbeContext<SshConfig> {
  return {
    target: "127.0.0.1",
    port,
    config: { expectedBanner: null, degradedThresholdMs: 3_000, ...config },
    timeoutMs: 2_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
  };
}

const OPENSSH = "SSH-2.0-OpenSSH_9.6p1 Debian-3\r\n";

describe("sshProbe against a daemon that answers", () => {
  it("reports the banner it was greeted with as up", async () => {
    const server = await daemon({ writes: [OPENSSH] });
    const ctx = context(server.port);

    const result = await sshProbe(ctx);

    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      identified: true,
      protocolVersion: "2.0",
      softwareVersion: "OpenSSH_9.6p1",
      banner: "SSH-2.0-OpenSSH_9.6p1 Debian-3",
    });
    expect(judge(sshSpec.assertions, ctx.config, result).verdict).toBe("up");
  });

  it("sends nothing at all", async () => {
    // The whole design: no identification string of our own, so no key
    // exchange starts, and no authentication is attempted. A probe that
    // spoke first would cost the monitored host a Diffie-Hellman every
    // interval and prove nothing the banner has not already proved.
    const server = await daemon({ writes: [OPENSSH] });
    await sshProbe(context(server.port));

    await new Promise((settle) => setTimeout(settle, 20));
    expect(server.sent()).toBe("");
  });

  it("reads a banner that arrives in fragments", async () => {
    // A read boundary is not a line boundary. Deciding on the first
    // chunk reports a daemon that greeted us as silent.
    const server = await daemon({
      writes: ["SSH-", "2.0-OpenS", "SH_9.6p1 Debian-3", "\r\n"],
    });
    const result = await sshProbe(context(server.port));

    expect(result.facts.identified).toBe(true);
    expect(result.facts.softwareVersion).toBe("OpenSSH_9.6p1");
  });

  it("skips the legal notice a bastion prints before its banner", async () => {
    // RFC 4253 §4.2 lets a server send other lines first. Stopping at
    // the first one reports every host with a banner file as down.
    const server = await daemon({
      writes: [
        "***************************************************\r\n",
        "Authorised access only. Sessions are recorded.\r\n",
        OPENSSH,
      ],
    });
    const result = await sshProbe(context(server.port));

    expect(result.facts).toMatchObject({
      identified: true,
      softwareVersion: "OpenSSH_9.6p1",
    });
  });

  it("accepts the bare LF some embedded daemons send", async () => {
    const server = await daemon({ writes: ["SSH-2.0-dropbear_2022.83\n"] });
    const result = await sshProbe(context(server.port));

    expect(result.facts).toMatchObject({
      identified: true,
      softwareVersion: "dropbear_2022.83",
    });
  });

  it("passes when the banner contains the expected version", async () => {
    const server = await daemon({ writes: [OPENSSH] });
    const ctx = context(server.port, { expectedBanner: "OpenSSH_9" });

    const result = await sshProbe(ctx);
    expect(judge(sshSpec.assertions, ctx.config, result).verdict).toBe("up");
  });

  it("fails when the daemon is not the version it is supposed to be", async () => {
    // The rollback case: the host is up, answering, and running the
    // build that was supposed to have been replaced.
    const server = await daemon({ writes: ["SSH-2.0-OpenSSH_7.4\r\n"] });
    const ctx = context(server.port, { expectedBanner: "OpenSSH_9" });

    const verdict = judge(sshSpec.assertions, ctx.config, await sshProbe(ctx));
    expect(verdict.failureClass).toBe("assertion");
    expect(verdict.error).toBe(
      'The banner is "SSH-2.0-OpenSSH_7.4", which does not contain "OpenSSH_9"',
    );
  });

  it("skips the banner assertion when no expectation was configured", async () => {
    const server = await daemon({ writes: ["SSH-2.0-anything_at_all\r\n"] });
    const ctx = context(server.port);

    expect(
      judge(sshSpec.assertions, ctx.config, await sshProbe(ctx))
        .failedAssertions,
    ).toEqual([]);
  });

  it("measures how long the greeting took", async () => {
    const server = await daemon({ writes: [OPENSSH] });
    const result = await sshProbe(context(server.port));

    expect(typeof result.responseTimeMs).toBe("number");
    expect(result.facts.responseTimeMs).toBe(result.responseTimeMs);
  });

  it("reports the daemon's answer as degraded when it is slower than the threshold", async () => {
    const server = await daemon({ writes: [OPENSSH] });
    const ctx = context(server.port, { degradedThresholdMs: 100 });
    const result = await sshProbe(ctx);

    // Loopback answers in single-digit milliseconds; what is under test
    // is the threshold, not how fast the kernel is today.
    const verdict = judge(sshSpec.assertions, ctx.config, {
      ...result,
      facts: { ...result.facts, responseTimeMs: 900 },
    });
    expect(verdict.verdict).toBe("degraded");
    expect(verdict.error).toContain("over the 100ms threshold");
  });
});

describe("sshProbe against something that is not an SSH daemon", () => {
  it("reports a web server on the port as not identifying itself", async () => {
    const server = await daemon({
      writes: ["HTTP/1.1 400 Bad Request\r\nServer: nginx\r\n\r\n"],
      closeAfter: true,
    });
    const ctx = context(server.port);

    const result = await sshProbe(ctx);
    const verdict = judge(sshSpec.assertions, ctx.config, result);

    // The connection worked, so this is an observation about what is on
    // the port rather than a transport failure. The line it did send is
    // carried, because that is what tells an operator what they hit.
    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({
      identified: false,
      banner: "HTTP/1.1 400 Bad Request",
    });
    expect(verdict.failureClass).toBe("assertion");
    expect(verdict.error).toBe("The server sent no SSH identification string");
  });

  it("reports a host that accepts and hangs up without greeting", async () => {
    // What a daemon over MaxStartups does, and what a TCP proxy in front
    // of a dead backend does. Without the close handler this would sit
    // until the timeout and report the wrong reason.
    const server = await daemon({ closeAfter: true });
    const ctx = context(server.port);

    const result = await sshProbe(ctx);
    expect(result.error).toBeNull();
    expect(result.facts).toMatchObject({ identified: false, banner: null });
    expect(judge(sshSpec.assertions, ctx.config, result).error).toBe(
      "The server sent no SSH identification string",
    );
  });

  it("reports a refused connection as a transport failure", async () => {
    const server = await daemon({ writes: [OPENSSH] });
    const port = server.port;
    server.close();

    const ctx = context(port);
    const result = await sshProbe(ctx);
    expect(result.error).toBeTruthy();
    expect(judge(sshSpec.assertions, ctx.config, result).failureClass).toBe(
      "transport",
    );
  });

  it("times out rather than waiting on a host that says nothing", async () => {
    const server = await daemon({});
    const result = await sshProbe({ ...context(server.port), timeoutMs: 250 });

    expect(result.error).toBe("Timed out after 250ms");
  });

  it("refuses a target that resolves into private space", async () => {
    // A hostname that passed the form can still resolve to 10.0.0.1 by
    // the time the worker dials it.
    const result = await sshProbe({
      ...context(22),
      target: "localhost",
      allowPrivateTargets: false,
    });
    expect(result.error).toBe("Target resolves to a private address");
    expect(result.facts).toEqual({});
  });
});

describe("readIdentification", () => {
  it("waits while the line is incomplete", () => {
    for (let cut = 1; cut < OPENSSH.length - 1; cut += 1) {
      expect(readIdentification(OPENSSH.slice(0, cut))).toEqual({
        state: "partial",
      });
    }
  });

  it("splits the version fields the way §4.2 defines them", () => {
    expect(readIdentification(OPENSSH)).toEqual({
      state: "identified",
      banner: "SSH-2.0-OpenSSH_9.6p1 Debian-3",
      protocolVersion: "2.0",
      softwareVersion: "OpenSSH_9.6p1",
    });
  });

  it("reads a banner with no comment field", () => {
    expect(readIdentification("SSH-1.99-OpenSSH_3.9p1\r\n")).toMatchObject({
      protocolVersion: "1.99",
      softwareVersion: "OpenSSH_3.9p1",
    });
  });

  it("refuses a line that starts like SSH and is not one", () => {
    // `SSH-2.0` with nothing after it is not an identification string.
    // Reported with the line, because that is the most useful thing to
    // show an operator about a peer imitating one badly.
    expect(readIdentification("SSH-2.0\r\n")).toEqual({
      state: "not-ssh",
      banner: "SSH-2.0",
    });
  });

  it("gives up on a peer that fills the buffer without identifying itself", () => {
    // Otherwise a chatty non-SSH service is waited out for the whole
    // timeout, and the operator is told "timed out" about a port that
    // answered instantly.
    const flood = `noise\r\n${"x".repeat(9_000)}\r\n`;
    expect(readIdentification(flood)).toEqual({
      state: "not-ssh",
      banner: "noise",
    });
  });
});

describe("the ssh spec", () => {
  function fromConfig(config: unknown): SshConfig {
    return sshSpec.fromRow({
      checkType: "ssh",
      url: "bastion.example.com",
      port: 22,
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 10_000,
      degradedThresholdMs: 3_000,
      expectedStatusCode: null,
      bodyKeyword: null,
      keywordAbsent: false,
      tlsCheck: false,
      tlsWarnDays: 14,
      config,
    });
  }

  it("names the port, because 22 and 2222 are different services", () => {
    expect(
      sshSpec.describeTarget("bastion.example.com", 2222, fromConfig(null)),
    ).toBe("bastion.example.com:2222");
  });

  it("holds no secrets, because it never authenticates", () => {
    expect(sshSpec.secretFields).toBeUndefined();
  });

  it("survives a config blob written by a build that is not this one", () => {
    expect(fromConfig({ expectedBanner: 42 })).toEqual({
      expectedBanner: null,
      degradedThresholdMs: 3_000,
    });
    expect(fromConfig(null)).toEqual({
      expectedBanner: null,
      degradedThresholdMs: 3_000,
    });
  });

  it("treats an empty expectation as no expectation", () => {
    // Otherwise clearing the field leaves an assertion that every banner
    // trivially satisfies, which is worse than no assertion: it looks
    // like one is being made.
    expect(sshSpec.storedSchema.parse({ expectedBanner: "   " })).toEqual({
      expectedBanner: null,
    });
  });
});
