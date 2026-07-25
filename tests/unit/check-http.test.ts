import { describe, expect, it, vi } from "vitest";

import {
  evaluateKeyword,
  performHttpCheck,
  type CheckTarget,
} from "@/modules/monitors/check";

const baseTarget: CheckTarget = {
  url: "https://example.com/health",
  method: "GET",
  timeoutMs: 5000,
  degradedThresholdMs: 3000,
  expectedStatusCode: null,
};

// allowPrivateTargets skips the real dns.lookup so these tests stay
// fully offline; the guard itself is covered separately below using
// "localhost", which resolves via the hosts file without network.

describe("performHttpCheck", () => {
  it("reports a successful 200 response with a measured response time", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));

    const outcome = await performHttpCheck(baseTarget, {
      allowPrivateTargets: true,
      fetchImpl,
    });

    expect(outcome).toMatchObject({
      ok: true,
      degraded: false,
      statusCode: 200,
      error: null,
    });
    expect(typeof outcome.responseTimeMs).toBe("number");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      baseTarget.url,
      expect.objectContaining({ method: "GET", redirect: "follow" }),
    );
  });

  it("reports a 503 response as a failure with an explanatory error", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));

    const outcome = await performHttpCheck(baseTarget, {
      allowPrivateTargets: true,
      fetchImpl,
    });

    expect(outcome).toMatchObject({
      ok: false,
      degraded: false,
      statusCode: 503,
      error: "Unexpected status 503",
    });
    expect(typeof outcome.responseTimeMs).toBe("number");
  });

  it("maps a TimeoutError DOMException to a timeout failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });

    const outcome = await performHttpCheck(baseTarget, {
      allowPrivateTargets: true,
      fetchImpl,
    });

    expect(outcome).toMatchObject({
      ok: false,
      degraded: false,
      statusCode: null,
      error: "Timed out after 5000ms",
    });
    expect(outcome.error).toContain("Timed out");
    expect(typeof outcome.responseTimeMs).toBe("number");
  });

  it("surfaces the cause message when fetch throws a TypeError with an Error cause", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("getaddrinfo ENOTFOUND example.com"),
      });
    });

    const outcome = await performHttpCheck(baseTarget, {
      allowPrivateTargets: true,
      fetchImpl,
    });

    expect(outcome).toMatchObject({
      ok: false,
      degraded: false,
      statusCode: null,
      error: "getaddrinfo ENOTFOUND example.com",
    });
  });

  describe("keyword assertion", () => {
    it("passes when the body contains the required keyword", async () => {
      const fetchImpl = vi.fn(
        async () => new Response('{"status":"healthy"}', { status: 200 }),
      );
      const outcome = await performHttpCheck(
        { ...baseTarget, bodyKeyword: "healthy" },
        { allowPrivateTargets: true, fetchImpl },
      );
      expect(outcome).toMatchObject({ ok: true, error: null });
    });

    it("fails a 200 when the required keyword is missing", async () => {
      const fetchImpl = vi.fn(
        async () => new Response("Database connection error", { status: 200 }),
      );
      const outcome = await performHttpCheck(
        { ...baseTarget, bodyKeyword: "healthy" },
        { allowPrivateTargets: true, fetchImpl },
      );
      expect(outcome).toMatchObject({
        ok: false,
        degraded: false,
        statusCode: 200,
        error: 'Body does not contain "healthy"',
      });
    });

    it("fails when a forbidden keyword is present (absent mode)", async () => {
      const fetchImpl = vi.fn(
        async () => new Response("Fatal: stack trace…", { status: 200 }),
      );
      const outcome = await performHttpCheck(
        { ...baseTarget, bodyKeyword: "Fatal", keywordAbsent: true },
        { allowPrivateTargets: true, fetchImpl },
      );
      expect(outcome).toMatchObject({
        ok: false,
        error: 'Body unexpectedly contains "Fatal"',
      });
    });

    it("does not read the body when no keyword is configured", async () => {
      const body = { getReader: vi.fn() };
      const fetchImpl = vi.fn(async () => {
        const res = new Response("ok", { status: 200 });
        Object.defineProperty(res, "body", { value: body });
        return res;
      });
      await performHttpCheck(baseTarget, {
        allowPrivateTargets: true,
        fetchImpl,
      });
      expect(body.getReader).not.toHaveBeenCalled();
    });

    it("skips the keyword on a HEAD request (no body to read)", async () => {
      const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
      const outcome = await performHttpCheck(
        { ...baseTarget, method: "HEAD", bodyKeyword: "healthy" },
        { allowPrivateTargets: true, fetchImpl },
      );
      expect(outcome).toMatchObject({ ok: true, error: null });
    });

    it("keeps a keyword failure as down, never degraded", async () => {
      const fetchImpl = vi.fn(
        async () => new Response("error", { status: 200 }),
      );
      const outcome = await performHttpCheck(
        { ...baseTarget, degradedThresholdMs: 0, bodyKeyword: "ok" },
        { allowPrivateTargets: true, fetchImpl },
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.degraded).toBe(false);
    });
  });

  describe("evaluateKeyword", () => {
    it("holds when present and required", () => {
      expect(evaluateKeyword("ok", false, "all ok here")).toBeNull();
    });
    it("fails when required but missing", () => {
      expect(evaluateKeyword("ok", false, "nope")).toMatch(/does not contain/);
    });
    it("holds when absent and forbidden", () => {
      expect(evaluateKeyword("error", true, "all good")).toBeNull();
    });
    it("fails when forbidden but present", () => {
      expect(evaluateKeyword("error", true, "an error")).toMatch(
        /unexpectedly contains/,
      );
    });
  });

  describe("private-address guard", () => {
    it("refuses a hostname that resolves to loopback and never issues a request", async () => {
      const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));

      const outcome = await performHttpCheck(
        { ...baseTarget, url: "http://localhost:1/" },
        { fetchImpl },
      );

      expect(outcome).toEqual({
        ok: false,
        degraded: false,
        statusCode: null,
        responseTimeMs: null,
        error: "Target resolves to a private address",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("proceeds with the request when allowPrivateTargets is true", async () => {
      const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));

      const outcome = await performHttpCheck(
        { ...baseTarget, url: "http://localhost:1/" },
        { allowPrivateTargets: true, fetchImpl },
      );

      expect(outcome).toMatchObject({
        ok: true,
        statusCode: 200,
        error: null,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});
