# High-frequency checks

Vigil can run HTTP, JSON-query and TCP checks on a 500 ms interval,
through a data plane separate from the one that runs everything else.

This page states what was measured, on what, and where it stops working.
The numbers below come from `scripts/bench/high-frequency.mjs`; the raw
JSON for every run is in `docs/evidence/bench/`.

## The one thing to be clear about first

**A 500 ms interval is not a 500 ms detection time.** They are different
quantities and this page never conflates them.

Detecting a failure costs, in order: the wait until the next scheduled
slot, the probe's own duration, the monitor's failure window before a
verdict is reached, then the incident and notification path. A monitor
checked every 500 ms notices sooner than one checked every 60 s. It does
not notice within 500 ms, and nothing here claims it does.

The benchmark measures cadence — how close the achieved interval is to
the configured one — and refuses to report anything else. Its output
carries that refusal in its own `caveats` field.

## What was measured

Every run: 500 ms configured interval, HTTP checks against a local
target, one worker process, a warm-up excluded from the window, and a
60-second observation window (45 s for N=1).

| Monitors |  Achieved | Expected |    p50 |    p95 |     p99 | Missed slots |
| -------: | --------: | -------: | -----: | -----: | ------: | -----------: |
|        1 |    1.98/s |      2/s | 503 ms | 505 ms |  508 ms |            0 |
|       10 |   19.92/s |     20/s | 503 ms | 505 ms |  506 ms |            0 |
|      100 |  199.29/s |    200/s | 503 ms | 506 ms |  508 ms |            0 |
|     1000 | 1443.63/s |   2000/s | 504 ms | 752 ms | 1527 ms |         2157 |

Resource cost in the same windows:

| Monitors | DB transactions/s | WAL written | Sample rows | Sample table growth |
| -------: | ----------------: | ----------: | ----------: | ------------------: |
|       10 |              19.1 |      654 KB |       1,200 |              112 KB |
|      100 |              98.2 |      5.8 MB |      11,965 |              1.1 MB |
|     1000 |             750.9 |     55.5 MB |      86,811 |              9.5 MB |

Error rate was 0 in every run.

### Environment

|            |                                                  |
| ---------- | ------------------------------------------------ |
| CPU        | AMD Ryzen 7 7445HS, 12 threads                   |
| OS         | Linux 7.1.4-1-cachyos                            |
| Node       | v26.4.0                                          |
| PostgreSQL | 18.4, local, `fsync=on`, `synchronous_commit=on` |
| Topology   | one worker process, one Postgres, same machine   |
| Target     | local HTTP server, sub-millisecond RTT           |

One machine running the worker, the database and the target is not a
production topology. It removes network RTT from the probe and puts the
database's CPU in contention with the scheduler's. Read the numbers as
what this scheduler can drive, not as a capacity plan.

## Where it stops

**Up to 100 monitors at 500 ms, this plane holds its cadence exactly.**
p99 of 508 ms against a 500 ms target, and not one missed slot across
11,958 checks.

**At 1000 it does not.** It sustains about 1,440 checks per second —
roughly 720 monitors at a true 500 ms — and past that the cadence
stretches rather than the plane failing: p50 stays at 504 ms while p99
reaches 1527 ms, and 2,157 slots are missed rather than queued. 844 of
the 1,000 monitors were sampled during the window; the rest were being
served on a longer effective interval.

That degradation shape is deliberate. A slot whose previous probe is
still in flight is skipped and counted, never queued behind it, because
queueing turns a slow target into a backlog that is still probing a
minute later. The missed-slot count is what makes the stretch visible
instead of silent.

One confound worth naming rather than hiding: in the N=1000 run the
monitors were spread across only 20 distinct targets, so 50 monitors
shared each host:port and the per-target in-flight cap
(`HF_MAX_INFLIGHT_PER_TARGET`) was under far more pressure than a real
deployment of 1,000 monitors would put it. The 1000-monitor figure is
therefore a floor, not a ceiling — but it is the number that was
measured, and it is the one published until a run with realistic target
spread replaces it.

## What may be claimed

Permitted, and supported by the table above:

- _HTTP checks configurable down to 500 ms._
- _A 500 ms interval holds its cadence to 100 monitors on one worker._

Not permitted:

- _500 ms detection_ — a different quantity, not measured here.
- _1,000 monitors at 500 ms_ — measured, and it does not hold.
- _2× faster than anything_ — no comparative measurement exists.

## Reproducing it

```sh
# 1. A local target on a spread of ports. One port would measure the
#    per-target fairness cap rather than the scheduler.
node scripts/bench/target.mjs           # or your own

# 2. Enrol monitors. Each run creates its own organization, because
#    HF_MAX_MONITORS_PER_ORG caps one organization at 50.
DATABASE_URL=… npx tsx scripts/bench/seed-monitors.ts 50

# 3. Start a worker against the same database.
DATABASE_URL=… npx tsx src/worker/index.ts

# 4. Measure.
BENCH_DATABASE_URL=… node scripts/bench/high-frequency.mjs \
  --monitors 100 --seconds 60 --warmup 30 --interval 500
```

Every run writes JSON under `bench-results/` carrying the machine, the
Postgres settings, the commit, and whether the working tree was dirty. A
throughput number without those beside it cannot be reproduced or
contradicted, which makes it decoration.

## What the benchmark found

Running it was not a formality. It found three defects that every test in
the suite had passed over:

1. **The worker could not start on a fresh database.** The rollup queue
   was scheduled but never created, and pg-boss enforces a foreign key
   from `schedule` to `queue`.
2. **The benchmark was reading the wrong table** — `monitor_checks`,
   which belongs to the pg-boss plane, not `monitor_hf_samples`.
3. **An enrolled monitor could be starved forever.** Monitors created
   together come due on the same boundary; the fairness caps admitted the
   first N and a stable iteration order handed the same monitors the same
   win every tick. Nine of ten reported a perfect 500 ms cadence and the
   tenth reported nothing at all — not slow, never probed. Shedding is
   backpressure now: a refused slot retries on the next tick instead of
   forfeiting its whole interval, which also makes it the most overdue
   slot in the next round.

## Operating notes

- Only inexpensive check types are eligible. The UI says which, and why
  for the ones that are not.
- Raw samples are kept for two hours, then rolled up to minute, hour and
  day. At 1,000 monitors the raw table grows about 9.5 MB a minute
  before rollup, which is the number to plan disk against.
- The interface shows configured and achieved cadence separately,
  because they are separate facts, and warns about CPU and storage
  before an operator enables it.
- Two workers divide the shards through leases rather than both probing.
  A worker that dies has its shards taken over when its lease expires; a
  monitor whose worker is gone falls back to the ordinary 2 s plane
  rather than to silence.
