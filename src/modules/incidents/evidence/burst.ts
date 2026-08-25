import dnsPromises from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  drainBodyCapped,
  egressFetch,
  egressPolicyFor,
  EgressBlockedError,
  type EgressLookup,
  type ResolvedAddress,
} from "@/modules/monitors/egress";
import {
  classifyAddress,
  isForbiddenEgressHost,
  isNeverReachable,
  normalizeHost,
} from "@/modules/monitors/net";
import { certificateResult } from "@/modules/monitors/types/probes/tls-expiry";

import type {
  BurstRecord,
  BurstSkipReason,
  BurstStep,
  EvidenceFacts,
} from "./types";

/**
 * The incident-onset diagnostic burst: at most four read-only probes,
 * fired once, when an incident opens.
 *
 * The reason this exists is narrow and worth stating, because "run more
 * probes during an outage" is otherwise a bad idea. A monitor's own
 * check answers "is it up". It very often cannot answer "which layer
 * broke", because the thing it reports is a timeout or a bare `fetch
 * failed`, and by the time an operator reads the incident the evidence
 * for the difference between "DNS is gone" and "the app is returning
 * 503" no longer exists anywhere. Four probes at onset - resolve,
 * connect, handshake, request - cost one round trip each and turn that
 * guess into a measurement. That is the whole feature.
 *
 * Everything else here is a bound, and the bounds are the contract:
 *
 * - **Requests.** {@link BURST_MAX_STEPS} steps, one socket each, and
 *   the HTTP step refuses to follow redirects, so a chain cannot turn
 *   one step into ten.
 * - **Duration.** {@link BURST_BUDGET_MS} across the whole burst, with
 *   each step capped at {@link BURST_STEP_TIMEOUT_MS} and given no more
 *   than the budget that is left. A burst that runs out stops early and
 *   says so by having fewer steps. Enforced by RACING each step against
 *   its deadline rather than by passing it a timeout and hoping: two of
 *   the four steps resolve a hostname through machinery that takes no
 *   timeout at all (`dns.lookup`, and `authorizeEgress` inside
 *   `egressFetch`), so a burst that only asked nicely was bounded by the
 *   system resolver's patience and not by this number.
 * - **Concurrency.** {@link MAX_CONCURRENT_BURSTS} at a time per worker
 *   process. A correlated outage takes a hundred monitors down at once,
 *   and a hundred simultaneous bursts is a stampede aimed at a target
 *   that is already having a bad day. Over the limit, the burst is
 *   skipped and the snapshot records `concurrency` - which is the bound
 *   reporting itself rather than a gap.
 * - **Storage.** Every step's detail is a small fact bag; the snapshot
 *   as a whole is capped by `capture.ts`.
 * - **Consequences.** None. Nothing here writes an observation, moves a
 *   monitor's status, touches an incident, pages anybody, feeds an SLO
 *   or reaches a status page. The result is one jsonb column that only
 *   the incident page reads. A burst that fails entirely costs the
 *   snapshot one field.
 *
 * The egress posture is the monitor channel's own, unchanged: the same
 * policy, the same classifier, the same refusal of private and metadata
 * space. A diagnostic that could reach further than the check it is
 * diagnosing would be an SSRF primitive with a friendly name.
 */

export const BURST_BUDGET_MS = 5_000;
export const BURST_MAX_STEPS = 4;
export const BURST_STEP_TIMEOUT_MS = 2_000;
export const MAX_CONCURRENT_BURSTS = 2;

/** How many resolved addresses are worth recording. */
const MAX_RECORDED_ADDRESSES = 4;

/**
 * Response headers that may be copied into evidence.
 *
 * An allow-list, not a deny-list, and that direction is the whole
 * point: `set-cookie`, `www-authenticate` and anything a target invents
 * are all secrets until proven otherwise, and a deny-list is a promise
 * to have thought of every one of them in advance. These seven are
 * routing and caching metadata that an operator reads to tell a CDN
 * failure from an origin failure.
 */
const SAFE_RESPONSE_HEADERS = [
  "server",
  "content-type",
  "content-length",
  "via",
  "age",
  "x-cache",
  "retry-after",
] as const;

const log = logger.child({ module: "incident-evidence-burst" });

/**
 * The four things a burst can do, behind an interface.
 *
 * Injectable for the same reason `ProbeContext.lookup` is: a test that
 * proves the classification, the ordering and the bounds must not need
 * a network, and a suite that resolves real hostnames fails in a
 * different test every run. Production passes nothing and gets
 * {@link systemTransport}.
 */
export interface BurstTransport {
  lookup: EgressLookup;
  connect(
    address: string,
    port: number,
    timeoutMs: number,
  ): Promise<{ error: string | null }>;
  handshake(
    address: string,
    servername: string,
    port: number,
    timeoutMs: number,
  ): Promise<{ facts: EvidenceFacts; error: string | null }>;
  request(
    url: string,
    method: string,
    timeoutMs: number,
    allowPrivate: boolean,
  ): Promise<{ facts: EvidenceFacts; error: string | null }>;
}

const systemLookup: EgressLookup = async (hostname) => {
  const addresses = await dnsPromises.lookup(hostname, { all: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));
};

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/** Redacted the way `authorizeEgress` redacts: origin and path only. */
function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

export const systemTransport: BurstTransport = {
  lookup: systemLookup,

  connect(address, port, timeoutMs) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: address, port });
      let settled = false;
      const settle = (error: string | null) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ error });
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => settle(null));
      socket.once("timeout", () => settle(`Timed out after ${timeoutMs}ms`));
      socket.once("error", (error: Error) =>
        settle(error.message || "Connection failed"),
      );
    });
  },

  handshake(address, servername, port, timeoutMs) {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      let settled = false;
      const settle = (facts: EvidenceFacts, error: string | null) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ facts, error });
      };
      const socket = tls.connect(
        {
          host: address,
          servername,
          port,
          timeout: timeoutMs,
          // The same decision the `tls-expiry` probe makes, for the same
          // reason: an expired or self-signed certificate is a thing to
          // report, not a reason to refuse to look. Nothing is sent over
          // this socket.
          rejectUnauthorized: false,
        },
        () => {
          const result = certificateResult(
            socket.getPeerCertificate(),
            elapsed(startedAt),
          );
          settle(
            {
              ...(result.facts as EvidenceFacts),
              protocol: socket.getProtocol(),
              authorized: socket.authorized,
              ...(socket.authorized
                ? {}
                : {
                    authorizationError: String(socket.authorizationError ?? ""),
                  }),
            },
            result.error,
          );
        },
      );
      socket.once("timeout", () =>
        settle({}, `TLS handshake timed out after ${timeoutMs}ms`),
      );
      socket.once("error", (error: Error) =>
        settle({}, error.message || "TLS handshake failed"),
      );
    });
  },

  async request(url, method, timeoutMs, allowPrivate) {
    const startedAt = performance.now();
    try {
      const { response } = await egressFetch(
        url,
        {
          method,
          signal: AbortSignal.timeout(timeoutMs),
          headers: { "user-agent": "vigil-monitor/1.0 (+https://github.com)" },
        },
        {
          policy: egressPolicyFor("monitor", allowPrivate),
          // Zero, so one diagnostic step is one request. A redirect is
          // recorded as what it is - a 3xx and a location - rather than
          // followed into a chain that would break the request bound
          // this whole module is built around.
          maxRedirects: 0,
        },
      );
      const durationMs = elapsed(startedAt);
      const facts: EvidenceFacts = {
        statusCode: response.status,
        responseTimeMs: durationMs,
        redirectsFollowed: 0,
      };
      for (const header of SAFE_RESPONSE_HEADERS) {
        const value = response.headers.get(header);
        if (value !== null) facts[header] = value.slice(0, 200);
      }
      const location = response.headers.get("location");
      if (location !== null) {
        // Resolved against the request URL so a relative redirect is
        // legible, then reduced to origin and path: a `location` can
        // carry a session token in its query string.
        const resolved = safeUrl(new URL(location, url).toString());
        if (resolved !== null) facts.location = resolved.slice(0, 500);
      }
      // Read and thrown away, capped, so the socket closes cleanly
      // without buffering a target's response into worker memory.
      await drainBodyCapped(response, 0).catch(() => undefined);
      return { facts, error: null };
    } catch (error) {
      const durationMs = elapsed(startedAt);
      if (error instanceof EgressBlockedError) {
        return { facts: { responseTimeMs: durationMs }, error: error.message };
      }
      const message =
        error instanceof Error
          ? error.cause instanceof Error
            ? error.cause.message
            : error.message
          : "Request failed";
      return { facts: { responseTimeMs: durationMs }, error: message };
    }
  },
};

/**
 * What a burst would dial. Null when the check type has nothing
 * dialable - a heartbeat, a group, an operator's own assertion.
 */
export interface BurstTarget {
  host: string;
  port: number | null;
  /** Set when the target is an http(s) URL that the HTTP step may request. */
  url: string | null;
  method: string;
  /** Whether a TLS handshake is part of what this target speaks. */
  tls: boolean;
}

let inFlight = 0;

/** How many bursts this process is running. Exported for the tests. */
export function burstsInFlight(): number {
  return inFlight;
}

export interface RunBurstOptions {
  target: BurstTarget;
  transport?: BurstTransport;
  allowPrivateTargets?: boolean;
  now?: Date;
  budgetMs?: number;
}

function skipped(
  reason: BurstSkipReason,
  now: Date,
  budgetMs: number,
): BurstRecord {
  return {
    ranAt: now.toISOString(),
    budgetMs,
    maxSteps: BURST_MAX_STEPS,
    spentMs: 0,
    steps: [],
    skipped: reason,
  };
}

/**
 * Runs one step under the budget, and turns every way it can go wrong
 * into a value.
 *
 * Two things this closes, both of which made the documented bound a
 * fiction rather than a bound:
 *
 * **A transport that never settles.** Passing a timeout to a step is
 * asking it nicely. `dns.lookup` takes no timeout at all, and
 * `egressFetch` resolves the hostname itself - inside `authorizeEgress`,
 * before the request's `AbortSignal` is anywhere near a socket - so the
 * resolve and the request could both hang for as long as the system
 * resolver felt like, with the 5000ms budget watching. The race is what
 * makes the number true: whatever the step is doing, the burst stops
 * waiting at the deadline. The step keeps running in the background
 * until its own machinery gives up, which is unavoidable without a
 * cancellable resolver, but nothing waits for it and nothing records it.
 *
 * **A transport that rejects.** Only the resolve step was wrapped. A
 * rejection from connect, handshake or request unwound `runBurst`,
 * `buildSnapshot` and `captureBurst` into `captureIncidentEvidence`'s
 * catch, so a single throwing socket cost the entire snapshot rather
 * than one field - the opposite of what this module promises.
 */
/**
 * The messages this module produces about ITSELF, as opposed to about
 * the target. `classify.ts` refuses to read a step carrying one as
 * evidence of a failing layer.
 */
const SELF_INFLICTED = ["The diagnostic budget was spent", "Gave up after"];

/** Whether a step's failure was Vigil's own doing. */
export function isSelfInflicted(error: string | null): boolean {
  if (error === null) return false;
  return SELF_INFLICTED.some((marker) => error.startsWith(marker));
}

async function step<T>(
  budgetMs: number,
  work: (timeoutMs: number) => Promise<T>,
  onFailure: (message: string) => T,
): Promise<T> {
  if (budgetMs <= 0) return onFailure(SELF_INFLICTED[0]!);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(budgetMs).catch((error: unknown) =>
        onFailure(error instanceof Error ? error.message : "The step failed"),
      ),
      new Promise<T>((resolve) => {
        timer = setTimeout(
          () => resolve(onFailure(`Gave up after ${budgetMs}ms`)),
          budgetMs,
        );
        // The burst must never be the reason a worker cannot exit.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs the burst and returns what it saw.
 *
 * Never throws. Every failure inside is either a recorded step or a
 * skip reason, because the caller is an incident that has already
 * opened and the only thing a throw here could achieve is to lose the
 * rest of the snapshot.
 */
export async function runBurst(options: RunBurstOptions): Promise<BurstRecord> {
  const now = options.now ?? new Date();
  const budgetMs = options.budgetMs ?? BURST_BUDGET_MS;
  const transport = options.transport ?? systemTransport;
  const allowPrivate =
    options.allowPrivateTargets ?? env.ALLOW_PRIVATE_MONITOR_TARGETS;
  const { target } = options;

  const host = normalizeHost(target.host);
  if (host === "" || isForbiddenEgressHost(host)) {
    return skipped("refused", now, budgetMs);
  }

  if (inFlight >= MAX_CONCURRENT_BURSTS) {
    log.debug({ host, inFlight }, "diagnostic burst skipped: too many running");
    return skipped("concurrency", now, budgetMs);
  }

  inFlight += 1;
  const startedAt = performance.now();
  const steps: BurstStep[] = [];
  /**
   * What is left of the budget, as this step's deadline.
   *
   * Read ONCE per step and passed down, never called twice around a
   * guard. Two calls a millisecond apart can straddle zero, and the
   * consequence is not a 0ms timeout but no timeout at all:
   * `socket.setTimeout(0)` and `tls.connect({timeout: 0})` both mean
   * "never time out" in Node, so the step would run until the OS gave
   * up on the SYN - about two minutes - with the budget unable to stop
   * it.
   */
  const slice = (): number =>
    Math.max(0, Math.min(BURST_STEP_TIMEOUT_MS, budgetMs - elapsed(startedAt)));

  try {
    // ── 1. Resolve ────────────────────────────────────────────────────
    const dnsStartedAt = performance.now();
    const resolved = await step(
      slice(),
      async (): Promise<{
        addresses: ResolvedAddress[];
        error: string | null;
      }> => {
        const found = await transport.lookup(host);
        return {
          addresses: found,
          error:
            found.length === 0 ? "Target did not resolve to any address" : null,
        };
      },
      (message) => ({ addresses: [] as ResolvedAddress[], error: message }),
    );
    const addresses = resolved.addresses;
    const dnsError = resolved.error;
    const recorded = addresses
      .slice(0, MAX_RECORDED_ADDRESSES)
      .map((a) => a.address);
    steps.push({
      kind: "dns",
      ok: dnsError === null,
      durationMs: elapsed(dnsStartedAt),
      detail: {
        addresses: recorded,
        addressCount: addresses.length,
        ...(recorded.length > 0 ? { family: addresses[0]!.family } : {}),
      },
      error: dnsError,
    });
    if (dnsError !== null) {
      return record(now, budgetMs, startedAt, steps);
    }

    // The same refusal every probe makes, applied to what the burst is
    // about to dial. A hostname that was public when the monitor was
    // created and resolves to 10.0.0.1 now is exactly the case this
    // exists for, and a diagnostic must not be the one path that
    // forgets to ask.
    //
    // Written as `authorizeEgress` writes it, down to the fallback for
    // an address the classifier cannot read: a stricter rule here would
    // be worse than a laxer one, not better. An installation that has
    // set `ALLOW_PRIVATE_MONITOR_TARGETS` is monitoring its own LAN, and
    // a diagnostic that refuses the target its own check just probed
    // reports "refused" for a target that is perfectly reachable.
    const refused = addresses.find((entry) => {
      const classification = classifyAddress(entry.address) ?? "reserved";
      if (classification === "public") return false;
      return isNeverReachable(classification) || !allowPrivate;
    });
    if (refused) {
      log.debug({ host }, "diagnostic burst refused by egress policy");
      // `skipped` alongside a recorded step, and the UI reads it
      // whatever `steps` holds. The resolve is kept because WHAT the
      // name resolved to is the finding here - "it now points at
      // 10.0.0.1" is the answer an operator wants, and dropping the step
      // to satisfy a tidier invariant would delete it.
      return {
        ...record(now, budgetMs, startedAt, steps),
        skipped: "refused",
      };
    }

    const pin = addresses[0]!.address;

    // ── 2. Connect ────────────────────────────────────────────────────
    const tcpBudget = slice();
    if (target.port === null || tcpBudget <= 0) {
      return record(now, budgetMs, startedAt, steps);
    }
    const tcpStartedAt = performance.now();
    const tcp = await step(
      tcpBudget,
      (timeoutMs) => transport.connect(pin, target.port!, timeoutMs),
      (message) => ({ error: message }),
    );
    steps.push({
      kind: "tcp",
      ok: tcp.error === null,
      durationMs: elapsed(tcpStartedAt),
      detail: { address: pin, port: target.port },
      error: tcp.error,
    });
    if (tcp.error !== null) return record(now, budgetMs, startedAt, steps);

    // ── 3. Handshake ──────────────────────────────────────────────────
    const tlsBudget = slice();
    if (target.tls && tlsBudget > 0) {
      const tlsStartedAt = performance.now();
      const handshake = await step(
        tlsBudget,
        (timeoutMs) => transport.handshake(pin, host, target.port!, timeoutMs),
        (message) => ({ facts: {} as EvidenceFacts, error: message }),
      );
      steps.push({
        kind: "tls",
        ok: handshake.error === null,
        durationMs: elapsed(tlsStartedAt),
        detail: handshake.facts,
        error: handshake.error,
      });
      if (handshake.error !== null)
        return record(now, budgetMs, startedAt, steps);
    }

    // ── 4. Request ────────────────────────────────────────────────────
    const httpBudget = slice();
    if (target.url !== null && httpBudget > 0) {
      const httpStartedAt = performance.now();
      const response = await step(
        httpBudget,
        (timeoutMs) =>
          transport.request(
            target.url!,
            target.method,
            timeoutMs,
            allowPrivate,
          ),
        (message) => ({ facts: {} as EvidenceFacts, error: message }),
      );
      steps.push({
        kind: "http",
        ok: response.error === null,
        durationMs: elapsed(httpStartedAt),
        detail: response.facts,
        error: response.error,
      });
    }

    return record(now, budgetMs, startedAt, steps);
  } finally {
    inFlight -= 1;
  }
}

/**
 * The longest error a step may record.
 *
 * The one field here whose length is decided by somebody else's server.
 * Capping it at the step keeps the storage bound in `capture.ts` from
 * ever having to fire for a single long message, which it would answer
 * by throwing away the rest of the snapshot.
 */
const MAX_STEP_ERROR_CHARS = 500;

function record(
  now: Date,
  budgetMs: number,
  startedAt: number,
  steps: BurstStep[],
): BurstRecord {
  return {
    ranAt: now.toISOString(),
    budgetMs,
    maxSteps: BURST_MAX_STEPS,
    spentMs: elapsed(startedAt),
    // Marked here rather than at each call site, so a step added later
    // cannot forget to do it: the marker is derived from the message the
    // step carries, and this is the one place every step passes through.
    steps: steps.map((step) => ({
      ...step,
      ...(isSelfInflicted(step.error) ? { selfInflicted: true as const } : {}),
      ...(step.error !== null && step.error.length > MAX_STEP_ERROR_CHARS
        ? { error: `${step.error.slice(0, MAX_STEP_ERROR_CHARS)}…` }
        : {}),
    })),
  };
}
