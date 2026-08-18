import { createHash } from "node:crypto";

import { and, eq, isNotNull } from "drizzle-orm";

import type { DbClient } from "@/db";
import { monitors } from "@/db/schema";

/**
 * What a migration remembers about where a monitor came from, and the
 * only thing that makes running one twice safe.
 *
 * ── the failure this closes ──────────────────────────────────────────
 *
 * The Uptime Kuma importer created every monitor it could map and asked
 * nothing first. Re-running a migration therefore doubled the fleet, and
 * re-running one is not an exotic act: the report exists to be read, it
 * names the checks that were refused, and the obvious response to "these
 * three were refused because their URLs are IP literals" is to fix them
 * in Kuma and import again. The operator who did that got three fixed
 * monitors and a second copy of the other two hundred, each of which
 * then probed the customer's endpoint on its own schedule and paged the
 * on-call twice for one outage.
 *
 * ── why a recorded id and not a match ────────────────────────────────
 *
 * The provider engine did dedup, on the triple (check type, target,
 * name). That is a guess wearing the costume of a key. Rename an
 * imported monitor in Vigil, which is among the first things anybody
 * does after a migration, and the triple stops matching: the next run
 * imports it again. Widen the guess and it goes wrong the other way,
 * matching a monitor somebody built by hand onto a source record that
 * has nothing to do with it.
 *
 * A source id cannot be renamed out of and cannot collide with a
 * hand-made monitor, because a hand-made monitor has no source id. The
 * cost is that the pair has to be *stored*, which is a migration, and
 * that migration is the honest price of the guarantee.
 *
 * ── what it deliberately does not do ─────────────────────────────────
 *
 * It does not update. A monitor whose source record changed since the
 * last import keeps every setting it has, and the report says the
 * record was already imported rather than quietly rewriting a threshold
 * an operator tuned by hand after the migration. Vigil's importers are
 * additive: nothing an import touches was ever deleted or overwritten,
 * and that promise is worth more than automatic reconciliation, which
 * nobody asked for and which cannot be undone.
 *
 * It also does not backfill. Every monitor that existed before this
 * column has null provenance and will keep it, because nothing anywhere
 * records which source record it came from. The consequence is stated
 * plainly: an organisation that migrated before this release gets one
 * more duplicate fleet on its next re-import, after which every row
 * carries provenance and the import is stable forever. Inventing the
 * missing values from a name match would be the same guess as before,
 * written into the schema where it looks authoritative.
 */

/**
 * The `import_source` value the Uptime Kuma importer records.
 *
 * A constant rather than a literal at the call site because it is
 * written by the importer and read by the same importer's next run, and
 * a typo in one of the two places is a silent return of the duplication
 * this module exists to stop. The provider engine uses the adapter's own
 * id, which is already a constant on the adapter.
 */
export const KUMA_IMPORT_SOURCE = "uptime-kuma";

/** A monitor a previous run of this import created. */
export interface ImportedMonitor {
  id: string;
  name: string;
}

/**
 * Every monitor this organisation already holds from `source`, by the
 * id it had in that system.
 *
 * Read once at the top of the import rather than queried per record: a
 * migration is one transaction and the answer cannot change under it,
 * and a per-record query would be one round trip per source check on a
 * path that already does several.
 *
 * Scoped to the organisation because provenance is. Two tenants
 * migrating off the same Kuma instance are two migrations, and neither
 * may be told anything about the other's rows.
 */
/**
 * What actually goes in the column: a digest of the source id, never the
 * id itself.
 *
 * The value is only ever compared for equality against the same source's
 * next answer, so a digest does the whole job. Storing the id verbatim
 * would not, because for some sources the id IS a credential:
 * Healthchecks.io identifies a check by a UUID that is also the secret
 * in its ping URL, so a migration off it would have copied a live
 * credential into a column that is long-lived, exported with the
 * monitor and present in every database dump. Nothing here needs to be
 * able to read it back, and a value nobody can read back cannot leak.
 *
 * The cost is real and worth stating: `import_source_id` is no longer
 * something an operator can eyeball to see which Kuma row a monitor came
 * from. The import report names the monitor instead, which is what they
 * were actually going to read.
 *
 * Unsalted on purpose. A salt would have to be stored beside the digest
 * to stay comparable, which buys nothing here, and a per-install salt
 * would make the column meaningless after a restore into a new install.
 */
export function sourceKey(sourceId: string): string {
  return createHash("sha256").update(sourceId, "utf8").digest("hex");
}

/**
 * The imported monitors of one source, looked up by the id the source
 * uses.
 *
 * A lookup object rather than a bare Map because the key on the row is a
 * digest and the caller holds the id. Hashing at the call sites would be
 * three places that have to remember, and forgetting in one of them
 * silently disables dedup: every lookup misses, every record is created
 * again, and the fleet doubles with nothing reporting a problem. That is
 * the exact failure this module exists to close, so the hash is applied
 * where it cannot be skipped.
 */
export interface ImportedIndex {
  get(sourceId: string): ImportedMonitor | undefined;
  readonly size: number;
}

export async function loadImportedMonitors(
  db: DbClient,
  organizationId: string,
  source: string,
): Promise<ImportedIndex> {
  const rows = await db
    .select({
      id: monitors.id,
      name: monitors.name,
      sourceId: monitors.importSourceId,
    })
    .from(monitors)
    .where(
      and(
        eq(monitors.organizationId, organizationId),
        eq(monitors.importSource, source),
        // A row with a source but no source id cannot be matched to any
        // record, and mapping it under the empty key would make the
        // first unidentifiable monitor swallow every later one.
        isNotNull(monitors.importSourceId),
      ),
    );
  const byKey = new Map<string, ImportedMonitor>();
  for (const row of rows) {
    if (row.sourceId === null) continue;
    byKey.set(row.sourceId, { id: row.id, name: row.name });
  }
  return {
    get: (sourceId: string) => byKey.get(sourceKey(sourceId)),
    get size() {
      return byKey.size;
    },
  };
}

/**
 * Stamps a freshly created monitor with where it came from.
 *
 * A direct `update` rather than a field on `createMonitorSchema`, and
 * this is the one place an importer writes a monitor column itself. The
 * reason is that provenance is not a monitor *setting*: no form section
 * declares it, no probe reads it, no type switch may reset it, and
 * `monitorColumnsFor` — which is why everything else goes through
 * `createMonitor` — is defined over the settings a spec declares and has
 * nothing to say about it. Routing it through the create path would mean
 * teaching the monitor module about migrations to record a fact only the
 * importer will ever read.
 *
 * Called inside the same savepoint as the create, so a monitor that
 * exists without its provenance is not a state this code can produce.
 * That matters more than it looks: an unstamped monitor is invisible to
 * the next import, which would duplicate it and report nothing wrong.
 */
export async function recordImportSource(
  db: DbClient,
  monitorId: string,
  source: string,
  sourceId: string,
): Promise<void> {
  await db
    .update(monitors)
    .set({ importSource: source, importSourceId: sourceKey(sourceId) })
    .where(eq(monitors.id, monitorId));
}

/**
 * The report line for a source record a previous run already imported.
 *
 * One sentence for both importers, because an operator comparing a
 * Pingdom migration to a Kuma one is entitled to the same words for the
 * same event. It says three things on purpose: that nothing was created,
 * that nothing was *changed* either, and what to do if a fresh copy was
 * what they wanted. "Skipped" on its own reads as a failure the operator
 * has to investigate.
 *
 * The monitor is named rather than pointed at by id, and when the two
 * names disagree the line says both. That second sentence is the only
 * warning anybody gets about the one way provenance can be wrong: source
 * ids are unique within an installation and not across two of them, so
 * an organisation that migrates a second Uptime Kuma instance has its
 * monitor 5 matched against the first instance's monitor 5 and skipped.
 * Skipping a genuinely new monitor is worse than duplicating one, and
 * printing both names is what lets the reader notice. It is also the
 * ordinary rename case, which is why the sentence names both causes
 * rather than accusing the operator of one.
 */
export function alreadyImportedDetail(
  sourceLabel: string,
  sourceId: string,
  monitor: ImportedMonitor,
  /** What the source calls this record now. */
  incomingName: string,
): string {
  const renamed =
    incomingName.trim().toLowerCase() === monitor.name.trim().toLowerCase()
      ? ""
      : ` The source now calls that record "${incomingName}". Either it was renamed on one side since the last import, which changes nothing, or this is a second installation whose record ids collide with the first one's, in which case import it into its own organisation so the two are kept apart.`;
  return (
    `Already imported. ${sourceLabel} ${sourceId} was imported into this organisation by an earlier run and is the Vigil monitor "${monitor.name}", ` +
    `so nothing was created and nothing about it was changed.${renamed} This is what makes running the same import twice safe. ` +
    `Delete that monitor first if you meant to import this record again.`
  );
}
