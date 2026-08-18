/**
 * Reading a vendor's JSON without trusting a byte of it.
 *
 * Every adapter walks a response shaped by somebody else's release
 * process. A field that was a number last quarter is a string this
 * quarter, a list arrives as null when it is empty, and one provider
 * returns its custom headers as a JSON document inside a JSON string.
 * None of that may throw: an import that dies on the eleventh check of
 * four hundred because one row had `port: ""` is worse than useless,
 * because the operator cannot tell whether the problem is their data or
 * this importer.
 *
 * So these readers never throw and never coerce something into a
 * plausible lie. `num("")` is `undefined`, not `0`. `bool("false")` is
 * `false`, not `true`. Absent stays absent all the way into the model,
 * where "the source did not say" is a distinct answer from "the source
 * said no".
 */

export type Json = unknown;

export function obj(value: Json): Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}

export function arr(value: Json): Json[] {
  return Array.isArray(value) ? value : [];
}

/** A non-empty trimmed string, or undefined. */
export function str(value: Json): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

/** Every string in a list, skipping anything that is not one. */
export function strs(value: Json): string[] {
  return arr(value)
    .map((entry) => str(entry))
    .filter((entry): entry is string => entry !== undefined);
}

/** A finite number, from a number or a numeric string. */
export function num(value: Json): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * A boolean, from the four shapes the supported providers use: a real
 * boolean, `"true"`, `1`, and `"1"`. Anything else is undefined rather
 * than false, because "the field was missing" and "the operator turned
 * it off" lead to different report lines.
 */
export function bool(value: Json): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number")
    return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") return true;
    if (lower === "false" || lower === "0" || lower === "no") return false;
  }
  return undefined;
}

/** The keys of an object-shaped field, for header names. */
export function keys(value: Json): string[] {
  return Object.keys(obj(value));
}

/**
 * A JSON document that arrived as a string, parsed, or an empty object.
 *
 * StatusCake stores custom headers this way. A malformed one is an empty
 * object rather than an exception: the adapter reports that headers
 * exist and could not be read, which is true and useful, where a thrown
 * parse error would lose the other three hundred checks.
 */
export function nested(value: Json): Record<string, Json> {
  if (typeof value !== "string") return obj(value);
  try {
    return obj(JSON.parse(value));
  } catch {
    return {};
  }
}
