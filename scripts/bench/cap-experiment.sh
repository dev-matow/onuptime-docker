#!/usr/bin/env bash
#
# Does MONITOR_SCHEDULER_BATCH actually bind, and where?
#
# The before-and-after sweep at 1000 monitors answers "can this
# installation keep up" and does NOT answer this: two workers there
# delivered 995 checks a minute through a 500-per-tick cap, so at that
# fleet size the cap was nowhere near the binding constraint and the
# shortfall at one worker was worker throughput.
#
# So this isolates the cap by holding everything else still: same build,
# same fleet, same worker count, one variable. The fleet is sized so that
# demand exceeds 500 per tick by a wide margin while staying inside what
# the workers can deliver - otherwise the run measures throughput again
# and says nothing about the bound.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${DATABASE_URL:?set DATABASE_URL}"
export BENCH_DESTRUCTIVE=yes
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-bench-secret-bench-secret-bench-42}"
export APP_URL="${APP_URL:-http://localhost:3000}"
WORKERS="${WORKERS:-4}"
# The fleet has to make MORE THAN `batch` monitors due in one tick, or the
# cap cannot bind and the experiment measures nothing. Due per tick is
# MONITORS * 60 / INTERVAL, so 2000 monitors on a 60-second interval puts
# 2000 in front of a 500 cap - except that a 60-second monitor schedules
# its own next check and never asks the tick at all. The fleet that
# isolates the cap therefore has an interval ABOVE the tick period, where
# the tick is the only path, and enough monitors that a tick's worth of
# them exceeds the smaller batch.
MONITORS="${CAP_MONITORS:-2000}"
INTERVAL="${CAP_INTERVAL:-60}"
psql_url() { psql "$DATABASE_URL" -qtA -c "$1"; }

for batch in 500 5000; do
  echo "── cap: batch=${batch}, ${WORKERS} worker(s) ─────────────"
  psql_url "update monitors set next_evaluation_at = now(),
                                dispatch_claimed_until = null,
                                first_failure_at = null,
                                consecutive_failures = 0,
                                current_status = 'unknown'" >/dev/null
  psql_url "truncate monitor_checks" >/dev/null
  psql_url "delete from incidents" >/dev/null
  if psql_url "select to_regclass('pgboss.job') is not null" | grep -q t; then
    psql_url "truncate table pgboss.job" >/dev/null
  fi
  MONITOR_SCHEDULER_BATCH="$batch" node "$ROOT/scripts/bench/scheduler.mjs" \
    --monitors "$MONITORS" --workers "$WORKERS" --warmup 70 --seconds 120 \
    --interval "$INTERVAL" --label "cap-i${INTERVAL}-batch${batch}"
  sleep 5
done
