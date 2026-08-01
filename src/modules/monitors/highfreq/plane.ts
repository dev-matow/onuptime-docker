import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { monitors } from "@/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

import { performCheck, type CheckOptions, type CheckResult } from "../check";
import { applyOutcome } from "../outcome";
import type { Monitor } from "../service";
import { toCheckSpec } from "../spec";
import type { Verdict } from "../types/conditions";
import { HIGH_FREQUENCY_TYPE_IDS } from "./capabilities";
import { SchedulerClock } from "./clock";
import { claimShards, liveShards, releaseShards, type Lease } from "./leases";
import {
  HF_MAX_INFLIGHT_PER_ORG,
  HF_MAX_INFLIGHT_PER_TARGET,
  HF_MAX_MONITORS_PER_WORKER,
  HF_MAX_PROBES_PER_SECOND,
  HF_PROBE_BURST,
  HF_RELOAD_MS,
  HF_LEASE_RENEW_MS,
  HF_TICK_MS,
  HF_UNSETTLED_PROMOTION_MS,
} from "./limits";
import { ALL_SHARDS, shardOf } from "./shards";
import { SampleWriter } from "./writer";

const log = logger.child({ module: "highfreq-plane" });

/**
 * The high-frequency data plane.
 *
 * ── what it is, and what it deliberately is not ──────────────────────
 *
 * It is a second scheduler, running inside the worker process, that owns
 * a small set of cheap monitors and probes them on a monotonic timer.
 * pg-boss keeps everything else: notifications, recovery, escalation,
 * retention, and every monitor not on this plane. Nothing here replaces
 * the queue, and if this plane stops, the monitors it owned fall back to
 * the queue's two-second cadence rather than to nothing.
 *
 * It is NOT `MIN_INTERVAL_SECONDS` lowered to a fraction. That change
 * would have been three characters and would have delivered nothing: the
 * floor was never the validation constant, it was pg-boss's job poll at
 * roughly two seconds, plus one queue round trip, one job row, one
 * `monitor_checks` insert and one ledger sequence bump per probe. Every
 * one of those is gone here, and each of them had to go.
 *
 * ── the properties that make it safe ─────────────────────────────────
 *
 * - **A shard lease, not a job row.** Two replicas cannot both probe a
 *   monitor because one of them holds its shard. See `leases.ts`.
 * - **A monotonic clock.** Slots are placed with `hrtime`, never with
 *   `Date.now()` deltas. See `clock.ts`.
 * - **One probe per monitor in flight.** A slot arriving while the
 *   previous probe is still open is skipped, never queued behind it.
 * - **Skip, never catch up.** See `advance`.
 * - **Fair limits and backpressure.** Per organization, per target, a
 *   global token bucket, and a writer that refuses rows when it is
 *   behind. Every refusal is counted.
 * - **Micro-batched writes.** See `writer.ts`.
 * - **Promotion, not duplication.** A sample becomes an observation of
 *   record only when it says something new. See `promote`.
 *
 * ── the thing this plane does not do ─────────────────────────────────
 *
 * It does not make detection twice as fast because the interval is
 * twice as short. Cadence is one term of detection time; the probe's own
 * duration, the failure window, the incident path and the notification
 * path are the others, and this plane only touches the first. See
 * `docs/HIGH-FREQUENCY.md`, which states the difference and refuses to
 * publish a detection-time number.
 */

interface Enqueuer {
  send: (name: string, data: object, options?: object) => Promise<unknown>;
}

export interface PlaneDeps {
  boss?: Enqueuer;
  actorId?: string;
  allowPrivateTargets?: boolean;
  /** Overrides the transport, for tests that must not open sockets. */
  fetchImpl?: typeof fetch;
  /** See `ProbeContext.lookup` — injectable so a test need not resolve. */
  lookup?: CheckOptions["lookup"];
  /** Overrides the identity this replica leases shards under. */
  ownerId?: string;
}

/**
 * One monitor's place in the schedule.
 *
 * Held in memory and rebuilt from the database every `HF_RELOAD_MS`.
 * That is the honest trade: the plane's state is not durable, so a
 * worker restart loses the slot phase (not the monitors, and not the
 * samples already written), and the monitors it was probing are picked
 * up by the ordinary plane within a tick until a replica takes the
 * shard back.
 */
interface Slot {
  monitor: Monitor;
  intervalMs: number;
  /** Monotonic deadline of the next probe. */
  dueMono: number;
  inFlight: boolean;
  promoting: boolean;
  /** host:port — what the per-target fairness limit counts. */
  targetKey: string;
  lastPromotedVerdict: Verdict | null;
  lastPromotedMono: number | null;
  /**
   * Whether the monitor row already agrees with what is being measured.
   * While it does not, promotion runs at `HF_UNSETTLED_PROMOTION_MS`.
   */
  settled: boolean;
  probes: number;
  missedSlots: number;
  shedSlots: number;
}

export interface PlaneStats {
  running: boolean;
  monitors: number;
  shards: number[];
  probes: number;
  /** Slots that were due and did not happen because a probe was late. */
  missedSlots: number;
  /** Slots refused by a rate, fairness or backpressure limit. */
  shedSlots: number;
  promotions: number;
  clockSteps: number;
  writer: ReturnType<SampleWriter["snapshot"]>;
}

/**
 * A token bucket, in milliseconds of accumulated allowance.
 *
 * Refilled from the monotonic clock on demand rather than by a timer,
 * so it costs nothing when the plane is idle and cannot drift from the
 * scheduler's own notion of time.
 */
class TokenBucket {
  private tokens: number;
  private lastMono: number;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    nowMono: number,
  ) {
    this.tokens = burst;
    this.lastMono = nowMono;
  }

  take(nowMono: number): boolean {
    const elapsedMs = Math.max(0, nowMono - this.lastMono);
    this.lastMono = nowMono;
    this.tokens = Math.min(
      this.burst,
      this.tokens + (elapsedMs * this.perSecond) / 1000,
    );
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class HighFrequencyPlane {
  private readonly clock = new SchedulerClock();
  private readonly writer = new SampleWriter(db);
  private readonly bucket: TokenBucket;
  private readonly slots = new Map<string, Slot>();
  private readonly inFlightPerOrg = new Map<string, number>();
  private readonly inFlightPerTarget = new Map<string, number>();
  private readonly ownerId: string;

  private ticker: NodeJS.Timeout | null = null;
  private reloader: NodeJS.Timeout | null = null;
  private renewer: NodeJS.Timeout | null = null;
  private leases: Lease[] = [];
  private running = false;
  private probes = 0;
  private missedSlots = 0;
  private shedSlots = 0;
  private promotions = 0;

  constructor(private readonly deps: PlaneDeps = {}) {
    this.ownerId =
      deps.ownerId ?? `${process.env.HOSTNAME ?? "worker"}:${process.pid}`;
    this.bucket = new TokenBucket(
      HF_MAX_PROBES_PER_SECOND,
      HF_PROBE_BURST,
      this.clock.now(),
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.renewLeases();
    await this.reload();

    this.ticker = setInterval(() => this.tick(), HF_TICK_MS);
    this.reloader = setInterval(() => void this.reload(), HF_RELOAD_MS);
    this.renewer = setInterval(
      () => void this.renewLeases(),
      HF_LEASE_RENEW_MS,
    );
    log.info(
      { ownerId: this.ownerId, shards: this.leases.length },
      "high-frequency plane started",
    );
  }

  /**
   * Stops probing, hands the shards back, and writes what is buffered.
   *
   * The order matters. Releasing the leases before the last flush would
   * let another replica start probing monitors whose samples this one
   * has not written yet, which is a gap in the sample stream that looks
   * exactly like a stall.
   */
  async stop(): Promise<void> {
    this.running = false;
    for (const timer of [this.ticker, this.reloader, this.renewer]) {
      if (timer) clearInterval(timer);
    }
    this.ticker = this.reloader = this.renewer = null;
    await this.writer.stop();
    await releaseShards(
      db,
      this.ownerId,
      this.leases.map((lease) => lease.shard),
    ).catch((error) =>
      // A lease that is not released expires on its own within
      // HF_LEASE_TTL_MS. Worth a log line and not worth failing a
      // shutdown over.
      log.warn({ err: error }, "could not release shard leases"),
    );
    this.leases = [];
    this.slots.clear();
    log.info(this.stats(), "high-frequency plane stopped");
  }

  stats(): PlaneStats {
    return {
      running: this.running,
      monitors: this.slots.size,
      shards: this.leases.map((lease) => lease.shard),
      probes: this.probes,
      missedSlots: this.missedSlots,
      shedSlots: this.shedSlots,
      promotions: this.promotions,
      clockSteps: this.clock.clockSteps(),
      writer: this.writer.snapshot(),
    };
  }

  /**
   * Whether this replica currently holds an unexpired lease on a shard.
   *
   * Asked on every tick rather than assumed from "the renewal loop is
   * running", because the case that matters is the one where the renewal
   * loop is running and failing: a partitioned worker with a stale lease
   * that keeps probing is the double-probe this design exists to
   * prevent, and it happens precisely when nobody is looking.
   */
  private holdsShards(nowWallMs: number): Set<number> {
    const held = new Set<number>();
    for (const lease of this.leases) {
      if (lease.expiresAt.getTime() > nowWallMs) held.add(lease.shard);
    }
    return held;
  }

  private async renewLeases(): Promise<void> {
    try {
      this.leases = await claimShards(db, this.ownerId, ALL_SHARDS);
    } catch (error) {
      // Left as they were: the existing expiry timestamps are still the
      // truth about what this replica was granted, and they will lapse
      // on their own. Clearing them here would stop probing on the first
      // transient database error, which is a worse outcome than probing
      // until the grant genuinely runs out.
      log.error({ err: error }, "could not renew shard leases");
    }
  }

  /**
   * Rebuilds the slot table from the database.
   *
   * Additive: a monitor already in the table keeps its slot phase and
   * its promotion state, so a reload does not re-align every monitor to
   * the same instant — which would turn a smooth 2000/s into a spike
   * every two seconds.
   */
  private async reload(): Promise<void> {
    if (!this.running) return;
    const held = this.holdsShards(Date.now());
    try {
      const rows = await db
        .select()
        .from(monitors)
        .where(
          and(
            eq(monitors.highFrequency, true),
            eq(monitors.paused, false),
            inArray(monitors.checkType, [...HIGH_FREQUENCY_TYPE_IDS]),
            sql`${monitors.highFrequencyIntervalMs} is not null`,
          ),
        );

      const mine = rows.filter((row) => held.has(shardOf(row.id)));
      const keep = new Set<string>();
      const now = this.clock.now();

      for (const monitor of mine) {
        if (keep.size >= HF_MAX_MONITORS_PER_WORKER) break;
        keep.add(monitor.id);
        const existing = this.slots.get(monitor.id);
        const intervalMs = monitor.highFrequencyIntervalMs ?? 0;
        if (existing) {
          existing.monitor = monitor;
          existing.intervalMs = intervalMs;
          existing.targetKey = targetKeyOf(monitor);
          continue;
        }
        this.slots.set(monitor.id, {
          monitor,
          intervalMs,
          // Spread across the first interval by hash rather than all
          // starting now: a reload that adds two hundred monitors would
          // otherwise fire two hundred probes in the same millisecond,
          // every time, forever — the slots never drift apart on their
          // own because they all advance by the same amount.
          dueMono: now + (shardOf(monitor.id) / ALL_SHARDS.length) * intervalMs,
          inFlight: false,
          promoting: false,
          targetKey: targetKeyOf(monitor),
          lastPromotedVerdict: null,
          lastPromotedMono: null,
          settled: true,
          probes: 0,
          missedSlots: 0,
          shedSlots: 0,
        });
      }

      if (mine.length > HF_MAX_MONITORS_PER_WORKER) {
        log.error(
          { enabled: mine.length, cap: HF_MAX_MONITORS_PER_WORKER },
          "more high-frequency monitors than this worker will schedule; the excess is not being probed at high frequency",
        );
      }

      for (const id of [...this.slots.keys()]) {
        if (!keep.has(id)) this.slots.delete(id);
      }
    } catch (error) {
      log.error({ err: error }, "could not reload high-frequency monitors");
    }
  }

  /**
   * One pass over the slot table.
   *
   * Synchronous by construction: it decides and dispatches, and never
   * awaits. A tick that awaited a probe would make the cadence of every
   * monitor a function of the slowest one — which is the shape of bug
   * that makes a monitoring product miss the outage it is watching for.
   */
  private tick(): void {
    if (!this.running) return;
    const now = this.clock.now();
    const held = this.holdsShards(Date.now());

    // Most overdue first, not insertion order.
    //
    // The fairness caps below refuse work when an organization or a
    // target already has enough in flight. With a stable iteration
    // order, the same monitors win that contention every tick and the
    // ones after them are refused every tick — so a tenth monitor in an
    // organization capped at eight in-flight probes is not slowed down,
    // it is never probed at all. A shed slot advances to its next
    // boundary like any other, so it does not accumulate priority by
    // itself; serving the most overdue first is what gives it the next
    // turn. Found by the benchmark: nine of ten monitors reported a
    // perfect 500ms cadence and the tenth reported nothing.
    const due = [];
    for (const slot of this.slots.values()) {
      if (slot.dueMono <= now) due.push(slot);
    }
    due.sort((a, b) => a.dueMono - b.dueMono);

    for (const slot of due) {
      // The lease lapsed under us. The slot is not missed and not shed —
      // it is not ours — so it is re-anchored without a counter, and if
      // the lease comes back the monitor resumes on the next tick.
      if (!held.has(shardOf(slot.monitor.id))) {
        this.advance(slot, now, null);
        continue;
      }

      const refusal = this.refuse(slot, now);
      if (refusal !== null) {
        this.advance(slot, now, refusal);
        continue;
      }

      this.advance(slot, now, null);
      void this.probe(slot, now);
    }
  }

  /**
   * Whether this slot may issue a probe, and if not, which counter it
   * belongs to.
   *
   * Ordered cheapest and most specific first. The in-flight check comes
   * before the rate limiter because an overrunning probe is a *missed*
   * slot, not a shed one: nothing refused it, the previous one had not
   * finished, and conflating the two would let a plane that is quietly
   * timing out on every probe report a clean shed count and a healthy
   * rate.
   */
  private refuse(slot: Slot, nowMono: number): "missed" | "shed" | null {
    if (slot.inFlight) return "missed";
    if (this.writer.saturated()) return "shed";
    if (
      (this.inFlightPerOrg.get(slot.monitor.organizationId) ?? 0) >=
      HF_MAX_INFLIGHT_PER_ORG
    ) {
      return "shed";
    }
    if (
      (this.inFlightPerTarget.get(slot.targetKey) ?? 0) >=
      HF_MAX_INFLIGHT_PER_TARGET
    ) {
      return "shed";
    }
    if (!this.bucket.take(nowMono)) return "shed";
    return null;
  }

  /**
   * Moves a slot to its next deadline.
   *
   * ── the missed-slot policy: SKIP ─────────────────────────────────
   *
   * When a slot's deadline has already passed — the probe overran, the
   * process was descheduled, the event loop was busy — the missed slots
   * are dropped and the schedule re-anchors to the next boundary. They
   * are counted, and the count is what the achieved-cadence figure and
   * the operator's own gaps in the sample stream are made of.
   *
   * The two rejected alternatives:
   *
   * *Coalesce* — fire the missed probes back to back to catch up. This
   * points a burst at a target at the exact moment something is already
   * slow, and the thing that is usually slow is the target. It converts
   * a monitoring product into a load generator on a struggling service,
   * and it does it hardest during an outage.
   *
   * *Record* — write a synthetic observation for the missed slot. That
   * puts a row nothing measured into the evidence table. Vigil's uptime
   * is duration-weighted, so a gap in the samples is already visible as
   * a longer segment and a shorter covered window; a manufactured row
   * would replace an honest "we did not look" with an invented reading,
   * which is the one thing the surrounding code goes out of its way
   * never to do (see `uptime.ts` on uncovered time).
   *
   * Skipping loses nothing the achieved-cadence number does not already
   * report, and it is the only one of the three that cannot make an
   * outage worse.
   */
  private advance(
    slot: Slot,
    nowMono: number,
    refusal: "missed" | "shed" | null,
  ): void {
    if (refusal === "missed") {
      slot.missedSlots += 1;
      this.missedSlots += 1;
    } else if (refusal === "shed") {
      slot.shedSlots += 1;
      this.shedSlots += 1;
      // Shedding is backpressure, not a forfeited slot. Retry on the
      // next tick rather than surrendering the whole interval.
      //
      // Without this, monitors created together stay aligned forever —
      // they come due on the same boundary, the fairness cap admits the
      // first N, and the rest advance by exactly one interval and arrive
      // at the next boundary just as aligned and just as late. A stable
      // sort then hands the same monitors the same win every tick. The
      // benchmark caught it as nine of ten monitors reporting a perfect
      // 500ms cadence and the tenth reporting nothing at all: not slow,
      // never probed.
      //
      // Coming back one tick later also makes it the most overdue slot
      // in the next round, so the ordering above gives it the turn.
      slot.dueMono = nowMono + HF_TICK_MS;
      return;
    }

    slot.dueMono += slot.intervalMs;
    if (slot.dueMono > nowMono) return;

    // Still behind after one interval: every boundary between here and
    // now is a slot that will not happen. Counted, then skipped.
    const behindMs = nowMono - slot.dueMono;
    const skipped = Math.floor(behindMs / slot.intervalMs) + 1;
    slot.missedSlots += skipped;
    this.missedSlots += skipped;
    slot.dueMono += skipped * slot.intervalMs;
  }

  private async probe(slot: Slot, issuedMono: number): Promise<void> {
    slot.inFlight = true;
    bump(this.inFlightPerOrg, slot.monitor.organizationId, 1);
    bump(this.inFlightPerTarget, slot.targetKey, 1);
    this.probes += 1;
    slot.probes += 1;

    let result: CheckResult;
    try {
      result = await performCheck(toCheckSpec(slot.monitor), {
        allowPrivateTargets:
          this.deps.allowPrivateTargets ?? env.ALLOW_PRIVATE_MONITOR_TARGETS,
        fetchImpl: this.deps.fetchImpl,
        lookup: this.deps.lookup,
      });
    } catch (error) {
      // `performCheck` answers rather than throwing for everything a
      // target can do; reaching here means the type itself is broken.
      // Recorded as indeterminate — Vigil could not tell — because
      // recording it as down would report a bug in Vigil as an outage
      // at the customer.
      result = {
        ok: false,
        degraded: false,
        statusCode: null,
        responseTimeMs: null,
        error: error instanceof Error ? error.message : "Probe failed",
        verdict: "indeterminate",
        failureClass: "misconfigured",
        facts: {},
        failedAssertions: [],
      };
    } finally {
      slot.inFlight = false;
      bump(this.inFlightPerOrg, slot.monitor.organizationId, -1);
      bump(this.inFlightPerTarget, slot.targetKey, -1);
    }

    // Stamped with the slot's issue time, not the completion time. The
    // question the cadence answers is "how often was this target
    // asked", and stamping on completion would fold the target's own
    // latency into the cadence — a target that slows down would look
    // like a scheduler that slowed down.
    this.writer.add({
      monitorId: slot.monitor.id,
      observedAt: this.clock.wallAt(issuedMono),
      ok: result.ok,
      verdict: result.verdict,
      responseTimeMs: result.responseTimeMs,
      error: result.error,
    });

    if (this.shouldPromote(slot, result, issuedMono)) {
      void this.promote(slot, result, issuedMono);
    }
  }

  /**
   * Whether this sample has to become an observation of record.
   *
   * Three rules, and the middle one is the one that makes a short
   * failure window mean anything.
   *
   * 1. **A changed verdict, always.** That is the edge an operator cares
   *    about and the moment an incident can open or resolve.
   * 2. **While the row does not yet agree with the measurement**, keep
   *    promoting at `HF_UNSETTLED_PROMOTION_MS`. A monitor that has been
   *    failing for three seconds with a five-second failure window has
   *    an incident due in two seconds, and the status controller is
   *    level-triggered: it opens the incident on the next observation it
   *    is given, not on a timer. Without this rule that observation is
   *    the next *interval* one — so a monitor probed twice a second on a
   *    five-second window would page a minute late, and the operator
   *    would have paid for high frequency and received none of it.
   * 3. **Otherwise once per `intervalSeconds`.** That is what feeds
   *    `uptime.ts`'s coverage horizon, which is sized from the same
   *    column. Promoting less often would report uncovered time for a
   *    monitor being watched twice a second; promoting on every sample
   *    would multiply the largest table in the product by 120.
   */
  private shouldPromote(
    slot: Slot,
    result: CheckResult,
    nowMono: number,
  ): boolean {
    if (slot.promoting) return false;
    if (slot.lastPromotedMono === null) return true;
    if (result.verdict !== slot.lastPromotedVerdict) return true;
    const sinceMs = nowMono - slot.lastPromotedMono;
    return slot.settled
      ? sinceMs >= slot.monitor.intervalSeconds * 1000
      : sinceMs >= HF_UNSETTLED_PROMOTION_MS;
  }

  /**
   * Hands one sample to the ordinary observation path.
   *
   * Everything downstream — the ledger stamp, the status controller,
   * incidents, notifications, groups, uptime — runs exactly as it does
   * for a queued check, through the same function, because there is one
   * implementation of what an observation means and this plane is not
   * allowed to become a second one.
   */
  private async promote(
    slot: Slot,
    result: CheckResult,
    issuedMono: number,
  ): Promise<void> {
    slot.promoting = true;
    try {
      const updated = await applyOutcome(slot.monitor, result, {
        actorId: this.deps.actorId,
        boss: this.deps.boss,
        now: this.clock.wallAt(issuedMono),
      });
      // The returned row, not the one we probed with. `recordCheckOutcome`
      // writes conditionally on `first_failure_at` still holding the
      // value the outcome was derived from, so a stale copy here makes
      // the *next* promotion match no row and silently do nothing.
      slot.monitor = updated;
      slot.lastPromotedVerdict = result.verdict;
      slot.lastPromotedMono = issuedMono;
      // "Settled" means the stored status already reflects what is being
      // measured, so nothing is pending that a faster observation would
      // bring forward. A failure run with no incident yet is the one
      // state where that is false.
      slot.settled =
        updated.firstFailureAt === null || updated.currentStatus === "down";
      this.promotions += 1;
    } catch (error) {
      log.error(
        { err: error, monitorId: slot.monitor.id },
        "could not promote a high-frequency sample",
      );
    } finally {
      slot.promoting = false;
    }
  }
}

/**
 * What the per-target fairness limit counts as one target.
 *
 * Host and port, so ten monitors watching ten paths on one host share
 * the budget — which is the case the limit exists for. Falls back to the
 * raw target when it will not parse as a URL, which is every non-HTTP
 * type: for those the target already *is* the host.
 */
function targetKeyOf(monitor: Monitor): string {
  try {
    const url = new URL(monitor.url);
    return `${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`;
  } catch {
    return `${monitor.url}:${monitor.port ?? 0}`;
  }
}

function bump(counts: Map<string, number>, key: string, delta: number): void {
  const next = (counts.get(key) ?? 0) + delta;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
}

/**
 * Whether the ordinary pg-boss plane should leave this monitor alone.
 *
 * Asked of the lease table, not of "am I the one probing it": the
 * question is whether *anybody* is, because the answer "nobody" has to
 * mean the queue picks the monitor back up. A worker that crashes
 * mid-outage must degrade a monitor from 500ms to 2s, not from 500ms to
 * silence — and the operator's failure window keeps meaning what it
 * said either way.
 */
export async function highFrequencyClaims(): Promise<(m: Monitor) => boolean> {
  const live = await cachedLiveShards();
  return (monitor) =>
    monitor.highFrequency &&
    monitor.highFrequencyIntervalMs !== null &&
    live.has(shardOf(monitor.id));
}

/**
 * How long the lease snapshot the ordinary plane reads may be stale.
 *
 * It is asked once per queued check, and without a cache that is an
 * extra query per monitor per interval across the whole installation —
 * paid by every deployment, including the overwhelming majority with no
 * high-frequency monitor at all. A second is safe in both directions and
 * neither is interesting: stale-live skips one queued check of a monitor
 * whose plane just died (it runs a tick later), stale-dead allows one
 * duplicate probe of a monitor whose plane just started.
 */
const CLAIMS_CACHE_MS = 1_000;

let claimsCache: { at: number; shards: Set<number> } | null = null;

async function cachedLiveShards(): Promise<Set<number>> {
  const now = Date.now();
  if (claimsCache && now - claimsCache.at < CLAIMS_CACHE_MS) {
    return claimsCache.shards;
  }
  const shards = await liveShards(db);
  claimsCache = { at: now, shards };
  return shards;
}
