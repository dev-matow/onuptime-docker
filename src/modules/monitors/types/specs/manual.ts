import { z } from "zod";

import { manualDescriptor } from "../catalog";
import type {
  Assertion,
  ManualCheckType,
  MonitorRowView,
  ProbeResult,
} from "../contract";
import { monitorLabelSchema } from "../targets";

/**
 * A manual monitor: a status an operator states, which then stands.
 *
 * It exists for the parts of a service Vigil cannot reach — a payment
 * provider, a warehouse, a supplier's API behind a VPN Vigil is not on
 * — and its whole point is that a human's knowledge belongs on the same
 * status page, in the same uptime maths, as a probe's.
 *
 * The statement is stored in the config, which makes it an ordinary
 * edit: it is versioned like any other rule change, it survives a save
 * that touched something else (see `types/config.ts`), and it appears
 * in the audit log with the person who made it. The consequences are
 * not special either — a manual monitor set to `down` opens an incident
 * through the same controller as a failed probe, because an outage an
 * operator knows about is not a lesser kind of outage.
 *
 * What makes it a kind rather than a flag is the scheduler: there is
 * nothing to poll. A manual monitor is never enqueued, and its
 * observation is written exactly when a person writes it.
 */

export const MANUAL_STATUSES = ["up", "degraded", "down"] as const;

export type ManualStatus = (typeof MANUAL_STATUSES)[number];

export interface ManualConfig {
  status: ManualStatus;
  /** Why. Printed on the timeline and in the incident that opens. */
  note: string | null;
}

export const manualStoredSchema = z.object({
  // `up` rather than `unknown`, because "unknown" is not a thing an
  // operator can assert — it is what Vigil says when nobody has told it
  // anything, and a monitor someone deliberately created is a monitor
  // someone has an opinion about. Creating one you already know is
  // broken is two clicks away and the more common case is the other one.
  status: z.enum(MANUAL_STATUSES).default("up"),
  note: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

export const manualConfigSchema: z.ZodType<ManualConfig> = z.object({
  status: z.enum(MANUAL_STATUSES),
  note: z.string().max(500).nullable(),
});

function withNote(sentence: string, note: string | null): string {
  return note === null ? sentence : `${sentence}: ${note}`;
}

/**
 * The operator's statement, judged.
 *
 * Deliberately a pair of ordinary assertions over an ordinary fact
 * rather than a shortcut that sets the verdict directly. It costs a few
 * lines and buys the property every other type has: the reason string
 * on the timeline, the failure class, and the ability to re-judge a
 * stored observation later all come from the same engine, so a manual
 * monitor is not a second code path through the product.
 */
const declaredDown: Assertion<ManualConfig> = {
  id: "declared-down",
  fact: "declaredStatus",
  severity: "down",
  evaluate(value, config) {
    if (value !== "down") return null;
    return withNote("An operator marked this monitor down", config.note);
  },
};

const declaredDegraded: Assertion<ManualConfig> = {
  id: "declared-degraded",
  fact: "declaredStatus",
  severity: "degraded",
  evaluate(value, config) {
    if (value !== "degraded") return null;
    return withNote("An operator marked this monitor degraded", config.note);
  },
};

export const manualSpec: ManualCheckType<ManualConfig> = {
  descriptor: manualDescriptor,
  configSchema: manualConfigSchema,
  storedSchema: manualStoredSchema,
  targetSchema: monitorLabelSchema,
  assertions: [declaredDown, declaredDegraded],
  fromRow(row: MonitorRowView): ManualConfig {
    const stored = manualStoredSchema.safeParse(row.config ?? {});
    // An unreadable blob falls back to `up`, matching the schema's
    // default rather than inventing a third answer. It is the same
    // choice `json-query` makes and for the same reason: a fallback that
    // could never pass turns a config Vigil cannot read into a
    // permanent false outage.
    return stored.success ? stored.data : { status: "up", note: null };
  },
  describeTarget(target) {
    return target;
  },
  declare({ config }): ProbeResult {
    return {
      facts: {
        declaredStatus: config.status,
        declaredNote: config.note,
      },
      // No duration: nobody timed anything. Null rather than 0, which
      // would put a point on the response-time chart claiming an
      // instantaneous reply from something that was never asked.
      responseTimeMs: null,
      error: null,
    };
  },
};
