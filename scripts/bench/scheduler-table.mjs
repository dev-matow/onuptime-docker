#!/usr/bin/env node
/**
 * Turns scheduler artefacts into the markdown rows `docs/SCALING.md`
 * quotes.
 *
 *   node scripts/bench/scheduler-table.mjs docs/evidence/bench 'sched-after'
 *
 * This exists so no cell in that table is ever typed by hand. The rule
 * this repository runs on is that a manually copied number is not
 * evidence, and `scripts/bench-check.mjs` enforces it after the fact -
 * but the cheapest way to pass that check is to never transcribe
 * anything in the first place.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const prefix = process.argv[3] ?? "";
if (!dir) {
  console.error("usage: scheduler-table.mjs <dir> [prefix]");
  process.exit(2);
}

const rows = readdirSync(dir)
  .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")))
  .sort(
    (a, b) =>
      a.configured.activeMonitorsInDatabase -
        b.configured.activeMonitorsInDatabase ||
      a.configured.workers - b.configured.workers,
  );

const cell = (value, width) => String(value).padStart(width);

console.log(
  "| Workers | Achieved | Required | Coverage | Missed | Duplicates | Lag p95 | Lag max | Queue p95 | Tick | Catch-up |",
);
console.log(
  "| ------: | -------: | -------: | -------: | -----: | ---------: | ------: | ------: | --------: | ---: | -------: |",
);
for (const run of rows) {
  const catchUp =
    run.catchUp.clearedAfterSeconds === null
      ? "never"
      : `${run.catchUp.clearedAfterSeconds}s`;
  console.log(
    [
      "",
      cell(run.configured.workers, 7),
      cell(`${run.achieved.checksPerSecond.toFixed(2)}/s`, 8),
      cell(`${run.configured.expectedChecksPerSecond.toFixed(2)}/s`, 8),
      // Two decimals, not none. A 5000-monitor run that never probed 24
      // of them is 99.52% covered and printed "100%" at whole-percent
      // precision - so the published table said every monitor was
      // covered while two dozen were starved.
      cell(`${(run.achieved.coverage * 100).toFixed(2)}%`, 8),
      cell(run.achieved.missedChecks, 6),
      cell(run.achieved.duplicateObservations, 10),
      cell(`${run.schedulerLagSeconds.p95.toFixed(1)}s`, 7),
      cell(`${run.schedulerLagSeconds.max.toFixed(1)}s`, 7),
      cell(run.queueDepth.p95, 9),
      cell(`${run.tick.avgMs.toFixed(0)} ms`, 4),
      cell(catchUp, 8),
      "",
    ].join(" | "),
  );
}
