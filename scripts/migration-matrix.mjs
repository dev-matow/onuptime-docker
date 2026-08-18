#!/usr/bin/env node
/**
 * Fill docs/MIGRATION.md's generated tables from the adapters.
 *
 *   node scripts/migration-matrix.mjs           rewrite the page
 *   node scripts/migration-matrix.mjs --check   fail if it has drifted
 *
 * The prose is written by hand and the tables are not. Each generated
 * block sits between a pair of HTML comments, so the page stays a page
 * an author edits while the parts nobody may get wrong are derived from
 * `providers/compatibility.ts`.
 *
 * `--check` is the CI guard. Without it, the day an adapter stops
 * importing a type is the day the documentation starts lying, and
 * nothing anywhere notices.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(ROOT, "docs/MIGRATION.md");

/**
 * Run the renderers in the project's own module graph.
 *
 * A throwaway file rather than a `--eval`, because the renderers import
 * through the `@/` alias that `tsx` resolves from `tsconfig.json`, and
 * that resolution needs a real file inside the project.
 */
function render() {
  const dir = mkdtempSync(join(tmpdir(), "vigil-migration-"));
  const probe = join(ROOT, `.migration-probe-${process.pid}.mts`);
  try {
    writeFileSync(
      probe,
      [
        `import * as compatibility from "@/modules/importers/providers/compatibility";`,
        `const parts = {`,
        `  counts: compatibility.migrationCounts(),`,
        `  sources: compatibility.renderSourceTable(),`,
        `  types: compatibility.renderTypeTable(),`,
        `  limits: compatibility.renderLimitationList(),`,
        `  refused: compatibility.renderRefusedTable(),`,
        `};`,
        `process.stdout.write("<<<JSON>>>" + JSON.stringify(parts));`,
      ].join("\n"),
    );
    const out = execFileSync("npx", ["tsx", probe], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, LOG_LEVEL: "error" },
    });
    const marker = out.indexOf("<<<JSON>>>");
    if (marker === -1) throw new Error("migration probe produced no output");
    return JSON.parse(out.slice(marker + "<<<JSON>>>".length));
  } finally {
    rmSync(probe, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Replace one marked block, leaving the markers in place. */
function splice(page, name, body) {
  const open = `<!-- GENERATED:${name} -->`;
  const close = `<!-- /GENERATED:${name} -->`;
  const start = page.indexOf(open);
  const end = page.indexOf(close);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`docs/MIGRATION.md has no ${name} block`);
  }
  return `${page.slice(0, start + open.length)}\n\n${body}\n\n${page.slice(end)}`;
}

/**
 * Through Prettier before comparing, because Prettier owns the column
 * padding in a Markdown table and this script owns the cells. Without
 * this, `--check` fails the moment anyone formats the repository, which
 * would train everybody to ignore it.
 */
function formatted(markdown) {
  return execFileSync(
    "npx",
    ["prettier", "--stdin-filepath", "docs/MIGRATION.md"],
    { cwd: ROOT, input: markdown, encoding: "utf8" },
  );
}

const parts = render();
const current = readFileSync(PAGE, "utf8");
let next = current;
for (const name of ["sources", "types", "limits", "refused"]) {
  next = splice(next, name, parts[name]);
}
next = formatted(next);

if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error(
      "docs/MIGRATION.md is stale. Run `npm run migration:matrix`.",
    );
    process.exit(1);
  }
  console.log(
    `migration: ${parts.counts.sources} sources, ${parts.counts.typesMapped} types mapped, ` +
      `${parts.counts.typesUnsupported} reported as unsupported, ${parts.counts.refused} sources refused.`,
  );
} else {
  writeFileSync(PAGE, next);
  console.log(
    `migration: wrote ${PAGE}, ${parts.counts.sources} sources, ` +
      `${parts.counts.typesMapped} types mapped, ${parts.counts.typesUnsupported} unsupported.`,
  );
}
