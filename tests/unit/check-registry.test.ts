import { describe, expect, it } from "vitest";

import {
  CHECK_TYPE_DESCRIPTORS,
  describeCheckType,
  findDescriptor,
  UNSCHEDULED_CHECK_TYPE_IDS,
} from "@/modules/monitors/types/catalog";
import { redactTargetCredentials } from "@/modules/monitors/spec";
import { connectionErrorMessage } from "@/modules/monitors/types/probes/guard";
import { isScheduledKind } from "@/modules/monitors/types/contract";
import { CHECK_TYPES } from "@/modules/monitors/types/registry";
import { CHECK_TYPE_SPECS } from "@/modules/monitors/types/specs";

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
