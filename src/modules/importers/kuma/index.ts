import type { DbClient } from "@/db";

import {
  importKumaDatabase,
  type KumaImportActor,
  type KumaImportOptions,
} from "./import";
import { readKumaDatabase } from "./read";
import type { ImportReport } from "./report";

export { KUMA_PIN, type SchemaDrift } from "./pinned";
export {
  FIELD_MATRIX,
  TYPE_MATRIX,
  fieldMappingFor,
  gamedigProtocolFor,
  mappedTypes,
  typeMappingFor,
  unsupportedTypes,
  type FieldClassification,
  type FieldMapping,
  type KumaMonitorRow,
  type TypeMapping,
} from "./mapping";
export {
  readKumaDatabase,
  schemaDrift,
  type KumaDatabase,
  type KumaRemoteBrowser,
  type KumaSchemaFacts,
} from "./read";
export {
  importKumaDatabase,
  type KumaImportActor,
  type KumaImportOptions,
} from "./import";
export {
  entriesOfKind,
  summariseReport,
  type ImportOutcome,
  type ImportReport,
  type ImportTotals,
  type ReportEntry,
  type SourceKind,
} from "./report";

/**
 * Read a `kuma.db` off disk and import it in one call.
 *
 * The two halves stay separately callable because a caller that has
 * already read the database — to show a preview before committing to
 * the write, which is the flow this is for — should not read it twice.
 */
export async function importKumaFile(
  db: DbClient,
  actor: KumaImportActor,
  path: string,
  options: KumaImportOptions = {},
): Promise<ImportReport> {
  return importKumaDatabase(db, actor, readKumaDatabase(path), options);
}
