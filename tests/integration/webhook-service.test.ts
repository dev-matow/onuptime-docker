import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { auditLogs, webhookEndpoints } from "@/db/schema";
import { createIncident } from "@/modules/incidents/service";
import {
  getOrCreateWebhook,
  sendIncidentWebhook,
  sendTestWebhook,
  updateWebhook,
} from "@/modules/notifications/webhook-service";

import { createTestOrg, db, type TestActor } from "../helpers";

describe("getOrCreateWebhook", () => {
  it("creates one endpoint per org with a generated secret, idempotently", async () => {
    const actor = await createTestOrg();

    const first = await getOrCreateWebhook(db, actor.organizationId);
    expect(first.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(first.enabled).toBe(false);
    expect(first.url).toBe("");

    const second = await getOrCreateWebhook(db, actor.organizationId);
    expect(second.id).toBe(first.id);
    expect(second.secret).toBe(first.secret);
  });
});

describe("updateWebhook", () => {
  it("saves url/enabled and writes an audit row", async () => {
    const actor = await createTestOrg();
    const updated = await updateWebhook(db, actor, {
      url: "https://example.com/hook",
      enabled: true,
    });
    expect(updated.url).toBe("https://example.com/hook");
    expect(updated.enabled).toBe(true);

    const audit = await db.query.auditLogs.findMany({
      where: and(
        eq(auditLogs.organizationId, actor.organizationId),
        eq(auditLogs.action, "webhook.updated"),
      ),
    });
    expect(audit).toHaveLength(1);
  });

  it("rotates the secret only when asked", async () => {
    const actor = await createTestOrg();
    const created = await getOrCreateWebhook(db, actor.organizationId);

    const kept = await updateWebhook(db, actor, {
      url: "https://example.com/hook",
      enabled: false,
    });
    expect(kept.secret).toBe(created.secret);

    const rotated = await updateWebhook(db, actor, {
      url: "https://example.com/hook",
      enabled: false,
      regenerateSecret: true,
    });
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
  });
});

describe("sendTestWebhook", () => {
  it("reports failure without a URL and never throws", async () => {
    const actor = await createTestOrg();
    const result = await sendTestWebhook(db, actor.organizationId);
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/no webhook url/i);
  });
});

describe("sendIncidentWebhook", () => {
  let actor: TestActor;

  beforeEach(async () => {
    actor = await createTestOrg();
  });

  it("is a no-op when the endpoint is disabled (never dispatches)", async () => {
    const incident = await createIncident(db, actor, {
      title: "Manual incident",
      severity: "major",
    });
    // Endpoint exists but is disabled with no URL — must not attempt delivery.
    await getOrCreateWebhook(db, actor.organizationId);

    await expect(
      sendIncidentWebhook(db, { event: "incident.opened", incident }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when enabled but the URL is empty", async () => {
    const incident = await createIncident(db, actor, {
      title: "Manual incident",
      severity: "minor",
    });
    const endpoint = await getOrCreateWebhook(db, actor.organizationId);
    await db
      .update(webhookEndpoints)
      .set({ enabled: true, url: "" })
      .where(eq(webhookEndpoints.id, endpoint.id));

    await expect(
      sendIncidentWebhook(db, { event: "incident.updated", incident }),
    ).resolves.toBeUndefined();
  });
});
