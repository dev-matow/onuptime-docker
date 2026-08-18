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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = join(ROOT, "docs", "evidence", "bench");
const PAGE = join(ROOT, "docs", "HIGH-FREQUENCY.md");

const problems = [];
const fail = (message) => problems.push(message);

/* ── the artefacts ─────────────────────────────────────────────────── */

// Three shapes now live in this directory, and this filter is the only
// thing keeping them apart. Without it the scheduler artefacts land in
// the high-frequency loop below, which reads `cadenceMs.p50` on an
// object that has no `cadenceMs` - so adding the evidence this file
// demands made it die with a TypeError instead of reporting anything.
//
// An allow-list, not a deny-list, and that is the fix for the second
// time this happened: the deny-list said `!sched-` and the cap
// artefacts arrived called `cap-`, so every one of them was read as a
// high-frequency run and reported six missing fields it was never
// supposed to have. A shape this loop does not recognise now belongs to
// nobody rather than to it.
const HF_ARTEFACT = /^n\d+-\d+ms-/;
const files = readdirSync(BENCH).filter(
  (name) => name.endsWith(".json") && HF_ARTEFACT.test(name),
);
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

const warnings = [];
const warn = (message) => warnings.push(message);

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
  // A published artefact whose jobs were throwing is the worst kind of
  // evidence: arithmetically correct and about nothing.
  //
  // The high-frequency artefacts below predate this release and do NOT
  // hold up to it: all four record `treeDirty: true` at 133cea6, and
  // n1-500ms records an error rate of 100%. They back
  // docs/HIGH-FREQUENCY.md, they were not re-measured in this goal, and
  // saying so out loud is the alternative to either a red build nobody
  // can fix here or an exemption list that quietly grows. Re-measuring
  // them is an owner action, not a silent one.
  if (raw.environment?.treeDirty || (raw.achieved?.errorRate ?? 0) > 0.02) {
    warn(
      `${name}: ${raw.environment?.treeDirty ? "measured on a dirty tree" : ""}${
        raw.environment?.treeDirty && (raw.achieved?.errorRate ?? 0) > 0.02
          ? " and "
          : ""
      }${
        (raw.achieved?.errorRate ?? 0) > 0.02
          ? `${(raw.achieved.errorRate * 100).toFixed(0)}% of its checks failed`
          : ""
      }; this artefact predates the scheduler work and needs re-measuring`,
    );
  }
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

/* ── the scheduler artefacts and docs/SCALING.md ───────────────────── */
// A fourth shape. It measures the ORDINARY plane - the pg-boss tick, one
// job per check, N workers draining it - which is a different question
// from the high-frequency plane above and must not share its required
// fields: the two report different things and a shared list would let
// either drop the field that makes it meaningful.
//
// The rows are checked in both directions. A cell the page quotes with no
// artefact behind it fails, and an artefact the page never quotes is
// reported too: a sweep that measured four worker counts and published
// two is a sweep whose two missing rows are the interesting ones.
const SCALING_PAGE = join(ROOT, "docs", "SCALING.md");

const SCHED_REQUIRED = [
  ["tick.avgMs", "a tick longer than its period is the failure this measures"],
  ["schedulerLagSeconds.max", "the worst moment, not just the typical one"],
  ["achieved.failures", "a run against struggling targets is a different run"],
  ["jobFailures", "whether the run measured a system or a broken harness"],
  ["window.seconds", "the observation window is what every rate divides by"],
  ["configured.activeMonitorsInDatabase", "the fleet that was actually active"],
  ["configured.workers", "the independent variable"],
  [
    "configured.schedulerBatch",
    "the cap experiment's independent variable; null means the build's own default",
  ],
  ["configured.expectedChecksPerSecond", "what the cadence demanded"],
  ["achieved.checksPerSecond", "what actually happened"],
  ["achieved.coverage", "throughput can hold steady while a subset starves"],
  ["achieved.missedChecks", "the observations that never happened"],
  [
    "achieved.duplicateObservations",
    "the one thing horizontal scaling is most likely to break",
  ],
  ["schedulerLagSeconds.p95", "the backlog's age is the failure signal"],
  ["queueDepth.p95", "backpressure"],
  ["catchUp.clearedAfterSeconds", "how a restart recovers, or does not"],
  ["database.transactionsPerSecond", "the cost side of the result"],
  ["environment.commit", "which code produced it"],
  ["environment.treeDirty", "whether that SHA describes what ran"],
  ["environment.postgres", "the database it wrote to"],
  ["environment.cpuModel", "the machine"],
  ["caveats", "what the number does NOT say"],
];

const schedFiles = readdirSync(BENCH).filter(
  (name) => name.startsWith("sched-") && name.endsWith(".json"),
);
if (schedFiles.length === 0) {
  fail(`no scheduler benchmark artefacts in ${BENCH} (expected sched-*.json)`);
}

const schedRuns = new Map();
for (const name of schedFiles) {
  const raw = JSON.parse(readFileSync(join(BENCH, name), "utf8"));
  for (const [path, why] of SCHED_REQUIRED) {
    if (pick(raw, path) === undefined) {
      fail(`${name}: missing \`${path}\`: ${why}`);
    }
  }
  // `clearedAfterSeconds` is legitimately null - a burst that never
  // cleared is a result, and the most interesting one - so it is checked
  // for presence rather than for a value, unlike everything else.
  if (pick(raw, "catchUp.clearedAfterSeconds") === undefined) {
    fail(`${name}: catchUp.clearedAfterSeconds is absent, not null`);
  }
  // Same shape, same reason: null is the honest answer for a build with
  // no such setting, and absent is a harness that forgot to look.
  if (!("schedulerBatch" in (raw.configured ?? {}))) {
    fail(`${name}: configured.schedulerBatch is absent, not null`);
  }
  // The three refusals, and they belong HERE - in the loop over the
  // artefacts that actually carry these fields. An earlier version put
  // them in the high-frequency loop above, where `jobFailures` does not
  // exist, so `?? {}` made the check that exists to catch a broken
  // benchmark silently pass every scheduler artefact it was written for.
  // A guard in the wrong loop is worse than no guard: it reads as
  // coverage.
  const failedJobs = Object.entries(raw.jobFailures ?? {});
  if (failedJobs.length > 0) {
    fail(
      `${name}: jobs failed during the window (${failedJobs
        .map(([job, n]) => `${job} x${n}`)
        .join(", ")}), so its numbers describe a broken run`,
    );
  }
  if (raw.environment?.treeDirty) {
    fail(
      `${name}: measured on a dirty tree, so ${String(raw.environment.commit).slice(0, 7)} does not describe what ran`,
    );
  }
  // A run whose checks were failing measured a struggling target, not a
  // scheduler.
  if ((raw.achieved?.errorRate ?? 0) > 0.02) {
    fail(
      `${name}: ${(raw.achieved.errorRate * 100).toFixed(1)}% of its checks failed, so it measured the targets rather than the scheduler`,
    );
  }
  const caveats = (raw.caveats ?? []).join(" ").toLowerCase();
  if (!caveats.includes("cadence") || !caveats.includes("detection")) {
    fail(`${name}: caveats do not separate cadence from detection time`);
  }
  if (!caveats.includes("demand")) {
    fail(
      `${name}: caveats do not say the rate is bounded by demand, so a reader would take it for a ceiling`,
    );
  }
  // Which sweep a row belongs to is in the file name, because the same
  // fleet and worker count are measured before and after the change and
  // the page quotes both.
  const phase = name.startsWith("sched-after") ? "after" : "before";
  const key = `${phase}:${raw.configured.workers}`;
  if (schedRuns.has(key)) {
    fail(`two ${phase} artefacts for ${raw.configured.workers} worker(s)`);
  }
  schedRuns.set(key, { name, raw });
}

// Core does not ship `docs/SCALING.md`: the page documents a commercial
// fleet view and sends the reader to a Settings tab that edition does not
// have, so `edition-gate.sh` removes it. The ARTEFACTS still ship, and
// are still validated above - the scheduler numbers are true of both
// editions - but there is no table to compare them against, and a check
// that failed for the absence of a page this edition deliberately lacks
// would be a red build nobody could fix.
if (!existsSync(SCALING_PAGE)) {
  console.log(
    `bench: ${runs.size} high-frequency artefacts and ${schedRuns.size} scheduler artefacts complete; no docs/SCALING.md in this edition, so no table to check`,
  );
  if (problems.length > 0) {
    console.error("benchmark evidence does not hold up:");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  process.exit(0);
}

const scalingPage = readFileSync(SCALING_PAGE, "utf8");

/** `|       1 |   9.94/s |  16.67/s |     100% |    812 |          0 | 161.3s | 165.2s |      1007 | 84 ms |    never |` */
const SCHED_ROW =
  /^\|\s*(\d+)\s*\|\s*([\d.]+)\/s\s*\|\s*([\d.]+)\/s\s*\|\s*([\d.]+)%\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([\d.]+)s\s*\|\s*([\d.]+)s\s*\|\s*(\d+)\s*\|\s*(\d+) ms\s*\|\s*(never|\d+s)\s*\|$/gm;

// The page has two tables with identical shapes, so a row cannot say
// which sweep it belongs to on its own. The headings do: everything
// after "### Before" and before "### After" is the before sweep.
const beforeStart = scalingPage.indexOf("### Before");
const afterStart = scalingPage.indexOf("### After");
if (beforeStart === -1 || afterStart === -1 || afterStart < beforeStart) {
  fail(
    "docs/SCALING.md no longer has a Before section followed by an After one",
  );
}
const sections = [
  ["before", scalingPage.slice(beforeStart, afterStart)],
  ["after", scalingPage.slice(afterStart)],
];

const schedQuoted = new Set();
for (const [phase, text] of sections) {
  for (const match of text.matchAll(SCHED_ROW)) {
    const [
      ,
      workers,
      achieved,
      required,
      coverage,
      missed,
      duplicates,
      lagP95,
      lagMax,
      queueP95,
      tickMs,
      catchUp,
    ] = match;
    const key = `${phase}:${Number(workers)}`;
    schedQuoted.add(key);
    const run = schedRuns.get(key);
    if (!run) {
      fail(
        `SCALING.md quotes ${phase} with ${workers} worker(s), and no artefact for it exists`,
      );
      continue;
    }
    const raw = run.raw;
    const check = (label, published, measured) => {
      if (String(published) !== String(measured)) {
        fail(
          `${phase} w=${workers} ${label}: the page says ${published}, ${run.name} says ${measured}`,
        );
      }
    };
    check("achieved", achieved, raw.achieved.checksPerSecond.toFixed(2));
    check(
      "required",
      required,
      raw.configured.expectedChecksPerSecond.toFixed(2),
    );
    check("coverage", coverage, (raw.achieved.coverage * 100).toFixed(2));
    check("missed", missed, raw.achieved.missedChecks);
    check("duplicates", duplicates, raw.achieved.duplicateObservations);
    check("lag p95", lagP95, raw.schedulerLagSeconds.p95.toFixed(1));
    check("lag max", lagMax, raw.schedulerLagSeconds.max.toFixed(1));
    check("queue p95", queueP95, raw.queueDepth.p95);
    check("tick", tickMs, raw.tick.avgMs.toFixed(0));
    check(
      "catch-up",
      catchUp,
      raw.catchUp.clearedAfterSeconds === null
        ? "never"
        : `${raw.catchUp.clearedAfterSeconds}s`,
    );
  }
}

for (const key of schedRuns.keys()) {
  if (!schedQuoted.has(key)) {
    const [phase, workers] = key.split(":");
    fail(
      `${schedRuns.get(key).name} measured ${phase} with ${workers} worker(s) and the page does not quote it`,
    );
  }
}

// The two sentences the whole page rests on. Both are claims a reader
// would otherwise take from the table and get wrong.
const SCALING_MUST_SAY = [
  [
    /bounded by demand/i,
    "that the achieved rate is bounded by demand rather than being a ceiling",
  ],
  [/ledger actor chain/i, "where the per-worker ceiling actually is"],
  [
    /no lease table/i,
    "that the control plane was already DB-arbitrated and no lease was added",
  ],
  [
    /Postgres is a single point of failure/i,
    "its own remaining single point of failure",
  ],
];
for (const [pattern, what] of SCALING_MUST_SAY) {
  if (!pattern.test(scalingPage)) {
    fail(`docs/SCALING.md no longer says ${what}`);
  }
}

/* ── the cap experiment ────────────────────────────────────────────── */
// A separate table with a separate shape, and until now no gate at all:
// `schedFiles` filters on `sched-`, so the cap artefacts sat in
// docs/evidence/bench validated by nothing and the published cap table
// was quoting them on trust. That table carries the release's central
// capacity claim - that the old 500-per-tick bound costs throughput at a
// fleet size people actually run - so it is the last one that should
// have been ungated.
const capFiles = readdirSync(BENCH).filter(
  (name) => name.startsWith("cap-") && name.endsWith(".json"),
);
const capRuns = new Map();
for (const name of capFiles) {
  const raw = JSON.parse(readFileSync(join(BENCH, name), "utf8"));
  const batch = raw.configured?.schedulerBatch;
  if (typeof batch !== "number") {
    fail(
      `${name}: configured.schedulerBatch is ${batch}, so this artefact cannot say which batch produced it`,
    );
    continue;
  }
  const failed = Object.entries(raw.jobFailures ?? {});
  if (failed.length > 0) {
    fail(
      `${name}: jobs failed during the window, so its numbers are not a result`,
    );
  }
  if (raw.environment?.treeDirty) {
    fail(`${name}: measured on a dirty tree`);
  }
  // Keyed by interval AND batch. The same batch against two intervals is
  // two different experiments - one where the cap sits on the only
  // scheduling path and one where it does not - and keying on batch alone
  // made the second of each pair look like a duplicate of the first.
  const key = `${raw.configured.intervalSeconds}:${batch}`;
  if (capRuns.has(key)) {
    fail(
      `two cap artefacts for interval ${raw.configured.intervalSeconds}s batch ${batch}`,
    );
  }
  capRuns.set(key, { name, raw });
}

/** `|   500 |     120s |     3000 |       4 |  10.50/s |  25.00/s |   42.33% |   1753 |   73.9s |` */
const CAP_ROW =
  /^\|\s*(\d+)\s*\|\s*(\d+)s\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([\d.]+)\/s\s*\|\s*([\d.]+)\/s\s*\|\s*([\d.]+)%\s*\|\s*(\d+)\s*\|\s*([\d.]+)s\s*\|$/gm;

const capQuoted = new Set();
for (const match of scalingPage.matchAll(CAP_ROW)) {
  const [
    ,
    batch,
    interval,
    fleet,
    workers,
    achieved,
    required,
    coverage,
    missed,
    lag,
  ] = match;
  const key = `${interval}:${batch}`;
  capQuoted.add(key);
  const run = capRuns.get(key);
  if (!run) {
    fail(
      `SCALING.md quotes a cap row for interval ${interval}s batch ${batch}, and no artefact for it exists`,
    );
    continue;
  }
  const raw = run.raw;
  const check = (label, published, measured) => {
    if (String(published) !== String(measured)) {
      fail(
        `cap batch=${batch} ${label}: the page says ${published}, ${run.name} says ${measured}`,
      );
    }
  };
  check("interval", interval, raw.configured.intervalSeconds);
  check("monitors", fleet, raw.configured.activeMonitorsInDatabase);
  check("workers", workers, raw.configured.workers);
  check("achieved", achieved, raw.achieved.checksPerSecond.toFixed(2));
  check(
    "required",
    required,
    raw.configured.expectedChecksPerSecond.toFixed(2),
  );
  check("coverage", coverage, (raw.achieved.coverage * 100).toFixed(2));
  check("missed", missed, raw.achieved.missedChecks);
  check("lag p95", lag, raw.schedulerLagSeconds.p95.toFixed(1));
}
for (const [key, run] of capRuns) {
  if (!capQuoted.has(key)) {
    fail(
      `${run.name} measured ${key.replace(":", "s batch ")} and the page does not quote it; a cap experiment that publishes one of its two cells is not a comparison`,
    );
  }
}

/* ── the numbers quoted in prose ───────────────────────────────────── */
// The tables above are gated. The sentences were not, and that is where
// the numbers actually reach a reader: CHANGELOG.md and the public
// changelog page both narrate the baseline measurement, and both had
// drifted from it - one said the backlog aged to 161 seconds where the
// artefact says 160.2, the other said 812 observations never happened
// where it measured 811. Neither is a big lie and that is the point:
// nothing could have caught them, so nothing did.
//
// Each claim must be FOUND as well as matched. A regex that quietly
// stops matching because the prose was reworded is a gate that reports
// success for a page it never read.
const PROSE_CLAIMS = [
  [
    /needs? ([\d.]+) checks a second/i,
    "before:1",
    (raw) => raw.configured.expectedChecksPerSecond.toFixed(2),
    "the cadence the fleet demands",
  ],
  [
    /one worker delivered ([\d.]+)/i,
    "before:1",
    (raw) => raw.achieved.checksPerSecond.toFixed(2),
    "what one worker actually delivered",
  ],
  [
    /backlog aged to (\d+) seconds/i,
    "before:1",
    (raw) => String(Math.round(raw.schedulerLagSeconds.p95)),
    "how far the backlog fell behind",
  ],
  [
    /(\d+) expected observations never happened/i,
    "before:1",
    (raw) => String(raw.achieved.missedChecks),
    "the checks that never ran",
  ],
];

// The free edition's changelog is here because it was the one carrying
// retracted numbers with nothing reading it. `scripts/core-overlay/` is
// what the edition gate swaps in for Core, so its CHANGELOG.md is a
// published page this check had never opened - and it repeated the
// 9.94-checks-a-second and 812-missed-observations claims that the
// artefacts contradict, in the edition more people run.
const PROSE_PAGES = [
  "CHANGELOG.md",
  join("landing", "changelog.html"),
  join("scripts", "core-overlay", "CHANGELOG.md"),
].filter((name) => existsSync(join(ROOT, name)));

for (const [pattern, key, expected, what] of PROSE_CLAIMS) {
  const run = schedRuns.get(key);
  if (!run) {
    fail(`no ${key} artefact, so "${what}" cannot be checked against one`);
    continue;
  }
  const want = expected(run.raw);
  let found = 0;
  for (const name of PROSE_PAGES) {
    const text = readFileSync(join(ROOT, name), "utf8");
    const beforeThisPage = found;
    // Newline-tolerant: both files wrap prose, so a claim routinely has a
    // line break inside it and a naive pattern would miss every one.
    for (const match of text
      .replace(/\s+/g, " ")
      .matchAll(new RegExp(pattern.source, "gi"))) {
      found += 1;
      if (match[1] !== want) {
        fail(
          `${name} says ${what} is ${match[1]}; ${run.name} measured ${want}`,
        );
      }
    }
    // Every page that narrates the baseline has to state every claim, or
    // one of them can quietly drop a number while the others keep the
    // global counter above zero. `landing/changelog.html` is exempt from
    // the missed-observations claim only because it is a summary page;
    // that exemption is named rather than emergent.
    if (
      found === beforeThisPage &&
      !(name.endsWith(".html") && /never happened/.test(pattern.source))
    ) {
      fail(`${name} does not state ${what}, so nothing holds it to the run`);
    }
  }
  if (found === 0 && PROSE_PAGES.length > 0) {
    fail(
      `no page states ${what}, so the pattern that checks it is matching nothing`,
    );
  }
}

if (problems.length > 0) {
  console.error("benchmark evidence does not hold up:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn("benchmark evidence that needs re-measuring:");
  for (const message of warnings) console.warn(`  ${message}`);
}

const summary = [...runs.keys()]
  .sort((a, b) => a - b)
  .map((n) => `N=${n}`)
  .join(", ");
console.log(
  `bench: ${runs.size} high-frequency artefacts (${summary}) and ${schedRuns.size} scheduler artefacts complete, and the published tables quote them exactly`,
);
