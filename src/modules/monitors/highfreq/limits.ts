/**
 * Every bound the high-frequency plane runs under, in one file.
 *
 * They are constants rather than settings because each one is a claim
 * about what was measured on real hardware (`docs/HIGH-FREQUENCY.md`),
 * and a knob invites an operator to move a number nobody re-measured.
 * When one of these has to change, the benchmark is re-run and the
 * document is rewritten with it.
 */

/**
 * How often the scheduler wakes to look for due slots.
 *
 * The alternative — a timer per monitor — means two thousand timer
 * registrations a second at a thousand monitors, and libuv's timer heap
 * becomes the thing being benchmarked. One wake-up scanning a flat array
 * costs a linear pass over at most `HF_MAX_MONITORS_PER_WORKER` entries,
 * which at 25ms granularity is forty thousand comparisons a second: less
 * than one probe's worth of CPU.
 *
 * 25ms is also the resolution the achieved cadence can possibly have. A
 * 500ms slot is therefore delivered on a 25ms grid, which is a 5%
 * quantisation and shows up in the measured p50 rather than being hidden.
 */
export const HF_TICK_MS = 25;

/**
 * How long a shard lease is good for, and how often it is renewed.
 *
 * The gap between them is the whole safety argument: a replica renews
 * three times inside one lease period, so losing a renewal to a slow
 * query or a stop-the-world pause does not hand its monitors to a second
 * replica while it is still probing them. A replica that cannot renew
 * for a full lease period has been unable to reach Postgres for six
 * seconds, at which point it cannot write samples either and stopping is
 * the correct behaviour.
 */
export const HF_LEASE_TTL_MS = 6_000;
export const HF_LEASE_RENEW_MS = 2_000;

/**
 * How many shards the monitor space is divided into.
 *
 * Sixteen, which bounds the lease traffic at sixteen upserts every two
 * seconds regardless of monitor count, and gives a four-replica
 * deployment four shards each. Higher would balance a large replica
 * count better and cost proportionally more lease traffic; this number
 * is a compromise for the deployments that exist, not a limit on them.
 *
 * Changing it re-maps every monitor to a different shard. That is safe —
 * a monitor moving between replicas loses at most one slot — but it must
 * happen while replicas agree, so it is a constant in the build rather
 * than configuration two replicas could disagree about mid-deploy.
 */
export const HF_SHARD_COUNT = 16;

/**
 * How often the plane reloads its monitor set from the database.
 *
 * This is the delay between an operator enabling high frequency and the
 * plane starting to probe. Two seconds is short enough that the toggle
 * feels immediate and long enough that the query — one indexed read per
 * replica — is not itself a load.
 */
export const HF_RELOAD_MS = 2_000;

/**
 * The global probe rate one worker will issue, in probes per second.
 *
 * Reached by arithmetic and then measured: 2000/s is a thousand monitors
 * at 500ms, which is the largest configuration the benchmark covers. The
 * bucket exists so that a misconfiguration — five thousand monitors
 * enabled at once — sheds slots at a stated rate instead of discovering
 * the limit as an out-of-file-descriptors crash.
 */
export const HF_MAX_PROBES_PER_SECOND = 2_500;

/**
 * The largest burst the rate limiter will release at once.
 *
 * One tick's worth plus a little. Without a cap, an idle second fills
 * the bucket with 2500 tokens and the next tick issues all of them
 * simultaneously — which is exactly the thundering herd the per-target
 * limit below exists to prevent, arriving through the front door.
 */
export const HF_PROBE_BURST = 128;

/**
 * How many monitors one worker will accept on the plane.
 *
 * Not a capacity claim — the benchmark says what the achieved cadence is
 * at 1000 — but a refusal to silently degrade past the point that was
 * measured. Beyond this the plane declines to schedule the excess and
 * says so in its log, which is a diagnosable failure; scheduling them
 * anyway and delivering 4-second cadence on a 500ms setting is not.
 */
export const HF_MAX_MONITORS_PER_WORKER = 1_000;

/**
 * Fairness, at admission time: how many monitors one organization may
 * put on the plane.
 *
 * The in-flight limits below share out the probe budget once a tick is
 * already oversubscribed, which is the wrong place to discover that one
 * tenant enabled four hundred monitors. This is the same fairness stated
 * where an operator can act on it — as a refusal with a reason, at the
 * moment they ask.
 *
 * Fifty at 500ms is a hundred probes a second from one tenant: a
 * twenty-fifth of the worker's budget, and more high-frequency monitors
 * than any deployment has yet been shown to need.
 */
export const HF_MAX_MONITORS_PER_ORG = 50;

/**
 * Fairness: probes in flight at once for any one organization.
 *
 * The failure this prevents is one tenant with three hundred
 * high-frequency monitors owning the entire probe budget for the tick,
 * so that everybody else's monitors miss slots and it is the *victims*
 * whose achieved cadence looks bad. Eight is enough for a tenant to run
 * sixteen monitors at 500ms with 250ms probes, and low enough that
 * thirty tenants fit inside the global rate.
 */
export const HF_MAX_INFLIGHT_PER_ORG = 8;

/**
 * Fairness: probes in flight at once against any one target.
 *
 * A "target" is host and port, so ten monitors pointed at ten paths on
 * one host share this budget. Two, because a third concurrent connection
 * to the same host measures the target's connection backlog rather than
 * its health, and because a monitoring product that opens unbounded
 * parallel connections to one endpoint is a stress tool.
 */
export const HF_MAX_INFLIGHT_PER_TARGET = 2;

/**
 * The micro-batch: rows per statement, and the longest a row waits.
 *
 * At 2000 samples a second, one INSERT per sample is 2000 transactions a
 * second — each with its own WAL record, its own commit fsync and its
 * own round trip — for six columns of data. Batching at 500 rows turns
 * that into four statements a second. The 250ms flush deadline is what
 * stops a nearly idle plane holding a handful of samples indefinitely:
 * an operator watching the achieved cadence should not have to wait for
 * a batch to fill.
 */
export const HF_BATCH_ROWS = 500;
export const HF_FLUSH_MS = 250;

/**
 * Backpressure: buffered rows above which the scheduler sheds slots.
 *
 * Ten seconds of maximum-rate samples. When Postgres stops keeping up,
 * the choice is to shed probes or to grow a buffer until the worker is
 * killed by the OOM killer, taking the monitors that *were* keeping up
 * with it. Shedding is visible (a counter, a log line, a gap in the
 * samples) and recoverable; the buffer is neither.
 */
export const HF_WRITER_HIGH_WATER_ROWS = 25_000;

/**
 * How long raw samples are kept.
 *
 * Two hours, because the only reader of raw samples is "what is this
 * monitor doing right now" and the rollups answer everything older. At
 * 2000 samples a second, a day of raw would be 172 million rows per day
 * for a fact that compresses to 1440 minute buckets per monitor.
 *
 * A prune that runs every minute deleting two hours of history is also
 * what keeps the table's dead tuples inside what autovacuum handles
 * without a full pass.
 */
export const HF_RAW_RETENTION_MINUTES = 120;

/** How long each rollup granularity is kept. */
export const HF_MINUTE_ROLLUP_RETENTION_DAYS = 7;
export const HF_HOUR_ROLLUP_RETENTION_DAYS = 90;
export const HF_DAY_ROLLUP_RETENTION_DAYS = 730;

/**
 * How long a monitor keeps promoting samples at the fast cadence while
 * its state has not settled.
 *
 * See `plane.ts`. This is the resolution of the failure-window deadline
 * for a high-frequency monitor, and one second is a deliberate
 * compromise: finer means more write amplification during the exact
 * minutes an outage is also generating notifications, and coarser makes
 * a 2-second failure window arrive late.
 */
export const HF_UNSETTLED_PROMOTION_MS = 1_000;
