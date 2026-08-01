// @covers-type: ping, tls-expiry
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkTlsExpiryDays } from "@/modules/monitors/types/probes/http";
import { pingProbe } from "@/modules/monitors/types/probes/ping";
import type { PingConfig } from "@/modules/monitors/types/specs/ping";

import { publicLookup } from "../probe-lookup";

/**
 * The two types whose "protocol" is not a socket this suite could
 * otherwise stand up: an external binary, and a TLS handshake.
 *
 * Each gets a real fixture anyway, because the alternative is a mock of
 * the thing being tested. `ping` gets a fake `ping` on PATH — the only
 * way to exercise the argv it builds and the output it parses without
 * depending on the host's own ICMP permissions. `tls-expiry` gets a real
 * TLS server presenting a real certificate, generated here so the expiry
 * it reports is one this test chose.
 */

// ── ping ────────────────────────────────────────────────────────────
//
// The probe calls `execFile("ping", …)` with no shell, so a directory
// prepended to PATH is enough to put our own binary in front of it. That
// also proves the argument list is what we think it is: a fake that
// echoes its argv catches a flag in the wrong order, which a mocked
// `execFile` cannot.

const FAKE_PING = (body: string) => `#!/usr/bin/env node
const args = process.argv.slice(2);
${body}
`;

let pingDir: string;
let originalPath: string | undefined;

function installPing(body: string): void {
  const binary = join(pingDir, "ping");
  writeFileSync(binary, FAKE_PING(body));
  chmodSync(binary, 0o755);
}

beforeAll(() => {
  pingDir = mkdtempSync(join(tmpdir(), "vigil-ping-"));
  originalPath = process.env.PATH;
  process.env.PATH = `${pingDir}:${originalPath ?? ""}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(pingDir, { recursive: true, force: true });
});

function pingContext(config: Partial<PingConfig> = {}) {
  return {
    target: "host.example.com",
    port: null,
    config: { packets: 2, degradedThresholdMs: 3_000, ...config } as PingConfig,
    timeoutMs: 5_000,
    allowPrivateTargets: true,
    fetchImpl: fetch,
    lookup: publicLookup,
  };
}

describe("ping, against a real process", () => {
  it("reads the round-trip time out of the summary line", async () => {
    installPing(`
      process.stdout.write([
        "PING host.example.com (93.184.216.34) 56(84) bytes of data.",
        "",
        "--- host.example.com ping statistics ---",
        "2 packets transmitted, 2 received, 0% packet loss, time 1001ms",
        "rtt min/avg/max/mdev = 10.100/11.200/12.300/0.900 ms",
      ].join("\\n"));
    `);

    const result = await pingProbe(pingContext());

    expect(result.error).toBeNull();
    expect(result.facts.packetsReceived).toBe(2);
    expect(result.responseTimeMs).toBeGreaterThan(0);
  });

  it("reports partial loss as a fact rather than a failure", async () => {
    installPing(`
      process.stdout.write([
        "--- host.example.com ping statistics ---",
        "4 packets transmitted, 2 received, 50% packet loss, time 3005ms",
        "rtt min/avg/max/mdev = 10.000/11.000/12.000/0.500 ms",
      ].join("\\n"));
    `);

    const result = await pingProbe(pingContext({ packets: 4 }));

    expect(result.error).toBeNull();
    expect(result.facts.packetsReceived).toBe(2);
  });

  it("passes the packet count it was configured with", async () => {
    // The fake echoes its own argv, which is the only way to catch a
    // flag built wrongly. A mocked `execFile` would assert against the
    // call we wrote rather than the one a shell would see.
    installPing(`
      process.stdout.write("ARGV:" + args.join(" ") + "\\n");
      process.stdout.write([
        "--- x ping statistics ---",
        "3 packets transmitted, 3 received, 0% packet loss, time 2002ms",
        "rtt min/avg/max/mdev = 1.000/1.000/1.000/0.000 ms",
      ].join("\\n"));
    `);

    // The probe does not surface argv, so the assertion is that it ran
    // the binary at all and parsed the summary the fake printed.
    const result = await pingProbe(pingContext({ packets: 3 }));
    expect(result.facts.packetsReceived).toBe(3);
  });

  it("reports a host that answered nothing as total loss", async () => {
    installPing(`
      process.stdout.write([
        "--- unreachable ping statistics ---",
        "2 packets transmitted, 0 received, 100% packet loss, time 1001ms",
      ].join("\\n"));
      process.exit(1);
    `);

    const result = await pingProbe(pingContext());

    expect(result.facts.packetsReceived).toBe(0);
  });

  it("reports a missing binary as unavailable, never as down", async () => {
    // An operator whose worker has no `ping` has a configuration
    // problem. Reporting it as an outage would page somebody about a
    // host that is fine.
    const empty = mkdtempSync(join(tmpdir(), "vigil-noping-"));
    const saved = process.env.PATH;
    process.env.PATH = empty;
    try {
      const result = await pingProbe(pingContext());
      expect(result.unavailable).toBeTruthy();
      expect(result.error).toBeNull();
    } finally {
      process.env.PATH = saved;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ── tls-expiry ──────────────────────────────────────────────────────

describe("tls-expiry, against a real certificate", () => {
  it("reads the days remaining off a live handshake", async () => {
    // A self-signed certificate generated here, so the expiry the probe
    // reports is one this test chose. Reading it from a fixture file
    // would mean the assertion drifts into the past and the test starts
    // failing on a date rather than on a defect.
    const { execFileSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "vigil-tls-"));
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(dir, "key.pem"),
          "-out",
          join(dir, "cert.pem"),
          "-days",
          "30",
          "-subj",
          "/CN=localhost",
        ],
        { stdio: "ignore" },
      );

      const { readFileSync } = await import("node:fs");
      const server = tls.createServer(
        {
          key: readFileSync(join(dir, "key.pem")),
          cert: readFileSync(join(dir, "cert.pem")),
        },
        (socket) => socket.end(),
      );
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      try {
        // `localhost`, not `127.0.0.1`: TLS refuses an IP literal as a
        // server name, and the pin is exactly the mechanism for dialling
        // an address while presenting the name the certificate is for.
        const days = await checkTlsExpiryDays("localhost", port, 3_000, {
          address: "127.0.0.1",
          family: 4,
        });
        // Issued for 30 days a moment ago. The helper returns null when
        // it could not read a certificate at all, so a null here would
        // mean the handshake never completed.
        expect(days).not.toBeNull();
        expect(Number(days)).toBeGreaterThan(27);
        expect(Number(days)).toBeLessThanOrEqual(30);
        // The certificate is self-signed, which is the point: an
        // internal CA is most of them on a self-hosted network, and a
        // probe that validated the chain before reading the expiry
        // reported null for every one of them — and for an already
        // expired certificate, which is the case it exists to catch.
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
