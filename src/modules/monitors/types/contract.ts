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

/** What the operator types into the target field. */
export type TargetKind = "url" | "hostname" | "domain";

/** Optional form sections a type opts into. */
export type FormSection =
  | "method"
  | "expectedStatusCode"
  | "keyword"
  | "tlsWarning"
  | "port"
  | "dnsRecord"
  | "expiryWarning";

/**
 * Everything about a type that is safe on both sides of the wire:
 * no zod, no `node:` imports. The monitor form imports this and only
 * this, which is what keeps the probe implementations (and the
 * validation schemas) out of the browser bundle.
 */
export interface CheckTypeDescriptor {
  id: string;
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
 * Everything about a type except its probe. Isomorphic: zod only, no
 * `node:` imports, so the server action layer can validate without
 * pulling a transport into the request path.
 */
export interface CheckTypeSpec<Config = unknown> {
  descriptor: CheckTypeDescriptor;
  /** Validates the runtime config the probe and assertions receive. */
  configSchema: z.ZodType<Config>;
  /**
   * Validates and normalises what the operator submits for the `config`
   * jsonb column. Returns `null` for the types that predate the blob
   * and keep using the flat columns.
   */
  storedSchema: z.ZodType<unknown>;
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

export interface CheckTypeDefinition<
  Config = unknown,
> extends CheckTypeSpec<Config> {
  probe(context: ProbeContext<Config>): Promise<ProbeResult>;
}
