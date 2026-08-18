import type { ConfigField } from "@/modules/monitors/types/contract";

/**
 * Turning a type's declared {@link ConfigField}s into form state and back.
 *
 * Kept out of the component so it can be tested without React, because
 * this is where the bugs live: what an emptied box means, whether a
 * hidden field is still submitted, and how an untouched secret survives
 * a save. All three were wrong in the version this replaces — there was
 * no version, and twenty-four types stored settings the dialog could not
 * reach at all.
 *
 * Nothing here validates. `storedSchema` on the server is the only
 * authority; this file's job is to produce a faithful patch and let the
 * server refuse it if it is wrong.
 */

/** One entry per declared field. Booleans stay boolean; everything else
 * is the string the input holds. */
export type ConfigFieldState = Record<string, string | boolean>;

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

/**
 * Form state for a monitor's stored config.
 *
 * `stored` is what the server sent, which for a secret is already
 * `SECRET_MASK` — the page redacts before the object crosses into the
 * client component. That sentinel is loaded into the input as-is and
 * travels back untouched unless the operator types over it, which is
 * exactly what makes "save without retyping the password" work.
 */
export function initialConfigState(
  fields: readonly ConfigField[],
  stored: Record<string, unknown> | null,
): ConfigFieldState {
  const state: ConfigFieldState = {};
  for (const field of fields) {
    const stored_ = stored?.[field.name];
    // A monitor being created has nothing stored, and for a control
    // where blank is not a legal answer the field says what it starts
    // on. See `ConfigField.defaultValue`: without it a select renders
    // empty and anything conditional on it vanishes.
    const value =
      stored_ === undefined || stored_ === null
        ? (field.defaultValue ?? stored_)
        : stored_;
    state[field.name] =
      field.control.kind === "boolean" ? value === true : displayValue(value);
  }
  return state;
}

/**
 * Whether a field's control is currently on screen.
 *
 * Presentation only — see {@link buildConfig}, which submits hidden
 * fields anyway.
 */
export function isFieldVisible(
  field: ConfigField,
  state: ConfigFieldState,
): boolean {
  if (!field.showWhen) return true;
  const current = state[field.showWhen.field];
  return typeof current === "string" && field.showWhen.equals.includes(current);
}

/**
 * The config patch to submit.
 *
 * Every declared field is present or deliberately absent; nothing is
 * dropped for being off screen. A hidden field still holds its stored
 * value, and omitting it would not leave that value alone — it would
 * leave it alone only until the next save from a different branch of
 * `showWhen`, at which point the operator would have silently kept a
 * setting they can no longer see. Submitting it keeps the row and the
 * dialog describing the same monitor.
 *
 * The blob is submitted whole rather than as a partial patch because
 * `storedSchema` carries cross-field rules — RabbitMQ's "a password
 * needs a username", Elasticsearch's "an API key or a username, not
 * both", SNMP's four — and a fragment would trip refinements about
 * fields it never mentioned.
 */
export function buildConfig(
  fields: readonly ConfigField[],
  state: ConfigFieldState,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = state[field.name];

    if (field.control.kind === "boolean") {
      config[field.name] = raw === true;
      continue;
    }

    const text = typeof raw === "string" ? raw : "";
    // A secret is not trimmed. Leading or trailing space is a legal part
    // of a password, and silently eating it produces an authentication
    // failure with no visible cause.
    const value = field.control.kind === "secret" ? text : text.trim();

    if (value === "") {
      // See `ConfigField.emptyValue`. The default is to leave the key
      // out, which `mergeConfig` reads as "did not say".
      if (field.emptyValue === "null") config[field.name] = null;
      else if (field.emptyValue === "empty") config[field.name] = "";
      continue;
    }

    if (field.control.kind === "number") {
      const parsed = Number(value);
      // Left to the server when it is not a number. Coercing it here to
      // a fallback would save a different monitor than the one on screen.
      config[field.name] = Number.isFinite(parsed) ? parsed : value;
      continue;
    }

    config[field.name] = value;
  }
  return config;
}
