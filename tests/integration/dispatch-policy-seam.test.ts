import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { notificationChannels, notificationOutbox } from "@/db/schema";
import { dispatchToChannels } from "@/modules/notifications/channel-service";
import {
  registerDispatchPolicy,
  registeredDispatchPolicies,
  resetDispatchPolicies,
} from "@/modules/notifications/dispatch-policy";

import { createTestOrg, db, type TestActor } from "../helpers";

/**
 * The dispatch-policy seam, asserted from Core's side.
 *
 * Not marked `@edition:ee`, deliberately: the property this file exists
 * to hold is that the free edition's routing is unchanged by the
 * registry's existence, and a test that only ran in the edition with a
 * policy registered would prove the smaller half of that. It runs in
 * both, and in Core it is the only thing standing between "the seam is a
 * no-op" and "the seam quietly is not".
 */

/** Registration is process-global and other suites register into it. */
beforeEach(() => {
  resetDispatchPolicies();
});

afterEach(() => {
  resetDispatchPolicies();
});

async function makeChannel(actor: TestActor, name = "Room"): Promise<string> {
  const [row] = await db
    .insert(notificationChannels)
    .values({
      organizationId: actor.organizationId,
      name,
      provider: "webhook",
      config: { url: `https://vigil-tests.example.com/${randomUUID()}` },
      secrets: "",
      destination: "vigil-tests.example.com",
      events: ["monitor", "incident", "expiry"],
    })
    .returning();
  return row!.id;
}

function dispatch(actor: TestActor) {
  return dispatchToChannels(db, {
    organizationId: actor.organizationId,
    event: "monitor.down",
    causeKey: `seam:${randomUUID()}`,
    subject: "Subject",
    detail: [],
    data: {},
    monitorId: null,
    monitorType: "http",
  });
}

describe("with no policy registered", () => {
  it("routes from the channel subscriptions, exactly as before the seam", async () => {
    const actor = await createTestOrg();
    const channelId = await makeChannel(actor);

    expect(registeredDispatchPolicies()).toHaveLength(0);
    expect(await dispatch(actor)).toBe(1);

    const rows = await db
      .select({ channelId: notificationOutbox.channelId })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    expect(rows.map((row) => row.channelId)).toEqual([channelId]);
  });
});

describe("a policy that throws", () => {
  it("degrades toward sending, not toward silence", async () => {
    const actor = await createTestOrg();
    const channelId = await makeChannel(actor);

    registerDispatchPolicy({
      name: "broken",
      async suppression() {
        throw new Error("the policy is broken");
      },
      async routes() {
        throw new Error("the policy is broken");
      },
    });

    // The failure mode of a broken routing policy has to be an alert in
    // the wrong room, never an outage nobody heard about.
    expect(await dispatch(actor)).toBe(1);
    const rows = await db
      .select({ channelId: notificationOutbox.channelId })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.organizationId, actor.organizationId));
    expect(rows.map((row) => row.channelId)).toEqual([channelId]);
  });
});

describe("a policy that names no channels", () => {
  it("sends nothing and does not fall through to the subscriptions", async () => {
    const actor = await createTestOrg();
    await makeChannel(actor);
    let recorded = -1;

    registerDispatchPolicy({
      name: "explicitly-nothing",
      async routes() {
        return {
          // An empty ARRAY, which is a decision. `null` would be the
          // absence of one and would fall through.
          channelIds: [],
          async record(queued) {
            recorded = queued;
          },
        };
      },
    });

    expect(await dispatch(actor)).toBe(0);
    expect(recorded).toBe(0);
    expect(
      await db
        .select()
        .from(notificationOutbox)
        .where(eq(notificationOutbox.organizationId, actor.organizationId)),
    ).toHaveLength(0);
  });
});

describe("a policy that suppresses", () => {
  it("stops the dispatch before any route is resolved", async () => {
    const actor = await createTestOrg();
    await makeChannel(actor);
    let routesAsked = false;

    registerDispatchPolicy({
      name: "silencer",
      async suppression() {
        return { reason: "a window is running" };
      },
      async routes() {
        routesAsked = true;
        return null;
      },
    });

    expect(await dispatch(actor)).toBe(0);
    // Order is fixed and it matters: routing after suppression would
    // compute a fan-out nobody receives and record that it was routed.
    expect(routesAsked).toBe(false);
  });
});
