import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { incidents, statusPages, statusPageSubscribers } from "@/db/schema";
import { openMonitorIncident } from "@/modules/incidents/service";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import { createMonitor, deleteMonitor } from "@/modules/monitors/service";
import {
  type EmailMessage,
  sendEmail,
  setEmailTransport,
} from "@/modules/notifications";
import { notifyStatusPageSubscribers } from "@/modules/notifications/subscriber-emails";
import { setStatusPageMonitors } from "@/modules/status-pages/service";
import {
  confirmSubscription,
  listConfirmedSubscribers,
  subscribeToStatusPage,
  unsubscribeByToken,
} from "@/modules/status-pages/subscribers";

import { createTestOrg, db, type TestActor } from "../helpers";

function monitorInput(
  overrides: Partial<CreateMonitorInput> = {},
): CreateMonitorInput {
  return {
    name: `Monitor ${randomUUID().slice(0, 8)}`,
    url: "https://vigil-tests.example.com/health",
    method: "GET",
    intervalSeconds: 60,
    timeoutMs: 10_000,
    degradedThresholdMs: 3_000,
    expectedStatusCode: null,
    bodyKeyword: null,
    keywordAbsent: false,
    checkType: "http" as const,
    tlsCheck: false,
    tlsWarnDays: 14,
    failureWindowSeconds: 120,
    config: null,
    ...overrides,
  };
}

// Capture outbound email for assertions; restore the log transport after.
const sent: EmailMessage[] = [];
setEmailTransport({
  async send(message) {
    sent.push(message);
    return { status: "delivered", providerMessageId: null } as const;
  },
});
beforeEach(() => {
  sent.length = 0;
});
afterAll(() => {
  setEmailTransport({
    async send() {
      /* no-op: drop mail once this file's suites finish */
      return { status: "delivered", providerMessageId: null } as const;
    },
  });
});

async function createStatusPage(
  actor: TestActor,
  visibility: "public" | "private" | "password" = "public",
  published = true,
): Promise<{ id: string; slug: string }> {
  const slug = `sp-${randomUUID().slice(0, 8)}`;
  const [page] = await db
    .insert(statusPages)
    .values({
      organizationId: actor.organizationId,
      slug,
      name: `Status ${slug}`,
      published,
      visibility,
    })
    .returning({ id: statusPages.id, slug: statusPages.slug });
  return page!;
}

describe("subscribeToStatusPage", () => {
  it("records a pending subscriber and is idempotent per address", async () => {
    const actor = await createTestOrg();
    const page = await createStatusPage(actor);

    const first = await subscribeToStatusPage(db, page.id, "Alice@Example.com");
    expect(first.alreadyConfirmed).toBe(false);

    // Same address (case-insensitive) returns the same row, not a duplicate.
    const again = await subscribeToStatusPage(db, page.id, "alice@example.com");
    expect(again.subscriberId).toBe(first.subscriberId);

    const rows = await db.query.statusPageSubscribers.findMany({
      where: eq(statusPageSubscribers.statusPageId, page.id),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe("alice@example.com");
    expect(rows[0]?.confirmedAt).toBeNull();
  });
});

describe("confirmSubscription", () => {
  it("confirms via a valid token and is idempotent", async () => {
    const actor = await createTestOrg();
    const page = await createStatusPage(actor);
    const { token } = await subscribeToStatusPage(db, page.id, "b@example.com");

    const result = await confirmSubscription(db, token);
    expect(result).toMatchObject({ email: "b@example.com", slug: page.slug });

    const row = await db.query.statusPageSubscribers.findFirst({
      where: eq(statusPageSubscribers.statusPageId, page.id),
    });
    const firstConfirm = row?.confirmedAt;
    expect(firstConfirm).toBeInstanceOf(Date);

    // Re-confirming keeps the original timestamp.
    await confirmSubscription(db, token);
    const row2 = await db.query.statusPageSubscribers.findFirst({
      where: eq(statusPageSubscribers.statusPageId, page.id),
    });
    expect(row2?.confirmedAt?.getTime()).toBe(firstConfirm?.getTime());
  });

  it("rejects an invalid token", async () => {
    expect(await confirmSubscription(db, "bogus.token")).toBeNull();
    expect(await confirmSubscription(db, undefined)).toBeNull();
  });
});

describe("unsubscribeByToken", () => {
  it("removes the subscriber and is idempotent", async () => {
    const actor = await createTestOrg();
    const page = await createStatusPage(actor);
    const { token } = await subscribeToStatusPage(db, page.id, "c@example.com");

    const result = await unsubscribeByToken(db, token);
    expect(result).toMatchObject({ email: "c@example.com", slug: page.slug });

    const rows = await db.query.statusPageSubscribers.findMany({
      where: eq(statusPageSubscribers.statusPageId, page.id),
    });
    expect(rows).toHaveLength(0);

    // A second unsubscribe (row already gone) returns null, not an error.
    expect(await unsubscribeByToken(db, token)).toBeNull();
  });
});

describe("listConfirmedSubscribers", () => {
  it("returns only confirmed rows", async () => {
    const actor = await createTestOrg();
    const page = await createStatusPage(actor);
    const confirmed = await subscribeToStatusPage(db, page.id, "y@example.com");
    await subscribeToStatusPage(db, page.id, "pending@example.com");
    await confirmSubscription(db, confirmed.token);

    const list = await listConfirmedSubscribers(db, page.id);
    expect(list.map((s) => s.email)).toEqual(["y@example.com"]);
  });
});

describe("notifyStatusPageSubscribers", () => {
  it("emails only confirmed subscribers of a published public page", async () => {
    const actor = await createTestOrg();
    const page = await createStatusPage(actor);
    const a = await subscribeToStatusPage(db, page.id, "one@example.com");
    const b = await subscribeToStatusPage(db, page.id, "two@example.com");
    await subscribeToStatusPage(db, page.id, "pending@example.com");
    await confirmSubscription(db, a.token);
    await confirmSubscription(db, b.token);

    await notifyStatusPageSubscribers(db, {
      incident: {
        id: randomUUID(),
        organizationId: actor.organizationId,
        title: "Checkout is failing",
        monitorId: null,
        source: "manual" as const,
      },
      kind: "opened",
    });

    const recipients = sent.map((m) => m.to).sort();
    expect(recipients).toEqual(["one@example.com", "two@example.com"]);
    expect(sent[0]?.subject).toContain("Incident opened");
    // Each email carries a working unsubscribe link.
    expect(sent[0]?.text).toMatch(/\/unsubscribe\?token=/);
  });

  it("sends nothing about a monitor kept off the page", async () => {
    // The page's own filter is not enough — this one leaves the
    // building. The monitor name is in the incident title.
    const actor = await createTestOrg();
    const page = await createStatusPage(actor);
    const s = await subscribeToStatusPage(db, page.id, "sub@example.com");
    await confirmSubscription(db, s.token);
    const hidden = await createMonitor(
      db,
      actor,
      monitorInput({ name: "postgres-primary.internal" }),
    );
    const incident = await openMonitorIncident(db, hidden, "refused");
    if (!incident) throw new Error("incident was not opened");

    await notifyStatusPageSubscribers(db, { incident, kind: "opened" });
    expect(sent).toHaveLength(0);

    // …and goes out once the operator puts it on the page.
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: hidden.id }],
    });
    await notifyStatusPageSubscribers(db, { incident, kind: "opened" });
    expect(sent.map((m) => m.to)).toEqual(["sub@example.com"]);
  });

  /**
   * Until migration 0013 an organization had exactly one status page, and
   * this notifier picked it with `findFirst`. An organization may now own
   * several — picking one would mail that page's subscribers and silently
   * skip every other page's, which reads as delivered because some mail
   * went out. The listing rule is applied per page for the same reason: a
   * monitor may be published on one page and deliberately withheld from
   * another.
   */
  it("mails the subscribers of every page listing the monitor", async () => {
    const actor = await createTestOrg();
    const first = await createStatusPage(actor);
    const second = await createStatusPage(actor);
    for (const [page, email] of [
      [first, "first@example.com"],
      [second, "second@example.com"],
    ] as const) {
      const s = await subscribeToStatusPage(db, page.id, email);
      await confirmSubscription(db, s.token);
    }

    const monitor = await createMonitor(db, actor, monitorInput());
    await setStatusPageMonitors(db, actor, {
      statusPageId: first.id,
      monitors: [{ monitorId: monitor.id }],
    });
    await setStatusPageMonitors(db, actor, {
      statusPageId: second.id,
      monitors: [{ monitorId: monitor.id }],
    });

    const incident = await openMonitorIncident(db, monitor, "down");
    if (!incident) throw new Error("incident was not opened");
    await notifyStatusPageSubscribers(db, { incident, kind: "opened" });

    expect(sent.map((m) => m.to).sort()).toEqual([
      "first@example.com",
      "second@example.com",
    ]);
  });

  it("skips a page that does not list the monitor, without skipping the rest", async () => {
    const actor = await createTestOrg();
    const listing = await createStatusPage(actor);
    const withholding = await createStatusPage(actor);
    for (const [page, email] of [
      [listing, "listed@example.com"],
      [withholding, "withheld@example.com"],
    ] as const) {
      const s = await subscribeToStatusPage(db, page.id, email);
      await confirmSubscription(db, s.token);
    }

    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ name: "postgres-primary.internal" }),
    );
    await setStatusPageMonitors(db, actor, {
      statusPageId: listing.id,
      monitors: [{ monitorId: monitor.id }],
    });

    const incident = await openMonitorIncident(db, monitor, "refused");
    if (!incident) throw new Error("incident was not opened");
    await notifyStatusPageSubscribers(db, { incident, kind: "opened" });

    expect(sent.map((m) => m.to)).toEqual(["listed@example.com"]);
  });

  it("sends nothing once that monitor has been deleted either", async () => {
    // `incidents.monitor_id` is ON DELETE SET NULL, so deleting the
    // monitor turns its incident into a NULL-monitor row. Reading that
    // as "manual announcement" mails the hostname to every subscriber —
    // the same disclosure, reached by an ordinary delete instead of by
    // a failure. `source` still says what opened it.
    const actor = await createTestOrg();
    const page = await createStatusPage(actor);
    const s = await subscribeToStatusPage(db, page.id, "sub@example.com");
    await confirmSubscription(db, s.token);
    const hidden = await createMonitor(
      db,
      actor,
      monitorInput({ name: "postgres-primary.internal" }),
    );
    const opened = await openMonitorIncident(db, hidden, "refused");
    if (!opened) throw new Error("incident was not opened");

    await deleteMonitor(db, actor, hidden.id);

    const orphaned = await db.query.incidents.findFirst({
      where: eq(incidents.id, opened.id),
    });
    expect(orphaned?.monitorId).toBeNull();
    expect(orphaned?.source).toBe("monitor");

    await notifyStatusPageSubscribers(db, {
      incident: orphaned!,
      kind: "resolved",
    });
    expect(sent).toHaveLength(0);
  });

  it("sends nothing for a private page", async () => {
    const actor = await createTestOrg();
    const page = await createStatusPage(actor, "private");
    const s = await subscribeToStatusPage(db, page.id, "priv@example.com");
    await confirmSubscription(db, s.token);

    await notifyStatusPageSubscribers(db, {
      incident: {
        id: randomUUID(),
        organizationId: actor.organizationId,
        title: "Private incident",
        monitorId: null,
        source: "manual" as const,
      },
      kind: "resolved",
    });
    expect(sent).toHaveLength(0);
  });

  it("sends nothing when the page is unpublished", async () => {
    const actor = await createTestOrg();
    const page = await createStatusPage(actor, "public", false);
    const s = await subscribeToStatusPage(db, page.id, "np@example.com");
    await confirmSubscription(db, s.token);

    await notifyStatusPageSubscribers(db, {
      incident: {
        id: randomUUID(),
        organizationId: actor.organizationId,
        title: "Unpublished",
        monitorId: null,
        source: "manual" as const,
      },
      kind: "opened",
    });
    expect(sent).toHaveLength(0);
  });
});

// Guard: sendEmail is the capture transport in this file.
describe("email capture sanity", () => {
  it("captures a direct send", async () => {
    await sendEmail({ to: "z@example.com", subject: "hi", text: "x" });
    expect(sent).toHaveLength(1);
  });
});
