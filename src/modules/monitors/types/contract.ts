import type { z } from "zod";

/**
 * The check-type contract.
 *
 * Two rules hold everything else together:
 *
 * 1. **Probes measure, the runner judges.** A probe returns facts and,
 *    at most, a transport error. It never returns `ok`, `degraded` or a
 *    failure class — those are derived by {@link judge} from the type's
 *    declared assertions. A type that returned its own verdict would
 *    make the shared condition engine advisory, and every later
 *    capability (shadow mode, replay, re-judging history against a new
 *    spec version) depends on the verdict being recomputable.
 *
 * 2. **A type is data plus three functions.** Everything a type needs to
 *    exist — its form, its validation, its assertions, its probe — is
 *    reachable from one object. That is what makes the registry
 *    plugin-shaped without a plugin runtime: a future external type is
 *    the same object, loaded from somewhere else.
 *
 * 3. **Not every type dials something.** Until 1.13.0 the contract
 *    assumed it did: `probe(ctx)` was mandatory, so a type whose state
 *    arrives (a heartbeat), is derived (a group) or is asserted (an
 *    operator) had nowhere to live except as a fake probe returning
 *    invented facts. {@link CheckTypeKind} names the four ways a
 *    monitor can come to have a state, and each kind carries exactly
 *    one function — the one it is evaluated by.
 *
 * The published extension contract (R9) will be a narrowing of this
 * interface, not a replacement, which is why it is written as if it were
 * already external.
 */

/** One measurement. Facts are observations, never judgments. */
export type FactValue = string | number | boolean | null;

export type FactBag = Record<string, FactValue | FactValue[] | undefined>;

/** Declares a fact a type can emit, so the UI can label it and the
 * conformance suite can prove assertions only read facts that exist. */
export interface FactDescriptor {
  key: string;
  label: string;
  kind: "number" | "string" | "boolean" | "list";
  /** Suffix for display ("ms", "days"). */
  unit?: string;
}

/**
 * What the operator types into the target field.
 *
 * `label` is free text that names the thing being watched rather than
 * addressing it — the job that reports in, what a group covers, what an
 * operator is tracking by hand. It is not a weaker hostname: nothing
 * ever dials it, so validating it as an address would refuse perfectly
 * good answers ("Nightly backup") for no gain.
 */
export type TargetKind = "url" | "hostname" | "domain" | "label";

/** Optional form sections a type opts into. */
export type FormSection =
  | "method"
  | "expectedStatusCode"
  | "keyword"
  | "tlsWarning"
  | "port"
  | "dnsRecord"
  | "expiryWarning"
  | "heartbeatGrace"
  | "manualStatus";

/**
 * How a monitor of this type comes to have a state.
 *
 * The distinction is not cosmetic — it decides whether the scheduler
 * may enqueue the monitor at all, and what "evaluating" it means:
 *
 * - `active` — Vigil dials the target and measures the answer. The
 *   scheduler owns the cadence.
 * - `passive` — the target reports in and Vigil measures the *silence*.
 *   Nothing is dialled; the monitor is evaluated against a deadline.
 * - `aggregate` — the state is derived from other monitors' states. It
 *   is never scheduled: there is nothing to measure and no target to
 *   dial, and enqueuing one would spend a worker slot to learn nothing.
 * - `manual` — an operator states the status and it stands until they
 *   state another one.
 */
export type CheckTypeKind = "active" | "passive" | "aggregate" | "manual";

/** The kinds the scheduler may enqueue. See {@link CheckTypeKind}. */
export const SCHEDULED_KINDS: readonly CheckTypeKind[] = ["active", "passive"];

export function isScheduledKind(kind: CheckTypeKind): boolean {
  return SCHEDULED_KINDS.includes(kind);
}

/**
 * Everything about a type that is safe on both sides of the wire:
 * no zod, no `node:` imports. The monitor form imports this and only
 * this, which is what keeps the probe implementations (and the
 * validation schemas) out of the browser bundle.
 */
export interface CheckTypeDescriptor<
  Kind extends CheckTypeKind = CheckTypeKind,
> {
  id: string;
  /**
   * Which of the four evaluation shapes this type has. Carried on the
   * descriptor rather than only on the spec because the browser needs
   * it too: a form that offers a timeout to a group, or a "checked
   * every" caption to a manual monitor, is describing something that
   * will never happen.
   */
  kind: Kind;
  label: string;
  /** One line, shown under the type selector. */
  description: string;
  target: {
    kind: TargetKind;
    label: string;
    placeholder: string;
    help: string;
  };
  /** null when the type takes no port. */
  port: { required: boolean; default: number | null } | null;
  facts: readonly FactDescriptor[];
  form: readonly FormSection[];
  /**
   * A host capability the probe needs (e.g. ICMP sockets). When it is
   * missing the monitor reports `misconfigured`, never `down` — an
   * operator error must never be indistinguishable from an outage.
   */
  requiresCapability?: string;
  /** Whether the recovery loop can re-probe this target to verify a fix. */
  supportsRecovery: boolean;
  /**
   * RBAC fragments this type contributes. Merged into the permission
   * statement by the registry, so gating a future commercial-only type
   * is a property of the type rather than an edit to a central literal.
   */
  permissions?: Readonly<Record<string, readonly string[]>>;
}

export interface ProbeContext<Config> {
  /** Target as the operator entered it. */
  target: string;
  port: number | null;
  config: Config;
  timeoutMs: number;
  allowPrivateTargets: boolean;
  fetchImpl: typeof fetch;
  /**
   * How a hostname becomes addresses, for the egress guard.
   *
   * Injectable for the same reason `fetchImpl` is. The guard resolves
   * before every outbound request — that is the whole point of it — so
   * without this, a probe test that injects a transport still performs a
   * real DNS lookup, and a suite of a thousand such tests becomes a
   * suite that fails when a resolver is slow. A test that is not
   * exercising the guard should not be able to fail because of the
   * network.
   *
   * Unset in production: the system resolver is the correct one.
   *
   * Typed structurally rather than importing `EgressLookup`, because
   * this file must stay free of `node:` imports — the monitor form
   * imports it, and pulling the egress module in would put a DNS client
   * in the browser bundle.
   */
  lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

export interface ProbeResult {
  facts: FactBag;
  /** Wall-clock duration, when the type measures one. */
  responseTimeMs: number | null;
  /**
   * Transport-level failure — the probe could not measure at all.
   * Distinct from an assertion failure, which the runner derives.
   */
  error: string | null;
  /**
   * The probe cannot run in this environment (missing capability,
   * missing binary, denied permission). Surfaces as `misconfigured`.
   */
  unavailable?: string | null;
  statusCode?: number | null;
}

export type AssertionSeverity = "down" | "degraded";

/**
 * A type's declared judgment over one fact.
 *
 * This is deliberately a function and not a rules DSL. A DSL here would
 * be a policy language with one consumer, and the architecture says not
 * to build one. The declared `fact` and `severity` are what make it
 * inspectable: the conformance suite proves the fact exists, and the UI
 * can explain why a monitor is down without running anything.
 */
export interface Assertion<Config = unknown> {
  id: string;
  /** The fact this assertion reads. Must appear in `descriptor.facts`. */
  fact: string;
  severity: AssertionSeverity;
  /** False when the operator has not enabled this assertion. */
  applies?(config: Config): boolean;
  /** `null` when the assertion holds; otherwise the failure message. */
  evaluate(
    value: FactValue | FactValue[] | undefined,
    config: Config,
  ): string | null;
}

/**
 * The monitor columns a type may read when assembling its config.
 *
 * `http` and `tcp` predate the `config` jsonb blob and keep reading the
 * flat columns they have always used; every type added since stores its
 * own settings in the blob. The dual storage is deliberate debt —
 * collapsing it is a breaking change and belongs to 2.0, not to an
 * additive minor.
 */
export interface MonitorRowView {
  checkType: string;
  url: string;
  port: number | null;
  method: "GET" | "HEAD";
  /**
   * The cadence the operator asked for. Readable by a type because for
   * a passive one it is not a cadence at all — it is the deadline a
   * heartbeat has to meet, and the assertion that judges lateness has
   * to be able to say what "late" was measured against.
   */
  intervalSeconds: number;
  timeoutMs: number;
  degradedThresholdMs: number;
  expectedStatusCode: number | null;
  bodyKeyword: string | null;
  keywordAbsent: boolean;
  tlsCheck: boolean;
  tlsWarnDays: number;
  config: unknown;
}

/** Columns a type writes back when a monitor is created or updated. */
export interface MonitorColumnWrite {
  port?: number | null;
  method?: "GET" | "HEAD";
  expectedStatusCode?: number | null;
  bodyKeyword?: string | null;
  keywordAbsent?: boolean;
  tlsCheck?: boolean;
  tlsWarnDays?: number;
  config?: unknown;
}

/**
 * Everything about a type except the function it is evaluated by.
 * Isomorphic: zod only, no `node:` imports, so the server action layer
 * can validate without pulling a transport into the request path.
 *
 * `Kind` defaults to `"active"`, and that default is load-bearing: it
 * makes every spec written before kinds existed keep meaning exactly
 * what it always meant — a type with a probe — instead of silently
 * widening to "some kind, we'll find out at runtime". A passive,
 * aggregate or manual type says so through one of the aliases below,
 * and the compiler then demands the one function that kind is evaluated
 * by. Use {@link AnyCheckTypeSpec} where the kind genuinely does not
 * matter (config merging, persistence, target validation).
 */
export interface CheckTypeSpec<
  Config = unknown,
  Kind extends CheckTypeKind = "active",
> {
  descriptor: CheckTypeDescriptor<Kind>;
  /** Validates the runtime config the probe and assertions receive. */
  configSchema: z.ZodType<Config>;
  /**
   * Validates and normalises what the operator submits for the `config`
   * jsonb column. Returns `null` for the types that predate the blob
   * and keep using the flat columns.
   */
  storedSchema: z.ZodType<unknown>;
  /**
   * Keys in the stored config that hold a credential.
   *
   * Stated per type rather than inferred from the field name: a field
   * called `token` might be a public identifier and one called `key`
   * might be a JSON path, and guessing wrong in the permissive
   * direction leaks a secret into a browser. Optional, defaulting to
   * none, so a type without credentials says nothing.
   *
   * `src/modules/monitors/types/config.ts` uses this for both halves of
   * the contract: these fields are masked on the way out, and a masked
   * value on the way back in means "keep the stored one".
   */
  secretFields?: readonly string[];
  /** Validates the target string for this type. */
  targetSchema: z.ZodType<string>;
  assertions: readonly Assertion<Config>[];
  /** Assembles the runtime config from a stored monitor row. */
  fromRow(row: MonitorRowView): Config;
  /**
   * Human description of the target, safe to put in an email, a webhook
   * payload or a public status page. Types whose target could ever
   * embed a credential must redact here — `monitor.url` is already
   * embedded in incident emails and webhook bodies.
   */
  describeTarget(target: string, port: number | null, config: Config): string;
}

/** A spec of any kind — for the code that does not care which. */
export type AnyCheckTypeSpec<Config = unknown> = CheckTypeSpec<
  Config,
  CheckTypeKind
>;

/** What a heartbeat carried when it arrived. */
export interface HeartbeatReport {
  /** What the caller said about itself. A job that ran and failed says so. */
  status: "up" | "down";
  message: string | null;
  /** How long the caller says its own work took, when it says. */
  responseTimeMs: number | null;
}

/**
 * What a passive type is told when its deadline comes up.
 *
 * Note the absence of a transport, a timeout and a fetch: a passive
 * evaluation performs no I/O at all, which is why {@link
 * PassiveCheckType.observe} is synchronous. Everything it needs has
 * already happened.
 */
export interface HeartbeatContext<Config> {
  config: Config;
  /** When the last heartbeat arrived; null when none ever has. */
  lastHeartbeatAt: Date | null;
  /** What that heartbeat said. Null when none has arrived. */
  reported: HeartbeatReport | null;
  /**
   * Where the clock starts before the first heartbeat — monitor
   * creation. Without it a monitor created ten seconds ago has been
   * silent since the epoch, and every push monitor is born down.
   */
  since: Date;
  now: Date;
}

/** One member of a group, as far as the group is concerned. */
export interface ChildState {
  id: string;
  name: string;
  status: "up" | "down" | "degraded" | "unknown";
  /** A paused member is evidence of nothing and is counted as nothing. */
  paused: boolean;
  /**
   * How often this member reports. A group cannot learn anything faster
   * than its slowest member does, so the group reports the slowest one
   * as a fact and its own cadence is set from it.
   */
  intervalSeconds: number;
}

export interface AggregateContext<Config> {
  config: Config;
  children: readonly ChildState[];
}

/**
 * A manual type reads nothing but its own config — the operator's
 * statement is stored there. It still takes a context object rather
 * than the bare config so that all four evaluation functions have the
 * same shape, which is what lets the runner dispatch on kind without a
 * per-kind argument list.
 */
export interface ManualContext<Config> {
  config: Config;
}

/**
 * A type Vigil dials. The fourteen types that predate kinds are all of
 * these.
 */
export type ActiveCheckType<Config = unknown> = CheckTypeSpec<
  Config,
  "active"
> & {
  probe(context: ProbeContext<Config>): Promise<ProbeResult>;
};

/** A type whose target reports in; Vigil measures the silence. */
export type PassiveCheckType<Config = unknown> = CheckTypeSpec<
  Config,
  "passive"
> & {
  observe(context: HeartbeatContext<Config>): ProbeResult;
};

/** A type whose state is derived from other monitors' states. */
export type AggregateCheckType<Config = unknown> = CheckTypeSpec<
  Config,
  "aggregate"
> & {
  derive(context: AggregateContext<Config>): ProbeResult;
};

/** A type whose state is whatever an operator last said it was. */
export type ManualCheckType<Config = unknown> = CheckTypeSpec<
  Config,
  "manual"
> & {
  declare(context: ManualContext<Config>): ProbeResult;
};

/**
 * A registered type: its spec joined to the one function its kind is
 * evaluated by.
 *
 * Every variant emits a {@link ProbeResult}, so `judge` is still the
 * only thing that decides anything. A heartbeat that is four hours
 * overdue is a *fact*; that four hours overdue means down is the
 * assertion `push` declares, and it is re-judgeable against a later
 * spec version exactly like an HTTP status code.
 */
export type CheckTypeDefinition<Config = unknown> =
  | ActiveCheckType<Config>
  | PassiveCheckType<Config>
  | AggregateCheckType<Config>
  | ManualCheckType<Config>;

/**
 * Narrowing helpers, and the reason they are functions rather than a
 * `switch` on `definition.descriptor.kind`.
 *
 * TypeScript narrows a union by a discriminant that is a *direct*
 * property of the union's members. `kind` is one level down, on the
 * descriptor, so `if (type.descriptor.kind === "active")` type-checks
 * and narrows nothing — the probe is still missing from the type
 * afterwards. Lifting a second copy of `kind` onto the spec would make
 * narrowing work and give a type two places to disagree with itself
 * about what it is; a predicate says the same thing once and is
 * checked at the one place it can be wrong.
 */
export function isActiveType<Config>(
  type: CheckTypeSpec<Config, CheckTypeKind>,
): type is ActiveCheckType<Config> {
  return type.descriptor.kind === "active";
}

export function isPassiveType<Config>(
  type: CheckTypeSpec<Config, CheckTypeKind>,
): type is PassiveCheckType<Config> {
  return type.descriptor.kind === "passive";
}

export function isAggregateType<Config>(
  type: CheckTypeSpec<Config, CheckTypeKind>,
): type is AggregateCheckType<Config> {
  return type.descriptor.kind === "aggregate";
}

export function isManualType<Config>(
  type: CheckTypeSpec<Config, CheckTypeKind>,
): type is ManualCheckType<Config> {
  return type.descriptor.kind === "manual";
}
