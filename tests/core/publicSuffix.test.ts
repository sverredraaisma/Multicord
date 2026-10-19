import { describe, expect, it } from "vitest";
import { dnsName, PublicSuffixList, publicSuffixList, voiceHostAllowed } from "../../src/core/publicSuffix";
// The cases every host's network policy must pass (the Kotlin port runs them too).
import cases from "../fixtures/netpolicy-cases.json";

describe("registrableDomain (the vendored Public Suffix List)", () => {
  it.each(cases.registrableDomain)("$host: $domain", ({ host, domain }) => {
    expect(publicSuffixList().registrableDomain(host) ?? null).toBe(domain);
  });

  it("reads the list once", () => {
    expect(publicSuffixList()).toBe(publicSuffixList());
  });

  it("takes rules, wildcards, exceptions and IDN rules from a list's text, ignoring comments and what follows a rule", () => {
    const list = new PublicSuffixList("// comment\r\n\r\nexample\n*.wild.example\n!keep.wild.example\nBücher.example  trailing words\n");
    expect(list.registrableDomain("a.b.example")).toBe("b.example");
    expect(list.registrableDomain("a.b.wild.example")).toBe("a.b.wild.example");
    expect(list.registrableDomain("b.wild.example")).toBeUndefined();
    expect(list.registrableDomain("a.keep.wild.example")).toBe("keep.wild.example");
    expect(list.registrableDomain("shop.xn--bcher-kva.example")).toBe("shop.xn--bcher-kva.example");
    expect(list.registrableDomain("xn--bcher-kva.example")).toBeUndefined();
    // No rule: the last label alone is the suffix.
    expect(list.registrableDomain("a.b.other")).toBe("b.other");
  });

  it("refuses what is no DNS name", () => {
    expect(dnsName(undefined)).toBeUndefined();
    expect(dnsName(`${"a.".repeat(127)}com`)).toBeUndefined();
    expect(dnsName(`${"a".repeat(64)}.com`)).toBeUndefined();
    expect(dnsName("a-.com")).toBeUndefined();
    expect(dnsName("A.Com")).toBe("a.com");
  });
});

describe("voiceHostAllowed", () => {
  it.each(cases.voiceHost)("$host beside $locked: $allowed", ({ locked, host, allowed }) => {
    expect(voiceHostAllowed(locked, host)).toBe(allowed);
  });

  it("takes another list", () => {
    const list = new PublicSuffixList("example");
    expect(voiceHostAllowed(["api.site.example"], "voice.site.example", list)).toBe(true);
    expect(voiceHostAllowed(["api.site.example"], "voice.other.example", list)).toBe(false);
  });
});
