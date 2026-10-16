import { describe, expect, it, vi } from "vitest";
import { checkUrl, hostMatches, isPrivateHost, MAX_REDIRECTS, narrowHosts, patternWithin, performHttp, type FetchLike, type UrlPolicy } from "../../src/main/netPolicy";
import { MAX_HTTP_BODY, type HttpRequest } from "../../src/shared/engine";
// The cases every host's network policy must pass; see docs/mobile.md.
import cases from "../fixtures/netpolicy-cases.json";

/** How each kind of refusal reads here. */
const REFUSALS: Record<string, RegExp> = {
  invalid: /^not a valid URL$/,
  scheme: /^[a-z]+: is not allowed$/,
  credentials: /^credentials in URLs are not allowed$/,
  private: / is a local or private address$/,
  host: / is not one of this module's hosts$/,
};

describe("isPrivateHost", () => {
  it.each(cases.privateHosts)("treats %s as private", (host) => expect(isPrivateHost(host)).toBe(true));

  it.each(cases.publicHosts)("treats %s as public", (host) => expect(isPrivateHost(host)).toBe(false));

  it.each(cases.numericHosts)("catches $url once the URL parser normalises it", ({ url, hostname }) => {
    expect(new URL(url).hostname).toBe(hostname);
    expect(isPrivateHost(new URL(url).hostname)).toBe(true);
  });
});

describe("hostMatches", () => {
  it.each(cases.hostMatches)("$host against $pattern: $matches", ({ host, pattern, matches }) => {
    expect(hostMatches(host, pattern)).toBe(matches);
  });
});

describe("checkUrl", () => {
  it.each(cases.checkUrl)("$url with $schemes and $hosts: $refused", (c) => {
    const policy: UrlPolicy = "hosts" in c ? { schemes: c.schemes, hosts: c.hosts } : { schemes: c.schemes };
    const problem = checkUrl(c.url, policy);
    if (!("refused" in c)) return expect(problem).toBeUndefined();
    expect(problem).toMatch(REFUSALS[c.refused!]!);
  });

  it("names what it refuses", () => {
    const policy: UrlPolicy = { schemes: ["https:"], hosts: ["*.example.com"] };
    expect(checkUrl("http://example.com/", policy)).toBe("http: is not allowed");
    expect(checkUrl("https://2130706433/", policy)).toBe("127.0.0.1 is a local or private address");
    expect(checkUrl("https://other.org/", policy)).toBe("other.org is not one of this module's hosts");
  });
});

describe("performHttp", () => {
  const policy: UrlPolicy = { schemes: ["https:"], hosts: ["*.example.com"] };
  const req = (over: Partial<HttpRequest> = {}): HttpRequest => ({ url: "https://a.example.com/x", method: "GET", headers: {}, ...over });
  const redirect = (status: number, location?: string): Response => new Response(null, { status, headers: location ? { location } : {} });
  const fetchOf = (...responses: Response[]) => {
    const fn = vi.fn<FetchLike>();
    for (const r of responses) fn.mockResolvedValueOnce(r);
    return fn;
  };

  it("strips forbidden headers and keeps the rest", async () => {
    const fetchImpl = fetchOf(new Response("ok"));
    await performHttp(fetchImpl, req({ headers: cases.requestHeaders.sent }), policy);
    expect(fetchImpl.mock.calls[0]![1].headers).toEqual(cases.requestHeaders.forwarded);
    expect(fetchImpl.mock.calls[0]![1].redirect).toBe("manual");
  });

  it("passes a Uint8Array body as a copy and string bodies as-is", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = fetchOf(new Response("a"), new Response("b"));
    await performHttp(fetchImpl, req({ method: "POST", body: bytes }), policy);
    await performHttp(fetchImpl, req({ method: "POST", body: "text" }), policy);
    const sent = fetchImpl.mock.calls[0]![1].body as Uint8Array;
    expect(sent).toEqual(bytes);
    expect(sent).not.toBe(bytes);
    expect(fetchImpl.mock.calls[1]![1].body).toBe("text");
  });

  it("returns status, headers without set-cookie, and a Uint8Array body", async () => {
    const headers = new Headers({ "content-type": "text/plain", "x-a": "1" });
    headers.append("set-cookie", "a=b");
    const res = await performHttp(fetchOf(new Response("hi", { status: 201, headers })), req(), policy);
    expect(res.status).toBe(201);
    expect(res.headers).toEqual({ "content-type": "text/plain", "x-a": "1" });
    expect(res.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(res.body)).toBe("hi");
  });

  it("drops set-cookie2 too", async () => {
    const fake = { status: 200, headers: new Headers({ "set-cookie2": "x", a: "b" }), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    expect((await performHttp(fetchOf(fake), req(), policy)).headers).toEqual({ a: "b" });
  });

  it("blocks the initial URL before fetching", async () => {
    const fetchImpl = fetchOf();
    await expect(performHttp(fetchImpl, req({ url: "https://evil.org/" }), policy)).rejects.toThrow(/^Request blocked: evil\.org is not/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("follows redirects, resolving relative locations", async () => {
    const fetchImpl = fetchOf(redirect(302, "/next"), redirect(301, "https://b.example.com/y"), new Response("done"));
    const res = await performHttp(fetchImpl, req(), policy);
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(["https://a.example.com/x", "https://a.example.com/next", "https://b.example.com/y"]);
    expect(res.status).toBe(200);
  });

  it("re-checks every hop", async () => {
    await expect(performHttp(fetchOf(redirect(302, "https://localhost/")), req(), policy)).rejects.toThrow(/^Request blocked: localhost is a local/);
    await expect(performHttp(fetchOf(redirect(302, "http://a.example.com/")), req(), policy)).rejects.toThrow("Request blocked: http: is not allowed");
  });

  it.each(cases.redirects)("after $status, $method goes on as $nextMethod", async ({ status, method, nextMethod, keepsBody }) => {
    const fetchImpl = fetchOf(redirect(status, "/n"), new Response("ok"));
    await performHttp(fetchImpl, req({ method, body: "x" }), policy);
    expect(fetchImpl.mock.calls[1]![1]).toMatchObject({ method: nextMethod, body: keepsBody ? "x" : undefined });
  });

  it("allows MAX_REDIRECTS hops but not more", async () => {
    expect(MAX_REDIRECTS).toBe(cases.maxRedirects);
    const hops = Array.from({ length: MAX_REDIRECTS }, () => redirect(302, "/n"));
    expect((await performHttp(fetchOf(...hops, new Response("ok")), req(), policy)).status).toBe(200);
    const tooMany = Array.from({ length: MAX_REDIRECTS + 1 }, () => redirect(302, "/n"));
    await expect(performHttp(fetchOf(...tooMany), req(), policy)).rejects.toThrow("Too many redirects");
  });

  it("returns a 3xx without Location as-is", async () => {
    expect((await performHttp(fetchOf(redirect(302)), req(), policy)).status).toBe(302);
  });

  it("rejects oversized responses by header and by actual size", async () => {
    const big = new Response("x", { headers: { "content-length": String(MAX_HTTP_BODY + 1) } });
    await expect(performHttp(fetchOf(big), req(), policy)).rejects.toThrow("Response too large");
    // No length given: the body is counted as it arrives.
    const unannounced = new Response(new Blob([new Uint8Array(MAX_HTTP_BODY + 1)]).stream());
    await expect(performHttp(fetchOf(unannounced), req(), policy)).rejects.toThrow("Response too large");
  });

  it("checks the final URL when the fetch followed redirects itself", async () => {
    const landed = new Response("x");
    Object.defineProperty(landed, "url", { value: "https://127.0.0.1/admin" });
    const fetchImpl = vi.fn(async () => landed);
    await expect(performHttp(fetchImpl, { url: "https://api.example.com/", method: "GET", headers: {} }, { schemes: ["https:"] }, "follow")).rejects.toThrow("Request blocked");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.example.com/", expect.objectContaining({ redirect: "follow" }));
  });
});

describe("host locks", () => {
  it.each(cases.patternWithin)("$pattern within $allowed: $within", ({ pattern, allowed, within }) => {
    expect(patternWithin(pattern, allowed)).toBe(within);
  });

  it.each(cases.narrowHosts)("only ever narrows, and never to private hosts: $requested", ({ current, requested, result }) => {
    expect(narrowHosts(current ?? undefined, requested)).toEqual(result ?? undefined);
  });
});

describe("readCapped", () => {
  it("reads bodies in pieces and stops at the limit", async () => {
    const { readCapped } = await import("../../src/main/netPolicy");
    const stream = (chunks: number[]) => {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled < chunks.length) controller.enqueue(new Uint8Array(chunks[pulled++]!).fill(1));
          else controller.close();
        },
      });
      return { response: new Response(body), pulled: () => pulled };
    };
    expect((await readCapped(stream([3, 4]).response, 10)).byteLength).toBe(7);
    // Endless in principle: reading stops once past the limit, not at the end.
    const big = stream([6, 6, 6, 6, 6]);
    await expect(readCapped(big.response, 10)).rejects.toThrow("Response too large");
    expect(big.pulled()).toBeLessThan(5);
    expect((await readCapped(new Response(null), 10)).byteLength).toBe(0);
  });
});

describe("createAddressGuard", () => {
  it("refuses names that resolve to private addresses, remembering answers for a while", async () => {
    const { createAddressGuard } = await import("../../src/main/netPolicy");
    let clock = 0;
    const answers: Record<string, string[]> = { "public.example": ["93.184.216.34", "2606:2800:220:1::1"], "sneaky.example": ["93.184.216.34", "192.168.1.10"], "v6.example": ["::1"] };
    const resolve = vi.fn(async (host: string) => {
      if (!(host in answers)) throw new Error("NXDOMAIN");
      return answers[host]!;
    });
    const guard = createAddressGuard(resolve, () => clock);
    expect(await guard("https://public.example/a")).toBe(true);
    expect(await guard("wss://sneaky.example/socket")).toBe(false);
    expect(await guard("https://v6.example/")).toBe(false);
    expect(await guard("https://missing.example/")).toBe(true); // fails by itself later
    expect(await guard("https://93.184.216.34/")).toBe(true); // literals: judged by checkUrl
    expect(await guard("https://[2606:2800::1]/")).toBe(true);
    expect(await guard("not a url")).toBe(false);
    await guard("https://public.example/b");
    expect(resolve).toHaveBeenCalledTimes(4);
    clock = 61_000;
    await guard("https://public.example/c");
    expect(resolve).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 501; i++) await guard(`https://h${i}.example/`);
    expect(resolve).toHaveBeenCalledTimes(506);
  });

  it.each(cases.resolvedAddresses)("judges a name resolving to $addresses public: $public", async ({ addresses, public: open }) => {
    const { createAddressGuard } = await import("../../src/main/netPolicy");
    expect(await createAddressGuard(async () => addresses)("wss://name.example/")).toBe(open);
  });
});
