// Network policy for module engines: what they may contact, and the HTTP
// bridge they use (engines have no CORS-free network of their own).

import { MAX_HTTP_BODY, type HttpRequest, type HttpResponse } from "../shared/engine";

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".onion"];

function ipv4(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return undefined;
  const octets = parts.map(Number);
  return octets.every((o) => o <= 255) ? octets : undefined;
}

/** Loopback, private, link-local, carrier-grade NAT, benchmarking, multicast and reserved IPv4 ranges. */
function isPrivateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a! >= 224
  );
}

/**
 * Whether a host is on this machine or a private network. Engines must not
 * reach those: a module could otherwise probe local services. Names that
 * resolve to private addresses are not caught here; the public-suffix
 * names cover the usual cases.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (host.startsWith("[")) {
    // Only global unicast IPv6 (2000::/3) is public.
    const first = Number.parseInt(host.slice(1).split(":")[0] || "0", 16);
    return !(first >= 0x2000 && first <= 0x3fff);
  }
  const octets = ipv4(host);
  return octets !== undefined && isPrivateIpv4(octets);
}

/** "example.com" matches only itself; "*.example.com" matches it and its subdomains. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (!p.startsWith("*.")) return h === p;
  const base = p.slice(2);
  return h === base || h.endsWith(`.${base}`);
}

export interface UrlPolicy {
  schemes: readonly string[];
  /** When set, the only hosts allowed. */
  hosts?: readonly string[];
}

/** Why an engine may not contact `url`, or undefined when it may. */
export function checkUrl(url: string, policy: UrlPolicy): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not a valid URL";
  }
  if (!policy.schemes.includes(parsed.protocol)) return `${parsed.protocol} is not allowed`;
  if (parsed.username || parsed.password) return "credentials in URLs are not allowed";
  if (isPrivateHost(parsed.hostname)) return `${parsed.hostname} is a local or private address`;
  if (policy.hosts && !policy.hosts.some((p) => hostMatches(parsed.hostname, p))) return `${parsed.hostname} is not one of this module's hosts`;
  return undefined;
}

/** Headers the bridge never forwards: the network stack sets them, or they would let a module pose as someone else. */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "cookie",
  "cookie2",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "via",
  "proxy-authorization",
  "proxy-connection",
]);

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
export const MAX_REDIRECTS = 5;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array<ArrayBuffer>; redirect: "manual" | "follow" }) => Promise<Response>;

/**
 * Performs an engine's HTTP request. Every URL, including each redirect, is
 * checked against the policy, and responses are capped in size. Cookies
 * never pass in either direction.
 *
 * With redirect "follow" the fetch implementation follows redirects itself
 * (Electron's net.fetch cancels manual ones); the caller must then police
 * each hop at the network layer, and the final URL is checked again here.
 */
export async function performHttp(fetchImpl: FetchLike, request: HttpRequest, policy: UrlPolicy, redirect: "manual" | "follow" = "manual"): Promise<HttpResponse> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (!FORBIDDEN_REQUEST_HEADERS.has(lower) && !lower.startsWith("sec-") && !lower.startsWith("proxy-")) headers[name] = value;
  }
  let url = request.url;
  let method = request.method;
  // An ArrayBuffer-backed copy, as fetch bodies require.
  let body = request.body instanceof Uint8Array ? new Uint8Array(request.body) : request.body;
  for (let hop = 0; ; hop++) {
    const problem = checkUrl(url, policy);
    if (problem) throw new Error(`Request blocked: ${problem}`);
    const response = await fetchImpl(url, { method, headers, body, redirect });
    const finalProblem = response.url ? checkUrl(response.url, policy) : undefined;
    if (finalProblem) throw new Error(`Request blocked: ${finalProblem}`);
    const location = response.headers.get("location");
    if (REDIRECTS.has(response.status) && location) {
      if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects");
      url = new URL(location, url).href;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_HTTP_BODY) throw new Error("Response too large");
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > MAX_HTTP_BODY) throw new Error("Response too large");
    const out: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (name !== "set-cookie" && name !== "set-cookie2") out[name] = value;
    });
    return { status: response.status, headers: out, body: data };
  }
}
