import { and, eq, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { monitors, statusPages } from "@/db/schema";
import { createMonitorSchema } from "@/modules/monitors/schemas";
import { createMonitor, setMonitorPaused } from "@/modules/monitors/service";
import { redactConfig } from "@/modules/monitors/types/config";
import { requireSpec } from "@/modules/monitors/types/specs";
import {
  createStatusPage,
  setStatusPageMonitors,
  updateStatusPage,
} from "@/modules/status-pages/service";

import type { SourceCheck, SourceSnapshot } from "./model";
import {
  alreadyImportedDetail,
  loadImportedMonitors,
  recordImportSource,
  type ImportedIndex,
} from "./provenance";
import {
  ReportBuilder,
  insertFailure,
  summariseEntries,
  type ImportStatus,
  type ImportTotals,
  type ReportEntry,
} from "./report";
import { vigilStatusPageSlug } from "./rewrite";
import { translateCheck } from "./translate";

/**
 * The migration engine: one snapshot, one transaction, one report.
 *
 * Everything is written through the modules that own the thing being
 * written, `createMonitor`, `createStatusPage`, `setStatusPageMonitors`,
 * rather than through `db.insert(...)`. The monitor service applies
 * `monitorColumnsFor`, which resets every setting the target type does
 * not declare a form section for, so an imported TCP monitor cannot
 * arrive carrying an `expectedStatusCode` that nothing will ever read
 * but that a later type switch would resurrect. It also writes the audit
 * row, which is the difference between a monitor that appeared and a
 * monitor someone can be shown to have created.
 *
 * ── the transaction, and what it buys ────────────────────────────────
 *
 * One transaction for the whole import. A migration that half-succeeds
 * leaves an operator reconciling two systems by hand at exactly the
 * moment they were trying to stop doing that.
 *
 * That single transaction is also what makes `dryRun` worth having. The
 * preview is not an estimate: it builds every monitor, validates it,
 * inserts it, lets Postgres check every constraint, and then rolls the
 * whole thing back. An operator confirming the second click is
 * confirming a result, not a forecast. The consequence is that the ids
 * on a preview's lines name rows that no longer exist, which is what
 * `status: "preview"` is for.
 *
 * A *single* check that fails to insert does not take the migration down
 * with it. Each one runs inside its own savepoint, so a row Postgres
 * refuses becomes one `skipped` line and the other two hundred still
 * arrive. Without the savepoint the first failure would poison the
 * transaction and every subsequent statement would fail with
 * "current transaction is aborted", which reads as a total outage of the
 * importer rather than as one bad row.
 *
 * ── repeatability ────────────────────────────────────────────────────
 *
 * This module used to say that Vigil's monitors carried no column naming
 * the system they came from and that it deliberately would not add one,
 * because an import log in the schema is a migration every installation
 * pays for to support a feature most of them run once. Repeatability was
 * a property of matching instead, on the triple (check type, target,
 * name), and the cost was written down in the docs: rename an imported
 * monitor in Vigil and a re-import treats it as new.
 *
 * That trade was wrong, and the Uptime Kuma importer is what proved it.
 * That path had no matching at all, so a re-import created a second copy
 * of every monitor: twenty-seven became fifty-four, each duplicate
 * probing the customer's endpoint on its own schedule and paging the
 * on-call twice for one outage. Re-importing is not an exotic act, it is
 * what the report invites, and a guarantee that only one of two import
 * paths offers is not a guarantee. So the pair (`import_source`,
 * `import_source_id`) is now on the monitor row and both paths record
 * it. See `provenance.ts` for the whole argument.
 *
 * Two keys, checked in this order:
 *
 * 1. **Provenance.** The source id this run is looking at, against the
 *    ids previous runs recorded. Survives a rename, cannot collide with
 *    a monitor somebody built by hand.
 * 2. **The natural key**, exactly as before. It is kept because the
 *    monitors an installation imported before provenance existed have
 *    none and can never truthfully be given any, and dropping the older
 *    key would make their next re-import duplicate everything.
 *
 * A natural-key match is deliberately NOT promoted into a provenance
 * record. It is a guess: it matches a hand-made monitor that happens to
 * share a name, type and target, and writing the guess into the column
 * would launder it into a fact that later runs, and the operator, would
 * then trust. It also means this import never writes to a row it did not
 * create, which is the property that makes re-running one safe to
 * recommend.
 */

export interface MigrationActor {
  organizationId: string;
  userId: string;
}

export interface MigrationOptions {
  /**
   * Do the whole import and roll it back, returning what would have
   * happened. The report is identical to the one a real run produces,
   * ids included, and those ids name rows that no longer exist.
   */
  dryRun?: boolean;
}

export interface MigrationReport {
  status: ImportStatus;
  /** The adapter id, so a stored report says what it read. */
  provider: string;
  /** What the adapter said about the read. Never a credential. */
  facts: readonly string[];
  entries: ReportEntry[];
  totals: ImportTotals;
}

/**
 * Rolls back the whole import when the caller only wanted to know.
 *
 * A sentinel thrown from inside the transaction rather than a flag
 * checked after it: Postgres has to be *told* to roll back, and the only
 * way to say so from inside a Drizzle transaction callback is to leave it
 * by throwing. Catching exactly this class is what keeps a genuine
 * failure from being read as a successful dry run.
 */
class DryRunRollback extends Error {
  constructor() {
    super("migration dry run");
    this.name = "DryRunRollback";
  }
}

async function withRollbackOnDryRun(
  db: DbClient,
  dryRun: boolean,
  work: (tx: DbClient) => Promise<void>,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await work(tx);
      if (dryRun) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
}

/**
 * The natural key an import matches an existing monitor on.
 *
 * Separated by NUL rather than a space, because a monitor may legally be
 * named "a b" while another is named "a" with a target ending " b", and
 * a separator that can appear inside a part is a separator that
 * collides.
 */
function identityKey(checkType: string, url: string, name: string): string {
  return [checkType, url.trim().toLowerCase(), name.trim().toLowerCase()].join(
    "\u0000",
  );
}

/**
 * The key a group is matched on, which is its name *and its parent*.
 *
 * A folder named "EU" under Payments and one under Billing are two
 * folders. Matching on the name alone would put the second import's
 * Billing checks inside the first import's Payments group, which is a
 * migration silently rearranging somebody's tree.
 */
function groupKey(parentId: string | null, name: string): string {
  return ["group", parentId ?? "-", name.trim().toLowerCase()].join("\u0000");
}

/**
 * The Vigil group monitors a set of group paths needs, created
 * outermost first.
 *
 * A path rather than an id because the providers disagree about whether
 * a group is a row, a string or a folder. `["Payments", "EU"]` becomes
 * two group monitors, the second inside the first, and a second check on
 * the same path reuses both. An existing group monitor with the same
 * name and parent is reused rather than duplicated, which is what makes
 * a second import of the same source add nothing.
 */
class GroupTree {
  /** joined path -> Vigil monitor id */
  readonly #byPath = new Map<string, string>();
  readonly #entries: ReportEntry[] = [];

  constructor(
    private readonly actor: MigrationActor,
    /**
     * Group monitors already in the organisation, keyed by parent and
     * name. The parent is in the key because two groups called "EU" in
     * different parts of the tree are two different groups, and reusing
     * one for the other would move a folder rather than fill it.
     */
    private readonly existing: ReadonlyMap<string, string>,
  ) {}

  entries(): readonly ReportEntry[] {
    return this.#entries;
  }

  /**
   * The monitor id for the innermost group of `path`, or null.
   *
   * The client is passed per call rather than held, so the caller can
   * hand this a savepoint and have a group that Postgres refuses cost
   * one monitor's grouping instead of the whole migration.
   *
   * That savepoint is also why the failure path undoes this object's own
   * bookkeeping. When the second segment of a path fails, Postgres rolls
   * the first one back too, and a cached id pointing at a row that no
   * longer exists would make every later check in that folder fail on a
   * foreign key with an error nobody could read.
   */
  async resolve(db: DbClient, path: readonly string[]): Promise<string | null> {
    const added: string[] = [];
    const entriesBefore = this.#entries.length;
    let parentId: string | null = null;
    try {
      for (let depth = 0; depth < path.length; depth += 1) {
        const name = (path[depth] ?? "").trim().slice(0, 100);
        if (name.length === 0) continue;
        const key = path.slice(0, depth + 1).join("/");
        const known = this.#byPath.get(key);
        if (known !== undefined) {
          parentId = known;
          continue;
        }
        const reused = this.existing.get(groupKey(parentId, name));
        if (reused !== undefined) {
          this.#byPath.set(key, reused);
          added.push(key);
          this.#entries.push({
            kind: "group",
            sourceId: key,
            label: name,
            outcome: "imported",
            detail:
              "A group of this name already existed in this organisation and was reused rather than duplicated, so importing the same source twice does not produce two of everything.",
            // Deliberately null: it counts a monitor this run did not
            // create, and `monitorsCreated` counts rows this run added.
            monitorId: null,
          });
          parentId = reused;
          continue;
        }
        // Through the schema rather than hand-built, so a group monitor
        // gets exactly the defaults a group created in the form would and
        // a new column with a default cannot be forgotten here.
        const created = await createMonitor(
          db,
          this.actor,
          createMonitorSchema.parse({
            name,
            checkType: "group",
            url: name,
            parentId,
          }),
        );
        this.#byPath.set(key, created.id);
        added.push(key);
        this.#entries.push({
          kind: "group",
          sourceId: key,
          label: name,
          outcome: "imported",
          detail: `Created as a Vigil group monitor${
            parentId === null ? "" : ` inside "${path[depth - 1] ?? ""}"`
          }. A group's state is derived from its members rather than measured.`,
          monitorId: created.id,
        });
        parentId = created.id;
      }
      return parentId;
    } catch (error) {
      for (const key of added) this.#byPath.delete(key);
      this.#entries.length = entriesBefore;
      throw error;
    }
  }
}

/**
 * Imports one already-read snapshot into an organisation.
 *
 * Takes the snapshot rather than credentials so the caller controls the
 * network call, and so the same bytes can be previewed and then applied
 * without asking the provider twice.
 */
export async function importSnapshot(
  db: DbClient,
  actor: MigrationActor,
  snapshot: SourceSnapshot,
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  const dryRun = options.dryRun === true;
  const report = new ReportBuilder();
  const checkEntries = new Map<string, ReportEntry>();
  const groupEntries: ReportEntry[] = [];
  const pageEntries: ReportEntry[] = [];
  /** source check id -> the Vigil monitor it became. */
  const created = new Map<string, { id: string; name: string }>();

  await withRollbackOnDryRun(db, dryRun, async (tx) => {
    const existing = await loadExisting(tx, actor.organizationId);
    // Read once, inside the transaction: a migration cannot see a write
    // that lands under it, and one query beats one per check.
    const imported = await loadImportedMonitors(
      tx,
      actor.organizationId,
      snapshot.provider,
    );
    const groups = new GroupTree(actor, existing);

    for (const check of snapshot.checks) {
      const entry = await importCheck(
        tx,
        actor,
        snapshot.provider,
        check,
        groups,
        existing,
        imported,
        created,
      );
      checkEntries.set(check.sourceId, entry);
    }
    groupEntries.push(...groups.entries());

    await importStatusPages(tx, actor, snapshot, created, pageEntries);
  });

  for (const check of snapshot.checks) {
    const entry = checkEntries.get(check.sourceId);
    if (entry !== undefined) report.add(entry);
  }
  for (const entry of groupEntries) report.add(entry);
  for (const entry of pageEntries) report.add(entry);

  reportTags(snapshot, report);
  for (const extra of snapshot.extras) {
    report.add({
      kind: extra.kind,
      sourceId: extra.sourceId,
      label: extra.label,
      outcome: "unsupported",
      detail: extra.detail,
      monitorId: null,
    });
  }

  return {
    status: dryRun ? "preview" : "completed",
    provider: snapshot.provider,
    facts: snapshot.facts,
    entries: report.list(),
    totals: report.totals(),
  };
}

/**
 * Existing monitors in the organisation, by natural key.
 *
 * Group monitors appear twice: once under the same key as any other
 * monitor, so a source check that happens to be named like a group is
 * still matched, and once under `groupKey`, which includes the parent
 * because a folder's identity is where it sits as well as what it is
 * called.
 */
async function loadExisting(
  db: DbClient,
  organizationId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      id: monitors.id,
      name: monitors.name,
      url: monitors.url,
      checkType: monitors.checkType,
      parentId: monitors.parentId,
    })
    .from(monitors)
    .where(eq(monitors.organizationId, organizationId));
  const byKey = new Map<string, string>();
  for (const row of rows) {
    byKey.set(identityKey(row.checkType, row.url, row.name), row.id);
    if (row.checkType === "group") {
      byKey.set(groupKey(row.parentId, row.name), row.id);
    }
  }
  return byKey;
}

/** Whether any monitor anywhere already answers on this push token. */
async function pushTokenTaken(db: DbClient, token: string): Promise<boolean> {
  const rows = await db
    .select({ id: monitors.id })
    .from(monitors)
    .where(
      and(
        eq(monitors.checkType, "push"),
        sql`${monitors.config} ->> 'token' = ${token}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function importCheck(
  tx: DbClient,
  actor: MigrationActor,
  provider: string,
  check: SourceCheck,
  groups: GroupTree,
  existing: Map<string, string>,
  imported: ImportedIndex,
  created: Map<string, { id: string; name: string }>,
): Promise<ReportEntry> {
  const label =
    check.name.trim().length > 0 ? check.name.trim() : check.sourceId;
  const base = {
    kind: "monitor" as const,
    sourceId: check.sourceId,
    label,
  };

  // Provenance first, and before the check is even translated. A record
  // a previous run imported needs no mapping decision made about it, and
  // asking this first is what makes the answer survive a rename: every
  // key below is derived from values an operator may have edited since.
  const already = imported.get(check.sourceId);
  if (already !== undefined) {
    // Recorded as this check's monitor, so a status page that published
    // it still publishes it on a re-run. Only the provenance branch does
    // this; the natural-key branch below is a guess, and a guess is not
    // good enough to put somebody's monitor on a public page.
    created.set(check.sourceId, { id: already.id, name: already.name });
    return {
      ...base,
      outcome: "skipped",
      detail: alreadyImportedDetail(
        `${provider} record`,
        check.sourceId,
        already,
        label,
      ),
      monitorId: null,
    };
  }

  const translated = translateCheck(check);
  if (translated.outcome === "unsupported") {
    return {
      ...base,
      outcome: "unsupported",
      detail: translated.detail,
      monitorId: null,
    };
  }

  const build = translated.build;
  const notes = [...build.notes];
  const refusals = [...build.refusals];

  if (check.groupPath !== undefined && check.groupPath.length > 0) {
    try {
      const parentId = await tx.transaction((sp) =>
        groups.resolve(sp, check.groupPath ?? []),
      );
      if (parentId !== null) {
        build.input.parentId = parentId;
        notes.push(`Kept in the group "${check.groupPath.join(" / ")}".`);
      }
    } catch (error) {
      notes.push(
        `The group "${check.groupPath.join(" / ")}" could not be created, so this monitor arrives without one: ${insertFailure(error)}`,
      );
    }
  }

  const parsed = createMonitorSchema.safeParse(build.input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const at = issue.path.join(".");
      const message = at.length > 0 ? `${at}: ${issue.message}` : issue.message;
      if (
        !refusals.some((existingText) => existingText.includes(issue.message))
      ) {
        refusals.push(`Vigil's monitor rules refuse it, ${message}`);
      }
    }
  }

  if (refusals.length > 0 || !parsed.success) {
    // The notes come too, even though nothing was written. An operator
    // who fixes the URL and re-runs should already know the headers are
    // not coming either, rather than finding out on the second pass.
    const alsoLost =
      notes.length === 0 ? "" : ` Had it imported: ${notes.join(" ")}`;
    return {
      ...base,
      outcome: "skipped",
      detail: `${refusals.join(" ")}${alsoLost}`,
      monitorId: null,
    };
  }

  const key = identityKey(
    parsed.data.checkType,
    parsed.data.url,
    parsed.data.name,
  );
  const duplicate = existing.get(key);
  if (duplicate !== undefined) {
    return {
      ...base,
      outcome: "skipped",
      detail: `A monitor with this name, type and target already exists in this organisation, so nothing was created. This is what makes running the same import twice safe. Rename or delete the existing monitor if you meant to replace it.`,
      monitorId: null,
    };
  }

  // The push token is the one setting whose validity depends on rows
  // outside this snapshot: `/api/push/<token>` resolves a caller to
  // exactly one monitor, and the database says so with a unique index.
  if (parsed.data.checkType === "push") {
    const config = parsed.data.config as { token?: string } | null;
    if (config !== null && typeof config?.token === "string") {
      if (await pushTokenTaken(tx, config.token)) delete config.token;
    }
  }

  let monitor;
  try {
    monitor = await tx.transaction(async (sp) => {
      const created = await createMonitor(sp, actor, parsed.data);
      // Inside the same savepoint as the create. A monitor that exists
      // without its provenance is invisible to the next import, which
      // would duplicate it and report nothing wrong, so the two writes
      // have to succeed or fail together.
      await recordImportSource(sp, created.id, provider, check.sourceId);
      return created;
    });
  } catch (error) {
    return {
      ...base,
      outcome: "skipped",
      detail: `Vigil refused to store it: ${insertFailure(error)}. The rest of the import was unaffected.`,
      monitorId: null,
    };
  }

  existing.set(key, monitor.id);
  created.set(check.sourceId, { id: monitor.id, name: monitor.name });

  if (check.paused) {
    await setMonitorPaused(tx, actor, monitor.id, true);
    notes.push("Imported paused, as it was in the source.");
  }

  const spec = requireSpec(parsed.data.checkType);
  return {
    ...base,
    outcome: notes.length === 0 ? "imported" : "transformed",
    detail:
      notes.length === 0
        ? `Imported as a Vigil ${parsed.data.checkType} monitor with nothing changed.`
        : `Imported as a Vigil ${parsed.data.checkType} monitor. ${notes.join(" ")}`,
    monitorId: monitor.id,
    // Redacted, not raw. The report is rendered, and a rendered
    // credential is the same leak `redactConfig` exists to close.
    configPreview:
      monitor.config === null ? undefined : redactConfig(spec, monitor.config),
  };
}

/**
 * Every tag the source applied, as one line each.
 *
 * Per tag rather than per application: a hundred checks carrying
 * `env:prod` is one capability an operator has to replace, not a hundred
 * of them, and a line each would bury the report.
 */
function reportTags(snapshot: SourceSnapshot, report: ReportBuilder): void {
  const seen = new Map<string, string[]>();
  for (const check of snapshot.checks) {
    for (const tag of check.tags ?? []) {
      const applied = seen.get(tag) ?? [];
      applied.push(check.name);
      seen.set(tag, applied);
    }
  }
  for (const [tag, appliedTo] of seen) {
    report.add({
      kind: "tag",
      sourceId: tag,
      label: tag,
      outcome: "unsupported",
      detail: `Applied to ${appliedTo.length} check(s) in the source. Vigil has no monitor tags: nothing in the schema can hold the name or its colour. A group is the nearest thing and is not the same thing, because a monitor belongs to one group and carries any number of tags. ${
        appliedTo.length <= 8
          ? `Tagged: ${appliedTo.join(", ")}.`
          : `Tagged: ${appliedTo.slice(0, 8).join(", ")} and ${appliedTo.length - 8} more.`
      }`,
      monitorId: null,
    });
  }
}

/** Vigil's status page cap; anything past it is reported, not lost. */
const MAX_PAGE_MONITORS = 50;

async function importStatusPages(
  db: DbClient,
  actor: MigrationActor,
  snapshot: SourceSnapshot,
  created: ReadonlyMap<string, { id: string; name: string }>,
  entries: ReportEntry[],
): Promise<void> {
  for (const page of snapshot.statusPages) {
    const label =
      page.name.trim().length > 0 ? page.name.trim() : page.sourceId;
    const notes = [...(page.losses ?? [])];
    const base = vigilStatusPageSlug(page.slug ?? label);

    if (base === null) {
      entries.push({
        kind: "status-page",
        sourceId: page.sourceId,
        label,
        outcome: "skipped",
        detail: `Neither the source slug nor the page name can become a Vigil one: a slug is 3 to 63 characters of lowercase letters, digits and dashes, because it is the public URL. Create the page by hand and add the imported monitors to it.`,
        monitorId: null,
      });
      continue;
    }

    // Asked before inserting rather than caught afterwards, because a
    // slug is globally unique across tenants and the polite outcome is a
    // suffix rather than a refusal. It is a read, so it is only ever an
    // answer about the moment it was asked: another tenant committing
    // the same slug between this SELECT and the insert below still fails
    // the insert, which is why the write is inside a savepoint. The
    // comment here used to claim this check was what stopped a failed
    // insert taking the whole migration down with it. It never was.
    const slug = await freeSlug(db, base);
    if (slug === null) {
      entries.push({
        kind: "status-page",
        sourceId: page.sourceId,
        label,
        outcome: "skipped",
        detail: `The slug "${base}" and every variation of it this importer tried are already in use, and a slug is the public URL so it can only belong to one page. Create the page under another slug and add the imported monitors to it.`,
        monitorId: null,
      });
      continue;
    }
    if (slug !== page.slug) {
      notes.push(`The public URL is /status/${slug}.`);
    }

    const members: { monitorId: string; displayName: null }[] = [];
    let missing = 0;
    for (const checkId of page.checkIds) {
      const monitor = created.get(checkId);
      if (monitor === undefined) {
        missing += 1;
        continue;
      }
      if (members.some((existing) => existing.monitorId === monitor.id)) {
        continue;
      }
      if (members.length >= MAX_PAGE_MONITORS) {
        missing += 1;
        continue;
      }
      members.push({ monitorId: monitor.id, displayName: null });
    }

    // One savepoint for the page, its settings and its member list,
    // because all three are one thing: a page that exists with the wrong
    // visibility or with nothing on it is worse than no page. And a
    // catch, because without one a slug another tenant took a
    // millisecond ago would abort the transaction and take every monitor
    // this migration just created with it. That is not hypothetical: it
    // was reproduced, and it cost a whole twenty-seven monitor import.
    try {
      await db.transaction(async (sp) => {
        const vigilPage = await createStatusPage(sp, actor, {
          name: label.slice(0, 100),
          slug,
        });
        await updateStatusPage(sp, actor, {
          statusPageId: vigilPage.id,
          name: label.slice(0, 100),
          slug,
          published: page.published,
          showBranding: true,
          visibility: "public",
        });
        await setStatusPageMonitors(sp, actor, {
          statusPageId: vigilPage.id,
          monitors: members,
        });
      });
    } catch (error) {
      entries.push({
        kind: "status-page",
        sourceId: page.sourceId,
        label,
        outcome: "skipped",
        detail: `Vigil refused to store it: ${insertFailure(error)}. The rest of the import was unaffected, so the monitors this page published are imported and only the page itself has to be recreated by hand.`,
        monitorId: null,
      });
      continue;
    }

    if (missing > 0) {
      notes.push(
        `${missing} of the ${page.checkIds.length} check(s) this page published are not on it: either they did not import, in which case their own report line says why, or the page is at Vigil's limit of ${MAX_PAGE_MONITORS} monitors.`,
      );
    }

    entries.push({
      kind: "status-page",
      sourceId: page.sourceId,
      label,
      outcome: notes.length === 0 ? "imported" : "transformed",
      detail:
        `Imported as /status/${slug} with ${members.length} monitor(s)${page.published ? ", published" : ", unpublished as it was in the source"}. ${notes.join(" ")}`.trim(),
      monitorId: null,
    });
  }
}

/**
 * The first free slug at or after `base`, or null when there is none
 * within a handful of tries.
 */
async function freeSlug(db: DbClient, base: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base.slice(0, 60)}-${attempt}`;
    const taken = await db.query.statusPages.findFirst({
      where: eq(statusPages.slug, candidate),
      columns: { id: true },
    });
    if (taken === undefined) return candidate;
  }
  return null;
}

/** The report as text, for a CLI run or a support ticket. */
export function summariseMigration(report: MigrationReport): string {
  const lines: string[] = [];
  lines.push(
    report.status === "refused"
      ? "Import refused. Nothing was written."
      : report.status === "preview"
        ? `Dry run. Nothing was written. ${report.totals.monitorsCreated} monitor(s) would be imported.`
        : `Imported ${report.totals.monitorsCreated} monitor(s).`,
  );
  for (const fact of report.facts) lines.push(`  source: ${fact}`);
  lines.push(...summariseEntries(report.totals, report.entries));
  return lines.join("\n");
}
