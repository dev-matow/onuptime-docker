import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { monitors, statusPageMonitors, statusPages } from "@/db/schema";
import { importSnapshot, summariseMigration } from "@/modules/importers/engine";
import type { SourceCheck, SourceSnapshot } from "@/modules/importers/model";
import { findProvider } from "@/modules/importers/providers";
import { SECRET_MASK } from "@/modules/monitors/types/config";

import { FIXTURE_SECRET, UPTIMEROBOT } from "../fixtures/migrations/accounts";
import { fakeTransport } from "../fixtures/migrations/fetcher";
import { createTestOrg, db } from "../helpers";

/**
 * The migration engine, against a real database.
 *
 * Three properties here cannot be proved anywhere else, and each of them
 * is a promise the import page makes in words:
 *
 * 1. a dry run writes nothing, and is a real import that was rolled
 *    back rather than an estimate;
 * 2. running the same import twice adds nothing the second time;
 * 3. nothing leaves the source without a line on the report.
 *
 * The fourth, that a credential never reaches a report, is asserted here
 * as well as in the adapter suite, because the report is the artefact an
 * operator pastes into a support ticket.
 */

function check(overrides: Partial<SourceCheck> = {}): SourceCheck {
  return {
    sourceId: "1",
    name: "Example",
    sourceType: "http",
    kind: "http",
    paused: false,
    target: { url: "https://www.example.com/health" },
    ...overrides,
  };
}

function snapshot(overrides: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    provider: "test",
    facts: ["A fixture account."],
    checks: [],
    statusPages: [],
    extras: [],
    ...overrides,
  };
}

async function countMonitors(organizationId: string): Promise<number> {
  const rows = await db
    .select({ id: monitors.id })
    .from(monitors)
    .where(eq(monitors.organizationId, organizationId));
  return rows.length;
}

describe("a dry run", () => {
  it("writes nothing at all, having done the whole import first", async () => {
    const org = await createTestOrg();
    const before = await countMonitors(org.organizationId);

    const report = await importSnapshot(
      db,
      org,
      snapshot({
        checks: [
          check({ sourceId: "1", name: "One" }),
          check({
            sourceId: "2",
            name: "Two",
            kind: "tcp",
            target: { host: "db.example.com", port: 5432 },
          }),
          check({
            sourceId: "3",
            name: "Three",
            groupPath: ["Payments", "EU"],
          }),
        ],
        statusPages: [
          {
            sourceId: "p1",
            name: "Public status",
            slug: "fixture-public-status",
            published: true,
            checkIds: ["1", "2"],
          },
        ],
      }),
      { dryRun: true },
    );

    expect(report.status).toBe("preview");
    expect(report.totals.monitorsCreated).toBeGreaterThan(0);
    expect(await countMonitors(org.organizationId)).toBe(before);

    // Not a monitor, not a group, not a status page and not a row on
    // one. A preview that left any of these behind would be a write
    // wearing the word "preview".
    const pages = await db
      .select({ id: statusPages.id })
      .from(statusPages)
      .where(eq(statusPages.organizationId, org.organizationId));
    expect(pages).toHaveLength(0);
  });

  it("gives ids that name rows which no longer exist, which the status is for", async () => {
    const org = await createTestOrg();
    const report = await importSnapshot(
      db,
      org,
      snapshot({ checks: [check()] }),
      { dryRun: true },
    );
    const created = report.entries.find((entry) => entry.monitorId !== null);
    expect(created?.monitorId).toBeTypeOf("string");
    const found = await db
      .select({ id: monitors.id })
      .from(monitors)
      .where(eq(monitors.id, created?.monitorId ?? ""));
    expect(found).toHaveLength(0);
  });
});

describe("a committed import", () => {
  it("creates the monitors, and says so with the same numbers it previewed", async () => {
    const org = await createTestOrg();
    const source = snapshot({
      checks: [
        check({ sourceId: "1", name: "Alpha" }),
        check({
          sourceId: "2",
          name: "Beta",
          kind: "ping",
          target: { host: "gateway.example.com" },
        }),
      ],
    });

    const preview = await importSnapshot(db, org, source, { dryRun: true });
    const applied = await importSnapshot(db, org, source);

    expect(applied.status).toBe("completed");
    expect(applied.totals.monitorsCreated).toBe(preview.totals.monitorsCreated);
    expect(await countMonitors(org.organizationId)).toBe(2);
  });

  it("carries the paused state, and says it did", async () => {
    const org = await createTestOrg();
    const report = await importSnapshot(
      db,
      org,
      snapshot({ checks: [check({ name: "Paused one", paused: true })] }),
    );
    const entry = report.entries.find((line) => line.kind === "monitor");
    const row = await db.query.monitors.findFirst({
      where: eq(monitors.id, entry?.monitorId ?? ""),
    });
    expect(row?.paused).toBe(true);
    expect(entry?.detail).toContain("Imported paused");
  });

  it("creates a group per path segment, outermost first, and puts the check in it", async () => {
    const org = await createTestOrg();
    await importSnapshot(
      db,
      org,
      snapshot({
        checks: [
          check({
            sourceId: "1",
            name: "Inner",
            groupPath: ["Payments", "EU"],
          }),
        ],
      }),
    );

    const rows = await db
      .select()
      .from(monitors)
      .where(eq(monitors.organizationId, org.organizationId));
    const payments = rows.find((row) => row.name === "Payments");
    const eu = rows.find((row) => row.name === "EU");
    const inner = rows.find((row) => row.name === "Inner");

    expect(payments?.checkType).toBe("group");
    expect(eu?.parentId).toBe(payments?.id);
    expect(inner?.parentId).toBe(eu?.id);
  });

  it("refuses the rows Vigil's own rules refuse, and imports the rest", async () => {
    const org = await createTestOrg();
    const report = await importSnapshot(
      db,
      org,
      snapshot({
        checks: [
          check({ sourceId: "1", name: "Good" }),
          // An address rather than a hostname: an SSRF boundary, not a
          // formatting preference.
          check({
            sourceId: "2",
            name: "Loopback",
            target: { url: "http://127.0.0.1:3001/" },
          }),
          // A POST, which Vigil cannot issue.
          check({ sourceId: "3", name: "Poster", http: { method: "POST" } }),
          // A TCP check with no port.
          check({
            sourceId: "4",
            name: "Portless",
            kind: "tcp",
            target: { host: "db.example.com" },
          }),
          check({ sourceId: "5", name: "Also good", http: { keyword: "ok" } }),
        ],
      }),
    );

    expect(report.totals.monitorsCreated).toBe(2);
    const skipped = report.entries.filter(
      (entry) => entry.outcome === "skipped",
    );
    expect(skipped).toHaveLength(3);
    for (const entry of skipped) {
      expect(entry.detail.length, entry.label).toBeGreaterThan(20);
    }
    expect(await countMonitors(org.organizationId)).toBe(2);
  });

  it("reports an unsupported type without attempting a row", async () => {
    const org = await createTestOrg();
    const report = await importSnapshot(
      db,
      org,
      snapshot({
        checks: [
          check({
            name: "Journey",
            sourceType: "playwright",
            kind: "unsupported",
            unsupportedReason: "The check is a browser script.",
          }),
        ],
      }),
    );
    expect(report.totals.unsupported).toBe(1);
    expect(report.totals.monitorsCreated).toBe(0);
    expect(await countMonitors(org.organizationId)).toBe(0);
  });
});

describe("importing the same source twice", () => {
  it("adds nothing the second time and says why on every line", async () => {
    const org = await createTestOrg();
    const source = snapshot({
      checks: [
        check({ sourceId: "1", name: "Alpha", groupPath: ["Payments"] }),
        check({
          sourceId: "2",
          name: "Beta",
          kind: "tcp",
          target: { host: "db.example.com", port: 5432 },
        }),
      ],
    });

    const first = await importSnapshot(db, org, source);
    const second = await importSnapshot(db, org, source);

    expect(first.totals.monitorsCreated).toBe(3); // two checks and a group
    expect(second.totals.monitorsCreated).toBe(0);
    expect(await countMonitors(org.organizationId)).toBe(3);

    for (const entry of second.entries.filter(
      (line) => line.kind === "monitor",
    )) {
      expect(entry.outcome).toBe("skipped");
      // Two keys now answer this, and they say different things on
      // purpose: provenance knows the source record was imported before,
      // the natural key only knows a monitor like this one is already
      // here. Both are correct and neither may be silent, so the
      // assertion is on the meaning rather than on one of the sentences.
      expect(entry.detail).toMatch(/already (imported|exists)/i);
    }
    // The group is not duplicated. Asserted against the database rather
    // than against a report line, because provenance now answers before
    // the group is ever reached: every check is recognised as already
    // imported, so nothing asks for a folder and no group line is
    // written. That is the right shape - a group is not a source record,
    // it is scaffolding for the records that need it - but it means the
    // proof has to be the row count, which is what the operator cares
    // about anyway.
    const groups = await db
      .select()
      .from(monitors)
      .where(
        and(
          eq(monitors.organizationId, org.organizationId),
          eq(monitors.checkType, "group"),
        ),
      );
    expect(groups).toHaveLength(1);
  });

  it("keeps two folders of the same name in different places apart", async () => {
    const org = await createTestOrg();
    await importSnapshot(
      db,
      org,
      snapshot({
        checks: [
          check({
            sourceId: "1",
            name: "Pay one",
            groupPath: ["Payments", "EU"],
          }),
          check({
            sourceId: "2",
            name: "Bill one",
            groupPath: ["Billing", "EU"],
          }),
        ],
      }),
    );

    // A second import adding NEW checks to the same two folders. This is
    // where matching a group on its name alone goes wrong: both "EU"
    // paths resolve to whichever row was found first, and one team's
    // checks are filed under the other team's folder.
    await importSnapshot(
      db,
      org,
      snapshot({
        checks: [
          check({
            sourceId: "3",
            name: "Pay two",
            groupPath: ["Payments", "EU"],
          }),
          check({
            sourceId: "4",
            name: "Bill two",
            groupPath: ["Billing", "EU"],
          }),
        ],
      }),
    );

    const rows = await db
      .select()
      .from(monitors)
      .where(eq(monitors.organizationId, org.organizationId));
    const payments = rows.find((row) => row.name === "Payments");
    const billing = rows.find((row) => row.name === "Billing");
    const eus = rows.filter((row) => row.name === "EU");
    const under = (name: string): string | null =>
      rows.find((row) => row.name === name)?.parentId ?? null;

    // Two folders called EU, one in each tree, and neither import made
    // a third.
    expect(eus).toHaveLength(2);
    const paymentsEu = eus.find((row) => row.parentId === payments?.id);
    const billingEu = eus.find((row) => row.parentId === billing?.id);
    expect(paymentsEu).toBeDefined();
    expect(billingEu).toBeDefined();

    // And every check is in the folder it came from, including the ones
    // the second run created.
    expect(under("Pay one")).toBe(paymentsEu?.id);
    expect(under("Pay two")).toBe(paymentsEu?.id);
    expect(under("Bill one")).toBe(billingEu?.id);
    expect(under("Bill two")).toBe(billingEu?.id);
  });

  it("treats two identical checks in one snapshot the same way", async () => {
    const org = await createTestOrg();
    const report = await importSnapshot(
      db,
      org,
      snapshot({
        checks: [
          check({ sourceId: "1", name: "Twin" }),
          check({ sourceId: "2", name: "Twin" }),
        ],
      }),
    );
    expect(report.totals.monitorsCreated).toBe(1);
    expect(await countMonitors(org.organizationId)).toBe(1);
  });
});

describe("the report", () => {
  it("leaves a line for every record the source held", async () => {
    const org = await createTestOrg();
    const report = await importSnapshot(
      db,
      org,
      snapshot({
        checks: [
          check({ sourceId: "1", name: "Alpha", tags: ["prod", "web"] }),
          check({ sourceId: "2", name: "Beta", tags: ["prod"] }),
        ],
        statusPages: [
          {
            sourceId: "p1",
            name: "Public",
            slug: "fixture-report-public",
            published: true,
            checkIds: ["1", "2", "missing"],
          },
        ],
        extras: [
          {
            kind: "alerting",
            sourceId: "policies",
            label: "Escalation policies",
            detail: "Vigil routes by escalation policy of its own.",
          },
        ],
      }),
      { dryRun: true },
    );

    const kinds = report.entries.map((entry) => entry.kind);
    expect(kinds.filter((kind) => kind === "monitor")).toHaveLength(2);
    expect(kinds).toContain("status-page");
    expect(kinds).toContain("alerting");
    // One line per distinct tag rather than per application.
    expect(kinds.filter((kind) => kind === "tag")).toHaveLength(2);
    for (const entry of report.entries) {
      expect(
        entry.detail.trim().length,
        `${entry.kind}:${entry.label}`,
      ).toBeGreaterThan(0);
    }
  });

  it("derives its totals from its lines rather than counting alongside them", async () => {
    const org = await createTestOrg();
    const report = await importSnapshot(
      db,
      org,
      snapshot({
        checks: [
          check({ sourceId: "1", name: "Clean" }),
          check({
            sourceId: "2",
            name: "Changed",
            http: { hasRequestBody: true },
          }),
          check({
            sourceId: "3",
            name: "Refused",
            target: { url: "http://127.0.0.1/" },
          }),
        ],
      }),
      { dryRun: true },
    );

    const counted = {
      imported: report.entries.filter((e) => e.outcome === "imported").length,
      transformed: report.entries.filter((e) => e.outcome === "transformed")
        .length,
      skipped: report.entries.filter((e) => e.outcome === "skipped").length,
      unsupported: report.entries.filter((e) => e.outcome === "unsupported")
        .length,
      monitorsCreated: report.entries.filter((e) => e.monitorId !== null)
        .length,
    };
    expect(report.totals).toEqual(counted);
  });

  it("says what happened in text a support ticket can carry", async () => {
    const org = await createTestOrg();
    const report = await importSnapshot(
      db,
      org,
      snapshot({
        checks: [check({ name: "Only one", http: { hasBasicAuth: true } })],
      }),
      { dryRun: true },
    );
    const text = summariseMigration(report);
    expect(text).toContain("Dry run. Nothing was written.");
    expect(text).toContain("source: A fixture account.");
    expect(text).toContain("[transformed]");
  });

  it("shows a config preview with its secrets masked", async () => {
    const org = await createTestOrg();
    const report = await importSnapshot(
      db,
      org,
      snapshot({
        checks: [
          check({
            name: "Nightly job",
            kind: "heartbeat",
            target: { label: "Nightly job" },
            heartbeat: { periodSeconds: 3600, graceSeconds: 300 },
          }),
        ],
      }),
      { dryRun: true },
    );
    const entry = report.entries.find((line) => line.kind === "monitor");
    const preview = entry?.configPreview as { token?: string } | undefined;
    // A push token authenticates one caller to one monitor, so the
    // report shows that there is one rather than what it is.
    expect(preview?.token).toBe(SECRET_MASK);
  });
});

describe("a status page", () => {
  it("is created with the monitors that imported, and names the ones that did not", async () => {
    const org = await createTestOrg();
    // A slug is a public URL and therefore globally unique, so a fixed
    // one here would collide with the row a previous run of this suite
    // committed and the importer would quietly suffix it. Deriving it
    // from the throwaway organisation keeps the assertion exact.
    const slug = `fixture-${org.organizationId.slice(-8)}`;
    const report = await importSnapshot(
      db,
      org,
      snapshot({
        checks: [check({ sourceId: "1", name: "On the page" })],
        statusPages: [
          {
            sourceId: "p1",
            name: "Public status",
            slug,
            published: true,
            checkIds: ["1", "never-imported"],
          },
        ],
      }),
    );

    const page = await db.query.statusPages.findFirst({
      where: and(
        eq(statusPages.organizationId, org.organizationId),
        eq(statusPages.slug, slug),
      ),
    });
    expect(page).toBeDefined();
    const members = await db
      .select({ id: statusPageMonitors.monitorId })
      .from(statusPageMonitors)
      .where(eq(statusPageMonitors.statusPageId, page?.id ?? ""));
    expect(members).toHaveLength(1);

    const entry = report.entries.find((line) => line.kind === "status-page");
    expect(entry?.detail).toContain("1 of the 2 check(s)");
  });

  it("refuses a page whose name cannot become a public URL, and says so", async () => {
    const org = await createTestOrg();
    const report = await importSnapshot(
      db,
      org,
      snapshot({
        statusPages: [
          {
            sourceId: "p1",
            name: "!!",
            slug: "!!",
            published: true,
            checkIds: [],
          },
        ],
      }),
      { dryRun: true },
    );
    const entry = report.entries.find((line) => line.kind === "status-page");
    expect(entry?.outcome).toBe("skipped");
    expect(entry?.detail).toContain("3 to 63 characters");
  });
});

describe("an end-to-end migration from a provider adapter", () => {
  it("reads an account, imports it, and never prints a credential", async () => {
    const org = await createTestOrg();
    const provider = findProvider("uptimerobot");
    expect(provider).toBeDefined();
    const { options } = fakeTransport(UPTIMEROBOT);
    const source = await provider!.read({
      credentials: { token: "integration-token" },
      transport: options,
    });

    const preview = await importSnapshot(db, org, source, { dryRun: true });
    expect(await countMonitors(org.organizationId)).toBe(0);

    const applied = await importSnapshot(db, org, source);
    expect(applied.totals.monitorsCreated).toBe(preview.totals.monitorsCreated);
    expect(applied.totals.monitorsCreated).toBeGreaterThan(0);

    const text = summariseMigration(applied);
    expect(text).not.toContain(FIXTURE_SECRET);
    expect(text).not.toContain("integration-token");
    expect(JSON.stringify(applied)).not.toContain(FIXTURE_SECRET);

    // Every source record still has a line, after a real write.
    expect(
      applied.entries.filter((entry) => entry.kind === "monitor"),
    ).toHaveLength(source.checks.length);

    // And the rows themselves. The report is what an operator reads;
    // this is what the database actually holds, which is where a
    // credential would do the lasting damage.
    const rows = await db
      .select()
      .from(monitors)
      .where(eq(monitors.organizationId, org.organizationId));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(FIXTURE_SECRET);
    expect(JSON.stringify(rows)).not.toContain("integration-token");
  });
});
