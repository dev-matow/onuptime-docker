import { describe, expect, it } from "vitest";

import {
  classifyAddress,
  isForbiddenEgressHost,
  isForbiddenEgressUrl,
  isPrivateAddress,
} from "@/modules/monitors/net";

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

    it("refuses an address it cannot parse rather than assuming it is public", () => {
      // Only ever asked about the output of a resolver. An answer this
      // module cannot read is not something to open a socket to.
      expect(isPrivateAddress("not-an-address")).toBe(true);
      expect(isPrivateAddress("999.1.1.1")).toBe(true);
    });

    it("refuses an octal-looking octet instead of guessing its base", () => {
      // `010.0.0.1` is 8.0.0.1 to some resolvers and 10.0.0.1 to others.
      // A classifier that picks one can be walked around by the other.
      expect(isPrivateAddress("010.0.0.1")).toBe(true);
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

describe("classifyAddress", () => {
  it("tells the classes apart rather than lumping them as private", () => {
    // Policy may unblock private and loopback. It may never unblock the
    // rest, so they have to be distinguishable.
    expect(classifyAddress("10.0.0.1")).toBe("private");
    expect(classifyAddress("127.0.0.1")).toBe("loopback");
    expect(classifyAddress("169.254.1.1")).toBe("link-local");
    expect(classifyAddress("169.254.169.254")).toBe("metadata");
    expect(classifyAddress("0.0.0.0")).toBe("unspecified");
    expect(classifyAddress("8.8.8.8")).toBe("public");
  });

  it("returns null for a hostname, which is not an address at all", () => {
    // Distinct from "reserved": a name has to be resolved, not refused.
    expect(classifyAddress("example.com")).toBeNull();
    expect(classifyAddress("host.internal")).toBeNull();
  });

  describe("IPv4 special-purpose ranges beyond RFC1918", () => {
    it.each([
      ["0.1.2.3", "this-network 0.0.0.0/8"],
      ["192.0.0.1", "IETF protocol assignments 192.0.0.0/24"],
      ["192.0.2.5", "TEST-NET-1"],
      ["192.88.99.1", "6to4 relay anycast"],
      ["198.18.0.1", "benchmarking 198.18.0.0/15"],
      ["198.19.255.1", "benchmarking 198.18.0.0/15"],
      ["198.51.100.5", "TEST-NET-2"],
      ["203.0.113.5", "TEST-NET-3"],
      ["224.0.0.1", "multicast"],
      ["240.0.0.1", "reserved for future use"],
      ["255.255.255.255", "broadcast"],
    ])("classifies %s as reserved (%s)", (address) => {
      expect(classifyAddress(address)).toBe("reserved");
    });

    it("leaves the neighbours of those ranges public", () => {
      expect(classifyAddress("192.0.1.1")).toBe("public");
      expect(classifyAddress("192.88.100.1")).toBe("public");
      expect(classifyAddress("198.20.0.1")).toBe("public");
      expect(classifyAddress("223.255.255.255")).toBe("public");
    });
  });

  describe("IPv6 encodings of the same address", () => {
    it("reads the hex form of an IPv4-mapped address, not just the dotted one", () => {
      // `::ffff:c0a8:0101` and `::ffff:192.168.1.1` are the same
      // address. A classifier that only matched the printed dotted form
      // saw the first as an ordinary public IPv6 address.
      expect(classifyAddress("::ffff:c0a8:0101")).toBe("private");
      expect(classifyAddress("::ffff:192.168.1.1")).toBe("private");
      expect(classifyAddress("::ffff:7f00:1")).toBe("loopback");
      expect(classifyAddress("::ffff:a9fe:a9fe")).toBe("metadata");
    });

    it("reads the deprecated IPv4-compatible form", () => {
      expect(classifyAddress("::10.0.0.1")).toBe("private");
      expect(classifyAddress("::169.254.169.254")).toBe("metadata");
    });

    it("reads the IPv4-translated form", () => {
      expect(classifyAddress("::ffff:0:10.0.0.1")).toBe("private");
    });

    it("reads the NAT64 well-known prefix", () => {
      expect(classifyAddress("64:ff9b::10.0.0.1")).toBe("private");
      expect(classifyAddress("64:ff9b::169.254.169.254")).toBe("metadata");
      expect(classifyAddress("64:ff9b::8.8.8.8")).toBe("public");
    });

    it("reads the IPv4 a 6to4 address carries", () => {
      // 2002:<v4>::/48 routes to that IPv4 address.
      expect(classifyAddress("2002:0a00:0001::1")).toBe("private");
      expect(classifyAddress("2002:0808:0808::1")).toBe("public");
    });

    it("classifies the whole of fe80::/10, not just addresses spelled fe8x", () => {
      for (const address of ["fe80::1", "fe90::1", "fea0::1", "febf::1"]) {
        expect(classifyAddress(address)).toBe("link-local");
      }
      expect(classifyAddress("fec0::1")).toBe("private"); // site-local
    });

    it("ignores a zone identifier on a link-local address", () => {
      expect(classifyAddress("fe80::1%eth0")).toBe("link-local");
    });

    it("classifies multicast, documentation, Teredo and discard space", () => {
      expect(classifyAddress("ff02::1")).toBe("reserved");
      expect(classifyAddress("2001:db8::1")).toBe("reserved");
      expect(classifyAddress("2001:0:5ef5:79fd::1")).toBe("reserved");
      expect(classifyAddress("100::1")).toBe("reserved");
    });

    it("knows the AWS IMDS address that lives inside allowed ULA space", () => {
      // fd00:ec2::254 sits in fc00::/7, which policy is allowed to
      // permit. It is still the credential vending machine.
      expect(classifyAddress("fd00:ec2::254")).toBe("metadata");
      expect(classifyAddress("fd00:ec2::255")).toBe("private");
    });

    it("rejects malformed IPv6 rather than parsing it loosely", () => {
      expect(classifyAddress("1:2:3:4:5:6:7:8:9")).toBeNull();
      expect(classifyAddress("::ffff::1")).toBeNull();
      expect(classifyAddress("1:2:3:4:5:6:7")).toBeNull();
      expect(classifyAddress("gggg::1")).toBeNull();
    });
  });
});

describe("isForbiddenEgressHost", () => {
  it("refuses cloud metadata by name", () => {
    expect(isForbiddenEgressHost("metadata.google.internal")).toBe(true);
    expect(isForbiddenEgressHost("METADATA.GOOGLE.INTERNAL")).toBe(true);
  });

  it("refuses the metadata address in every encoding, including bracketed", () => {
    expect(isForbiddenEgressHost("169.254.169.254")).toBe(true);
    expect(isForbiddenEgressHost("[::ffff:169.254.169.254]")).toBe(true);
    expect(isForbiddenEgressHost("[::ffff:a9fe:a9fe]")).toBe(true);
    expect(isForbiddenEgressHost("[fd00:ec2::254]")).toBe(true);
  });

  it("refuses link-local, unspecified and reserved literals", () => {
    expect(isForbiddenEgressHost("169.254.10.1")).toBe(true);
    expect(isForbiddenEgressHost("[fe80::1]")).toBe(true);
    expect(isForbiddenEgressHost("0.0.0.0")).toBe(true);
    expect(isForbiddenEgressHost("240.0.0.1")).toBe(true);
  });

  it("permits the private literals that recovery endpoints legitimately use", () => {
    // A restart hook on the operator's own network is the feature.
    expect(isForbiddenEgressHost("10.0.0.5")).toBe(false);
    expect(isForbiddenEgressHost("192.168.1.10")).toBe(false);
    expect(isForbiddenEgressHost("127.0.0.1")).toBe(false);
    expect(isForbiddenEgressHost("[fd12::1]")).toBe(false);
  });

  it("permits ordinary hostnames, which are resolved rather than refused", () => {
    expect(isForbiddenEgressHost("example.com")).toBe(false);
    expect(isForbiddenEgressHost("host.internal")).toBe(false);
  });
});

describe("isForbiddenEgressUrl", () => {
  it("reads the host out of the URL", () => {
    expect(
      isForbiddenEgressUrl("http://169.254.169.254/latest/meta-data"),
    ).toBe(true);
    expect(isForbiddenEgressUrl("http://[::ffff:169.254.169.254]/")).toBe(true);
    expect(isForbiddenEgressUrl("http://10.0.0.5:9000/hooks/restart")).toBe(
      false,
    );
  });

  it("says nothing about a string that is not a URL", () => {
    // That is the URL check's verdict to give; reporting a typo as a
    // security refusal tells the operator to fix the wrong thing.
    expect(isForbiddenEgressUrl("not a url")).toBe(false);
  });
});
