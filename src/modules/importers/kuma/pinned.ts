/**
 * The one Uptime Kuma release this importer claims to understand.
 *
 * Kuma's `monitor` table is not a published interface. It is 111 columns
 * that accreted across 50 knex migrations, several of them reused by a
 * later type for an unrelated purpose — `radius_password` holds an SNMP
 * community string, `radius_username` an Oracle login. Nothing in the
 * schema says so; you learn it by reading the release you targeted.
 *
 * Targeting `master` would make every claim this module publishes true
 * only on the day it was written. "Imports 31 of 31 monitor types" is a
 * statement about a specific type selector in a specific
 * `EditMonitor.vue`; a moving target turns it into a number that decays
 * silently, and the first anyone hears of it is an operator whose
 * migration dropped a type nobody knew existed. So the version is
 * pinned, the facts about it are asserted against the fixture, and a
 * Kuma release that changes any of them fails a test rather than
 * quietly publishing a wrong number.
 *
 * Refreshing this means re-running the seed against the new image and
 * re-diffing the type selector — see `tests/fixtures/kuma/README.md`.
 */
export const KUMA_PIN = {
  release: "2.4.0",
  commit: "9f3b837c8c7f359ec1acee80b3c0430451986a03",
  publishedOn: "2026-05-31",
  image: "louislam/uptime-kuma:2.4.0",
  /** `setting.database_version`, Kuma's own schema stamp. */
  databaseVersion: 10,
  /** Columns on `monitor`. The field matrix must classify every one. */
  monitorColumnCount: 111,
  /**
   * Entries in Kuma's top-level monitor-type selector, counted from the
   * 2.4.0 tag's `src/pages/EditMonitor.vue`.
   *
   * Group and Manual are counted: they are values Kuma writes to
   * `monitor.type` and rows an importer therefore has to account for,
   * even though neither describes a probe. The 29 figure exists because
   * Kuma's own comparison tables quote it, and a compatibility page that
   * cites a different denominator than the project it compares against
   * invites exactly the argument it was written to prevent.
   */
  selectableTypes: 31,
  selectableProbeTypes: 29,
} as const;

/** One way the source database disagrees with {@link KUMA_PIN}. */
export interface SchemaDrift {
  subject: "database_version" | "monitor_columns" | "monitor_types";
  detail: string;
}
