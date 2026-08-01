// @covers-type: ping
import { describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type { ProbeContext } from "@/modules/monitors/types/contract";
import {
  buildArgs,
  looksLikePermissionProblem,
  MissingBinaryError,
  parseReceived,
  parseRtt,
  pingProbe,
  type PingRun,
} from "@/modules/monitors/types/probes/ping";
import { pingSpec, type PingConfig } from "@/modules/monitors/types/specs/ping";

import { publicLookup } from "../probe-lookup";

const REPLY = `PING example.com (93.184.216.34) 56(84) bytes of data.
64 bytes from 93.184.216.34: icmp_seq=1 ttl=57 time=12.3 ms

--- example.com ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 12.300/12.300/12.300/0.000 ms`;

const TOTAL_LOSS = `PING example.com (93.184.216.34) 56(84) bytes of data.

--- example.com ping statistics ---
3 packets transmitted, 0 received, 100% packet loss, time 2043ms`;

function context(
  overrides: Partial<ProbeContext<PingConfig>> = {},
): ProbeContext<PingConfig> {
  return {
    target: "example.com",
    port: null,
    config: { degradedThresholdMs: 3_000, packets: 1 },
    timeoutMs: 5_000,
    // Skips the DNS guard so these tests stay fully offline.
    allowPrivateTargets: true,
    fetchImpl: fetch,
    lookup: publicLookup,
    ...overrides,
  };
}

function runner(result: Partial<PingRun>) {
  return async () => ({ stdout: "", stderr: "", code: 0, ...result });
}

describe("ping output parsing", () => {
  it("reads the reply count from the summary", () => {
    expect(parseReceived(REPLY)).toBe(1);
    expect(parseReceived(TOTAL_LOSS)).toBe(0);
    expect(parseReceived("nothing useful")).toBeNull();
  });

  it("reads the average round trip from the rtt summary", () => {
    expect(parseRtt(REPLY)).toBe(12);
  });

  it("falls back to a reply line when there is no summary", () => {
    expect(
      parseRtt("64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=4.7 ms"),
    ).toBe(5);
  });

  it("reads the BSD summary label too", () => {
    expect(parseRtt("round-trip min/avg/max/stddev = 1.0/2.5/4.0/1.0 ms")).toBe(
      3,
    );
  });

  it("recognises the permission failures that mean ICMP is unavailable", () => {
    expect(
      looksLikePermissionProblem("ping: socket: Operation not permitted"),
    ).toBe(true);
    expect(looksLikePermissionProblem("ping: socket: Permission denied")).toBe(
      true,
    );
    expect(looksLikePermissionProblem("ping: unknown host nope.invalid")).toBe(
      false,
    );
  });
});

describe("buildArgs", () => {
  it("never lets the target be read as a flag", () => {
    // execFile means there is no shell to inject into, but a leading
    // dash would still be argument confusion. The target is always last.
    const args = buildArgs("example.com", 1, 5_000);
    expect(args.at(-1)).toBe("example.com");
    expect(args).toContain("-n");
  });

  it("passes the requested packet count", () => {
    expect(buildArgs("example.com", 3, 5_000)).toContain("3");
  });

  it("rounds a sub-second timeout up to one second", () => {
    // ping's deadline flags take whole seconds; 0 would mean "no wait".
    expect(buildArgs("example.com", 1, 200)).toContain("1");
  });
});

describe("pingProbe", () => {
  it("emits a reply count and a round trip on success", async () => {
    const result = await pingProbe(context(), runner({ stdout: REPLY }));
    expect(result.error).toBeNull();
    expect(result.unavailable).toBeUndefined();
    expect(result.facts).toMatchObject({
      packetsReceived: 1,
      responseTimeMs: 12,
    });
    expect(judge(pingSpec.assertions, context().config, result).verdict).toBe(
      "up",
    );
  });

  it("treats total packet loss as a measurement, judged down", async () => {
    // Exit code 1 with a parsed summary: the probe ran perfectly and
    // observed silence. That is an assertion failure, not a transport
    // failure, and the distinction is what keeps `misconfigured` free
    // to mean something else.
    const result = await pingProbe(
      context(),
      runner({ stdout: TOTAL_LOSS, code: 1 }),
    );
    expect(result.error).toBeNull();
    expect(result.facts.packetsReceived).toBe(0);

    const verdict = judge(pingSpec.assertions, context().config, result);
    expect(verdict.verdict).toBe("down");
    expect(verdict.failureClass).toBe("assertion");
    expect(verdict.error).toBe("No ICMP reply");
  });

  it("reports an unknown host as a transport failure", async () => {
    const result = await pingProbe(
      context(),
      runner({ stderr: "ping: unknown host nope.invalid", code: 2 }),
    );
    expect(result.error).toBe("unknown host nope.invalid");
    expect(
      judge(pingSpec.assertions, context().config, result).failureClass,
    ).toBe("transport");
  });

  it("reports a missing ping binary as unavailable, never as down", async () => {
    const result = await pingProbe(context(), async () => {
      throw new MissingBinaryError();
    });
    expect(result.unavailable).toContain("not available on this host");
    expect(result.error).toBeNull();

    const verdict = judge(pingSpec.assertions, context().config, result);
    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.failureClass).toBe("misconfigured");
  });

  it("reports missing ICMP permission as unavailable, with the fix", async () => {
    const result = await pingProbe(
      context(),
      runner({ stderr: "ping: socket: Operation not permitted", code: 2 }),
    );
    expect(result.unavailable).toContain("CAP_NET_RAW");
    expect(judge(pingSpec.assertions, context().config, result).verdict).toBe(
      "indeterminate",
    );
  });

  it("refuses a target that is not a hostname without spawning anything", async () => {
    let spawned = false;
    const result = await pingProbe(
      context({ target: "-oProxyCommand=touch /tmp/pwned" }),
      async () => {
        spawned = true;
        return { stdout: "", stderr: "", code: 0 };
      },
    );
    expect(spawned).toBe(false);
    expect(result.unavailable).toContain("Not a valid hostname");
  });

  it("is judged degraded when the round trip is over the threshold", async () => {
    const config: PingConfig = { degradedThresholdMs: 5, packets: 1 };
    const result = await pingProbe(
      context({ config }),
      runner({ stdout: REPLY }),
    );
    const verdict = judge(pingSpec.assertions, config, result);
    expect(verdict.verdict).toBe("degraded");
    expect(verdict.ok).toBe(true);
  });
});
