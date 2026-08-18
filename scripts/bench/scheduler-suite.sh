#!/usr/bin/env bash
#
# The scheduler capacity sweep, reproducibly.
#
#   scripts/bench/scheduler-suite.sh <label> [monitor-counts] [worker-counts]
#
# Each cell is a fresh fleet: the database is reset between runs, because
# a run that inherits the previous one's backlog measures the previous
# one. `next_evaluation_at` is set to now for every monitor, so every run
# starts from the same worst case — everything due at once — and the
# catch-up burst is comparable across cells.
#
# The queue is emptied too. pg-boss keeps completed jobs around for its
# own retention window, and a queue-depth reading that included the last
# run's corpses would be the benchmark measuring its own history.
#
# Env: DATABASE_URL must point at a database with the schema applied and
# a seeded fleet (scripts/bench/seed-scheduled.ts). BETTER_AUTH_SECRET
# and APP_URL are needed only because the worker validates them at boot.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABEL="${1:-baseline}"
COUNTS="${2:-1000}"
WORKERS="${3:-1 2 3}"
SECONDS_PER_RUN="${BENCH_SECONDS:-120}"
WARMUP="${BENCH_WARMUP:-70}"
INTERVAL="${BENCH_INTERVAL:-60}"

: "${DATABASE_URL:?set DATABASE_URL}"

# ── the guard ────────────────────────────────────────────────────────────
# Everything below TRUNCATES observations, DELETES incidents and PAUSES
# monitors. `DATABASE_URL` is the same variable the application reads, so
# the published reproduction steps are one shell history away from doing
# that to a production installation - and the failure would be silent,
# because the script's output looks identical either way.
#
# Two conditions, and both must hold. The database name has to look like
# a benchmark database, and the operator has to say so explicitly. Either
# alone is too easy to satisfy by accident.
BENCH_DB="$(printf '%s' "$DATABASE_URL" | sed -E 's#.*/([^/?]+).*#\1#')"
case "$BENCH_DB" in
  *bench*|*_test|test_*) ;;
  *)
    echo "refusing to run: '$BENCH_DB' is not a benchmark database." >&2
    echo "This script truncates monitor_checks, deletes incidents and" >&2
    echo "pauses monitors. Point DATABASE_URL at a throwaway database" >&2
    echo "whose name contains 'bench'." >&2
    exit 2
    ;;
esac
if [ "${BENCH_DESTRUCTIVE:-}" != "yes" ]; then
  echo "refusing to run: set BENCH_DESTRUCTIVE=yes to confirm that" >&2
  echo "'$BENCH_DB' may be truncated." >&2
  exit 2
fi
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-bench-secret-bench-secret-bench-42}"
export APP_URL="${APP_URL:-http://localhost:3000}"

psql_url() { psql "$DATABASE_URL" -qtA -c "$1"; }

reset_fleet() {
  local want="$1"
  # Trim or grow the fleet to exactly `want` active monitors by pausing
  # the surplus rather than deleting it. Deleting and re-seeding would
  # change the ids, and the ids decide the shard a monitor lands on -
  # so two cells of the sweep would not be measuring the same fleet.
  psql_url "update monitors set paused = (row_number > $want)
            from (select id, row_number() over (order by id) as row_number
                    from monitors) ranked
           where monitors.id = ranked.id" >/dev/null
  psql_url "update monitors set next_evaluation_at = now(),
                                 first_failure_at = null,
                                 consecutive_failures = 0,
                                 current_status = 'unknown'" >/dev/null
  # The scheduler's claim column, cleared so a cell does not inherit the
  # previous one's leases. Conditional because this same script measures
  # the release BEFORE the column existed - that is the whole point of a
  # before-and-after sweep - and a hard reference would make the baseline
  # unmeasurable.
  if psql_url "select count(*) from information_schema.columns
                where table_name = 'monitors'
                  and column_name = 'dispatch_claimed_until'" | grep -q 1; then
    psql_url "update monitors set dispatch_claimed_until = null" >/dev/null
  fi
  psql_url "truncate monitor_checks" >/dev/null
  psql_url "delete from incidents" >/dev/null
  # Not silenced. The queue emptying is load-bearing for the depth
  # readings, and swallowing a lock timeout here would leave the next
  # cell measuring the previous cell's corpses while reporting nothing.
  # A missing schema on the very first run is the one legitimate failure,
  # and it is told apart by asking first.
  if psql_url "select to_regclass('pgboss.job') is not null" | grep -q t; then
    psql_url "truncate table pgboss.job" >/dev/null
  fi
  psql_url "select pg_stat_statements_reset()" >/dev/null 2>&1 || true
}

for count in $COUNTS; do
  for workers in $WORKERS; do
    echo "── ${LABEL}: ${count} monitors, ${workers} worker(s) ─────────────"
    reset_fleet "$count"
    node "$ROOT/scripts/bench/scheduler.mjs" \
      --monitors "$count" \
      --workers "$workers" \
      --warmup "$WARMUP" \
      --seconds "$SECONDS_PER_RUN" \
      --interval "$INTERVAL" \
      --label "${LABEL}-n${count}-w${workers}"
    # The workers get a moment to exit before the next cell starts, or
    # the next run measures two generations of worker at once.
    sleep 5
  done
done
