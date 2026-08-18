#!/usr/bin/env node
/**
 * Writes the measured tables into `docs/SCALING.md`, in place.
 *
 *   node scripts/bench/scaling-tables.mjs
 *
 * `scheduler-table.mjs` prints a table for a human to copy. This one
 * removes the human. The rule this repository runs on is that a manually
 * copied number is not evidence, and `scripts/bench-check.mjs` enforces
 * it afterwards - but a check that catches a bad transcription is a
 * worse instrument than not transcribing at all, and every round of
 * "bench-check says row three disagrees" was a round spent fixing a
 * typo rather than reading a result.
 *
 * Each table lives between a pair of HTML comments, which stay in the
 * file. Regenerating is therefore idempotent and a reader can see where
 * the generated regions begin and end.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BENCH = join(ROOT, "docs", "evidence", "bench");
const PAGE = join(ROOT, "docs", "SCALING.md");

function load(prefix) {
  return readdirSync(BENCH)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => ({
      name,
      raw: JSON.parse(readFileSync(join(BENCH, name), "utf8")),
    }))
    .sort(
      (a, b) =>
        a.raw.configured.activeMonitorsInDatabase -
          b.raw.configured.activeMonitorsInDatabase ||
        a.raw.configured.workers - b.raw.configured.workers,
    );
}

const HEAD = [
  "| Workers | Achieved | Required | Coverage | Missed | Duplicates | Lag p95 | Lag max | Queue p95 | Tick | Catch-up |",
  "| ------: | -------: | -------: | -------: | -----: | ---------: | ------: | ------: | --------: | ---: | -------: |",
];

/** One row per artefact, in the column order the page's header declares. */
function row(raw) {
  return [
    "",
    raw.configured.workers,
    `${raw.achieved.checksPerSecond.toFixed(2)}/s`,
    `${raw.configured.expectedChecksPerSecond.toFixed(2)}/s`,
    // Two decimals, not none. A run that never probed 0.5% of the fleet
    // printed as "100%" at whole-percent precision, so the published
    // table said every monitor was covered while two dozen starved.
    `${(raw.achieved.coverage * 100).toFixed(2)}%`,
    raw.achieved.missedChecks,
    raw.achieved.duplicateObservations,
    `${raw.schedulerLagSeconds.p95.toFixed(1)}s`,
    `${raw.schedulerLagSeconds.max.toFixed(1)}s`,
    raw.queueDepth.p95,
    `${raw.tick.avgMs.toFixed(0)} ms`,
    raw.catchUp.clearedAfterSeconds === null
      ? "never"
      : `${raw.catchUp.clearedAfterSeconds}s`,
    "",
  ]
    .join(" | ")
    .trim();
}

/**
 * The cap experiment varies batch size, not worker count, so its first
 * column names the variable that actually moved - and its second names
 * the interval, because the same batch against two intervals is two
 * different experiments and the first pair of these looked identical
 * without it.
 */
function capRow(raw) {
  return [
    "",
    raw.configured.schedulerBatch ?? "?",
    `${raw.configured.intervalSeconds}s`,
    raw.configured.activeMonitorsInDatabase,
    raw.configured.workers,
    `${raw.achieved.checksPerSecond.toFixed(2)}/s`,
    `${raw.configured.expectedChecksPerSecond.toFixed(2)}/s`,
    `${(raw.achieved.coverage * 100).toFixed(2)}%`,
    raw.achieved.missedChecks,
    `${raw.schedulerLagSeconds.p95.toFixed(1)}s`,
    "",
  ]
    .join(" | ")
    .trim();
}

const CAP_HEAD = [
  "| Batch | Interval | Monitors | Workers | Achieved | Required | Coverage | Missed | Lag p95 |",
  "| ----: | -------: | -------: | ------: | -------: | -------: | -------: | -----: | ------: |",
];

const before = load("sched-before");
const after = load("sched-after");
const cap = load("cap-").sort(
  (a, b) =>
    a.raw.configured.intervalSeconds - b.raw.configured.intervalSeconds ||
    a.raw.configured.schedulerBatch - b.raw.configured.schedulerBatch,
);

if (before.length === 0 || after.length === 0) {
  console.error(
    `need sched-before-*.json and sched-after-*.json in ${BENCH}; found ${before.length} and ${after.length}`,
  );
  process.exit(2);
}

/**
 * Refuses to publish a broken run.
 *
 * The same rule as `bench-check`, applied one step earlier. A cell whose
 * jobs were throwing produces an artefact full of arithmetically correct
 * numbers about a system that was not running, and the failure this
 * guards against is writing that into the page and only finding out at
 * gate time - by which point the table looks authoritative.
 */
for (const { name, raw } of [...before, ...after, ...cap]) {
  const failures = Object.entries(raw.jobFailures ?? {});
  if (failures.length > 0) {
    console.error(
      `${name}: jobs failed during the window (${failures
        .map(([job, n]) => `${job} x${n}`)
        .join(", ")}); this is not a result`,
    );
    process.exit(3);
  }
  if (raw.environment.treeDirty) {
    console.error(
      `${name}: measured on a dirty tree, so ${raw.environment.commit.slice(0, 7)} does not describe what ran`,
    );
    process.exit(3);
  }
}

// Core does not ship docs/SCALING.md - `edition-gate.sh` removes it,
// because the page documents a commercial fleet view and sends the
// reader to a Settings tab that edition does not have. This script
// still ships, because the package.json pruner only drops a script
// whose file is missing, so in Core `npm run bench:tables` reached an
// unconditional read of a deleted file and died with a raw ENOENT
// stack. `bench-check.mjs` already guarded exactly this and the guard
// was not copied across.
if (!existsSync(PAGE)) {
  console.log(
    "no docs/SCALING.md in this edition, so there is no table to write",
  );
  process.exit(0);
}

let page = readFileSync(PAGE, "utf8");

function splice(marker, lines) {
  const open = `<!-- ${marker} -->`;
  const close = `<!-- /${marker} -->`;
  const block = [open, "", ...lines, "", close].join("\n");
  const existing = new RegExp(`${open}[\\s\\S]*?${close}|${open}`, "");
  if (!existing.test(page)) {
    console.error(`docs/SCALING.md has no ${open} marker`);
    process.exit(2);
  }
  page = page.replace(existing, block);
}

splice("BEFORE-TABLE", [...HEAD, ...before.map((r) => row(r.raw))]);
splice("AFTER-TABLE", [...HEAD, ...after.map((r) => row(r.raw))]);
if (cap.length > 0) {
  splice("CAP-TABLE", [...CAP_HEAD, ...cap.map((r) => capRow(r.raw))]);
}

writeFileSync(PAGE, page);
console.log(
  `docs/SCALING.md: ${before.length} before, ${after.length} after, ${cap.length} cap rows written from ${BENCH}`,
);
