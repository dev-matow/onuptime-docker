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
 *
 * A secret field may hold a *map* rather than a scalar, and the same
 * four cases then apply per key. That arrived with scripted synthetics,
 * whose credentials are named by the operator rather than by the type: a
 * journey has a `sessionToken` and an `apiKey` because its author said
 * so, and a fixed `secretFields: ["token"]` cannot describe that. The
 * rules are the scalar ones read one level down — a key echoing the
 * sentinel keeps its stored value, a key present with a value replaces
 * it, and a key the client omits is **removed**, because for a map the
 * operator's list is the whole truth about which credentials exist and
 * there is no other way to delete one.
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
    const value = redacted[field];
    if (value === null || value === undefined) continue;
    if (isSecretMap(value)) {
      // The names survive and every value is masked. The operator has to
      // be able to see *which* credentials a journey holds in order to
      // reference them by name; what they must never receive is any of
      // them.
      //
      // An empty value is left empty rather than masked, and that is not
      // a leak: an empty string is not a credential. It is what makes an
      // imported journey readable — the importer writes a blank for
      // every secret that has to be re-entered, and a form that showed
      // those as "already set" would send the operator looking for a
      // credential that is not there.
      const masked: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        masked[key] =
          typeof entry === "string" && entry.length === 0 ? "" : SECRET_MASK;
      }
      redacted[field] = masked;
      continue;
    }
    redacted[field] = SECRET_MASK;
  }
  return redacted;
}

/**
 * Whether a stored secret field holds a map of named credentials rather
 * than one value.
 *
 * Decided from the *data* and not from a second declaration on the spec,
 * because the two would then be able to disagree — and the direction
 * they would disagree in is a map serialised into a browser under a
 * scalar rule, which is the leak this file exists to prevent. A plain
 * object here can only have come from a `z.record(...)` in a stored
 * schema, and a scalar secret can never be one.
 */
function isSecretMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The scalar rule, applied per key.
 *
 * The one thing that differs from a scalar field is deletion. A scalar
 * secret is cleared by sending `null`, and a *key* cannot be cleared
 * that way because the client would have to send `{apiKey: null}` and
 * the schema would then have to accept a nullable value it never wants
 * to store. So for a map the submission is authoritative about
 * membership: a key the client did not send is gone. That is safe in the
 * direction that matters — the failure mode is a credential deleted,
 * which the journey then fails loudly on, rather than a credential
 * silently retained after an operator removed it from the list.
 */
function mergeSecretMap(
  stored: unknown,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const existing = asRecord(stored);
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === SECRET_MASK) {
      // Keep the stored one. A sentinel for a key that has no stored
      // value is a client claiming an unchanged credential that never
      // existed; dropping the key is the only honest answer, and the
      // journey's own validation is what reports the missing name.
      if (Object.hasOwn(existing, key)) merged[key] = existing[key];
      continue;
    }
    merged[key] = value;
  }
  return merged;
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
    if (secrets.has(key) && isSecretMap(value)) {
      merged[key] = mergeSecretMap(base[key], value);
      continue;
    }
    merged[key] = value;
  }

  return spec.storedSchema.parse(merged);
}
