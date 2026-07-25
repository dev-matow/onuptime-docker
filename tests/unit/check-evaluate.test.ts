import { describe, expect, it } from "vitest";

import { evaluateResponse } from "@/modules/monitors/check";

const defaultTarget = { expectedStatusCode: null, degradedThresholdMs: 3000 };

describe("evaluateResponse", () => {
  describe("without an expected status code", () => {
    it("treats 2xx and 3xx statuses as ok", () => {
      expect(evaluateResponse(defaultTarget, 200, 100)).toEqual({
        ok: true,
        degraded: false,
      });
      expect(evaluateResponse(defaultTarget, 204, 100)).toEqual({
        ok: true,
        degraded: false,
      });
      expect(evaluateResponse(defaultTarget, 302, 100)).toEqual({
        ok: true,
        degraded: false,
      });
      expect(evaluateResponse(defaultTarget, 399, 100)).toEqual({
        ok: true,
        degraded: false,
      });
    });

    it("treats 4xx and 5xx statuses as not ok", () => {
      expect(evaluateResponse(defaultTarget, 400, 100).ok).toBe(false);
      expect(evaluateResponse(defaultTarget, 404, 100).ok).toBe(false);
      expect(evaluateResponse(defaultTarget, 500, 100).ok).toBe(false);
      expect(evaluateResponse(defaultTarget, 503, 100).ok).toBe(false);
    });

    it("treats statuses below 200 as not ok", () => {
      expect(evaluateResponse(defaultTarget, 199, 100).ok).toBe(false);
    });
  });

  describe("with an exact expected status code", () => {
    const expects401 = { expectedStatusCode: 401, degradedThresholdMs: 3000 };

    it("accepts only the exact expected status, even outside 2xx/3xx", () => {
      expect(evaluateResponse(expects401, 401, 100)).toEqual({
        ok: true,
        degraded: false,
      });
    });

    it("rejects an otherwise-healthy 200 when 401 is expected", () => {
      expect(evaluateResponse(expects401, 200, 100)).toEqual({
        ok: false,
        degraded: false,
      });
    });
  });

  describe("degradation", () => {
    it("marks the check degraded when ok and strictly slower than the threshold", () => {
      expect(evaluateResponse(defaultTarget, 200, 3001)).toEqual({
        ok: true,
        degraded: true,
      });
    });

    it("is not degraded at exactly the threshold", () => {
      expect(evaluateResponse(defaultTarget, 200, 3000)).toEqual({
        ok: true,
        degraded: false,
      });
    });

    it("is never degraded when the check is not ok, regardless of latency", () => {
      expect(evaluateResponse(defaultTarget, 500, 10_000)).toEqual({
        ok: false,
        degraded: false,
      });
    });
  });
});
