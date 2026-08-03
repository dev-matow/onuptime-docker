#!/usr/bin/env node
/**
 * Validates the benchmark artefacts, and the table that quotes them.
 *
 *   node scripts/bench-check.mjs
 *
 * Two failures this exists to catch, both of which have happened to
 * other projects and neither of which any other check here would see.
 *
 * FIRST: a published number that no longer matches the run it came
 * from. `docs/HIGH-FREQUENCY.md` states achieved rate, percentiles and
 * missed slots per N; every one of those is copied by hand out of the
 * raw JSON. The repository's own rule is that a manually copied number
 * is not evidence, so each cell is compared against the artefact it
 * claims to quote.
 *
 * SECOND: an artefact that cannot be audited. A benchmark result with
 * no commit, no environment and no window is a number with no
 * provenance, unreproducible by definition, however true it was on the
 * day. Every required field is asserted present.
 *
 * What this cannot do is re-run the benchmark. It checks that what was
 * published matches what was measured, not that what was measured is
 * still what the code does; `scripts/bench/high-frequency.mjs` is the
 * only thing that answers the second question.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = join(ROOT, "docs", "evidence", "bench");
const PAGE = join(ROOT, "docs", "HIGH-FREQUENCY.md");

const problems = [];
const fail = (message) => problems.push(message);

/* ── the artefacts ─────────────────────────────────────────────────── */

const files = readdirSync(BENCH).filter((name) => name.endsWith(".json"));
if (files.length === 0) fail(`no benchmark artefacts in ${BENCH}`);

/** Field, and why a result without it cannot be audited. */
const REQUIRED = [
  ["window.seconds", "the observation window is what every rate divides by"],
  ["configured.monitors", "N"],
  ["configured.intervalMs", "the cadence that was requested"],
  ["achieved.checksPerSecond", "what actually happened"],
  ["cadenceMs.p50", "cadence distribution"],
  ["cadenceMs.p99", "the tail is the interesting half"],
  ["missedSlots", "a slot that never ran is the failure this measures"],
  ["database.transactionsPerSecond", "the cost side of the result"],
  ["environment.commit", "which code produced it"],
  ["environment.node", "runtime"],
  ["environment.postgres", "the database it wrote to"],
  ["environment.cpuModel", "the machine"],
  ["caveats", "what the number does NOT say"],
];

const pick = (object, path) =>
  path.split(".").reduce((value, key) => value?.[key], object);

const runs = new Map();

for (const name of files) {
  const raw = JSON.parse(readFileSync(join(BENCH, name), "utf8"));
  for (const [path, why] of REQUIRED) {
    if (pick(raw, path) === undefined || pick(raw, path) === null) {
      fail(`${name}: missing \`${path}\`: ${why}`);
    }
  }

  // A run that says "500 ms" and was configured for something else is
  // the single most misleading artefact this directory could hold.
  if (raw.configured?.intervalMs !== 500) {
    fail(
      `${name}: configured intervalMs is ${raw.configured?.intervalMs}, not 500`,
    );
  }

  // Cadence is derived from samples; a run with none measured nothing.
  if (!(raw.cadenceMs?.samples > 0)) {
    fail(`${name}: no cadence samples`);
  }

  // The caveat that keeps cadence, detection and notification apart is
  // load-bearing for every public sentence about this feature.
  const caveats = (raw.caveats ?? []).join(" ").toLowerCase();
  if (!caveats.includes("cadence") || !caveats.includes("detection")) {
    fail(`${name}: caveats do not separate cadence from detection time`);
  }

  const n = raw.configured?.monitors;
  if (runs.has(n))
    fail(`two artefacts for N=${n}; the table cannot quote both`);
  runs.set(n, { name, raw });
}

/* ── the channel fan-out artefact ──────────────────────────────────── */
// A third shape, in a third directory, and NOT edition-marked: channels
// ship in both editions, so both have to be able to prove the numbers.
//
// This one exists because "unlimited channels" is a claim, and a claim
// about scale that nobody can reproduce is marketing. The artefact is
// what `docs/NOTIFICATIONS.md` quotes; the required fields below are the
// ones without which a reader could not tell what was measured.
const CHANNEL_BENCH = join(ROOT, "docs", "evidence", "channel-bench");

const CHANNEL_REQUIRED = [
  ["sizes", "the measurements themselves"],
  ["method", "how the run was configured"],
  ["environment.commit", "which code produced it"],
  ["environment.node", "runtime"],
  ["environment.postgres", "the database it wrote to"],
  ["environment.cpuModel", "the machine"],
  ["caveats", "what the number does NOT say"],
];

let channelFiles = [];
try {
  channelFiles = readdirSync(CHANNEL_BENCH).filter((name) =>
    name.endsWith(".json"),
  );
} catch {
  fail(`no channel benchmark directory at ${CHANNEL_BENCH}`);
}
if (channelFiles.length === 0)
  fail(`no channel benchmark artefacts in ${CHANNEL_BENCH}`);

// Two shapes live in this directory now, and they are checked
// separately for the same reason the probe artefacts are kept apart
// from the high-frequency ones: one measures the cost of many
// CHANNELS, the other the cost of many QUEUED MESSAGES, and a shared
// required-field list would let either drop the field that makes it
// meaningful. What they share is the discipline - provenance, the
// sizes the docs table is built from, and caveats that say what the
// number is NOT.
const QUEUE_REQUIRED = [
  ["cases", "the measurements themselves"],
  ["method", "how the run was configured"],
  ["doesNotMeasure", "what a reader must not take this for"],
  ["environment.commit", "which code produced it"],
  ["environment.node", "runtime"],
  ["environment.postgres", "the database it wrote to"],
  ["environment.poolMax", "the pool the concurrency is derived from"],
];

for (const name of channelFiles.filter((n) => n === "queue-depth.json")) {
  const raw = JSON.parse(readFileSync(join(CHANNEL_BENCH, name), "utf8"));
  for (const [path, why] of QUEUE_REQUIRED) {
    if (pick(raw, path) === undefined || pick(raw, path) === null) {
      fail(`${name}: missing \`${path}\`: ${why}`);
    }
  }
  // The depths the docs table is built from. A run that skipped the
  // deep one is the run that would have found the problem.
  const depths = new Set((raw.cases ?? []).map((row) => row.queued));
  for (const depth of [1, 100, 1000, 10000]) {
    if (!depths.has(depth)) {
      fail(`${name}: no measurement at ${depth} queued deliveries`);
    }
  }
  for (const row of raw.cases ?? []) {
    for (const field of [
      "planMs",
      "claimBatchMs",
      "tickMs",
      "workerHeapMb",
      "poolWaitingAfter",
    ]) {
      if (typeof row[field] !== "number") {
        fail(`${name}: ${row.queued} queued has no ${field}`);
      }
    }
  }
  // The caveat that stops a queue-depth number being read as a
  // delivery-rate promise. The transport is a stub; saying so is the
  // difference between a measurement and a claim about somebody else's
  // rate limiter.
  const notMeasured = String(raw.doesNotMeasure ?? "").toLowerCase();
  if (!notMeasured.includes("provider throughput")) {
    fail(`${name}: doesNotMeasure must rule out reading this as throughput`);
  }
  if (!notMeasured.includes("stub")) {
    fail(`${name}: doesNotMeasure must say the transport was a stub`);
  }
}

for (const name of channelFiles.filter((n) => n !== "queue-depth.json")) {
  const raw = JSON.parse(readFileSync(join(CHANNEL_BENCH, name), "utf8"));
  for (const [path, why] of CHANNEL_REQUIRED) {
    if (pick(raw, path) === undefined || pick(raw, path) === null) {
      fail(`${name}: missing \`${path}\`: ${why}`);
    }
  }

  // The sizes the docs table is built from. A run that skipped the big
  // one is the run that would have found the problem.
  const measured = new Set((raw.sizes ?? []).map((row) => row.channels));
  for (const size of [0, 1, 10, 100, 1000]) {
    if (!measured.has(size)) {
      fail(`${name}: no measurement at ${size} channels`);
    }
  }
  for (const row of raw.sizes ?? []) {
    for (const field of ["listPageMs", "resolveRoutesMs", "dispatchMs"]) {
      if (typeof row[field] !== "number") {
        fail(`${name}: ${row.channels} channels has no ${field}`);
      }
    }
  }

  // The two caveats that stop this being read as a delivery-rate claim.
  // "Unlimited" is about the application's own limits; the providers
  // still have theirs, and the artefact has to say so.
  const caveats = (raw.caveats ?? []).join(" ").toLowerCase();
  if (!caveats.includes("no provider is contacted")) {
    fail(`${name}: caveats do not say that no provider was contacted`);
  }
  if (!caveats.includes("provider's own limits")) {
    fail(`${name}: caveats do not rule out reading this as throughput`);
  }
}

/* ── the probe artefacts ───────────────────────────────────────────── */

/* ── the published table ───────────────────────────────────────────── */

const page = readFileSync(PAGE, "utf8");

/** `| 1000 | 1443.63/s | 2000/s | 504 ms | 752 ms | 1527 ms | 2157 |` */
const ROW =
  /^\|\s*(\d+)\s*\|\s*([\d.]+)\/s\s*\|\s*(\d+)\/s\s*\|\s*(\d+) ms\s*\|\s*(\d+) ms\s*\|\s*(\d+) ms\s*\|\s*([\d,]+)\s*\|$/gm;

const quoted = new Set();
for (const match of page.matchAll(ROW)) {
  const [, nRaw, achieved, expected, p50, p95, p99, missed] = match;
  const n = Number(nRaw);
  quoted.add(n);

  const run = runs.get(n);
  if (!run) {
    fail(`the page quotes N=${n}, and no artefact for it exists`);
    continue;
  }

  const check = (label, published, measured) => {
    if (published !== measured) {
      fail(
        `N=${n} ${label}: the page says ${published}, ${run.name} says ${measured}`,
      );
    }
  };

  // The rate is quoted to two decimals; compare at that precision
  // rather than pretending a table can carry sixteen.
  check(
    "achieved",
    Number(achieved).toFixed(2),
    run.raw.achieved.checksPerSecond.toFixed(2),
  );
  check(
    "expected",
    Number(expected),
    run.raw.configured.expectedChecksPerSecond,
  );
  check("p50", Number(p50), run.raw.cadenceMs.p50);
  check("p95", Number(p95), run.raw.cadenceMs.p95);
  check("p99", Number(p99), run.raw.cadenceMs.p99);
  check("missed slots", Number(missed.replace(/,/g, "")), run.raw.missedSlots);
}

for (const n of runs.keys()) {
  if (!quoted.has(n)) {
    fail(`an artefact for N=${n} exists and the page does not quote it`);
  }
}

/* ── the boundary ──────────────────────────────────────────────────── */

// Stated as a requirement rather than a prohibition, because this is
// the one page where those exact phrases SHOULD appear, in the
// sentences that deny them. Forbidding the words here would flag the
// disclaimer and pass a page that simply never raised the subject,
// which is the wrong way round: silence about the boundary is the
// failure, not mention of it. `public-facts.mjs` polices the marketing
// surfaces, where the words really are forbidden.
const MUST_SAY = [
  [
    /interval is not a 500\s*ms detection time/i,
    "that a configured interval is not a detection time",
  ],
  [
    /1,?000 monitors at 500\s*ms.*does not hold/is,
    "that 1,000 monitors at 500 ms was measured and does not hold",
  ],
];
for (const [pattern, what] of MUST_SAY) {
  if (!pattern.test(page)) {
    fail(`the page no longer says ${what}`);
  }
}

if (problems.length > 0) {
  console.error("benchmark evidence does not hold up:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

const summary = [...runs.keys()]
  .sort((a, b) => a - b)
  .map((n) => `N=${n}`)
  .join(", ");
console.log(
  `bench: ${runs.size} artefacts (${summary}) complete, and the published table quotes them exactly`,
);
