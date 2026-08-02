import {
  FIELD_MATRIX,
  TYPE_MATRIX,
  mappedTypes,
  unsupportedTypes,
  type FieldClassification,
  type TypeMapping,
} from "./mapping";

/**
 * The compatibility page, rendered from the matrices.
 *
 * `docs/KUMA-IMPORT.md` is a public claim about what a migration
 * moves, and a public claim maintained by hand is a public claim that
 * goes stale. The tables in it are the output of these functions, and a
 * test asserts the file still contains what they produce — so a type
 * that stops importing cannot leave a page behind saying it does.
 *
 * That is the whole reason this exists rather than a prose table: the
 * one number nobody may get wrong is the one everybody quotes.
 */

function cell(value: string): string {
  // A pipe inside a note would silently split the row and drop the rest
  // of the sentence, which is exactly the kind of quiet loss this
  // module is about.
  return value.replace(/\|/g, "\\|");
}

export interface CompatibilityCounts {
  types: { total: number; mapped: number; unsupported: number };
  columns: Record<FieldClassification, number> & { total: number };
}

export function compatibilityCounts(): CompatibilityCounts {
  const columns: Record<FieldClassification, number> & { total: number } = {
    mapped: 0,
    transformed: 0,
    unsupported: 0,
    "not-applicable": 0,
    total: FIELD_MATRIX.length,
  };
  for (const field of FIELD_MATRIX) columns[field.classification] += 1;
  return {
    types: {
      total: TYPE_MATRIX.length,
      mapped: mappedTypes().length,
      unsupported: unsupportedTypes().length,
    },
    columns,
  };
}

/** Every Kuma type, what it becomes, and what changes or why not. */
export function renderTypeTable(): string {
  // Widened to the interface on purpose. `TYPE_MATRIX` is `as const`,
  // so its element type is a union of literals, and once every entry
  // has a non-null `checkType` the compiler narrows the "not imported"
  // branch below to `never` — which would make the renderer stop
  // compiling the day a type became unmappable again. The table has to
  // outlive the current answer.
  const matrix: readonly TypeMapping[] = TYPE_MATRIX;
  const rows = [...matrix]
    .sort((a, b) => a.kumaType.localeCompare(b.kumaType))
    .map((entry) => {
      const becomes =
        entry.checkType === null ? "- not imported" : `\`${entry.checkType}\``;
      const note = entry.checkType === null ? entry.reason : entry.transform;
      return `| \`${entry.kumaType}\` | ${becomes} | ${cell(note ?? "Imported unchanged.")} |`;
    });
  return [
    "| Uptime Kuma type | Vigil check type | What changes |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** Every `monitor` column and its classification. */
export function renderFieldTable(): string {
  const rows = FIELD_MATRIX.map(
    (field) =>
      `| \`${field.column}\` | ${field.classification} | ${
        field.target === null ? "-" : `\`${field.target}\``
      } | ${cell(field.note)} |`,
  );
  return [
    "| Kuma `monitor` column | Classification | Vigil destination | Note |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** How the 111 columns divide up. */
export function renderCountsTable(): string {
  const counts = compatibilityCounts();
  return [
    "| Classification | Columns |",
    "| --- | --- |",
    `| \`mapped\`: carried unchanged | ${counts.columns.mapped} |`,
    `| \`transformed\`: carried, meaning restated | ${counts.columns.transformed} |`,
    `| \`unsupported\`: Vigil cannot express it | ${counts.columns.unsupported} |`,
    `| \`not-applicable\`: Kuma bookkeeping | ${counts.columns["not-applicable"]} |`,
    `| **total** | **${counts.columns.total}** |`,
  ].join("\n");
}
