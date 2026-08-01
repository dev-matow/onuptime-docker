#!/usr/bin/env node
/**
 * The Uptime Kuma mapping matrix, as a file something other than the
 * TypeScript build can read.
 *
 *   node scripts/kuma-matrix.mjs           regenerate kuma-mapping.json
 *   node scripts/kuma-matrix.mjs --check   fail if it has drifted
 *
 * The mapping already exists exactly once, in
 * `src/modules/importers/kuma/mapping.ts`, and that stays the source of
 * truth. What it does not do is answer a question from outside the app:
 * a migration reviewer, a CI job, or an operator deciding whether their
 * install will come across cannot import a `.ts` module. So this emits
 * the same two tables verbatim, plus the pin they were written against
 * and the fixture they were tested against.
 *
 * It derives, never restates. If a reviewer wants to know whether
 * `mqtt` imports, the answer here is the same object the importer
 * branches on — not a sentence somebody kept up to date by hand.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = join(ROOT, "kuma-mapping.json");
const FIXTURE = "tests/fixtures/kuma/kuma-2.4.0.db";

const CHECK = process.argv.includes("--check");

function readMapping() {
  const script = `
    import { FIELD_MATRIX, TYPE_MATRIX, NOTABLE_DROPS } from "@/modules/importers/kuma/mapping";
    import { KUMA_PIN } from "@/modules/importers/kuma/pinned";
    process.stdout.write("@@" + JSON.stringify({
      pin: KUMA_PIN,
      types: TYPE_MATRIX,
      fields: FIELD_MATRIX,
      drops: NOTABLE_DROPS,
    }) + "@@");
  `;
  const out = execFileSync("npx", ["tsx", "-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const match = out.match(/@@(.*)@@/s);
  if (!match) throw new Error("kuma mapping probe produced no output");
  return JSON.parse(match[1]);
}

const { pin, types, fields, drops } = readMapping();

if (!existsSync(join(ROOT, FIXTURE))) {
  console.error(`fixture missing: ${FIXTURE}`);
  process.exit(1);
}

const artifact = {
  // Regenerate with `npm run kuma:matrix`; `--check` is a CI guard.
  generatedBy: "scripts/kuma-matrix.mjs",
  kuma: {
    release: pin.release,
    commit: pin.commit,
    publishedOn: pin.publishedOn,
    image: pin.image,
    databaseVersion: pin.databaseVersion,
    fixture: FIXTURE,
  },
  counts: {
    // Two different numbers, kept apart on purpose: a type having an
    // equivalent is not a promise that every monitor of that type
    // imports. Monitor outcomes are in the import report, not here.
    kumaTypes: types.length,
    typesMapped: types.filter((t) => t.checkType !== null).length,
    typesUnmapped: types.filter((t) => t.checkType === null).length,
    monitorColumns: fields.length,
  },
  types,
  fields,
  notableDrops: drops,
};

// The pin states these counts independently of the tables; if they
// ever disagree, one of the two was edited without the other and the
// artefact would publish the disagreement as fact.
for (const [what, fromPin, fromMatrix] of [
  ["selectable types", pin.selectableTypes, artifact.counts.kumaTypes],
  ["monitor columns", pin.monitorColumnCount, artifact.counts.monitorColumns],
]) {
  if (fromPin !== fromMatrix) {
    console.error(
      `KUMA_PIN says ${fromPin} ${what}, the matrix has ${fromMatrix}.`,
    );
    process.exit(1);
  }
}

const serialised = `${JSON.stringify(artifact, null, 2)}\n`;

if (CHECK) {
  const current = existsSync(ARTIFACT) ? readFileSync(ARTIFACT, "utf8") : "";
  if (current !== serialised) {
    console.error("kuma-mapping.json is stale. Run `npm run kuma:matrix`.");
    process.exit(1);
  }
  console.log(
    `kuma: ${artifact.counts.typesMapped}/${artifact.counts.kumaTypes} types mapped, ` +
      `${artifact.counts.monitorColumns} columns classified, pinned to ${pin.release}`,
  );
} else {
  writeFileSync(ARTIFACT, serialised);
  console.log(
    `kuma: wrote ${ARTIFACT} — ${artifact.counts.typesMapped}/${artifact.counts.kumaTypes} types, ` +
      `${artifact.counts.monitorColumns} columns`,
  );
}
