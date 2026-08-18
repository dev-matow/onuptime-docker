import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  CHECK_TYPE_DESCRIPTORS,
  describeCheckType,
  findDescriptor,
  UNSCHEDULED_CHECK_TYPE_IDS,
} from "@/modules/monitors/types/catalog";
import {
  maskTargetSecret,
  redactTargetCredentials,
  restoreTargetSecret,
} from "@/modules/monitors/spec";
import { SECRET_MASK } from "@/modules/monitors/types/config";
import { connectionErrorMessage } from "@/modules/monitors/types/probes/guard";
import { isScheduledKind } from "@/modules/monitors/types/contract";
import { CHECK_TYPES } from "@/modules/monitors/types/registry";
import { CHECK_TYPE_SPECS } from "@/modules/monitors/types/specs";

/**
 * A stored config schema unwrapped to its object shape.
 *
 * `.superRefine` and friends wrap the object, and the wrapper has no
 * shape of its own — SNMP's four cross-field rules are the reason this
 * has to walk rather than read `.shape` directly. Types that store no
 * blob at all (`flatColumnsOnly`, `groupStoredSchema`) are a transform
 * over `z.unknown()` with no shape anywhere, and correctly yield null.
 */
function storedConfigShape(schema: unknown): Record<string, z.ZodType> | null {
  let node = schema as Record<string, unknown> | null;
  for (let depth = 0; depth < 30 && node; depth++) {
    const shape = (node as { shape?: unknown }).shape;
    if (shape && typeof shape === "object") {
      return shape as Record<string, z.ZodType>;
    }
    const def =
      (node._zod as { def?: Record<string, unknown> } | undefined)?.def ??
      (node._def as Record<string, unknown> | undefined) ??
      (node.def as Record<string, unknown> | undefined);
    if (!def) return null;
    node = (def.innerType ?? def.in ?? def.schema ?? null) as Record<
      string,
      unknown
    > | null;
  }
  return null;
}

function storedConfigKeys(schema: unknown): Set<string> {
  return new Set(Object.keys(storedConfigShape(schema) ?? {}));
}

/** The default a key carries, or undefined when it has none. */
function schemaDefault(schema: unknown): unknown {
  let node = schema as Record<string, unknown> | null;
  for (let depth = 0; depth < 30 && node; depth++) {
    const def =
      (node._zod as { def?: Record<string, unknown> } | undefined)?.def ??
      (node._def as Record<string, unknown> | undefined) ??
      (node.def as Record<string, unknown> | undefined);
    if (!def) return undefined;
    if (def.type === "default" || def.typeName === "ZodDefault") {
      const value = def.defaultValue;
      return typeof value === "function" ? (value as () => unknown)() : value;
    }
    node = (def.innerType ?? def.in ?? def.schema ?? null) as Record<
      string,
      unknown
    > | null;
  }
  return undefined;
}

/**
 * What an emptied box must submit for this key, from the schema alone.
 *
 * Three cases, and the middle one is the one worth stating: a key is
 * given `"empty"` only when the empty string is its own default, so
 * blanking the box and never touching it agree. A key whose default is
 * something else — `jsonPath` defaulting to `status` — takes `"omit"`,
 * because there a blank box means "the default", and submitting `""`
 * would create a monitor asserting that the health endpoint returns an
 * empty string.
 */
function derivedEmptyValue(key: z.ZodType): "null" | "empty" | "omit" {
  if (key.safeParse(null).success) return "null";
  return schemaDefault(key) === "" ? "empty" : "omit";
}

/**
 * The config keys each legacy {@link FormSection} writes.
 *
 * Four sections predate `configFields` and build the blob themselves in
 * `buildConfig()`. Stated here so the coverage rule can credit them,
 * and stated once so that a section which stops writing a key cannot
 * quietly leave that key unreachable.
 */
const FORM_SECTION_CONFIG_KEYS: Partial<Record<string, readonly string[]>> = {
  dnsRecord: ["recordType", "expectedValue"],
  expiryWarning: ["warnDays"],
  heartbeatGrace: ["graceSeconds"],
  manualStatus: ["status", "note"],
};

/**
 * The conformance suite.
 *
 * Every rule a check type must obey is checked here, for every type,
 * automatically. That is the point of a registry: the seventh type
 * inherits these guarantees without anyone remembering to write them,
 * and a type that breaks one fails at build time rather than at 3am on
 * somebody's production monitor.
 */
describe("check type registry conformance", () => {
  const entries = Object.entries(CHECK_TYPES);

  it("registers every catalogued type, and nothing else", () => {
    expect(Object.keys(CHECK_TYPES).sort()).toEqual(
      CHECK_TYPE_DESCRIPTORS.map((d) => d.id).sort(),
    );
    expect(Object.keys(CHECK_TYPE_SPECS).sort()).toEqual(
      Object.keys(CHECK_TYPES).sort(),
    );
  });

  it.each(entries)("%s: its key matches its descriptor id", (id, type) => {
    expect(type.descriptor.id).toBe(id);
  });

  it.each(entries)(
    "%s: carries exactly the one evaluation function its kind names",
    (_id, type) => {
      // The rule the kinds exist to enforce, checked from both sides.
      // A group with a probe is a transport somebody wrote believing it
      // would run; a push type without `observe` is a monitor that can
      // never say anything. Both used to be expressible, because the
      // contract had one mandatory `probe` and three types that could
      // not honestly implement it.
      const functions = {
        active: "probe",
        passive: "observe",
        aggregate: "derive",
        manual: "declare",
      } as const;
      const expected = functions[type.descriptor.kind];
      const carried = Object.values(functions).filter(
        (name) =>
          typeof (type as unknown as Record<string, unknown>)[name] ===
          "function",
      );
      expect(carried).toEqual([expected]);
      expect(Array.isArray(type.assertions)).toBe(true);
    },
  );

  it.each(entries)(
    "%s: is only offered to the scheduler when its kind is scheduled",
    (id, type) => {
      // `findDueMonitors` filters on this list. A type that fell out of
      // it by accident would be enqueued forever and evaluated into an
      // observation nobody asked for; one that fell into it by accident
      // would silently stop being checked.
      expect(UNSCHEDULED_CHECK_TYPE_IDS.includes(id)).toBe(
        !isScheduledKind(type.descriptor.kind),
      );
    },
  );

  it.each(entries)(
    "%s: only claims to support recovery if something can re-probe it",
    (_id, type) => {
      // Recovery verifies a fix by probing again. A kind with no
      // transport has nothing to verify with, so claiming support would
      // schedule a verification that can only ever time out.
      if (type.descriptor.kind !== "active") {
        expect(type.descriptor.supportsRecovery).toBe(false);
      }
    },
  );

  it.each(entries)(
    "%s: every assertion reads a fact the type declares",
    (_id, type) => {
      // Without this, an assertion silently evaluates `undefined`
      // forever after a fact is renamed — a monitor that passes because
      // its check quietly stopped being made.
      const declared = new Set(type.descriptor.facts.map((f) => f.key));
      for (const assertion of type.assertions) {
        expect(declared).toContain(assertion.fact);
      }
    },
  );

  it.each(entries)("%s: assertion ids are unique", (_id, type) => {
    const ids = type.assertions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(entries)("%s: declared facts have unique keys", (_id, type) => {
    const keys = type.descriptor.facts.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * The rule that would have caught the gap this section exists for.
   *
   * `buildConfig()` used to write the config blob for four types and
   * return null for the rest, so twenty-four types stored settings no
   * control could reach. Nothing failed, because nothing compared the
   * dialog against the registry. A JSON-query monitor checked a path
   * nobody chose; a Redis monitor with no password box answered `PING`
   * unauthenticated, got an error rather than a pong, and read **up**.
   *
   * These four assertions are that comparison. They are per-type and
   * mechanical: the forty-first type inherits them without anyone
   * remembering to write them, which is the point of a registry.
   */
  it.each(entries)(
    "%s: every stored config field has a form control",
    (_id, type) => {
      const stored = storedConfigKeys(type.storedSchema);
      const declared = new Set(
        (type.descriptor.configFields ?? []).map((f) => f.name),
      );
      const omitted = new Set(
        Object.keys(type.descriptor.configFieldsOmitted ?? {}),
      );
      // The four sections that predate `configFields` write the blob
      // themselves; a key one of them owns is reachable too.
      const legacy = new Set(
        type.descriptor.form.flatMap(
          (section) => FORM_SECTION_CONFIG_KEYS[section] ?? [],
        ),
      );
      // A field an operator cannot set is a monitor an operator cannot
      // fix — and, for most of these types, a healthy server reported
      // as down.
      expect(
        [...stored].filter(
          (key) => !declared.has(key) && !omitted.has(key) && !legacy.has(key),
        ),
      ).toEqual([]);
    },
  );

  it.each(entries)(
    "%s: declares no control for a key it does not store",
    (_id, type) => {
      const stored = storedConfigKeys(type.storedSchema);
      expect(
        (type.descriptor.configFields ?? [])
          .map((f) => f.name)
          .filter((name) => !stored.has(name)),
      ).toEqual([]);
    },
  );

  it.each(entries)("%s: every secret renders as a secret", (_id, type) => {
    // Both directions. A credential in a text box is shoulder-readable
    // and offered to a password manager as a login; a public identifier
    // behind dots is a field the operator cannot check they typed right.
    const secrets = new Set(type.secretFields ?? []);
    for (const field of type.descriptor.configFields ?? []) {
      expect([field.name, field.control.kind === "secret"]).toEqual([
        field.name,
        secrets.has(field.name),
      ]);
    }
  });

  it.each(entries)(
    "%s: every control's empty value is one the schema takes",
    (_id, type) => {
      // `emptyValue` is derived from the schema, not typed by hand, and
      // this is where that is enforced. Getting it wrong fails a save
      // over a blank box, or — worse — writes an empty string where the
      // operator meant "use the default".
      const shape = storedConfigShape(type.storedSchema);
      for (const field of type.descriptor.configFields ?? []) {
        if (field.control.kind === "boolean") continue;
        const key = shape?.[field.name];
        if (!key) continue;
        expect([field.name, field.emptyValue ?? "omit"]).toEqual([
          field.name,
          derivedEmptyValue(key),
        ]);
      }
    },
  );

  it.each(entries)(
    "%s: a control that cannot render blank starts on the schema's default",
    (_id, type) => {
      // The bug this exists for shipped in the first version of the
      // config renderer and was caught by opening the dialog, not by a
      // test. SNMP's `version` defaults to `2c`; on create there was no
      // stored value, so the select rendered empty, and the community
      // field, which applies only to v1 and v2c, was conditional on it
      // and never appeared. A brand new SNMP monitor could not be given
      // the one credential it has - the exact failure the whole change
      // set out to remove.
      // The EFFECTIVE default, taken by parsing an empty config through
      // the whole schema. Reading `ZodDefault` alone is not enough:
      // several types supply their default with `.nullish().transform()`
      // instead, and RADIUS's `expectAccept` is one, so a rule that only
      // understood `.default()` would have called it undeclared.
      const parsed = type.storedSchema.safeParse({});
      const effective = parsed.success
        ? (parsed.data as Record<string, unknown>)
        : {};
      const shape = storedConfigShape(type.storedSchema);
      for (const field of type.descriptor.configFields ?? []) {
        const key = shape?.[field.name];
        if (!key) continue;
        const fallback = effective[field.name] ?? schemaDefault(key);
        // Blank is a legal answer for a select that offers an empty
        // option, and for text and number controls, which carry a
        // placeholder and an `emptyValue` instead.
        const mustRender =
          field.control.kind === "boolean" ||
          (field.control.kind === "select" &&
            !field.control.options.some((o) => o.value === "") &&
            fallback !== undefined &&
            fallback !== null);
        if (!mustRender) continue;
        expect([field.name, field.defaultValue]).toEqual([
          field.name,
          field.control.kind === "boolean"
            ? fallback === true
            : String(fallback),
        ]);
      }
    },
  );

  it.each(entries)(
    "%s: every select option is a value the schema accepts",
    (_id, type) => {
      const shape = storedConfigShape(type.storedSchema);
      for (const field of type.descriptor.configFields ?? []) {
        if (field.control.kind !== "select") continue;
        const key = shape?.[field.name];
        if (!key) continue;
        for (const option of field.control.options) {
          // "" is the renderer's "not set" and is submitted as null or
          // as an omission, never as the empty string itself.
          if (option.value === "") continue;
          expect([field.name, option.value, true]).toEqual([
            field.name,
            option.value,
            key.safeParse(option.value).success,
          ]);
        }
      }
    },
  );

  it.each(entries)(
    "%s: a required port with no default is asked for in the form",
    (_id, type) => {
      // Otherwise the type is uncreatable: validation demands a port the
      // form never renders.
      if (
        type.descriptor.port?.required &&
        type.descriptor.port.default === null
      ) {
        expect(type.descriptor.form).toContain("port");
      }
    },
  );

  it.each(entries)(
    "%s: describeTarget returns something, and never the raw config",
    (_id, type) => {
      const config = type.fromRow({
        checkType: type.descriptor.id,
        url: "example.com",
        port: type.descriptor.port?.default ?? null,
        method: "GET",
        intervalSeconds: 60,
        timeoutMs: 10_000,
        degradedThresholdMs: 3_000,
        expectedStatusCode: null,
        bodyKeyword: null,
        keywordAbsent: false,
        tlsCheck: false,
        tlsWarnDays: 14,
        config: null,
      });
      const described = type.describeTarget(
        "example.com",
        type.descriptor.port?.default ?? null,
        config,
      );
      expect(described.length).toBeGreaterThan(0);
      expect(described).toContain("example.com");
    },
  );

  it.each(entries)(
    "%s: fromRow tolerates a missing or junk config blob",
    (_id, type) => {
      // Rows predate the blob (every 1.9.x monitor has `config = null`),
      // and a downgrade can leave a shape this build does not know.
      // Neither may throw on the worker's hot path.
      for (const config of [null, undefined, {}, { nonsense: true }, 42]) {
        expect(() =>
          type.fromRow({
            checkType: type.descriptor.id,
            url: "example.com",
            port: null,
            method: "GET",
            intervalSeconds: 60,
            timeoutMs: 10_000,
            degradedThresholdMs: 3_000,
            expectedStatusCode: null,
            bodyKeyword: null,
            keywordAbsent: false,
            tlsCheck: false,
            tlsWarnDays: 14,
            config,
          }),
        ).not.toThrow();
      }
    },
  );

  it.each(entries)(
    "%s: storedSchema accepts an empty submission",
    (_id, type) => {
      expect(type.storedSchema.safeParse({}).success).toBe(true);
    },
  );
});

describe("describeCheckType", () => {
  it("returns the real descriptor for a known type", () => {
    expect(describeCheckType("dns").label).toBe("DNS record");
  });

  it("degrades gracefully for a type this build does not have", () => {
    // `check_type` is text so a monitor created by a build with an extra
    // type survives a downgrade as data. The UI must still render it.
    //
    // The id here has to be one nothing will ever register — it used to
    // be "redis", which stopped being hypothetical the day redis shipped
    // and turned this into a test of the real descriptor.
    const unknown = describeCheckType("not-a-real-check-type");
    expect(unknown.id).toBe("not-a-real-check-type");
    expect(unknown.form).toEqual([]);
    expect(findDescriptor("not-a-real-check-type")).toBeUndefined();
  });
});

describe("target redaction", () => {
  /**
   * A target could not carry a credential until `postgres` shipped, and
   * the first thing it did was put a password into every incident email
   * and webhook body. Both send paths go through a redactor now; this
   * pins the string-level one, which is the guard that still works when
   * a check type is missing from the build.
   */
  it.each([
    [
      "postgres://app:hunter2@db.example.com:5432/prod",
      "postgres://db.example.com:5432/prod",
    ],
    [
      "postgres://db.example.com:5432/prod",
      "postgres://db.example.com:5432/prod",
    ],
    ["https://example.com/health", "https://example.com/health"],
    // An @ in a path is not userinfo, and must survive untouched.
    ["https://example.com/a@b", "https://example.com/a@b"],
    ["db.example.com", "db.example.com"],
  ])("redacts %s", (input, expected) => {
    expect(redactTargetCredentials(input)).toBe(expected);
  });
});

/**
 * The edit dialog's half of the same rule.
 *
 * Redaction is right for a label and wrong for a form: an operator who
 * opens the dialog to change a port must not save the target back with
 * its user name gone. So the form is handed the target with only the
 * password replaced, and `updateMonitor` puts the stored one back when
 * the sentinel comes home untouched.
 */
describe("target secret masking", () => {
  it.each([
    [
      "postgres://app:hunter2@db.example.com:5432/prod",
      `postgres://app:${SECRET_MASK}@db.example.com:5432/prod`,
    ],
    // No password to mask. A bare user name is configuration, and hiding
    // it would remove something the operator needs in order to edit.
    [
      "postgres://app@db.example.com:5432/prod",
      "postgres://app@db.example.com:5432/prod",
    ],
    [
      "postgres://db.example.com:5432/prod",
      "postgres://db.example.com:5432/prod",
    ],
    ["https://example.com/a@b", "https://example.com/a@b"],
    ["db.example.com", "db.example.com"],
  ])("masks %s", (input, expected) => {
    expect(maskTargetSecret(input)).toBe(expected);
  });

  it("never leaves the real password anywhere in the masked target", () => {
    const masked = maskTargetSecret(
      "postgres://app:hunter2@db.example.com:5432/prod",
    );
    expect(masked).not.toContain("hunter2");
  });

  it("restores the stored password when the mask comes back untouched", () => {
    const stored = "postgres://app:hunter2@db.example.com:5432/prod";
    expect(restoreTargetSecret(maskTargetSecret(stored), stored)).toBe(stored);
  });

  it("restores around an edit to the rest of the target", () => {
    const stored = "postgres://app:hunter2@db.example.com:5432/prod";
    // The operator changed the host and the database but did not retype
    // the password. That is the case masking exists for.
    const edited = `postgres://app:${SECRET_MASK}@db2.example.com:5432/staging`;
    expect(restoreTargetSecret(edited, stored)).toBe(
      "postgres://app:hunter2@db2.example.com:5432/staging",
    );
  });

  it("takes a retyped password over the stored one", () => {
    const stored = "postgres://app:hunter2@db.example.com:5432/prod";
    const retyped = "postgres://app:correct-horse@db.example.com:5432/prod";
    expect(restoreTargetSecret(retyped, stored)).toBe(retyped);
  });

  it("clears the password when the operator removes it", () => {
    const stored = "postgres://app:hunter2@db.example.com:5432/prod";
    const cleared = "postgres://app@db.example.com:5432/prod";
    expect(restoreTargetSecret(cleared, stored)).toBe(cleared);
  });

  /**
   * The invariant the sentinel exists to hold. With nothing stored to
   * restore — an import into a fresh organization — writing the mask
   * through would dial a real server with `__vigil_unchanged_secret__`
   * as its password.
   */
  it("drops the sentinel rather than writing it when there is nothing to restore", () => {
    const masked = `postgres://app:${SECRET_MASK}@db.example.com:5432/prod`;
    const restored = restoreTargetSecret(masked, null);
    expect(restored).toBe("postgres://app@db.example.com:5432/prod");
    expect(restored).not.toContain(SECRET_MASK);
  });
});

describe("connectionErrorMessage", () => {
  /**
   * Node raises an AggregateError with an EMPTY message when every
   * address of a multi-homed host fails. `judge` reads a falsy error as
   * "no transport failure", so returning it verbatim files a dead server
   * as an assertion failure — or, for a type whose assertions all skip on
   * missing facts, as up. Two probes hit this independently.
   */
  it("unwraps an AggregateError with no message of its own", () => {
    const aggregate = new AggregateError(
      [new Error("connect ECONNREFUSED 10.0.0.1:5432")],
      "",
    );
    expect(connectionErrorMessage(aggregate, "Connection failed")).toBe(
      "connect ECONNREFUSED 10.0.0.1:5432",
    );
  });

  it("never returns an empty string", () => {
    expect(connectionErrorMessage(new AggregateError([], ""), "fallback")).toBe(
      "fallback",
    );
    expect(connectionErrorMessage(new Error(""), "fallback")).toBe("fallback");
    expect(connectionErrorMessage(undefined, "fallback")).toBe("fallback");
  });

  it("passes an ordinary error through", () => {
    expect(connectionErrorMessage(new Error("boom"), "fallback")).toBe("boom");
  });
});
