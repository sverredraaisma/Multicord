// The Public Suffix List (publicsuffix.org), vendored at
// github.com/publicsuffix/list commit 52b71b3c4576ff77450cc7ebcfc7f34a916af3f9
// (2026-10-17) in ./publicsuffix, under the Mozilla Public License 2.0
// (./publicsuffix/LICENSE). esbuild and the tests load it as text.
import LIST from "./publicsuffix/public_suffix_list.dat";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ASCII = /^[\x00-\x7f]*$/;

/**
 * A host name as the rules below take it: lower case ASCII (an IDN in its
 * punycode form, as a URL's hostname gives it), at least two labels of
 * letters, digits and inner hyphens, at most 253 characters, and no IP
 * address (a last label of digits alone). Undefined for anything else.
 */
export function dnsName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 253) return undefined;
  const host = value.toLowerCase();
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || /^\d+$/.test(labels.at(-1)!)) return undefined;
  return host;
}

/** A rule's label in the form host names come in: punycode for one with other than ASCII. */
const asciiLabel = (label: string): string => (ASCII.test(label) ? label : new URL(`http://${label}`).hostname);

/**
 * The Public Suffix List's rules (its ICANN and private sections alike),
 * read from the list's text: `example` rules, `*.example` wildcards and
 * `!www.example` exceptions, as publicsuffix.org/list/ describes them.
 */
export class PublicSuffixList {
  private readonly rules = new Set<string>();
  /** For `*.x`, x. */
  private readonly wildcards = new Set<string>();
  private readonly exceptions = new Set<string>();

  constructor(text: string) {
    for (const line of text.split(/\r?\n/)) {
      const rule = line.trim().split(/\s/)[0]!.toLowerCase();
      if (rule === "" || rule.startsWith("//")) continue;
      if (rule.startsWith("!")) this.exceptions.add(this.ascii(rule.slice(1)));
      else if (rule.startsWith("*.")) this.wildcards.add(this.ascii(rule.slice(2)));
      else this.rules.add(this.ascii(rule));
    }
  }

  private ascii(rule: string): string {
    return rule.split(".").map(asciiLabel).join(".");
  }

  /** How many labels at the end of `labels` are the public suffix: the longest rule that matches, an exception's minus one, else the last label alone. */
  private suffixLength(labels: string[]): number {
    for (let i = 0; i < labels.length; i++) {
      const name = labels.slice(i).join(".");
      if (this.exceptions.has(name)) return labels.length - i - 1;
      if (this.rules.has(name)) return labels.length - i;
      if (i + 1 < labels.length && this.wildcards.has(labels.slice(i + 1).join("."))) return labels.length - i;
    }
    return 1;
  }

  /**
   * The registrable domain of a host (its public suffix and one label more:
   * "example.co.uk" for "a.b.example.co.uk"); undefined for a host that is
   * a public suffix itself ("co.uk", "github.io") or is no DNS name (dnsName()).
   */
  registrableDomain(value: unknown): string | undefined {
    const host = dnsName(value);
    if (!host) return undefined;
    const labels = host.split(".");
    const suffix = this.suffixLength(labels);
    return labels.length > suffix ? labels.slice(-suffix - 1).join(".") : undefined;
  }
}

let vendored: PublicSuffixList | undefined;

/** The vendored list, read once on first use. */
export function publicSuffixList(): PublicSuffixList {
  vendored ??= new PublicSuffixList(LIST);
  return vendored;
}

/**
 * Whether an engine locked to `locked` may also open sockets to `host`, its
 * one voice host (ModuleManifest.voiceHost "sibling"): a DNS name with the
 * same registrable domain as one of the locked hosts (a wildcard lock
 * counts by its base), so a voice server the instance names on its own
 * domain (voice.example.com beside api.example.com) is let through, but no
 * other site, nor a sibling under a public suffix (bar.github.io beside
 * foo.github.io).
 */
export function voiceHostAllowed(locked: readonly string[], host: string, list: PublicSuffixList = publicSuffixList()): boolean {
  const domain = list.registrableDomain(host);
  return domain !== undefined && locked.some((l) => list.registrableDomain(l.replace(/^\*\./, "")) === domain);
}
