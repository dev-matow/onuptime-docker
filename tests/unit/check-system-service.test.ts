// @covers-type: system-service
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import type {
  ProbeContext,
  ProbeResult,
} from "@/modules/monitors/types/contract";
import {
  MissingSystemctlError,
  SystemctlPermissionError,
  parseShowOutput,
  runSystemctl,
  systemServiceProbe,
  systemctlArgs,
  type SystemctlRun,
} from "@/modules/monitors/types/probes/system-service";
import {
  systemServiceSpec,
  systemServiceTargetSchema,
  type SystemServiceConfig,
} from "@/modules/monitors/types/specs/system-service";

/**
 * The fixture is a real `systemctl`: an executable this probe spawns,
 * which reads the argv it was given and writes the output a systemd
 * would have written. Nothing here is stubbed — `execFile` runs, a
 * process starts, its stdout is parsed, its exit code is read and its
 * deadline kills it — because every one of those is where this check
 * can be wrong, and a mocked function proves none of them.
 *
 * The units it knows about are named for the state they produce.
 */
const FAKE_SYSTEMCTL = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
fs.writeFileSync(
  path.join(__dirname, "last-invocation.json"),
  JSON.stringify({ argv, lang: process.env.LC_ALL ?? null }),
);
const unit = argv[1];
const say = (lines) => process.stdout.write(lines.join("\\n") + "\\n");

switch (unit) {
  case "running.service":
    say([
      "LoadState=loaded",
      "ActiveState=active",
      "SubState=running",
      "UnitFileState=enabled",
      "NRestarts=2",
    ]);
    break;
  case "failed.service":
    say([
      "LoadState=loaded",
      "ActiveState=failed",
      "SubState=failed",
      "UnitFileState=enabled",
      "NRestarts=7",
    ]);
    break;
  case "missing.service":
    // What a real systemd prints for a unit that is not installed: it
    // answers, successfully, that there is nothing here.
    say([
      "LoadState=not-found",
      "ActiveState=inactive",
      "SubState=dead",
      "UnitFileState=",
      "NRestarts=0",
    ]);
    break;
  case "masked.service":
    say(["LoadState=masked", "ActiveState=inactive", "SubState=dead"]);
    break;
  case "starting.service":
    say([
      "LoadState=loaded",
      "ActiveState=activating",
      "SubState=start-pre",
      "UnitFileState=enabled",
      "NRestarts=0",
    ]);
    break;
  case "reloading.service":
    say([
      "LoadState=loaded",
      "ActiveState=reloading",
      "SubState=reload",
      "UnitFileState=enabled",
      "NRestarts=0",
    ]);
    break;
  case "listener.socket":
    // A socket unit has no NRestarts property at all.
    say(["LoadState=loaded", "ActiveState=active", "SubState=listening"]);
    break;
  case "nosystemd.service":
    process.stderr.write(
      "System has not been booted with systemd as init system (PID 1). Can't operate.\\n",
    );
    process.exit(1);
    break;
  case "nobus.service":
    process.stderr.write("Failed to connect to bus: No such file or directory\\n");
    process.exit(1);
    break;
  case "silent.service":
    process.stderr.write("Unit silent.service could not be found.\\n");
    process.exit(4);
    break;
  case "slow.service":
    // Never answers. The probe's deadline has to be what ends this.
    setTimeout(() => undefined, 60_000);
    break;
  default:
    process.stderr.write("unexpected unit " + unit + "\\n");
    process.exit(2);
}
`;

let directory: string;
let binary: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "vigil-systemctl-"));
  binary = join(directory, "systemctl");
  writeFileSync(binary, FAKE_SYSTEMCTL);
  chmodSync(binary, 0o755);
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** The real runner, pointed at the fake binary. */
const runFake = (args: string[], timeoutMs: number): Promise<SystemctlRun> =>
  runSystemctl(args, timeoutMs, binary);

function contextFor(
  unit: string,
  timeoutMs = 5_000,
): ProbeContext<SystemServiceConfig> {
  return {
    target: unit,
    port: null,
    config: { degradedThresholdMs: 3_000 },
    timeoutMs,
    allowPrivateTargets: false,
    fetchImpl: (() => {
      throw new Error("a system-service check must never make an HTTP request");
    }) as unknown as typeof fetch,
  };
}

function probe(unit: string, timeoutMs?: number): Promise<ProbeResult> {
  return systemServiceProbe(contextFor(unit, timeoutMs), runFake);
}

function verdictFor(result: ProbeResult) {
  return judge(
    systemServiceSpec.assertions,
    { degradedThresholdMs: 3_000 },
    result,
  );
}

describe("asking the local systemd about a unit", () => {
  it("reports the state of a running unit as facts and no error", async () => {
    const result = await probe("running.service");

    expect(result.facts).toMatchObject({
      activeState: "active",
      subState: "running",
      loadState: "loaded",
      unitFileState: "enabled",
      restarts: 2,
    });
    expect(result.error).toBeNull();
    expect(result.unavailable).toBeUndefined();
    expect(verdictFor(result).verdict).toBe("up");
  });

  it("asks systemctl only for the properties it reads, in the C locale", async () => {
    await probe("running.service");
    const invocation = JSON.parse(
      readFileSync(join(directory, "last-invocation.json"), "utf8"),
    ) as { argv: string[]; lang: string | null };

    expect(invocation.argv).toEqual([
      "show",
      "running.service",
      "--no-pager",
      "--property=LoadState,ActiveState,SubState,UnitFileState,NRestarts",
    ]);
    // A localised systemd would make "there is no systemd here"
    // undetectable, which is the one thing this check must get right.
    expect(invocation.lang).toBe("C");
  });

  it("records no restart count for a unit type that has none", async () => {
    // Reporting zero would be inventing a measurement systemd never
    // made: a socket unit has no NRestarts property at all.
    const result = await probe("listener.socket");
    expect(result.facts.restarts).toBeNull();
    expect(result.facts.subState).toBe("listening");
  });

  it("counts a unit that is reloading as still doing its job", async () => {
    // An nginx reloading on every certificate renewal must not page.
    const result = await probe("reloading.service");
    expect(verdictFor(result).verdict).toBe("up");
  });
});

describe("what the runner makes of the facts", () => {
  it("judges a failed unit down, and says which state it is in", async () => {
    const result = await probe("failed.service");
    // The probe measures and does not judge: no error, no verdict.
    expect(result.error).toBeNull();

    const judgment = verdictFor(result);
    expect(judgment.verdict).toBe("down");
    expect(judgment.failureClass).toBe("assertion");
    expect(judgment.error).toBe("The unit is failed rather than active");
  });

  it("judges a unit systemd has never heard of down, naming that as the cause", async () => {
    const judgment = verdictFor(await probe("missing.service"));
    expect(judgment.verdict).toBe("down");
    // Both `loaded` and `active` fail — a unit that is not there is also
    // not active — and the reported reason is the one that sends the
    // reader somewhere useful.
    expect(judgment.error).toBe(
      "systemd has no unit by this name on this machine",
    );
    expect(judgment.failedAssertions).toEqual(["loaded", "active"]);
  });

  it("distinguishes a masked unit from one that is merely stopped", async () => {
    const judgment = verdictFor(await probe("masked.service"));
    expect(judgment.error).toBe("The unit is masked, so nothing can start it");
  });

  it("reports a unit that is still starting as degraded rather than down", async () => {
    // A restart that outlasts one check interval must not open an
    // incident for a service that is coming back up on its own.
    const judgment = verdictFor(await probe("starting.service"));
    expect(judgment.verdict).toBe("degraded");
    expect(judgment.error).toBe("The unit is still starting up");
  });

  it("reports a slow answer as degraded once it passes the threshold", () => {
    const judgment = judge(
      systemServiceSpec.assertions,
      { degradedThresholdMs: 50 },
      {
        facts: {
          activeState: "active",
          loadState: "loaded",
          responseTimeMs: 400,
        },
        responseTimeMs: 400,
        error: null,
      },
    );
    expect(judgment.verdict).toBe("degraded");
    expect(judgment.error).toContain("400ms");
  });
});

describe("a host with no systemd on it", () => {
  it("reports unavailable, never down, when the machine was not booted with systemd", async () => {
    const result = await probe("nosystemd.service");

    expect(result.error).toBeNull();
    expect(result.unavailable).toContain("systemd did not answer");

    const judgment = verdictFor(result);
    // The whole point: an operator error must never be
    // indistinguishable from an outage of the service.
    expect(judgment.verdict).toBe("indeterminate");
    expect(judgment.failureClass).toBe("misconfigured");
  });

  it("reports unavailable when systemd's bus cannot be reached", async () => {
    const result = await probe("nobus.service");
    expect(verdictFor(result).failureClass).toBe("misconfigured");
    expect(result.unavailable).toContain("bus is not reachable");
  });

  it("reports unavailable when there is no systemctl binary at all", async () => {
    // The real spawn, against a path that does not exist: this is where
    // ENOENT is turned into an operator-facing sentence.
    await expect(
      runSystemctl(
        ["show", "x.service"],
        2_000,
        join(directory, "not-installed"),
      ),
    ).rejects.toBeInstanceOf(MissingSystemctlError);

    const result = await systemServiceProbe(
      contextFor("running.service"),
      (args, ms) => runSystemctl(args, ms, join(directory, "not-installed")),
    );
    expect(result.unavailable).toContain("no `systemctl` on this host");
    expect(verdictFor(result).verdict).toBe("indeterminate");
  });

  it("reports unavailable when the worker may not execute systemctl", async () => {
    const unreadable = join(directory, "systemctl-no-x");
    writeFileSync(unreadable, FAKE_SYSTEMCTL);
    chmodSync(unreadable, 0o644);

    await expect(
      runSystemctl(["show", "x.service"], 2_000, unreadable),
    ).rejects.toBeInstanceOf(SystemctlPermissionError);

    const result = await systemServiceProbe(
      contextFor("running.service"),
      (args, ms) => runSystemctl(args, ms, unreadable),
    );
    expect(result.unavailable).toContain("may not execute");
  });

  it("reports unavailable when systemctl answers without a state", async () => {
    // Silence judged as health is the failure this check exists to
    // avoid: every assertion skips a fact that is not there, so a
    // stateless answer would otherwise read as `up`.
    const result = await probe("silent.service");
    expect(result.unavailable).toContain("could not be found");
    expect(verdictFor(result).verdict).toBe("indeterminate");
  });
});

describe("a systemd that does not answer", () => {
  it("treats a systemctl that outlives its deadline as a transport failure", async () => {
    // Not `unavailable`: something IS there and is not answering, which
    // is news about the machine rather than about how it was deployed.
    const result = await probe("slow.service", 1_000);
    expect(result.unavailable).toBeUndefined();
    expect(result.error).toBe("systemctl did not answer within 1000ms");
    expect(verdictFor(result).failureClass).toBe("transport");
  }, 10_000);
});

describe("the target a system-service monitor accepts", () => {
  it.each([
    "nginx.service",
    "docker.socket",
    "postgresql@14.service",
    "systemd-timesyncd.service",
    "backup.timer",
    "dev-sda1.device",
    "var-lib\\x2ddocker.mount",
  ])("accepts %s", (unit) => {
    expect(systemServiceTargetSchema.safeParse(unit).success).toBe(true);
  });

  it.each([
    ["nginx", "a bare name with no suffix"],
    ["nginx.conf", "a suffix that is not a unit type"],
    ["-rf.service", "a name a shell argument parser would read as a flag"],
    ["../etc/passwd.service", "a path"],
    ["nginx service.service", "a space"],
    ["", "nothing at all"],
  ])("refuses %s (%s)", (unit) => {
    expect(systemServiceTargetSchema.safeParse(unit).success).toBe(false);
  });

  it("explains what it wants when it refuses", () => {
    // This message is what the form puts under the field, so it has to
    // say what to type rather than what was wrong.
    const parsed = systemServiceTargetSchema.safeParse("nginx");
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("nginx.service");
  });

  it("refuses a unit name in the probe as well, in case a row predates the schema", async () => {
    const result = await systemServiceProbe(contextFor("-rf.service"), runFake);
    expect(result.unavailable).toContain("not a systemd unit name");
  });
});

describe("what the rest of the product is told", () => {
  it("names the machine as well as the unit, because the unit alone is a claim about a service", () => {
    const config = systemServiceSpec.fromRow({
      checkType: "system-service",
      url: "nginx.service",
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
    expect(
      systemServiceSpec.describeTarget("nginx.service", null, config),
    ).toBe("nginx.service (local systemd)");
  });

  it("stores no config blob, because it has no settings", () => {
    expect(systemServiceSpec.storedSchema.parse({ anything: true })).toBeNull();
    expect(systemServiceSpec.secretFields).toBeUndefined();
  });

  it("declares every fact its assertions read", () => {
    const declared = new Set(
      systemServiceSpec.descriptor.facts.map((fact) => fact.key),
    );
    for (const assertion of systemServiceSpec.assertions) {
      expect(declared).toContain(assertion.fact);
    }
  });
});

describe("reading systemctl's output", () => {
  it("keeps an = that is part of a value", () => {
    // `Description=Nginx HTTP Server (with --with-http_v2_module=1)` is
    // an ordinary property; splitting on every = would truncate it.
    expect(parseShowOutput("Description=a=b=c\nActiveState=active")).toEqual({
      Description: "a=b=c",
      ActiveState: "active",
    });
  });

  it("drops a property systemd printed with no value", () => {
    // An empty UnitFileState is systemd saying "not applicable", and ""
    // is not a state to put on a timeline.
    expect(parseShowOutput("UnitFileState=\nActiveState=active")).toEqual({
      ActiveState: "active",
    });
  });

  it("asks for the five properties the facts are built from", () => {
    expect(systemctlArgs("nginx.service")[3]).toBe(
      "--property=LoadState,ActiveState,SubState,UnitFileState,NRestarts",
    );
  });
});
