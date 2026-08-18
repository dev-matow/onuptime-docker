import { PROVIDERS, UNSUPPORTED_SOURCES } from "./index";

/**
 * The migration compatibility page, rendered from the adapters.
 *
 * `docs/MIGRATION.md` is a public claim about what a migration moves,
 * and a public claim maintained by hand is a public claim that goes
 * stale. The tables in it are the output of these functions, and a test
 * asserts the file still contains what they produce, so a source that
 * stops importing cannot leave a page behind saying it does.
 *
 * That is the whole reason this exists rather than a prose table: the
 * one number nobody may get wrong is the one everybody quotes.
 */

function cell(value: string): string {
  // A pipe inside a note would silently split the row and drop the rest
  // of the sentence, which is exactly the kind of quiet loss this whole
  // feature is about.
  return value.replace(/\|/g, "\\|");
}

export interface MigrationCounts {
  /** Sources with an adapter. Uptime Kuma is counted, and is not one. */
  sources: number;
  /** Source check types that become a Vigil monitor. */
  typesMapped: number;
  /** Source check types that deliberately do not. */
  typesUnsupported: number;
  /** Sources this product will not claim to support. */
  refused: number;
}

export function migrationCounts(): MigrationCounts {
  let typesMapped = 0;
  let typesUnsupported = 0;
  for (const provider of PROVIDERS) {
    for (const capability of provider.capabilities) {
      if (capability.becomes === null) typesUnsupported += 1;
      else typesMapped += 1;
    }
  }
  return {
    // Plus one for Uptime Kuma, which has its own module and its own
    // page and is still a source a customer migrates from.
    sources: PROVIDERS.length + 1,
    typesMapped,
    typesUnsupported,
    refused: UNSUPPORTED_SOURCES.length,
  };
}

/** One row per source: how it is read, and what the token must carry. */
export function renderSourceTable(): string {
  const rows = PROVIDERS.map((provider) => {
    const mapped = provider.capabilities.filter(
      (capability) => capability.becomes !== null,
    ).length;
    return `| ${provider.label} | \`${provider.id}\` | ${provider.input.toUpperCase()} | ${mapped}/${provider.capabilities.length} | ${cell(provider.access)} |`;
  });
  return [
    "| Source | Adapter id | Input | Types mapped | What the credential must be |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** Every source check type, what it becomes, and what changes. */
export function renderTypeTable(): string {
  const rows: string[] = [];
  for (const provider of PROVIDERS) {
    for (const capability of provider.capabilities) {
      const becomes =
        capability.becomes === null
          ? "- not imported"
          : `\`${capability.becomes}\``;
      rows.push(
        `| ${provider.label} | \`${capability.sourceType}\` | ${becomes} | ${cell(capability.note)} |`,
      );
    }
  }
  return [
    "| Source | Their type | Vigil check type | What changes |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** What each source cannot bring, whatever the type. */
export function renderLimitationList(): string {
  const blocks = PROVIDERS.map((provider) => {
    const bullets = provider.limitations.map((limitation) => `- ${limitation}`);
    return [`### ${provider.label}`, "", ...bullets].join("\n");
  });
  return blocks.join("\n\n");
}

/** Sources this product will not claim to support, and why. */
export function renderRefusedTable(): string {
  const rows = UNSUPPORTED_SOURCES.map(
    (source) => `| ${source.label} | ${cell(source.reason)} |`,
  );
  return ["| Source | Why not |", "| --- | --- |", ...rows].join("\n");
}
