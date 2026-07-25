import { describe, expect, it } from "vitest";

import { isPrivateAddress } from "@/modules/monitors/net";

describe("isPrivateAddress", () => {
  describe("IPv4", () => {
    it("flags RFC1918 10.0.0.0/8 addresses as private", () => {
      expect(isPrivateAddress("10.0.0.1")).toBe(true);
    });

    it("flags loopback 127.0.0.0/8 as private", () => {
      expect(isPrivateAddress("127.0.0.1")).toBe(true);
    });

    it("flags link-local / cloud-metadata 169.254.0.0/16 as private", () => {
      expect(isPrivateAddress("169.254.169.254")).toBe(true);
    });

    it("flags the full 172.16.0.0/12 range as private", () => {
      expect(isPrivateAddress("172.16.0.1")).toBe(true);
      expect(isPrivateAddress("172.31.255.255")).toBe(true);
    });

    it("does not flag 172.32.0.1, just outside the /12 range", () => {
      expect(isPrivateAddress("172.32.0.1")).toBe(false);
    });

    it("flags 192.168.0.0/16 as private", () => {
      expect(isPrivateAddress("192.168.1.1")).toBe(true);
    });

    it("flags CGNAT 100.64.0.0/10 as private", () => {
      expect(isPrivateAddress("100.64.0.1")).toBe(true);
    });

    it("flags the unspecified address 0.0.0.0 as private", () => {
      expect(isPrivateAddress("0.0.0.0")).toBe(true);
    });

    it("does not flag public IPv4 addresses", () => {
      expect(isPrivateAddress("8.8.8.8")).toBe(false);
      expect(isPrivateAddress("1.1.1.1")).toBe(false);
    });
  });

  describe("IPv6", () => {
    it("flags the loopback address ::1 as private", () => {
      expect(isPrivateAddress("::1")).toBe(true);
    });

    it("flags unique-local fc00::/7 addresses as private", () => {
      expect(isPrivateAddress("fc00::1")).toBe(true);
      expect(isPrivateAddress("fd12::1")).toBe(true);
    });

    it("flags link-local fe80::/10 addresses as private", () => {
      expect(isPrivateAddress("fe80::1")).toBe(true);
    });

    it("does not flag public IPv6 addresses", () => {
      expect(isPrivateAddress("2606:4700::1111")).toBe(false);
    });

    it("rechecks the embedded IPv4 in IPv4-mapped addresses", () => {
      expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
      expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
    });
  });
});
