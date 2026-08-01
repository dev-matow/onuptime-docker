#!/usr/bin/env node
/**
 * The high-frequency check benchmark.
 *
 * Section 21 of the release reference says a prose result without the
 * script and the raw data is not evidence, so this is the script and it
 * emits the raw data. It measures what the scheduler ACHIEVES, which is
 * the only number worth publishing — a configured interval is a request,
 * not a promise, and the gap between them is the entire question.
 *
 *   node scripts/bench/high-frequency.mjs --monitors 100 --seconds 120
 *
 * Every run writes a machine-readable JSON file under `bench-results/`
 * carrying the environment it ran in and the commit it ran at, because a
 * throughput number without a machine and a SHA beside it cannot be
 * reproduced or contradicted.
 *
 * It reads `monitor_hf_samples`, which is the high-frequency plane's own
 * table. Reading `monitor_checks` would measure the pg-boss plane — a
 * different scheduler, with a different floor, and the one this feature
 * exists because of.
 *
 * ── what it does NOT measure ─────────────────────────────────────────
 *
 * Detection time and notification time. Those are different quantities
 * and conflating them with cadence is the specific dishonesty this file
 * exists to prevent: a monitor checked every 500 ms does not detect a
 * failure within 500 ms. Detection additionally costs the probe's own
 * duration, the failure window before a verdict, and then the incident
 * and notification path. The report names cadence and nothing else.
 */

import { execFileSync } from "node:child_process";
import {
  cpus,
  freemem,
  hostname,
  totalmem,
  type as osType,
  release,
} from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(ROOT, "bench-results");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const MONITORS = Number(arg("monitors", "10"));
const SECONDS = Number(arg("seconds", "60"));
const WARMUP_SECONDS = Number(arg("warmup", "15"));
const INTERVAL_MS = Number(arg("interval", "500"));
/**
 * The worker process to measure CPU and RSS for. Optional: without it
 * the report says the worker's resource use was not measured, which is
 * better than reporting the observer's.
 */
const WORKER_PID = arg("worker-pid", null);
const DATABASE_URL =
  process.env.BENCH_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres@localhost:5433/vigil";

/**
 * Percentiles from a sorted array, nearest-rank.
 *
 * p99 of a two-minute run at 100 monitors is ~24,000 samples, so exact
 * percentiles over the full set are affordable and there is no reason to
 * approximate. An approximation here would be a second thing to defend.
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

async function environment(client) {
  const { rows: version } = await client.query("show server_version");
  const { rows: settings } = await client.query(
    `select name, setting from pg_settings
     where name in ('max_connections','shared_buffers','wal_level','synchronous_commit','fsync')`,
  );
  let commit = "unknown";
  let dirty = false;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT })
      .toString()
      .trim();
    dirty =
      execFileSync("git", ["status", "--porcelain"], { cwd: ROOT })
        .toString()
        .trim().length > 0;
  } catch {
    // Not a git checkout. Recorded as unknown rather than omitted: a
    // result whose provenance is missing should look wrong, not tidy.
  }
  return {
    commit,
    // A dirty tree means the SHA does not describe what actually ran.
    // Stated rather than silently implied by the number.
    treeDirty: dirty,
    node: process.version,
    os: `${osType()} ${release()}`,
    hostname: hostname(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemBytes: totalmem(),
    freeMemBytesAtStart: freemem(),
    postgres: version[0]?.server_version ?? "unknown",
    postgresSettings: Object.fromEntries(
      settings.map((r) => [r.name, r.setting]),
    ),
  };
}

/**
 * Which table the achieved cadence is read from.
 *
 * The high-frequency plane deliberately does not write a
 * `monitor_checks` row per probe — that would multiply the largest table
 * in the product by 120 per monitor and put a ledger sequence bump on
 * the hot path. It writes to `monitor_hf_samples` and promotes a sample
 * into `monitor_checks` only when it says something new. So the cadence
 * this script measures has to come from the samples, and the promotion
 * count is reported separately: they answer different questions and
 * adding them together would answer neither.
 *
 * Auto-detected rather than switched, because a run against a build
 * without the plane must still work and must still say which table it
 * read.
 */
async function samplesTable(client) {
  const { rows } = await client.query(
    `select to_regclass('public.monitor_hf_samples') is not null as present`,
  );
  return rows[0].present ? "monitor_hf_samples" : "monitor_checks";
}

async function dbCounters(client, table) {
  const { rows } = await client.query(
    `select
       (select sum(xact_commit + xact_rollback) from pg_stat_database) as transactions,
       (select pg_current_wal_lsn()) as wal_lsn,
       (select count(*) from monitor_checks) as check_rows,
       (select pg_total_relation_size('monitor_checks')) as check_bytes,
       (select count(*) from ${table}) as sample_rows,
       (select pg_total_relation_size('${table}')) as sample_bytes`,
  );
  return rows[0];
}

/**
 * Whatever the operating system will tell us about the worker's own
 * resource use.
 *
 * The benchmark process is not the process under test — it observes the
 * database while a separate worker probes — so `process.cpuUsage()` here
 * measures the observer and is nearly zero. The number that matters is
 * the worker's, and on Linux `/proc/<pid>/stat` has it without any
 * cooperation from the worker itself. Absent on other platforms, and
 * recorded as absent rather than as zero.
 */
function processUsage(pid) {
  if (pid === null) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field can contain spaces and parentheses, so everything
    // is indexed from the closing paren rather than from the start.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(process.env.CLOCK_TICKS ?? 100);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const rss = /VmRSS:\s+(\d+) kB/.exec(status);
    return {
      // utime and stime are fields 14 and 15 of `stat`, which are 12 and
      // 13 places past the closing paren.
      userCpuMs: (Number(fields[11]) / ticks) * 1000,
      systemCpuMs: (Number(fields[12]) / ticks) * 1000,
      rssBytes: rss ? Number(rss[1]) * 1024 : null,
    };
  } catch {
    return null;
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const env = await environment(client);
  const TABLE = await samplesTable(client);
  const TIME_COLUMN =
    TABLE === "monitor_hf_samples" ? "observed_at" : "checked_at";
  console.log(
    `bench: ${MONITORS} monitors @ ${INTERVAL_MS}ms, ${SECONDS}s after ${WARMUP_SECONDS}s warm-up`,
  );
  console.log(`bench: reading achieved cadence from ${TABLE}`);
  console.log(
    `bench: ${env.cpuCount}x ${env.cpuModel}, postgres ${env.postgres}`,
  );
  if (env.treeDirty) {
    console.warn(
      "bench: WORKING TREE IS DIRTY — this result is not reproducible",
    );
  }

  // The observation window opens only after warm-up. A cold JIT, an
  // unfilled connection pool and an empty page cache are real, but they
  // are a property of starting up rather than of the steady state the
  // number claims to describe.
  const startedAt = Date.now();
  await new Promise((r) => setTimeout(r, WARMUP_SECONDS * 1000));

  // Counters are read at the START OF THE WINDOW, not before the
  // warm-up. Reading them earlier folds the warm-up's transactions, WAL
  // and rows into a per-second figure divided by the window length,
  // which overstates every one of them by the ratio of the two.
  const startCounters = await dbCounters(client, TABLE);
  const windowStart = new Date();
  const cpuStart = process.cpuUsage();
  const workerStart = processUsage(WORKER_PID);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  const windowEnd = new Date();
  const cpuUsed = process.cpuUsage(cpuStart);
  const workerEnd = processUsage(WORKER_PID);
  const endCounters = await dbCounters(client, TABLE);

  // Achieved cadence is read from the observations themselves — the gap
  // between consecutive checks of the same monitor — not from what the
  // scheduler intended. Intent is what is already in doubt.
  const { rows: gaps } = await client.query(
    `with ordered as (
       select monitor_id, ${TIME_COLUMN} as at,
              lag(${TIME_COLUMN}) over (partition by monitor_id order by ${TIME_COLUMN}) as prev
       from ${TABLE}
       where ${TIME_COLUMN} >= $1 and ${TIME_COLUMN} < $2
     )
     select extract(epoch from (at - prev)) * 1000 as gap_ms
     from ordered where prev is not null`,
    [windowStart, windowEnd],
  );

  const { rows: totals } = await client.query(
    `select count(*)::int as checks,
            count(distinct monitor_id)::int as monitors,
            count(*) filter (where ok = false)::int as failures
     from ${TABLE} where ${TIME_COLUMN} >= $1 and ${TIME_COLUMN} < $2`,
    [windowStart, windowEnd],
  );

  // Observations of record written during the window. Reported beside
  // the sample count rather than instead of it: the ratio between them
  // is the entire claim that this plane does not multiply the size of
  // `monitor_checks` by the sample rate, and a reader who cannot see
  // both numbers has to take that claim on trust.
  const { rows: promoted } = await client.query(
    `select count(*)::int as promotions
     from monitor_checks
     where checked_at >= $1 and checked_at < $2`,
    [windowStart, windowEnd],
  );

  const gapValues = gaps
    .map((r) => Number(r.gap_ms))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  // Lag is measured against the CONFIGURED interval, so a positive
  // number is the scheduler running late and a negative one is it
  // running early. Reporting |gap| would hide which.
  const lags = gapValues.map((g) => g - INTERVAL_MS).sort((a, b) => a - b);
  const observed = totals[0];
  const windowSeconds = (windowEnd - windowStart) / 1000;

  const result = {
    _: "Raw benchmark output. Generated by scripts/bench/high-frequency.mjs.",
    startedAt: new Date(startedAt).toISOString(),
    window: {
      start: windowStart.toISOString(),
      end: windowEnd.toISOString(),
      seconds: windowSeconds,
      warmupSeconds: WARMUP_SECONDS,
    },
    configured: {
      monitors: MONITORS,
      intervalMs: INTERVAL_MS,
      // What the arithmetic in the release reference says this run
      // *should* produce, so the achieved figure has something to be
      // compared against inside the same file.
      expectedChecksPerSecond: (MONITORS * 1000) / INTERVAL_MS,
    },
    measuredFrom: {
      table: TABLE,
      column: TIME_COLUMN,
      note:
        TABLE === "monitor_hf_samples"
          ? "The high-frequency plane writes a sample per probe here and promotes one into monitor_checks only when the verdict changes or the monitor's own interval elapses. Cadence is the samples; promotions are counted separately below."
          : "No high-frequency plane in this build; cadence read from the observation table the pg-boss plane writes.",
    },
    achieved: {
      checks: observed.checks,
      distinctMonitors: observed.monitors,
      checksPerSecond: observed.checks / windowSeconds,
      failures: observed.failures,
      errorRate:
        observed.checks === 0 ? null : observed.failures / observed.checks,
      /** Rows added to `monitor_checks`, the observation table of record. */
      promotedObservations: promoted[0].promotions,
    },
    cadenceMs: {
      samples: gapValues.length,
      p50: percentile(gapValues, 50),
      p95: percentile(gapValues, 95),
      p99: percentile(gapValues, 99),
      min: gapValues[0] ?? null,
      max: gapValues[gapValues.length - 1] ?? null,
    },
    schedulerLagMs: {
      p50: percentile(lags, 50),
      p95: percentile(lags, 95),
      p99: percentile(lags, 99),
      max: lags[lags.length - 1] ?? null,
    },
    // A slot is missed when a gap is at least twice the configured
    // interval: one whole scheduled check did not happen.
    missedSlots: gapValues.filter((g) => g >= INTERVAL_MS * 2).length,
    database: {
      transactions:
        Number(endCounters.transactions) - Number(startCounters.transactions),
      transactionsPerSecond:
        (Number(endCounters.transactions) -
          Number(startCounters.transactions)) /
        windowSeconds,
      walBytes: null,
      checkRowsWritten:
        Number(endCounters.check_rows) - Number(startCounters.check_rows),
      checkTableGrowthBytes:
        Number(endCounters.check_bytes) - Number(startCounters.check_bytes),
      sampleRowsWritten:
        Number(endCounters.sample_rows) - Number(startCounters.sample_rows),
      sampleTableGrowthBytes:
        Number(endCounters.sample_bytes) - Number(startCounters.sample_bytes),
    },
    /** The observer, not the thing observed. Kept so it is not mistaken for it. */
    benchProcess: {
      userCpuMs: cpuUsed.user / 1000,
      systemCpuMs: cpuUsed.system / 1000,
      rssBytes: process.memoryUsage().rss,
    },
    worker:
      workerStart && workerEnd
        ? {
            pid: Number(WORKER_PID),
            userCpuMs: workerEnd.userCpuMs - workerStart.userCpuMs,
            systemCpuMs: workerEnd.systemCpuMs - workerStart.systemCpuMs,
            cpuCoresUsed:
              (workerEnd.userCpuMs -
                workerStart.userCpuMs +
                workerEnd.systemCpuMs -
                workerStart.systemCpuMs) /
              (windowSeconds * 1000),
            rssBytesAtEnd: workerEnd.rssBytes,
          }
        : null,
    environment: env,
    caveats: [
      "This measures CADENCE, not detection time and not notification time.",
      "A configured interval is a request; the achieved figures above are what happened.",
      "The benchmark process observes the database; the worker under test is a separate process.",
    ],
  };

  try {
    const { rows } = await client.query(
      `select pg_wal_lsn_diff($1, $2)::bigint as bytes`,
      [endCounters.wal_lsn, startCounters.wal_lsn],
    );
    result.database.walBytes = Number(rows[0].bytes);
  } catch (error) {
    // Needs a role with the right privileges; absence is recorded rather
    // than silently reported as zero, which would read as "no WAL".
    result.database.walBytes = null;
    result.database.walError = String(error.message ?? error);
  }

  const stamp = windowStart.toISOString().replace(/[:.]/g, "-");
  const file = join(OUT_DIR, `n${MONITORS}-${INTERVAL_MS}ms-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);

  console.log(
    `bench: ${result.achieved.checks} checks in ${windowSeconds.toFixed(1)}s ` +
      `= ${result.achieved.checksPerSecond.toFixed(2)}/s ` +
      `(expected ${result.configured.expectedChecksPerSecond})`,
  );
  console.log(
    `bench: cadence p50 ${result.cadenceMs.p50}ms p95 ${result.cadenceMs.p95}ms ` +
      `p99 ${result.cadenceMs.p99}ms, ${result.missedSlots} missed slots`,
  );
  console.log(`bench: wrote ${file}`);

  await client.end();
}

main().catch((error) => {
  console.error("bench failed:", error);
  process.exit(1);
});
