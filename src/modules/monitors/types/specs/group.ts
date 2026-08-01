import { z } from "zod";

import { groupDescriptor } from "../catalog";
import type {
  AggregateCheckType,
  Assertion,
  ChildState,
  ProbeResult,
} from "../contract";
import { monitorLabelSchema } from "../targets";

/**
 * A group: one state derived from other monitors' states.
 *
 * Nothing here measures anything. `derive` reads the members' current
 * statuses and reports what it found; the assertions below decide what
 * that means, exactly as they do for a status code. Keeping the
 * severity rules in assertions rather than in the derivation is what
 * lets an operator read "2 of 7 members are down" on the timeline and
 * see the rule that turned it into an outage.
 *
 * Membership is stored on the members (`monitors.parent_id`), never on
 * the group. A group holding a list of ids would have to be kept in
 * step with the monitors it names — and the day one of them is deleted,
 * the group is left pointing at a row that is gone. The foreign key
 * points the other way precisely so the database maintains it, and so
 * deleting a group can null out its members' membership instead of
 * cascading into deleting the monitors themselves.
 */

/**
 * A group has no settings.
 *
 * Not an empty object: `null` is what "this type stores no config" has
 * meant since the flat-column types, `flatColumnsOnly` already produces
 * it, and a `{}` would invite the first speculative option to be added
 * without anyone asking whether the group needed one.
 */
export type GroupConfig = null;

export const groupStoredSchema: z.ZodType<unknown> = z
  .unknown()
  .transform(() => null);

export const groupConfigSchema: z.ZodType<GroupConfig> = z.null();

/** Which member is worst, for the fact that names it on the timeline. */
const SEVERITY_ORDER = ["down", "degraded", "unknown", "up"] as const;

/**
 * The members a group's state is derived from.
 *
 * A paused member is excluded outright. Pausing is how an operator says
 * "do not tell me about this one", and a paused monitor writes no
 * observations at all — so counting its last known status would let a
 * monitor that stopped being watched in March keep a group red today.
 */
export function countedMembers(
  children: readonly ChildState[],
): readonly ChildState[] {
  return children.filter((child) => !child.paused);
}

const anyMemberDown: Assertion<GroupConfig> = {
  id: "member-down",
  fact: "downMembers",
  severity: "down",
  evaluate(value) {
    if (typeof value !== "number" || value === 0) return null;
    return value === 1 ? "One member is down" : `${value} members are down`;
  },
};

const anyMemberDegraded: Assertion<GroupConfig> = {
  id: "member-degraded",
  fact: "degradedMembers",
  severity: "degraded",
  evaluate(value) {
    if (typeof value !== "number" || value === 0) return null;
    return value === 1
      ? "One member is degraded"
      : `${value} members are degraded`;
  },
};

export const groupSpec: AggregateCheckType<GroupConfig> = {
  descriptor: groupDescriptor,
  configSchema: groupConfigSchema,
  storedSchema: groupStoredSchema,
  targetSchema: monitorLabelSchema,
  assertions: [anyMemberDown, anyMemberDegraded],
  fromRow() {
    return null;
  },
  describeTarget(target) {
    return target;
  },
  derive({ children }): ProbeResult {
    const counted = countedMembers(children);

    // An empty group is not a healthy group. It is a group that has
    // nothing to say, and saying "up" for it would publish a green tile
    // for a region containing no monitors — the exact shape of a status
    // page that reassures everybody while nothing is being watched.
    if (counted.length === 0) {
      return {
        facts: {
          memberCount: 0,
          downMembers: 0,
          degradedMembers: 0,
          unmeasuredMembers: 0,
          worstMember: null,
          memberIntervalSeconds: null,
        },
        responseTimeMs: null,
        error: null,
        unavailable:
          children.length === 0
            ? "This group has no members yet."
            : "Every member of this group is paused.",
      };
    }

    const downMembers = counted.filter((c) => c.status === "down").length;
    const degradedMembers = counted.filter(
      (c) => c.status === "degraded",
    ).length;
    // Counted and reported, never escalated. A member Vigil could not
    // measure is not evidence of an outage — treating it as one would
    // turn every ping monitor on a host without CAP_NET_RAW into a red
    // region — and it is not evidence of health either, which is why it
    // has a fact of its own instead of being quietly folded into "up".
    const unmeasuredMembers = counted.filter(
      (c) => c.status === "unknown",
    ).length;

    const worst = [...counted].sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.status) - SEVERITY_ORDER.indexOf(b.status),
    )[0];

    return {
      facts: {
        memberCount: counted.length,
        downMembers,
        degradedMembers,
        unmeasuredMembers,
        worstMember: worst ? worst.name : null,
        // Measured, not configured. A group's state can only change when
        // a member reports, so how often the slowest one does is the
        // real answer to "how fresh is this?" — and it is what
        // `outcome.ts` keeps the group's own interval equal to, so that
        // uptime's coverage horizon matches the evidence that exists.
        memberIntervalSeconds: Math.max(
          ...counted.map((child) => child.intervalSeconds),
        ),
      },
      // A group has no latency of its own. Averaging its members' would
      // invent a number that describes nothing an operator can act on.
      responseTimeMs: null,
      error: null,
      // Every member unmeasured means the group is unmeasured too: with
      // no member establishing any state, "up" would be a claim nothing
      // supports.
      ...(unmeasuredMembers === counted.length
        ? { unavailable: "No member of this group has been measured yet." }
        : {}),
    };
  },
};
