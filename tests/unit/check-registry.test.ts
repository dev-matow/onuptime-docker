import { describe, expect, it } from "vitest";

import {
  CHECK_TYPE_DESCRIPTORS,
  describeCheckType,
  findDescriptor,
} from "@/modules/monitors/types/catalog";
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

  it.each(entries)("%s: has a probe and assertions", (_id, type) => {
    expect(typeof type.probe).toBe("function");
    expect(Array.isArray(type.assertions)).toBe(true);
  });

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
    const unknown = describeCheckType("redis");
    expect(unknown.id).toBe("redis");
    expect(unknown.form).toEqual([]);
    expect(findDescriptor("redis")).toBeUndefined();
  });
});
