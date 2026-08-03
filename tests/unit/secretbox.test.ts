import { describe, expect, it } from "vitest";

import {
  isPlainEnvelope,
  openSecrets,
  sealSecrets,
  SecretboxError,
} from "@/modules/notifications/secretbox";

describe("sealSecrets / openSecrets", () => {
  it("round-trips a secret map through an enc1 envelope", () => {
    const secrets = { botToken: "12345:AAss-token", password: "hunter2!" };
    const envelope = sealSecrets(secrets);
    expect(envelope.startsWith("enc1:")).toBe(true);
    // The whole point: neither value is readable in what is stored.
    expect(envelope).not.toContain("12345");
    expect(envelope).not.toContain("hunter2");
    expect(openSecrets(envelope)).toEqual(secrets);
  });

  it("seals an empty map to the empty string and opens it back", () => {
    expect(sealSecrets({})).toBe("");
    expect(openSecrets("")).toEqual({});
  });

  it("drops blank values instead of storing them", () => {
    const envelope = sealSecrets({ apiKey: "re_123", empty: "" });
    expect(openSecrets(envelope)).toEqual({ apiKey: "re_123" });
  });

  it("produces a fresh envelope per seal (random iv)", () => {
    const a = sealSecrets({ k: "v" });
    const b = sealSecrets({ k: "v" });
    expect(a).not.toBe(b);
    expect(openSecrets(a)).toEqual(openSecrets(b));
  });

  it("accepts the migration's plain: form", () => {
    const envelope = `plain:${JSON.stringify({ secret: "whsec_abc" })}`;
    expect(isPlainEnvelope(envelope)).toBe(true);
    expect(openSecrets(envelope)).toEqual({ secret: "whsec_abc" });
    expect(isPlainEnvelope(sealSecrets({ secret: "whsec_abc" }))).toBe(false);
  });

  it("refuses a tampered envelope rather than returning garbage", () => {
    const envelope = sealSecrets({ apiKey: "re_123" });
    const raw = Buffer.from(envelope.slice("enc1:".length), "base64");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    const tampered = `enc1:${raw.toString("base64")}`;
    expect(() => openSecrets(tampered)).toThrow(SecretboxError);
  });

  it("refuses unknown formats and non-object payloads", () => {
    expect(() => openSecrets("v9:zzzz")).toThrow(SecretboxError);
    expect(() => openSecrets("plain:[1,2]")).toThrow(SecretboxError);
    expect(() => openSecrets("plain:not json")).toThrow(SecretboxError);
  });
});
