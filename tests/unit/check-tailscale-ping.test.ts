// @covers-type: tailscale-ping
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import {
  parsePong,
  tailscalePingProbe,
  unavailableReason,
} from "@/modules/monitors/types/probes/tailscale-ping";
import {
  tailscalePeerSchema,
  tailscalePingSpec,
  tailscalePingStoredSchema,
  type TailscalePingConfig,
} from "@/modules/monitors/types/specs/tailscale-ping";

/**
 * The tailnet check, against a real `tailscale` binary.
 *
 * Not the real one — the one in `tests/fixtures/tailscale`, which is put
 * on PATH and spawned through exactly the `execFile` the probe uses in
 * production. Nothing in `node:child_process` is mocked: these tests
 * exercise argv construction, the LC_ALL environment, exit statuses,
 * stdout and stderr parsing and the ENOENT path against a real process
 * boundary. A tailnet is the one thing that cannot be faked, and the
 * fixture is what stands in for it.
 *
 * The distinction being defended throughout: a peer that did not answer
 * is `down`, and a host that is not on a tailnet at all is
 * `misconfigured`. Collapsing the two would page somebody at 3am
 * because a container was rebuilt without Tailscale in it.
 */

const FIXTURE_BIN = path.resolve(__dirname, "../fixtures/tailscale");

let argvFile: string;
let workDir: string;
let originalPath: string | undefined;

beforeEach(() => {
  originalPath = process.env.PATH;
  workDir = mkdtempSync(path.join(tmpdir(), "vigil-tailscale-"));
  argvFile = path.join(workDir, "argv");
  process.env.PATH = `${FIXTURE_BIN}${path.delimiter}${originalPath ?? ""}`;
  process.env.VIGIL_TEST_TAILSCALE_ARGV = argvFile;
  process.env.VIGIL_TEST_TAILSCALE_MODE = "direct";
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.VIGIL_TEST_TAILSCALE_ARGV;
  delete process.env.VIGIL_TEST_TAILSCALE_MODE;
  rmSync(workDir, { recursive: true, force: true });
});

function context(
  config: Partial<TailscalePingConfig> = {},
  target = "db-1",
): ProbeContext<TailscalePingConfig> {
  return {
    target,
    port: null,
    config: {
      packets: 2,
      requireDirect: false,
      degradedThresholdMs: 3_000,
      ...config,
    },
    timeoutMs: 6_000,
    allowPrivateTargets: false,
    fetchImpl: fetch,
  };
}

function judged(
  result: Awaited<ReturnType<typeof tailscalePingProbe>>,
  config: TailscalePingConfig,
) {
  return judge(tailscalePingSpec.assertions, config, result);
}

describe("tailscalePingProbe", () => {
  it("reports a direct pong with the peer and the path it took", async () => {
    const ctx = context();

    const result = await tailscalePingProbe(ctx);

    expect(result.error).toBeNull();
    expect(result.unavailable).toBeUndefined();
    expect(result.facts).toEqual({
      outcome: "pong",
      peer: "db-1",
      peerAddress: "100.101.102.103",
      via: "203.0.113.7:41641",
      direct: true,
      responseTimeMs: 12,
    });
    expect(judged(result, ctx.config).verdict).toBe("up");
  });

  it("asks the CLI for one answer rather than for a direct path", async () => {
    // `--until-direct` is the CLI's default and it makes the command
    // keep pinging until the peers negotiate a direct connection. A
    // monitor wants the first answer; whether it was direct is a fact it
    // reports afterwards.
    await tailscalePingProbe(context({ packets: 2 }));

    expect(readFileSync(argvFile, "utf8").trimEnd().split("\n")).toEqual([
      "ping",
      "--c=2",
      // Six seconds of budget across two attempts.
      "--timeout=3s",
      "--until-direct=false",
      "db-1",
    ]);
  });

  it("reports a relayed peer as up, because a relay carries traffic", async () => {
    process.env.VIGIL_TEST_TAILSCALE_MODE = "derp";
    const ctx = context();

    const result = await tailscalePingProbe(ctx);

    expect(result.facts).toMatchObject({ via: "DERP(fra)", direct: false });
    expect(judged(result, ctx.config).verdict).toBe("up");
  });

  it("reports a relayed peer as degraded when the monitor asks for a direct path", async () => {
    process.env.VIGIL_TEST_TAILSCALE_MODE = "derp";
    const ctx = context({ requireDirect: true });

    const result = await tailscalePingProbe(ctx);

    expect(judged(result, ctx.config)).toMatchObject({
      verdict: "degraded",
      error: "Reachable only through a DERP relay, not directly",
    });
  });

  it("accepts an answer to the second attempt when the first was lost", async () => {
    // A peer that has just changed networks drops a packet while the
    // path is renegotiated. Opening an incident for that is how a
    // monitor loses an operator's trust.
    process.env.VIGIL_TEST_TAILSCALE_MODE = "retry";
    const ctx = context();

    const result = await tailscalePingProbe(ctx);

    expect(result.facts).toMatchObject({ outcome: "pong", responseTimeMs: 31 });
    expect(judged(result, ctx.config).verdict).toBe("up");
  });

  it("is degraded when the round trip is over the monitor's threshold", async () => {
    process.env.VIGIL_TEST_TAILSCALE_MODE = "slow";
    const ctx = context({ degradedThresholdMs: 3_000 });

    const result = await tailscalePingProbe(ctx);

    expect(judged(result, ctx.config)).toMatchObject({
      verdict: "degraded",
      error: "Replied in 4210ms, over the 3000ms threshold",
    });
  });

  it("reports a peer that is not in the tailnet as down", async () => {
    process.env.VIGIL_TEST_TAILSCALE_MODE = "no-peer";
    const ctx = context();

    const result = await tailscalePingProbe(ctx);

    // Down rather than misconfigured: a peer that has been removed from
    // the tailnet and a peer that was mistyped produce the same sentence
    // from tailscaled, and the first of those is a real outage.
    expect(judged(result, ctx.config)).toMatchObject({
      verdict: "down",
      failureClass: "assertion",
      error: "No peer with that name is in this tailnet",
    });
  });

  it("reports silence from a known peer as down", async () => {
    process.env.VIGIL_TEST_TAILSCALE_MODE = "no-reply";
    const ctx = context();

    const result = await tailscalePingProbe(ctx);

    expect(result.error).toBeNull();
    expect(result.facts.outcome).toBe("no-reply");
    expect(judged(result, ctx.config)).toMatchObject({
      verdict: "down",
      error: "The peer is in the tailnet but did not answer",
    });
  });

  it("reports an answer it has never seen without inventing a cause", async () => {
    process.env.VIGIL_TEST_TAILSCALE_MODE = "something-new";
    const ctx = context();

    const result = await tailscalePingProbe(ctx);

    expect(judged(result, ctx.config)).toMatchObject({
      verdict: "down",
      error: "The tailnet ping did not succeed",
    });
  });
});

describe("tailscalePingProbe: a setup gap is never an outage", () => {
  const setups: [string, RegExp][] = [
    ["no-daemon", /tailscaled is not answering/],
    ["logged-out", /not signed in to a tailnet/],
    ["stopped", /installed but stopped/],
    ["denied", /may not talk to tailscaled/],
  ];

  it.each(setups)(
    "reports %s as misconfigured with something to act on",
    async (mode, message) => {
      process.env.VIGIL_TEST_TAILSCALE_MODE = mode;
      const ctx = context();

      const result = await tailscalePingProbe(ctx);

      expect(result.error).toBeNull();
      expect(result.unavailable).toMatch(message);
      expect(judged(result, ctx.config)).toMatchObject({
        verdict: "indeterminate",
        failureClass: "misconfigured",
      });
    },
  );

  it("reports a host with no tailscale binary as misconfigured", async () => {
    // The default install. It must say what to install, and it must not
    // say the database is down.
    process.env.PATH = workDir;
    const ctx = context();

    const result = await tailscalePingProbe(ctx);

    expect(result.unavailable).toMatch(
      /The `tailscale` command is not on this host/,
    );
    expect(judged(result, ctx.config).verdict).toBe("indeterminate");
  });

  it("refuses a target that is not a peer name before it reaches argv", async () => {
    const ctx = context({}, "-rf /");

    const result = await tailscalePingProbe(ctx);

    expect(result.unavailable).toBe(
      '"-rf /" is not a tailnet peer name or address.',
    );
    expect(judged(result, ctx.config).verdict).toBe("indeterminate");
  });
});

describe("parsePong", () => {
  it("reads the round trip out of a direct pong", () => {
    expect(
      parsePong("pong from nas (100.64.0.9) via 198.51.100.4:41641 in 7ms"),
    ).toEqual({
      peer: "nas",
      peerAddress: "100.64.0.9",
      via: "198.51.100.4:41641",
      direct: true,
      responseTimeMs: 7,
    });
  });

  it("recognises a DERP relay as not direct", () => {
    expect(
      parsePong("pong from nas (100.64.0.9) via DERP(sin) in 142ms")?.direct,
    ).toBe(false);
  });

  it("reads an IPv6 endpoint, brackets and all", () => {
    expect(
      parsePong("pong from nas (100.64.0.9) via [2001:db8::1]:41641 in 9ms")
        ?.via,
    ).toBe("[2001:db8::1]:41641");
  });

  it("takes the first pong when several attempts printed one", () => {
    const output = [
      "pong from nas (100.64.0.9) via DERP(sin) in 142ms",
      "pong from nas (100.64.0.9) via 198.51.100.4:41641 in 9ms",
    ].join("\n");
    expect(parsePong(output)?.responseTimeMs).toBe(142);
  });

  it("finds no pong in output that has none", () => {
    expect(parsePong("no reply from 100.64.0.9 after 5s")).toBeNull();
  });

  it("rounds a fractional round trip, because a fact is a whole millisecond", () => {
    expect(
      parsePong("pong from nas (100.64.0.9) via DERP(sin) in 4.7ms")
        ?.responseTimeMs,
    ).toBe(5);
  });
});

describe("unavailableReason", () => {
  it("says nothing about output that describes the peer rather than this host", () => {
    expect(unavailableReason("no reply from 100.64.0.9 after 5s")).toBeNull();
    expect(unavailableReason('ping "nope": no matching peer')).toBeNull();
  });

  it("names the fix for each way this host can be unable to ask", () => {
    expect(unavailableReason("failed to connect to local tailscaled")).toMatch(
      /Start Tailscale/,
    );
    expect(unavailableReason("Logged out.")).toMatch(/tailscale up/);
    expect(unavailableReason("connect: permission denied")).toMatch(/group/);
  });
});

describe("tailscale-ping spec", () => {
  it("accepts the peer names a tailnet actually uses", () => {
    for (const peer of [
      "db-1",
      "db-1.tailnet-name.ts.net",
      "100.101.102.103",
      "fd7a:115c:a1e0::1",
    ]) {
      expect({ peer, ok: tailscalePeerSchema.safeParse(peer).success }).toEqual(
        {
          peer,
          ok: true,
        },
      );
    }
  });

  it("refuses anything that would reach argv as a flag or an argument", () => {
    for (const peer of ["-rf", "--version", "db 1", "db;rm -rf /", ""]) {
      expect({ peer, ok: tailscalePeerSchema.safeParse(peer).success }).toEqual(
        {
          peer,
          ok: false,
        },
      );
    }
  });

  it("says the target is a tailnet one, because the name usually exists twice", () => {
    const config = tailscalePingSpec.fromRow({
      checkType: "tailscale-ping",
      url: "db-1",
      port: null,
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 10_000,
      degradedThresholdMs: 3_000,
      expectedStatusCode: null,
      bodyKeyword: null,
      keywordAbsent: false,
      tlsCheck: false,
      tlsWarnDays: 14,
      config: null,
    });
    expect(tailscalePingSpec.describeTarget("db-1", null, config)).toBe(
      "db-1 on the tailnet",
    );
    // The defaults a monitor created with no settings at all gets.
    expect(config).toMatchObject({ packets: 2, requireDirect: false });
  });

  it("keeps the settings a monitor was created with", () => {
    expect(
      tailscalePingStoredSchema.parse({ packets: 5, requireDirect: true }),
    ).toEqual({ packets: 5, requireDirect: true });
  });
});
