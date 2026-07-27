import type {
  CheckTypeSpec,
  FormSection,
  MonitorColumnWrite,
} from "./contract";

/**
 * Turns validated monitor input into the columns to store.
 *
 * The normalisation rule is one sentence: a setting is persisted only
 * if the type declares a form section for it, and reset to its neutral
 * value otherwise. That means a monitor switched from `http` to `dns`
 * cannot keep a stale `expectedStatusCode` lying around where a later
 * switch back would silently resurrect it.
 *
 * Driving it off `descriptor.form` — the same list the monitor form
 * renders from — is deliberate: the UI and the writer cannot disagree
 * about which settings a type has, because they read the same array.
 */

export interface MonitorSettings {
  port?: number | null;
  method?: "GET" | "HEAD";
  expectedStatusCode?: number | null;
  bodyKeyword?: string | null;
  keywordAbsent?: boolean;
  tlsCheck?: boolean;
  tlsWarnDays?: number;
  config?: unknown;
}

function uses(spec: CheckTypeSpec<unknown>, section: FormSection): boolean {
  return spec.descriptor.form.includes(section);
}

export function monitorColumnsFor(
  spec: CheckTypeSpec<unknown>,
  input: MonitorSettings,
): MonitorColumnWrite {
  const portSpec = spec.descriptor.port;

  return {
    port: portSpec === null ? null : (input.port ?? portSpec.default ?? null),
    method: uses(spec, "method") ? (input.method ?? "GET") : "GET",
    expectedStatusCode: uses(spec, "expectedStatusCode")
      ? (input.expectedStatusCode ?? null)
      : null,
    bodyKeyword: uses(spec, "keyword") ? (input.bodyKeyword ?? null) : null,
    keywordAbsent: uses(spec, "keyword")
      ? (input.keywordAbsent ?? false)
      : false,
    tlsCheck: uses(spec, "tlsWarning") ? (input.tlsCheck ?? false) : false,
    tlsWarnDays: uses(spec, "tlsWarning") ? (input.tlsWarnDays ?? 14) : 14,
    config: spec.storedSchema.parse(input.config ?? {}),
  };
}
