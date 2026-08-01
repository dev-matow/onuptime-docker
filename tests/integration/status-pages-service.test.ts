import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditLogs, monitorChecks, monitors } from "@/db/schema";
import { ConflictError, NotFoundError } from "@/lib/errors";
import {
  createIncident,
  openMonitorIncident,
} from "@/modules/incidents/service";
import { recordSystemEvent } from "@/modules/incidents/service";
import type { CreateMonitorInput } from "@/modules/monitors/schemas";
import {
  createMonitor,
  deleteMonitor,
  recordCheckOutcome,
  setMonitorPaused,
  type Monitor,
} from "@/modules/monitors/service";
import {
  createStatusPage,
  listStatusPages,
  getPublicStatusPage,
  getStatusPageAccess,
  listStatusPageMonitors,
  setStatusPageMonitors,
  unlockStatusPage,
  updateStatusPage,
} from "@/modules/status-pages/service";
import { postIncidentUpdate } from "@/modules/incidents/service";

import {
  createTestOrg,
  db,
  failResult,
  indeterminateResult,
  okResult,
  type TestActor,
} from "../helpers";

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

function uniqueSlug(): string {
  return `page-${randomUUID().slice(0, 12)}`;
}

/** A fresh status page for this actor. Nothing picks "the" page now. */
async function newPage(actor: TestActor, name = "Test Status") {
  return createStatusPage(db, actor, { name, slug: uniqueSlug() });
}

/** Publishes a given page and returns its slug. Publishing a page other
 * than the one under test is the mistake this signature prevents. */
async function publishPage(
  actor: TestActor,
  page: { id: string; slug: string },
  name = "Test Status",
): Promise<string> {
  const updated = await updateStatusPage(db, actor, {
    statusPageId: page.id,
    name,
    slug: page.slug,
    published: true,
    showBranding: true,
    visibility: "public" as const,
  });
  return updated.slug;
}

async function upMonitor(actor: TestActor, name: string): Promise<Monitor> {
  const monitor = await createMonitor(db, actor, monitorInput({ name }));
  const { monitor: checked } = await recordCheckOutcome(
    db,
    monitor,
    okResult(),
  );
  return checked;
}

describe("white-label", () => {
  /**
   * Uptime Kuma's status pages are white-label for nothing, so this is
   * free in both editions rather than a paid switch. The public read
   * model carries it because the page is incrementally cached: deciding
   * in the component from a second query would render the footer from
   * one page's setting on another page's cache entry.
   */
  it("carries the branding flag on the public read model", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const slug = await publishPage(actor, page);

    expect((await getPublicStatusPage(db, slug))?.showBranding).toBe(true);

    await updateStatusPage(db, actor, {
      statusPageId: page.id,
      name: "P",
      slug,
      published: true,
      showBranding: false,
      visibility: "public",
    });
    expect((await getPublicStatusPage(db, slug))?.showBranding).toBe(false);
  });
});

describe("createStatusPage", () => {
  it("creates a page that starts unpublished", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor, "Acme");

    expect(page.organizationId).toBe(actor.organizationId);
    expect(page.published).toBe(false);
  });

  it("lets one organization own many pages", async () => {
    const actor = await createTestOrg();
    const first = await newPage(actor, "Clients");
    const second = await newPage(actor, "Internal");

    expect(second.id).not.toBe(first.id);
    const all = await listStatusPages(db, actor.organizationId);
    expect(all.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
  });

  it("refuses a slug another organization already uses", async () => {
    const mine = await createTestOrg();
    const theirs = await createTestOrg();
    const slug = uniqueSlug();
    await createStatusPage(db, theirs, { name: "Theirs", slug });

    // The slug is the public URL, so it is unique across the install.
    await expect(
      createStatusPage(db, mine, { name: "Mine", slug }),
    ).rejects.toThrow(ConflictError);
  });
});

describe("updateStatusPage", () => {
  it("changes name, slug and published, and writes an audit row", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const slug = uniqueSlug();

    const updated = await updateStatusPage(db, actor, {
      statusPageId: page.id,
      name: "Acme Public Status",
      slug,
      published: true,
      showBranding: true,
      visibility: "public",
    });
    expect(updated).toMatchObject({
      name: "Acme Public Status",
      slug,
      published: true,
    });

    const audit = await db.query.auditLogs.findMany({
      where: and(
        eq(auditLogs.organizationId, actor.organizationId),
        eq(auditLogs.action, "status_page.updated"),
      ),
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: actor.userId,
      targetType: "status_page",
      targetId: updated.id,
      metadata: { slug, published: true },
    });
  });

  it("rejects a slug already used by another organization", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const pageA = await newPage(orgA);
    const pageB = await newPage(orgB);
    const slug = uniqueSlug();

    await updateStatusPage(db, orgA, {
      statusPageId: pageA.id,
      name: "A",
      slug,
      published: false,
      showBranding: true,
      visibility: "public" as const,
    });

    await expect(
      updateStatusPage(db, orgB, {
        statusPageId: pageB.id,
        name: "B",
        slug,
        published: false,
        showBranding: true,
        visibility: "public" as const,
      }),
    ).rejects.toThrow(ConflictError);
  });

  /**
   * The page id is client input on a server action now that an
   * organization owns several. Naming someone else's page has to fail on
   * ownership before anything is written — otherwise the id is the only
   * thing between two tenants, exactly as `escalationPolicyId` was.
   */
  it("refuses to update another organization's page", async () => {
    const mine = await createTestOrg();
    const theirs = await createTestOrg();
    const theirPage = await newPage(theirs, "Theirs");

    await expect(
      updateStatusPage(db, mine, {
        statusPageId: theirPage.id,
        name: "Hijacked",
        slug: uniqueSlug(),
        published: true,
        showBranding: true,
        visibility: "public" as const,
      }),
    ).rejects.toThrow(NotFoundError);

    const unchanged = await listStatusPages(db, theirs.organizationId);
    expect(unchanged[0]?.name).toBe("Theirs");
    expect(unchanged[0]?.published).toBe(false);
  });

  it("refuses to set components on another organization's page", async () => {
    const mine = await createTestOrg();
    const theirs = await createTestOrg();
    const theirPage = await newPage(theirs);
    const myMonitor = await createMonitor(db, mine, monitorInput());

    await expect(
      setStatusPageMonitors(db, mine, {
        statusPageId: theirPage.id,
        monitors: [{ monitorId: myMonitor.id }],
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("setStatusPageMonitors", () => {
  it("rejects monitor ids belonging to another organization", async () => {
    const owner = await createTestOrg();
    const intruder = await createTestOrg();
    const page = await newPage(intruder);
    const foreign = await createMonitor(db, owner, monitorInput());
    const own = await createMonitor(db, intruder, monitorInput());

    await expect(
      setStatusPageMonitors(db, intruder, {
        statusPageId: page.id,
        monitors: [{ monitorId: own.id }, { monitorId: foreign.id }],
      }),
    ).rejects.toThrow(NotFoundError);

    // The rejected transaction must not have written anything.
    const list = await listStatusPageMonitors(
      db,
      intruder.organizationId,
      page.id,
    );
    expect(list).toEqual([]);
  });

  it("replaces the previous set and preserves the given order", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const m1 = await createMonitor(db, actor, monitorInput({ name: "API" }));
    const m2 = await createMonitor(db, actor, monitorInput({ name: "Web" }));
    const m3 = await createMonitor(db, actor, monitorInput({ name: "CDN" }));

    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: m1.id }, { monitorId: m2.id }],
    });
    const initial = await listStatusPageMonitors(
      db,
      actor.organizationId,
      page.id,
    );
    expect(initial.map((c) => c.monitorId)).toEqual([m1.id, m2.id]);

    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: m3.id }, { monitorId: m1.id }],
    });
    const replaced = await listStatusPageMonitors(
      db,
      actor.organizationId,
      page.id,
    );
    expect(replaced.map((c) => c.monitorId)).toEqual([m3.id, m1.id]);
    expect(replaced.map((c) => c.internalName)).toEqual(["CDN", "API"]);
  });

  it("round-trips displayName and leaves it null when omitted", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const m1 = await createMonitor(
      db,
      actor,
      monitorInput({ name: "internal-api" }),
    );
    const m2 = await createMonitor(
      db,
      actor,
      monitorInput({ name: "internal-web" }),
    );

    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [
        { monitorId: m1.id, displayName: "Public API" },
        { monitorId: m2.id },
      ],
    });

    const list = await listStatusPageMonitors(
      db,
      actor.organizationId,
      page.id,
    );
    expect(list).toEqual([
      {
        monitorId: m1.id,
        internalName: "internal-api",
        displayName: "Public API",
      },
      { monitorId: m2.id, internalName: "internal-web", displayName: null },
    ]);
  });
});

describe("getPublicStatusPage", () => {
  it("returns null for an unknown slug", async () => {
    const page = await getPublicStatusPage(db, `missing-${randomUUID()}`);
    expect(page).toBeNull();
  });

  it("returns null while the page is unpublished", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    expect(page.published).toBe(false);

    await expect(getPublicStatusPage(db, page.slug)).resolves.toBeNull();
  });

  it("shows components with displayName falling back to the monitor name", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const api = await upMonitor(actor, "internal-api");
    const web = await upMonitor(actor, "Website");

    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [
        { monitorId: api.id, displayName: "Public API" },
        { monitorId: web.id },
      ],
    });
    const slug = await publishPage(actor, page, "Acme Status");

    const view = await getPublicStatusPage(db, slug);
    expect(view).not.toBeNull();
    expect(view?.name).toBe("Acme Status");
    expect(view?.components.map((c) => c.name)).toEqual([
      "Public API",
      "Website",
    ]);
    expect(view?.components.map((c) => c.status)).toEqual(["up", "up"]);
    expect(view?.overall).toBe("operational");
    expect(view?.activeIncidents).toEqual([]);
  });

  it("reports an outage when a component monitor is down", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const healthy = await upMonitor(actor, "Web");
    const failing = await createMonitor(
      db,
      actor,
      monitorInput({ name: "API", failureWindowSeconds: 0 }),
    );
    const { monitor: down } = await recordCheckOutcome(
      db,
      failing,
      failResult(),
    );
    expect(down.currentStatus).toBe("down");

    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: healthy.id }, { monitorId: failing.id }],
    });
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    expect(view?.components.map((c) => c.status)).toEqual(["up", "down"]);
    expect(view?.overall).toBe("outage");
  });

  it("includes active incidents with their timeline events", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await upMonitor(actor, "API");
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    const incident = await createIncident(db, actor, {
      title: "Elevated error rates",
      severity: "major",
      message: "We are investigating elevated error rates.",
    });
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    expect(view?.activeIncidents).toHaveLength(1);
    expect(view?.activeIncidents[0]).toMatchObject({
      id: incident.id,
      title: "Elevated error rates",
      status: "investigating",
      severity: "major",
      resolvedAt: null,
    });
    expect(view?.activeIncidents[0]?.events).toEqual([
      expect.objectContaining({
        type: "created",
        status: "investigating",
        message: "We are investigating elevated error rates.",
      }),
    ]);
    // An active incident degrades the page even with all components up.
    expect(view?.overall).toBe("degraded");
  });

  it("does not publish an incident for a monitor kept off the page", async () => {
    // Auto-opened incidents are titled `${monitor.name} is down`, and
    // monitor names are internal hostnames in practice. Filtering on
    // organizationId alone published every one of them, including for
    // monitors the operator deliberately excluded.
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const listed = await upMonitor(actor, "API");
    const hidden = await createMonitor(
      db,
      actor,
      monitorInput({ name: "postgres-primary.internal" }),
    );
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: listed.id }],
    });
    const secret = await openMonitorIncident(db, hidden, "connection refused");
    expect(secret).not.toBeNull();
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    expect(view?.activeIncidents).toEqual([]);
    expect(view?.components).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain("postgres-primary.internal");
  });

  it("keeps it hidden after that monitor is deleted", async () => {
    // `incidents.monitor_id` is ON DELETE SET NULL. Keying the filter
    // on "no monitor id" therefore reopened the whole disclosure the
    // moment anyone deleted the excluded monitor — the ordinary end of
    // a monitor's life — because the orphan then looked exactly like a
    // hand-written announcement. `source` is NOT NULL and never
    // updated, so it still says what opened the incident.
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const listed = await upMonitor(actor, "API");
    const hidden = await createMonitor(
      db,
      actor,
      monitorInput({ name: "postgres-primary.internal" }),
    );
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: listed.id }],
    });
    await openMonitorIncident(db, hidden, "connection refused");
    const slug = await publishPage(actor, page);

    await deleteMonitor(db, actor, hidden.id);

    const view = await getPublicStatusPage(db, slug);
    expect(view?.activeIncidents).toEqual([]);
    expect(JSON.stringify(page)).not.toContain("postgres-primary.internal");
  });

  it("still publishes a manual announcement that names no monitor", async () => {
    // The reason this is not a join: an incident with no monitorId is
    // an org-wide announcement written for exactly this audience.
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const listed = await upMonitor(actor, "API");
    const hidden = await createMonitor(
      db,
      actor,
      monitorInput({ name: "postgres-primary.internal" }),
    );
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: listed.id }],
    });
    await openMonitorIncident(db, hidden, "connection refused");
    const announcement = await createIncident(db, actor, {
      title: "Scheduled maintenance tonight",
      severity: "minor",
      message: "We will be upgrading the database.",
    });
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    expect(view?.activeIncidents.map((i) => i.id)).toEqual([announcement.id]);
  });

  it("hides internal recovery (system) events from the public timeline", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await upMonitor(actor, "API");
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    const incident = await createIncident(db, actor, {
      title: "API is down",
      severity: "critical",
      message: "We are investigating.",
    });
    // The worker writes recovery progress as `system` events — these are
    // operator-only mechanics and must never reach the public page.
    await recordSystemEvent(
      db,
      incident.id,
      "Automatic recovery exhausted after 2 attempts — waiting for a human.",
    );
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    const events = view?.activeIncidents[0]?.events ?? [];
    expect(events.every((event) => event.type !== "system")).toBe(true);
    expect(events.some((event) => /recovery/i.test(event.message))).toBe(false);
    // The customer-facing lifecycle event is still shown.
    expect(events.some((event) => event.type === "created")).toBe(true);
  });

  it("shows paused monitors as unknown", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await upMonitor(actor, "API");
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    await setMonitorPaused(db, actor, monitor.id, true);
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    expect(view?.components).toHaveLength(1);
    expect(view?.components[0]?.status).toBe("unknown");
    expect(view?.overall).toBe("operational");
  });
});

describe("status page visibility & password", () => {
  it("stores a password hash for password visibility and clears it otherwise", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const slug = uniqueSlug();

    const withPw = await updateStatusPage(db, actor, {
      statusPageId: page.id,
      name: "P",
      slug,
      published: true,
      showBranding: true,
      visibility: "password",
      password: "s3cret",
    });
    expect(withPw.visibility).toBe("password");
    expect(withPw.passwordHash).not.toBeNull();

    // Empty password keeps the existing hash.
    const kept = await updateStatusPage(db, actor, {
      statusPageId: page.id,
      name: "P",
      slug,
      published: true,
      showBranding: true,
      visibility: "password",
      password: "",
    });
    expect(kept.passwordHash).toBe(withPw.passwordHash);

    // Switching to public clears the hash.
    const pub = await updateStatusPage(db, actor, {
      statusPageId: page.id,
      name: "P",
      slug,
      published: true,
      showBranding: true,
      visibility: "public",
    });
    expect(pub.visibility).toBe("public");
    expect(pub.passwordHash).toBeNull();
  });

  it("requires a password the first time password protection is enabled", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    await expect(
      updateStatusPage(db, actor, {
        statusPageId: page.id,
        name: "P",
        slug: uniqueSlug(),
        published: true,
        showBranding: true,
        visibility: "password",
        password: "",
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("getStatusPageAccess returns visibility only for published pages", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const slug = uniqueSlug();
    await updateStatusPage(db, actor, {
      statusPageId: page.id,
      name: "Private",
      slug,
      published: false,
      showBranding: true,
      visibility: "private",
    });
    expect(await getStatusPageAccess(db, slug)).toBeNull();

    await updateStatusPage(db, actor, {
      statusPageId: page.id,
      name: "Private",
      slug,
      published: true,
      showBranding: true,
      visibility: "private",
    });
    const access = await getStatusPageAccess(db, slug);
    expect(access?.visibility).toBe("private");
    expect(access?.organizationId).toBe(actor.organizationId);
  });

  it("unlockStatusPage verifies the shared password", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const slug = uniqueSlug();
    await updateStatusPage(db, actor, {
      statusPageId: page.id,
      name: "P",
      slug,
      published: true,
      showBranding: true,
      visibility: "password",
      password: "open-sesame",
    });
    expect(await unlockStatusPage(db, slug, "open-sesame")).toBe(page.id);
    expect(await unlockStatusPage(db, slug, "wrong")).toBeNull();
  });

  it("hides internal notes from the public status page", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await upMonitor(actor, "API");
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    const incident = await createIncident(db, actor, {
      title: "Incident",
      severity: "major",
      message: "Public: investigating.",
    });
    await postIncidentUpdate(db, actor, incident.id, "Public update", false);
    await postIncidentUpdate(
      db,
      actor,
      incident.id,
      "Internal: paged the DBA",
      true,
    );
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    const messages = (view?.activeIncidents[0]?.events ?? []).map(
      (event) => event.message,
    );
    expect(messages).toContain("Public update");
    expect(messages).not.toContain("Internal: paged the DBA");
  });
});

describe("the headline never sits green over something unmeasured", () => {
  /**
   * `unknown` used to fall through to "operational", so a component
   * Vigil could not measure — a ping monitor on a host without ICMP,
   * say — published "All systems operational" directly above its own
   * "No data" chip.
   */
  it("reports degraded when a component cannot be measured", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ name: "Edge" }),
    );
    await recordCheckOutcome(
      db,
      monitor,
      indeterminateResult("ICMP is not permitted for this process."),
    );
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    expect(view?.components[0]?.status).toBe("unknown");
    expect(view?.components[0]?.paused).toBe(false);
    expect(view?.overall).toBe("degraded");
  });

  it("stays operational for a monitor nobody has checked yet", async () => {
    // The other direction of the same mistake. A brand-new monitor is
    // `unknown` because there is no observation at all — holding a
    // customer's headline amber over an absence of evidence is not the
    // same as holding it amber over a probe that came back "cannot
    // measure".
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const healthy = await upMonitor(actor, "API");
    const fresh = await createMonitor(
      db,
      actor,
      monitorInput({ name: "Just added" }),
    );
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: healthy.id }, { monitorId: fresh.id }],
    });
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    expect(view?.components.find((c) => c.name === "Just added")?.status).toBe(
      "unknown",
    );
    expect(view?.overall).toBe("operational");
  });

  it("stays operational for the two minutes after a resume", async () => {
    // `setMonitorPaused` writes `currentStatus: "unknown"` on the way
    // back in, and has to: `deriveStatus` returns `previousStatus`
    // inside the failure window, so a stale `down` would page on the
    // first failing check after the resume. The consequence is a
    // monitor that reads `unknown` until its next check lands — which
    // used to paint the headline amber for a whole interval every time
    // anyone unpaused anything.
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await upMonitor(actor, "API");
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    await setMonitorPaused(db, actor, monitor.id, true);
    const resumed = await setMonitorPaused(db, actor, monitor.id, false);
    expect(resumed.currentStatus).toBe("unknown");
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    expect(view?.components[0]?.status).toBe("unknown");
    expect(view?.components[0]?.paused).toBe(false);
    expect(view?.overall).toBe("operational");
  });

  it("goes amber for a monitor whose latest probe failed inside the window", async () => {
    // `deriveStatus` returns `previousStatus` for a failing check
    // inside the window, and that is `unknown` for a monitor which
    // never succeeded — so a monitor failing right now stores
    // `unknown`, and a rule keyed on `indeterminate` alone published
    // "All systems operational" above its own "No data" chip. No
    // incident rescues it either: `openIncident` needs status `down`.
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ name: "Batch", failureWindowSeconds: 3600 }),
    );
    const { monitor: after, reconciliation } = await recordCheckOutcome(
      db,
      monitor,
      failResult(),
    );
    expect(after.currentStatus).toBe("unknown");
    expect(reconciliation.openIncident).toBe(false);
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    expect(view?.components[0]?.status).toBe("unknown");
    expect(view?.activeIncidents).toEqual([]);
    expect(view?.overall).toBe("degraded");
  });

  it("does not turn greener when a probe stops being indeterminate and starts failing", async () => {
    // The monotonicity case. A ping monitor with no ICMP is amber; the
    // next probe reaches the host and finds it failing — strictly worse
    // news — and the banner used to flip to green because the latest
    // verdict was no longer `indeterminate`.
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ name: "Edge", failureWindowSeconds: 3600 }),
    );
    const { monitor: probed } = await recordCheckOutcome(
      db,
      monitor,
      indeterminateResult("ICMP is not permitted for this process."),
    );
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    const slug = await publishPage(actor, page);
    expect((await getPublicStatusPage(db, slug))?.overall).toBe("degraded");

    await recordCheckOutcome(db, probed, failResult());

    const view = await getPublicStatusPage(db, slug);
    expect(view?.components[0]?.status).toBe("unknown");
    expect(view?.overall).toBe("degraded");
  });

  it("goes amber when the first probe after a resume fails", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await upMonitor(actor, "API");
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    await setMonitorPaused(db, actor, monitor.id, true);
    const resumed = await setMonitorPaused(db, actor, monitor.id, false);
    const slug = await publishPage(actor, page);
    // Still green while nothing has been measured since the resume.
    expect((await getPublicStatusPage(db, slug))?.overall).toBe("operational");

    await recordCheckOutcome(db, resumed, failResult());

    expect((await getPublicStatusPage(db, slug))?.overall).toBe("degraded");
  });

  it("still goes amber when the last thing measured was indeterminate", async () => {
    // The pair to the two above: pausing and resuming does not launder
    // a probe that could not run.
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ name: "Edge" }),
    );
    await recordCheckOutcome(db, monitor, indeterminateResult("no ICMP"));
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    await setMonitorPaused(db, actor, monitor.id, true);
    await setMonitorPaused(db, actor, monitor.id, false);
    const slug = await publishPage(actor, page);

    expect((await getPublicStatusPage(db, slug))?.overall).toBe("degraded");
  });

  it("goes amber for a pre-1.10.0 failing row, which has no verdict", async () => {
    // Migration 0010 added `verdict` with no backfill, so every row
    // written before 1.10.0 is NULL there while carrying a real `ok`.
    // Reading verdict alone made a monitor whose whole history predates
    // the upgrade, and which never succeeded, look healthy — green
    // where 1.10.0 itself showed amber. `recordCheckOutcome` always
    // writes a verdict, so the row has to be inserted directly to
    // reproduce what an upgraded database actually holds.
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ name: "Legacy", failureWindowSeconds: 3600 }),
    );
    await db.insert(monitorChecks).values({
      monitorId: monitor.id,
      ok: false,
      verdict: null,
      responseTimeMs: 0,
      checkedAt: new Date(),
    });
    await db
      .update(monitors)
      .set({ currentStatus: "unknown", firstFailureAt: new Date() })
      .where(eq(monitors.id, monitor.id));
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    expect(view?.components[0]?.status).toBe("unknown");
    expect(view?.overall).toBe("degraded");
  });

  it("stays green for a pre-1.10.0 row that passed", async () => {
    // The other half: a NULL verdict is not evidence of trouble by
    // itself, so `ok = true` must not colour the headline.
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ name: "Legacy ok" }),
    );
    await db.insert(monitorChecks).values({
      monitorId: monitor.id,
      ok: true,
      verdict: null,
      responseTimeMs: 12,
      checkedAt: new Date(),
    });
    await db
      .update(monitors)
      .set({ currentStatus: "unknown" })
      .where(eq(monitors.id, monitor.id));
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    const slug = await publishPage(actor, page);

    expect((await getPublicStatusPage(db, slug))?.overall).toBe("operational");
  });

  it("still reports operational when the only unknown is paused", async () => {
    // A paused monitor is an operator's decision, not a gap in what
    // Vigil knows, so it must not colour the headline.
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const healthy = await upMonitor(actor, "API");
    const off = await upMonitor(actor, "Batch");
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: healthy.id }, { monitorId: off.id }],
    });
    await setMonitorPaused(db, actor, off.id, true);
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    expect(view?.components.find((c) => c.name === "Batch")?.paused).toBe(true);
    expect(view?.overall).toBe("operational");
  });

  it("an outage still outranks an unmeasured component", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const down = await createMonitor(
      db,
      actor,
      monitorInput({ name: "Checkout", failureWindowSeconds: 0 }),
    );
    await recordCheckOutcome(db, down, failResult());
    const unmeasured = await createMonitor(
      db,
      actor,
      monitorInput({ name: "Edge" }),
    );
    await recordCheckOutcome(db, unmeasured, indeterminateResult("no ICMP"));
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: down.id }, { monitorId: unmeasured.id }],
    });
    const slug = await publishPage(actor, page);

    expect((await getPublicStatusPage(db, slug))?.overall).toBe("outage");
  });
});

describe("status-page uptime is duration-weighted", () => {
  /** Writes checks at controlled timestamps, relative to now. */
  async function seedDays(
    monitorId: string,
    points: { minutesAgo: number; ok: boolean }[],
  ): Promise<void> {
    const now = Date.now();
    await db.insert(monitorChecks).values(
      points.map((p) => ({
        monitorId,
        checkedAt: new Date(now - p.minutesAgo * 60_000),
        ok: p.ok,
        responseTimeMs: p.ok ? 100 : null,
        verdict: p.ok ? "up" : "down",
      })),
    );
  }

  it("does not let a dense burst outweigh the time it covers", async () => {
    // The scheduler probes a failing monitor up to 16x as often. Under
    // the old count-based rule those extra rows made a one-minute blip
    // read as a 43% outage on a customer's public page.
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ name: "Checkout" }),
    );
    const points: { minutesAgo: number; ok: boolean }[] = [];
    for (let m = 10; m > 1; m--) points.push({ minutesAgo: m, ok: true });
    for (let s = 0; s < 12; s++) {
      points.push({ minutesAgo: 1 - s / 12, ok: false });
    }
    await seedDays(monitor.id, points);
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    const component = view?.components[0];
    // Nine of ten minutes up. By row count it would be 43%.
    expect(component?.uptime90dPct).toBeGreaterThan(88);
    expect(component?.uptime90dPct).toBeLessThan(92);
  });

  it("weights the 90-day headline by duration, not by day", async () => {
    // A mean of daily percentages counts a day holding two samples as
    // heavily as a day holding seven hundred. Here: one fully-covered
    // hour today at 0%, and a single up sample yesterday. Averaging the
    // two days gives 50%; weighting by duration gives far less, because
    // yesterday's lone sample only vouches for its horizon.
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ name: "API", intervalSeconds: 60 }),
    );
    const points: { minutesAgo: number; ok: boolean }[] = [
      { minutesAgo: 60 * 26, ok: true },
    ];
    for (let m = 60; m >= 1; m--) points.push({ minutesAgo: m, ok: false });
    await seedDays(monitor.id, points);
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    const component = view?.components[0];
    // Yesterday's sample stands for 3 minutes; today's outage for 60.
    // 3 / 63 ≈ 4.8%, nowhere near the 50% a mean of means reports.
    expect(component?.uptime90dPct).toBeLessThan(10);
    expect(component?.dailyUptime.length).toBeGreaterThanOrEqual(2);
  });

  it("charges an outage that straddles midnight to both days", async () => {
    // A `group by date_trunc('day', checked_at)` charges a sample wholly
    // to the day it was taken. A segment that starts at 23:30 and runs
    // to 00:30 belongs half to each.
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ name: "Edge", intervalSeconds: 60 }),
    );
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const minutesSinceMidnight = Math.floor(
      (Date.now() - midnight.getTime()) / 60_000,
    );
    // Only meaningful once the clock is far enough past UTC midnight for
    // both sides of the boundary to sit inside the retained window.
    if (minutesSinceMidnight < 40) return;

    const points: { minutesAgo: number; ok: boolean }[] = [];
    for (
      let m = minutesSinceMidnight + 30;
      m >= minutesSinceMidnight - 30;
      m--
    ) {
      points.push({ minutesAgo: m, ok: false });
    }
    await seedDays(monitor.id, points);
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    const daily = view?.components[0]?.dailyUptime ?? [];
    const measured = daily.filter((d) => d.uptimePct !== null);
    expect(measured.length).toBe(2);
    expect(measured.every((d) => d.uptimePct === 0)).toBe(true);
  });

  it("reports a day with no coverage as null, never as zero", async () => {
    const actor = await createTestOrg();
    const page = await newPage(actor);
    const monitor = await createMonitor(
      db,
      actor,
      monitorInput({ name: "Quiet" }),
    );
    await setStatusPageMonitors(db, actor, {
      statusPageId: page.id,
      monitors: [{ monitorId: monitor.id }],
    });
    const slug = await publishPage(actor, page);

    const view = await getPublicStatusPage(db, slug);
    expect(view?.components[0]?.uptime90dPct).toBeNull();
    expect(view?.components[0]?.dailyUptime).toEqual([]);
  });
});
