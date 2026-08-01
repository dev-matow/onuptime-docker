import type { AnyCheckTypeSpec } from "./contract";

/**
 * Reading, merging and redacting a monitor's type-specific config.
 *
 * Before 1.13.0 there was no merge. `monitorColumnsFor` did
 * `spec.storedSchema.parse(input.config ?? {})`, and the monitor form's
 * `buildConfig()` returned `null` for twelve of the fourteen types — so
 * saving a Redis monitor after changing nothing but its name parsed
 * `{}`, produced a config of all defaults, and wrote it over the row.
 * The password was gone, the monitor started failing authentication, and
 * nothing anywhere said why.
 *
 * The rule now is read–merge–validate–write, and the three cases an
 * operator can express are distinct on the wire:
 *
 * | what the client sends      | what happens          |
 * |----------------------------|-----------------------|
 * | field absent from the patch| stored value kept     |
 * | field set to `null`        | value cleared         |
 * | field set to a value       | value replaced        |
 *
 * Secrets need a fourth case, because the client is never given the
 * stored value to send back. A form that has never seen the password
 * cannot echo it, so it echoes `SECRET_MASK` instead, which means "the
 * one you already have". Clearing a secret is `null`, exactly like any
 * other field — the distinction the old code could not make.
 */

/**
 * What the client receives in place of a stored secret, and sends back
 * when it means "unchanged".
 *
 * A sentinel rather than an empty string, because empty string is a
 * legitimate thing for an operator to type and has to keep meaning
 * "clear this". The value is deliberately not a plausible credential:
 * if it ever reaches a transport, the resulting auth failure names
 * itself in the log.
 */
export const SECRET_MASK = "__vigil_unchanged_secret__";

/**
 * Config fields whose values must never travel back to a browser.
 *
 * Declared per spec rather than inferred from a name pattern: a field
 * called `token` might be a public identifier, and one called `key`
 * might be a JSON path. Getting this wrong in the inferring direction
 * leaks a credential, so it is stated.
 */
export function secretFieldsOf(spec: AnyCheckTypeSpec): readonly string[] {
  return spec.secretFields ?? [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The stored config with every secret replaced by `SECRET_MASK`.
 *
 * Everything that hands a monitor to a client component goes through
 * this. The old path serialised the raw blob into a React server
 * component's props, which put the Redis password in the page source of
 * anyone who could open the edit dialog — including a viewer-role member
 * who cannot edit the monitor at all.
 *
 * A null secret stays null. Masking absence would tell the operator a
 * credential exists when none does, and they would then be unable to
 * clear a field that was never set.
 */
export function redactConfig(spec: AnyCheckTypeSpec, config: unknown): unknown {
  const secrets = secretFieldsOf(spec);
  if (secrets.length === 0) return config;
  const source = asRecord(config);
  const redacted: Record<string, unknown> = { ...source };
  for (const field of secrets) {
    if (redacted[field] !== null && redacted[field] !== undefined) {
      redacted[field] = SECRET_MASK;
    }
  }
  return redacted;
}

/**
 * Merges an operator's patch over the stored config and validates the
 * result.
 *
 * @param stored the config currently on the row, or null/undefined on create
 * @param patch  what the operator submitted; `undefined` means "did not say"
 * @param storedCheckType the type the stored config belongs to
 */
export function mergeConfig(
  spec: AnyCheckTypeSpec,
  stored: unknown,
  patch: unknown,
  storedCheckType?: string,
): unknown {
  // A config belongs to the type that wrote it. When the operator
  // switches a monitor from `redis` to `dns`, the stored blob describes
  // a Redis server and merging it under the DNS schema would either
  // fail validation or — worse, if the shapes happen to overlap — carry
  // a stale setting into a type that never asked for it. This is the
  // same rule `monitorColumnsFor` applies to the flat columns.
  const carriesOver =
    storedCheckType === undefined || storedCheckType === spec.descriptor.id;
  const base = carriesOver ? asRecord(stored) : {};

  if (patch === undefined) {
    // Nothing said about config at all: keep what is there. Re-parsing
    // rather than passing it through unchanged means a row written by an
    // older schema version is normalised on its next save.
    return spec.storedSchema.parse(base);
  }

  const incoming = asRecord(patch);
  const merged: Record<string, unknown> = { ...base };
  const secrets = new Set(secretFieldsOf(spec));

  for (const [key, value] of Object.entries(incoming)) {
    if (secrets.has(key) && value === SECRET_MASK) {
      // "The one you already have." Never write the sentinel itself —
      // that is the bug this constant exists to make impossible.
      continue;
    }
    merged[key] = value;
  }

  return spec.storedSchema.parse(merged);
}
