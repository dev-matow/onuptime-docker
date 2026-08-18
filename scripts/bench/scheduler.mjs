#!/usr/bin/env node
/**
 * How many ordinary monitors one installation can actually keep on
 * cadence, and what breaks first when it cannot.
 *
 *   node scripts/bench/scheduler.mjs --monitors 1000 --workers 2 --seconds 180
 *
 * This measures the plane every deployment runs: the pg-boss tick,
 * `findDueMonitors`, one job per check, N worker replicas draining it.
 * The high-frequency benchmark next door measures a different plane with
 * a different correctness argument, and the two numbers are not
 * comparable — that one reports achieved sub-second cadence, this one
 * reports whether a fleet stays on the cadence its operator configured.
 *
 * WHAT IS MEASURED, and why each one is here rather than derived:
 *
 *   throughput      observations actually written, per second. The only
 *                   number that cannot be faked by a scheduler that
 *                   enqueues eagerly and drops work later.
 *   schedulerLag    `now() - next_evaluation_at` over monitors that are
 *                   DUE, sampled every second. This is the backlog's
 *                   age, and it is the number that goes to infinity when
 *                   a fleet outgrows its scheduler. Reported as
 *                   percentiles over the samples, not as a mean: the
 *                   mean of a growing backlog is a number halfway
 *                   through the failure.
 *   coverage        monitors that got at least one observation. A
 *                   scheduler can hold throughput steady while starving
 *                   a subset, and throughput alone will not show it.
 *   missed          expected observations minus achieved, where expected
 *                   is derived from the configured interval and the
 *                   window. Negative is impossible and is reported as
 *                   zero rather than hidden.
 *   duplicates      two observations of one monitor closer together than
 *                   half its interval. That is the signature of two
 *                   workers probing the same monitor, and it is the one
 *                   thing horizontal scaling is most likely to break.
 *   queueDepth      pg-boss jobs created-but-not-finished, sampled. The
 *                   backpressure signal.
 *   tick            the tick job's own duration and how many of them
 *                   ran. A tick that takes longer than its period is the
 *                   failure this whole exercise is about.
 *   database        transactions, WAL, table growth, and lock waits.
 *
 * The script spawns the workers itself. That is the difference between a
 * benchmark and an anecdote: "then start two workers somehow" is the
 * step that makes a result unreproducible, and worker count is the
 * independent variable here.
 *
 * Nothing in this file asserts a threshold. It writes what it measured;
 * `scripts/bench-check.mjs` compares the published table against the
 * artefact, and a claim with no artefact behind it fails there.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  cpus,
  freemem,
  hostname,
  release,
  totalmem,
  type as osType,
} from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(ROOT, "bench-results");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const MONITORS = Number(arg("monitors", "100"));
const WORKERS = Number(arg("workers", "1"));
const SECONDS = Number(arg("seconds", "120"));
/**
 * Discarded from the front of the run.
 *
 * A fresh fleet is seeded all-due-at-once, so the first minute measures
 * the catch-up burst rather than the steady state. Both are interesting;
 * only one of them is "can this installation hold cadence", and the
 * burst is reported separately as `catchUp` rather than averaged into
 * the answer.
 */
const WARMUP_SECONDS = Number(arg("warmup", "70"));
const INTERVAL_SECONDS = Number(arg("interval", "60"));
const LABEL = arg("label", null);
const DATABASE_URL =
  arg("db", null) ?? process.env.DATABASE_URL ?? process.env.BENCH_DATABASE_URL;

if (!DATABASE_URL) {
  console.error("set DATABASE_URL or pass --db");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[index];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
  };
}

async function environment(client) {
  const { rows: version } = await client.query("show server_version");
  const { rows: settings } = await client.query(
    `select name, setting from pg_settings
     where name in ('max_connections','shared_buffers','wal_level','synchronous_commit','fsync','work_mem')`,
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

async function dbCounters(client) {
  const { rows } = await client.query(`
    select
      (select sum(xact_commit + xact_rollback) from pg_stat_database) as transactions,
      (select pg_current_wal_lsn()) as wal_lsn,
      (select count(*) from monitor_checks) as check_rows,
      (select pg_total_relation_size('monitor_checks')) as check_bytes,
      (select sum(deadlocks) from pg_stat_database) as deadlocks
  `);
  return rows[0];
}

/**
 * One poll of everything that changes second to second.
 *
 * Deliberately one statement. Six round trips a second against the
 * database under test would be the observer competing with the thing
 * observed, and at the depths this runs to that is not a rounding error.
 */
async function poll(client, hasQueue) {
  const { rows } = await client.query(`
    select
      (select coalesce(max(extract(epoch from (now() - next_evaluation_at))), 0)
         from monitors
        where paused = false and next_evaluation_at is not null
          and next_evaluation_at <= now()) as lag_seconds,
      (select count(*) from monitors
        where paused = false and next_evaluation_at is not null
          and next_evaluation_at <= now()) as due_now,
      ${
        hasQueue
          ? `(select count(*) from pgboss.job
        where name = 'monitor-check' and state in ('created','active','retry'))`
          : "0"
      } as queue_depth,
      (select count(*) from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock') as lock_waiters,
      (select count(*) from pg_stat_activity where datname = current_database()) as connections
  `);
  return rows[0];
}

/**
 * The queue tables do not exist until a worker has booted and pg-boss
 * has migrated its own schema.
 *
 * Polled rather than slept on: how long `boss.start()` takes is a
 * property of the machine, and a fixed sleep is either wasted time or a
 * flaky benchmark. Bounded, because a worker that never boots must fail
 * the run rather than hang it.
 */
async function waitForQueue(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await client.query(
      `select to_regclass('pgboss.job') is not null as present`,
    );
    if (rows[0].present) return true;
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
}

/** pg-boss keeps finished jobs in the same partitioned table; the tick's
 * own duration is the only direct evidence of how long selection takes. */
async function tickStats(client, since, hasQueue) {
  if (!hasQueue) return { ticks: 0, avg_ms: 0, max_ms: 0 };
  const { rows } = await client.query(
    `select count(*)::int as ticks,
            coalesce(avg(extract(epoch from (completed_on - started_on)) * 1000), 0) as avg_ms,
            coalesce(max(extract(epoch from (completed_on - started_on)) * 1000), 0) as max_ms
       from pgboss.job
      where name = 'monitor-tick' and completed_on >= $1`,
    [since],
  );
  return rows[0];
}

/**
 * How many worker processes are on this machine right now.
 *
 * Counted BEFORE anything is spawned, and never after. A count taken
 * afterwards cannot be compared to anything useful: one worker is
 * several processes once its runtime has forked, so "more processes
 * than workers I started" is true of every healthy run and would refuse
 * them all. What is worth refusing is a machine that already had
 * workers on it when this run began.
 */
const strayWorkers = () => {
  try {
    const listed = execFileSync("pgrep", ["-af", "src/worker/index.ts"], {
      encoding: "utf8",
    });
    // Only processes whose executable IS node. `pgrep -f` matches any
    // command line containing the path, which includes the shell command
    // that ran this benchmark and every `grep` looking for it - so a
    // plain count refuses to measure because it can see itself, which is
    // the most annoying possible false positive.
    return listed
      .split("\n")
      .filter(Boolean)
      .filter((line) => /^\d+\s+\S*\bnode\b/.test(line)).length;
  } catch {
    // pgrep exits non-zero when nothing matches, which is the good case.
    return 0;
  }
};

/**
 * Spawns the workers, and can actually stop them again.
 *
 * `npx tsx src/worker/index.ts` was the obvious spelling and it is
 * wrong here, in a way that silently corrupted three multi-worker cells
 * before it was caught: `npx` is a wrapper process, so SIGTERM to the
 * child kills the WRAPPER and leaves the worker underneath running. Each
 * cell of the sweep then started its workers on top of the previous
 * cell's survivors - fifteen worker processes measured during what the
 * artefact would have called a three-worker run - and the numbers were
 * of a machine thrashing, not of a fleet.
 *
 * Two changes fix it and both are needed. The binary is invoked
 * directly, so there is one process per worker; and the group is killed
 * rather than the process, so anything it spawned goes with it.
 */
function spawnWorkers(count) {
  const children = [];
  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  for (let index = 0; index < count; index += 1) {
    const child = spawn(tsx, ["src/worker/index.ts"], {
      // Its own process group, so one signal reaches everything it
      // started rather than only the thing this script can see.
      detached: true,
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL,
        // A distinct ledger identity per replica, which is what the
        // product does per host in production. Without it every replica
        // shares one actor chain and contends on its sequence, which
        // would make this benchmark measure a configuration nobody runs.
        VIGIL_ACTOR_NAME: `bench-worker-${index}`,
        LOG_LEVEL: process.env.BENCH_WORKER_LOG_LEVEL ?? "warn",
        ALLOW_PRIVATE_MONITOR_TARGETS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      if (/error|fatal/i.test(text))
        process.stderr.write(`[w${index}] ${text}`);
    });
    children.push(child);
  }
  return children;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const env = await environment(client);
  const { rows: fleet } = await client.query(
    `select count(*)::int as n from monitors where paused = false`,
  );

  // The corruption this catches does not look like a failure: a cell
  // simply reports a lower rate, and a reader has no way to know another
  // cell's processes were competing for the same CPUs. Three cells were
  // measured that way before the group-kill above existed.
  const inherited = strayWorkers();
  if (inherited > 0) {
    console.error(
      `refusing to measure: ${inherited} worker process(es) are already running. A previous run leaked them, and these numbers would be of a contended machine. Stop them first.`,
    );
    process.exit(3);
  }

  const children = spawnWorkers(WORKERS);
  let stopped = false;
  const stopWorkers = () => {
    if (stopped) return;
    stopped = true;
    for (const child of children) {
      try {
        // The GROUP, not the process. A negative pid is the whole group,
        // which is the difference between stopping a worker and orphaning
        // one into the next cell of the sweep.
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone. The run is over either way.
      }
    }
  };

  process.on("exit", stopWorkers);
  process.on("SIGINT", () => {
    stopWorkers();
    process.exit(130);
  });

  const hasQueue = await waitForQueue(client, 60_000);
  if (!hasQueue) {
    console.error("pgboss schema never appeared; is the worker starting?");
  }

  const startedAt = new Date();
  console.error(
    `bench: ${MONITORS} configured, ${fleet[0].n} active in db, ${WORKERS} worker(s), warmup ${WARMUP_SECONDS}s, window ${SECONDS}s`,
  );

  // ── catch-up phase ──────────────────────────────────────────────────
  // Measured, not skipped. A fleet that is entirely due at once is
  // exactly the state a scheduler is in after a restart or a rolling
  // deploy, and how long it takes to clear is the "failover cannot
  // create an alert storm" question in numeric form.
  const catchUpLag = [];
  const catchUpDue = [];
  for (let second = 0; second < WARMUP_SECONDS; second += 1) {
    const row = await poll(client, hasQueue);
    catchUpLag.push(Number(row.lag_seconds));
    catchUpDue.push(Number(row.due_now));
    await sleep(1_000);
  }

  // ── measurement window ──────────────────────────────────────────────
  const windowStart = new Date();
  const before = await dbCounters(client);
  const lag = [];
  const due = [];
  const depth = [];
  const lockWaiters = [];
  const connections = [];

  for (let second = 0; second < SECONDS; second += 1) {
    const row = await poll(client, hasQueue);
    lag.push(Number(row.lag_seconds));
    due.push(Number(row.due_now));
    depth.push(Number(row.queue_depth));
    lockWaiters.push(Number(row.lock_waiters));
    connections.push(Number(row.connections));
    await sleep(1_000);
  }

  const windowEnd = new Date();
  const after = await dbCounters(client);
  const ticks = await tickStats(client, windowStart, hasQueue);

  // ── what actually landed in the window ──────────────────────────────
  const { rows: achieved } = await client.query(
    `select count(*)::int as checks,
            count(distinct monitor_id)::int as distinct_monitors
       from monitor_checks
      where checked_at >= $1 and checked_at < $2`,
    [windowStart, windowEnd],
  );

  const { rows: fleetSize } = await client.query(
    `select count(*)::int as n,
            coalesce(min(interval_seconds), 0)::int as min_interval,
            coalesce(max(interval_seconds), 0)::int as max_interval
       from monitors where paused = false`,
  );

  // `--interval` decides expectedChecks, missedChecks and the duplicate
  // threshold, and nothing used to check it against the fleet it was
  // measuring. Seed at 30s, run with the default 60, and expected becomes
  // half the real demand - so a scheduler delivering half the configured
  // cadence reports zero missed checks and looks perfect.
  if (
    fleetSize[0].n > 0 &&
    (fleetSize[0].min_interval !== INTERVAL_SECONDS ||
      fleetSize[0].max_interval !== INTERVAL_SECONDS)
  ) {
    console.error(
      `refusing to publish: --interval is ${INTERVAL_SECONDS}s and the fleet is seeded at ${fleetSize[0].min_interval}..${fleetSize[0].max_interval}s. Every derived figure would be wrong by that ratio.`,
    );
    stopWorkers();
    await client.end();
    process.exit(4);
  }

  /**
   * Two observations of one monitor closer together than the POLICY
   * could possibly have asked for.
   *
   * The threshold was half an interval in the first version of this
   * script, and that was wrong in a way worth recording: it reported 23
   * to 59 "duplicates" per run against builds that had none. The
   * scheduler is adaptive. `nextEvaluationAt` tightens a monitor with any
   * failed observation in its recent history to interval divided by
   * SUSPICION_DIVISOR, a sixteenth, so a 60-second monitor that failed
   * once is legitimately probed every 3.75 seconds, and half an interval
   * counted every one of those as duplicate work.
   *
   * A benchmark that reports the product working as a defect is worse
   * than no benchmark: it invites a fix for something that is not broken.
   * The threshold is now the tightest gap the policy can produce, below
   * which two observations cannot be its doing.
   *
   * SUSPICION_DIVISOR is 16 in `modules/monitors/scheduling.ts`. It is
   * repeated rather than imported because this script is plain ESM with
   * no build step and runs against checkouts it does not typecheck, and
   * if the two disagree this reports MORE duplicates than exist rather
   * than fewer, which is the safe direction for a number nobody wants to
   * flatter.
   */
  const SUSPICION_DIVISOR = 16;
  const { rows: duplicates } = await client.query(
    `with ordered as (
       select c.monitor_id,
              c.checked_at,
              lag(c.checked_at) over (partition by c.monitor_id order by c.checked_at) as previous,
              m.interval_seconds
         from monitor_checks c
         join monitors m on m.id = c.monitor_id
        where c.checked_at >= $1 and c.checked_at < $2
     )
     select count(*)::int as n
       from ordered
      where previous is not null
        and extract(epoch from (checked_at - previous))
              < (interval_seconds::float / ${SUSPICION_DIVISOR})`,
    [windowStart, windowEnd],
  );

  /**
   * How many observations failed.
   *
   * The context that makes the duplicate count readable. A run against
   * local targets should be almost all successes; a run with a high error
   * rate is measuring a struggling target rather than a scheduler, and a
   * reader has to be able to tell which one they are holding.
   */
  const { rows: outcomes } = await client.query(
    `select count(*) filter (where not ok)::int as failures,
            count(*)::int as total
       from monitor_checks
      where checked_at >= $1 and checked_at < $2`,
    [windowStart, windowEnd],
  );

  /**
   * Jobs that threw during the run.
   *
   * The reason this exists: a run whose every scheduler tick was failing
   * reported 0.00 checks/s, 0 duplicates and a growing lag, wrote the
   * artefact, and moved on to the next cell. Every number in it was
   * arithmetically correct and the whole file was worthless - the fleet
   * was not slow, the tick could not run at all, because the database
   * was one migration behind the tree being measured.
   *
   * Nothing downstream could have caught it either. Zero throughput is
   * indistinguishable from a very slow fleet if you only read the
   * throughput, and "0 duplicates" reads as a pass. So the run reports
   * what the queue recorded, and `jobFailures` above zero means the
   * artefact describes a broken harness rather than a measured system.
   */
  const { rows: jobFailures } = await client.query(
    `select name, count(*)::int as failures
       from pgboss.job
      where state = 'failed' and created_on >= $1
      group by name
      order by failures desc`,
    [windowStart],
  );

  const seconds = (windowEnd - windowStart) / 1000;
  const activeMonitors = fleetSize[0].n;
  const expected = Math.floor((activeMonitors * seconds) / INTERVAL_SECONDS);

  const walBytes = (
    await client.query(`select pg_wal_lsn_diff($1,$2)::bigint as bytes`, [
      after.wal_lsn,
      before.wal_lsn,
    ])
  ).rows[0].bytes;

  const result = {
    _: "Raw benchmark output. Generated by scripts/bench/scheduler.mjs.",
    startedAt: startedAt.toISOString(),
    window: {
      start: windowStart.toISOString(),
      end: windowEnd.toISOString(),
      seconds,
      warmupSeconds: WARMUP_SECONDS,
    },
    configured: {
      monitors: MONITORS,
      activeMonitorsInDatabase: activeMonitors,
      workers: WORKERS,
      intervalSeconds: INTERVAL_SECONDS,
      /**
       * How many due monitors one tick may enqueue.
       *
       * Recorded because it is the independent variable of the cap
       * experiment, and without it that experiment's artefacts are two
       * files distinguishable only by their names - which is to say, by
       * whatever the person running it typed. Read from the environment
       * the workers inherit, so it is the value they actually used
       * rather than the value the caller meant to pass.
       *
       * `null` when unset, and NOT the current default. The Before sweep
       * runs a build where this setting does not exist and the batch is
       * a hardcoded 500, so filling in today's default would have the
       * artefact state, in a provenance field, the exact number the
       * experiment exists to disprove.
       */
      schedulerBatch:
        process.env.MONITOR_SCHEDULER_BATCH === undefined
          ? null
          : Number(process.env.MONITOR_SCHEDULER_BATCH),
      expectedChecksPerSecond: activeMonitors / INTERVAL_SECONDS,
    },
    measuredFrom: {
      table: "monitor_checks",
      column: "checked_at",
      note: "The ordinary plane writes one observation per check. Cadence, coverage and duplicates are all read from this table; the scheduler's own backlog is read from monitors.next_evaluation_at.",
    },
    achieved: {
      checks: achieved[0].checks,
      checksPerSecond: achieved[0].checks / seconds,
      distinctMonitors: achieved[0].distinct_monitors,
      coverage:
        activeMonitors === 0
          ? 0
          : achieved[0].distinct_monitors / activeMonitors,
      expectedChecks: expected,
      missedChecks: Math.max(0, expected - achieved[0].checks),
      failures: outcomes[0].failures,
      errorRate:
        outcomes[0].total === 0 ? 0 : outcomes[0].failures / outcomes[0].total,
      duplicateObservations: duplicates[0].n,
      duplicateThresholdSeconds: INTERVAL_SECONDS / 16,
    },
    /**
     * Whether the run measured a system or a broken harness. Any entry
     * here means jobs were throwing during the window, and every rate
     * below is the rate of a thing that was not working.
     */
    jobFailures: Object.fromEntries(
      jobFailures.map((row) => [row.name, row.failures]),
    ),
    schedulerLagSeconds: stats(lag),
    dueBacklog: stats(due),
    queueDepth: stats(depth),
    catchUp: {
      note: "The seeded fleet is entirely due at t=0. This is the burst a scheduler faces after a restart or a rolling deploy.",
      seconds: WARMUP_SECONDS,
      lagSeconds: stats(catchUpLag),
      dueBacklog: stats(catchUpDue),
      /** The first second at which nothing was overdue, or null if the
       * burst never cleared inside the warmup. */
      clearedAfterSeconds:
        catchUpDue.findIndex((n) => n === 0) === -1
          ? null
          : catchUpDue.findIndex((n) => n === 0),
    },
    tick: {
      ticks: ticks.ticks,
      avgMs: Number(ticks.avg_ms),
      maxMs: Number(ticks.max_ms),
      periodSeconds: 60,
    },
    database: {
      transactions: Number(after.transactions) - Number(before.transactions),
      transactionsPerSecond:
        (Number(after.transactions) - Number(before.transactions)) / seconds,
      walBytes: Number(walBytes),
      checkRowsWritten: Number(after.check_rows) - Number(before.check_rows),
      checkTableGrowthBytes:
        Number(after.check_bytes) - Number(before.check_bytes),
      deadlocks: Number(after.deadlocks) - Number(before.deadlocks),
      lockWaiters: stats(lockWaiters),
      connections: stats(connections),
    },
    /**
     * What the numbers above do NOT say.
     *
     * Required by `scripts/bench-check.mjs`, and not as ceremony: every
     * one of these is a misreading somebody would otherwise make from
     * the table, and a benchmark that publishes a rate without them is
     * publishing a number that will be quoted wrongly.
     */
    caveats: [
      "This measures CADENCE - whether checks happen as often as configured - not detection time. A monitor is judged down only after its failure window elapses, and alert delivery is a third thing again with its own retries.",
      "Throughput is bounded by DEMAND, not by capacity. 1000 monitors on a 60-second interval require 16.67 checks per second, so a result at 16.6 means the fleet is being kept up with; it is not the largest rate the workers could reach.",
      "Duplicate observations count pairs closer together than the TIGHTEST gap the adaptive scheduler can ask for, which is interval/16. A wider threshold counts the scheduler tightening on a monitor that failed once as duplicate work: the first version of this script used half an interval and reported dozens of duplicates against builds that had none.",
      "Targets are local HTTP servers on a spread of ports. This measures the scheduler and the database, not anybody's network, and a real fleet's checks take longer.",
      "Workers, Postgres and the targets share one machine. Worker scaling measured here is therefore a LOWER bound on a deployment where they do not compete for the same CPUs.",
      "The catch-up figure is the burst after every monitor is made due at once. That is the state a restart leaves, and it is deliberately the worst case rather than the ordinary one.",
      "database.transactions and database.deadlocks come from pg_stat_database summed across the WHOLE CLUSTER, not this database alone. On a cluster hosting anything else, both are upper bounds rather than measurements of this run.",
      "schedulerLag is now() minus next_evaluation_at with no grace period, over monitors that are late but not necessarily selectable. It is deliberately immune to the scheduler claim: the claim leases a monitor in its own column, so a backlog does not vanish the moment a tick looks at it.",
    ],
    environment: env,
  };

  const stamp = windowStart.toISOString().replace(/[:.]/g, "-");
  const name = LABEL
    ? `${LABEL}-${stamp}.json`
    : `sched-n${MONITORS}-w${WORKERS}-${stamp}.json`;
  const path = join(OUT_DIR, name);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  console.log(path);
  console.log(
    JSON.stringify(
      {
        checksPerSecond: result.achieved.checksPerSecond,
        expectedPerSecond: result.configured.expectedChecksPerSecond,
        coverage: result.achieved.coverage,
        missed: result.achieved.missedChecks,
        duplicates: result.achieved.duplicateObservations,
        lagP95: result.schedulerLagSeconds.p95,
        lagMax: result.schedulerLagSeconds.max,
        queueP95: result.queueDepth.p95,
        tickAvgMs: result.tick.avgMs,
        catchUpClearedAfter: result.catchUp.clearedAfterSeconds,
        jobFailures: result.jobFailures,
      },
      null,
      1,
    ),
  );

  stopWorkers();
  await client.end();
  // The workers get a moment to release their leases and flush.
  await sleep(1_500);

  // A run whose jobs were throwing is not a slow result, it is a broken
  // one, and it exits non-zero so the sweep around it stops instead of
  // spending twenty more minutes producing more of the same. The
  // artefact is still written - a failed run is worth reading, it just
  // is not worth quoting.
  const failedJobs = Object.entries(result.jobFailures);
  if (failedJobs.length > 0) {
    console.error(
      `bench: NOT A RESULT - jobs failed during the window: ${failedJobs
        .map(([name, n]) => `${name} x${n}`)
        .join(", ")}`,
    );
    console.error(
      "Every rate above is the rate of a system that was not working.",
    );
    process.exit(3);
  }
  process.exit(0);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
