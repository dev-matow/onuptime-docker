// @covers-type: push, group, manual
import { describe, expect, it } from "vitest";

import { judgeMeasurement } from "@/modules/monitors/check";
import type { ChildState } from "@/modules/monitors/types/contract";
import {
  isActiveType,
  isAggregateType,
  isManualType,
  isPassiveType,
} from "@/modules/monitors/types/contract";
import { CHECK_TYPES } from "@/modules/monitors/types/registry";
import {
  groupSpec,
  type GroupConfig,
} from "@/modules/monitors/types/specs/group";
import {
  manualSpec,
  type ManualConfig,
} from "@/modules/monitors/types/specs/manual";
import {
  newPushToken,
  pushSpec,
  pushStoredSchema,
  type PushConfig,
} from "@/modules/monitors/types/specs/push";

/**
 * The three kinds that never dial anything, judged.
 *
 * Everything here goes through `judgeMeasurement` rather than reading
 * the facts directly, because the claim being tested is not "observe
 * returns the right object" — it is that a heartbeat, a group and an
 * operator's statement reach a verdict through the same engine an HTTP
 * status code does. A test that inspected facts would pass even if the
 * assertions had been bypassed, which is the one failure that would
 * matter.
 */

const NOW = new Date("2026-08-01T12:00:00.000Z");

function secondsAgo(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

function pushConfig(overrides: Partial<PushConfig> = {}): PushConfig {
  return {
    token: newPushToken(),
    graceSeconds: 30,
    intervalSeconds: 60,
    degradedThresholdMs: 3_000,
    ...overrides,
  };
}

function judgePush(
  config: PushConfig,
  context: {
    lastHeartbeatAt: Date | null;
    reported?: {
      status: "up" | "down";
      message: string | null;
      responseTimeMs: number | null;
    };
    since?: Date;
  },
) {
  return judgeMeasurement(
    pushSpec.assertions,
    config,
    pushSpec.observe({
      config,
      lastHeartbeatAt: context.lastHeartbeatAt,
      reported: context.reported ?? null,
      since: context.since ?? secondsAgo(3600),
      now: NOW,
    }),
  );
}

describe("a push monitor measures the silence between heartbeats", () => {
  it("is up when the last heartbeat arrived inside the interval", () => {
    const verdict = judgePush(pushConfig(), {
      lastHeartbeatAt: secondsAgo(20),
      reported: { status: "up", message: null, responseTimeMs: null },
    });
    expect(verdict.verdict).toBe("up");
    expect(verdict.facts.secondsSinceHeartbeat).toBe(20);
  });

  it("tolerates a heartbeat that is late by less than the grace period", () => {
    // A cron on a 60s timer does not deliver every 60.000s, and the
    // evaluation judging it is itself aligned to a tick. Without the
    // grace the two clocks eventually land the wrong way round and a job
    // that never missed a beat records a failure.
    const verdict = judgePush(pushConfig({ graceSeconds: 30 }), {
      lastHeartbeatAt: secondsAgo(75),
      reported: { status: "up", message: null, responseTimeMs: null },
    });
    expect(verdict.verdict).toBe("up");
  });

  it("reports the monitor down once the heartbeat is past its deadline", () => {
    const verdict = judgePush(pushConfig({ graceSeconds: 30 }), {
      lastHeartbeatAt: secondsAgo(120),
      reported: { status: "up", message: null, responseTimeMs: null },
    });
    expect(verdict.verdict).toBe("down");
    expect(verdict.failedAssertions).toContain("heartbeat-overdue");
    expect(verdict.error).toContain("No heartbeat");
  });

  it("says nothing at all until the first heartbeat is actually late", () => {
    // Not up: nothing has succeeded. Not down: nothing has failed. A
    // monitor created a moment ago has been told nothing, and reporting
    // either verdict would be a claim Vigil cannot support.
    const verdict = judgePush(pushConfig(), {
      lastHeartbeatAt: null,
      since: secondsAgo(10),
    });
    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.failureClass).toBe("misconfigured");
    expect(verdict.facts.heartbeatReceived).toBe(false);
  });

  it("goes down when the first heartbeat never arrives at all", () => {
    // The other half of the rule above, and the one that matters: a job
    // whose cron was never installed must be caught, not left Pending
    // for ever looking like a monitor that is merely young.
    const verdict = judgePush(pushConfig(), {
      lastHeartbeatAt: null,
      since: secondsAgo(600),
    });
    expect(verdict.verdict).toBe("down");
    expect(verdict.failedAssertions).toContain("heartbeat-overdue");
  });

  it("is down when a heartbeat arrives on time reporting a failure", () => {
    const verdict = judgePush(pushConfig(), {
      lastHeartbeatAt: secondsAgo(5),
      reported: {
        status: "down",
        message: "backup failed",
        responseTimeMs: null,
      },
    });
    expect(verdict.verdict).toBe("down");
    expect(verdict.failedAssertions).toContain("reported-failure");
    expect(verdict.facts.reportedMessage).toBe("backup failed");
  });

  it("reports the job as degraded when it says it took longer than the threshold", () => {
    const verdict = judgePush(pushConfig({ degradedThresholdMs: 1_000 }), {
      lastHeartbeatAt: secondsAgo(5),
      reported: { status: "up", message: null, responseTimeMs: 4_200 },
    });
    expect(verdict.verdict).toBe("degraded");
    expect(verdict.responseTimeMs).toBe(4_200);
  });
});

describe("a push monitor's token", () => {
  it("is generated by the schema, because a monitor without one has no endpoint", () => {
    const parsed = pushStoredSchema.parse({});
    expect(typeof parsed.token).toBe("string");
    expect(parsed.token.length).toBeGreaterThanOrEqual(32);
  });

  it("issues a different token every time", () => {
    expect(newPushToken()).not.toBe(newPushToken());
  });

  it("refuses a token an operator could guess", () => {
    // A submitted token is accepted so a migration can carry Kuma's
    // across; the floor is what stops that door being a way to install
    // `test123`.
    expect(pushStoredSchema.safeParse({ token: "test123" }).success).toBe(
      false,
    );
  });

  it("is declared a secret, so it never rides back to a browser", () => {
    expect(pushSpec.secretFields).toContain("token");
  });
});

function child(overrides: Partial<ChildState> = {}): ChildState {
  return {
    id: crypto.randomUUID(),
    name: "member",
    status: "up",
    paused: false,
    intervalSeconds: 60,
    ...overrides,
  };
}

function judgeGroup(children: ChildState[]) {
  return judgeMeasurement<GroupConfig>(
    groupSpec.assertions,
    null,
    groupSpec.derive({ config: null, children }),
  );
}

describe("a group derives its state from its members", () => {
  it("is up when every member is up", () => {
    const verdict = judgeGroup([child(), child(), child()]);
    expect(verdict.verdict).toBe("up");
    expect(verdict.facts.memberCount).toBe(3);
  });

  it("is down when any member is down, and names how many", () => {
    const verdict = judgeGroup([
      child(),
      child({ name: "api", status: "down" }),
      child({ status: "degraded" }),
    ]);
    expect(verdict.verdict).toBe("down");
    expect(verdict.error).toBe("One member is down");
    expect(verdict.facts.worstMember).toBe("api");
  });

  it("is degraded when a member is degraded and none is down", () => {
    const verdict = judgeGroup([child(), child({ status: "degraded" })]);
    expect(verdict.verdict).toBe("degraded");
  });

  it("counts a member it could not measure without calling the group down", () => {
    // A ping monitor on a host without CAP_NET_RAW is an operator
    // problem, not an outage. Letting it turn a region red would make
    // every group in the product useless the first time one appeared.
    const verdict = judgeGroup([child(), child({ status: "unknown" })]);
    expect(verdict.verdict).toBe("up");
    expect(verdict.facts.unmeasuredMembers).toBe(1);
  });

  it("ignores a paused member entirely", () => {
    // Pausing is how an operator says "stop telling me about this one".
    // Counting its last known status would let a monitor nobody has
    // watched since March keep a group red today.
    const verdict = judgeGroup([
      child(),
      child({ status: "down", paused: true }),
    ]);
    expect(verdict.verdict).toBe("up");
    expect(verdict.facts.memberCount).toBe(1);
  });

  it("says nothing rather than up when it has no members", () => {
    // "Up" for an empty group is a green tile over a region containing
    // nothing that is being watched.
    const verdict = judgeGroup([]);
    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.error).toContain("no members");
  });

  it("says nothing when every member is paused", () => {
    const verdict = judgeGroup([child({ paused: true })]);
    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.error).toContain("paused");
  });

  it("says nothing when no member has been measured yet", () => {
    const verdict = judgeGroup([
      child({ status: "unknown" }),
      child({ status: "unknown" }),
    ]);
    expect(verdict.verdict).toBe("indeterminate");
  });

  it("reports its slowest member's cadence, because that is how fresh it can be", () => {
    const verdict = judgeGroup([
      child({ intervalSeconds: 30 }),
      child({ intervalSeconds: 3_600 }),
    ]);
    expect(verdict.facts.memberIntervalSeconds).toBe(3_600);
  });
});

function judgeManual(config: ManualConfig) {
  return judgeMeasurement(
    manualSpec.assertions,
    config,
    manualSpec.declare({ config }),
  );
}

describe("a manual monitor reports what an operator stated", () => {
  it("is up when an operator says it is", () => {
    expect(judgeManual({ status: "up", note: null }).verdict).toBe("up");
  });

  it("is down when an operator says so, and gives their reason", () => {
    const verdict = judgeManual({ status: "down", note: "vendor outage" });
    expect(verdict.verdict).toBe("down");
    expect(verdict.error).toBe(
      "An operator marked this monitor down: vendor outage",
    );
    expect(verdict.failureClass).toBe("assertion");
  });

  it("is degraded when an operator says so", () => {
    const verdict = judgeManual({ status: "degraded", note: null });
    expect(verdict.verdict).toBe("degraded");
    expect(verdict.error).toBe("An operator marked this monitor degraded");
  });

  it("falls back to up when the stored statement cannot be read", () => {
    // A fallback that could never pass would turn a config Vigil cannot
    // read into a permanent false outage.
    const config = manualSpec.fromRow({
      checkType: "manual",
      url: "Stripe",
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
      config: { status: "sideways" },
    });
    expect(config.status).toBe("up");
  });
});

describe("the kind of a registered type", () => {
  it("routes each of the three new types to its own evaluation function", () => {
    expect(isPassiveType(CHECK_TYPES.push!)).toBe(true);
    expect(isAggregateType(CHECK_TYPES.group!)).toBe(true);
    expect(isManualType(CHECK_TYPES.manual!)).toBe(true);
    expect(isActiveType(CHECK_TYPES.http!)).toBe(true);
  });

  it("does not claim any of them is active", () => {
    // The predicate the scheduler and `performCheck` both branch on. If
    // this were ever true for a group, the worker would try to dial a
    // monitor with nothing to dial.
    for (const id of ["push", "group", "manual"]) {
      expect(isActiveType(CHECK_TYPES[id]!)).toBe(false);
    }
  });
});
