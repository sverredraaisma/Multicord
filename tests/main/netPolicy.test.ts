import { describe, expect, it, vi } from "vitest";
import { checkUrl, hostMatches, isPrivateHost, MAX_REDIRECTS, performHttp, type FetchLike, type UrlPolicy } from "../../src/main/netPolicy";
import { MAX_HTTP_BODY, type HttpRequest } from "../../src/shared/engine";

describe("isPrivateHost", () => {
  it.each([
    "localhost", "LOCALHOST", "localhost.", "foo.localhost", "x.local", "a.internal", "a.lan", "a.home.arpa", "abc.onion",
    "127.0.0.1", "10.1.2.3", "100.64.0.1", "100.127.255.255", "169.254.1.1", "172.16.0.1", "172.31.9.9", "192.168.1.1",
    "198.18.0.1", "198.19.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "[::1]", "[fe80::1]", "[fd00::1]", "[::ffff:7f00:1]", "[::]",
  ])("treats %s as private", (host) => expect(isPrivateHost(host)).toBe(true));

  it.each(["example.com", "8.8.8.8", "100.63.0.1", "100.128.0.1", "172.15.0.1", "172.32.0.1", "198.17.0.1", "223.255.255.255", "[2001:db8::1]", "1.2.3", "1.2.3.4.5", "1.2.3.256", "a.b.c.d", "1234.1.1.1"])(
    "treats %s as public",
    (host) => expect(isPrivateHost(host)).toBe(false),
  );

  it("catches numeric IP forms once the URL parser normalises them", () => {
    expect(new URL("https://2130706433/").hostname).toBe("127.0.0.1");
    for (const url of ["https://2130706433/", "https://0x7f.1/", "https://017700000001/", "https://127.1/"]) {
      expect(isPrivateHost(new URL(url).hostname)).toBe(true);
    }
  });
});

describe("hostMatches", () => {
  it("matches exact hosts only without a wildcard", () => {
    expect(hostMatches("example.com", "example.com")).toBe(true);
    expect(hostMatches("a.example.com", "example.com")).toBe(false);
  });

  it("matches the apex and subdomains for *. patterns", () => {
    expect(hostMatches("example.com", "*.example.com")).toBe(true);
    expect(hostMatches("a.b.example.com", "*.example.com")).toBe(true);
    expect(hostMatches("evilexample.com", "*.example.com")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(hostMatches("API.Example.COM", "*.EXAMPLE.com")).toBe(true);
    expect(hostMatches("EXAMPLE.com", "example.COM")).toBe(true);
  });
});

describe("checkUrl", () => {
  const policy: UrlPolicy = { schemes: ["https:"], hosts: ["*.example.com", "api.test"] };

  it("rejects what it should", () => {
    expect(checkUrl("nope", policy)).toBe("not a valid URL");
    expect(checkUrl("http://example.com/", policy)).toBe("http: is not allowed");
    expect(checkUrl("https://user:pw@example.com/", policy)).toMatch(/credentials/);
    expect(checkUrl("https://user@example.com/", policy)).toMatch(/credentials/);
    expect(checkUrl("https://localhost/", policy)).toMatch(/local or private/);
    expect(checkUrl("https://2130706433/", policy)).toMatch(/127\.0\.0\.1 is a local or private/);
    expect(checkUrl("https://other.org/", policy)).toBe("other.org is not one of this module's hosts");
  });

  it("allows matching hosts, and any public host without an allowlist", () => {
    expect(checkUrl("https://a.example.com/x", policy)).toBeUndefined();
    expect(checkUrl("https://api.test/", policy)).toBeUndefined();
    expect(checkUrl("https://other.org/", { schemes: ["https:"] })).toBeUndefined();
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
    const headers = {
      Cookie: "a=b", cookie2: "x", Host: "h", "Content-Length": "1", Connection: "x", "Transfer-Encoding": "x", "Keep-Alive": "x",
      Upgrade: "x", TE: "x", Trailer: "x", Expect: "x", Via: "x", "Proxy-Authorization": "x", "Proxy-Connection": "x", "Proxy-Foo": "x",
      "Sec-Fetch-Mode": "x", "sec-ch-ua": "x", Authorization: "Bearer t", "X-Custom": "1",
    };
    await performHttp(fetchImpl, req({ headers }), policy);
    expect(fetchImpl.mock.calls[0]![1].headers).toEqual({ Authorization: "Bearer t", "X-Custom": "1" });
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

  it.each([[303], [301], [302]])("switches POST to GET without a body on %i", async (status) => {
    const fetchImpl = fetchOf(redirect(status, "/n"), new Response("ok"));
    await performHttp(fetchImpl, req({ method: "POST", body: "x" }), policy);
    expect(fetchImpl.mock.calls[1]![1]).toMatchObject({ method: "GET", body: undefined });
  });

  it("switches PUT to GET on 303 but keeps it on 301", async () => {
    const a = fetchOf(redirect(303, "/n"), new Response("ok"));
    await performHttp(a, req({ method: "PUT", body: "x" }), policy);
    expect(a.mock.calls[1]![1].method).toBe("GET");
    const b = fetchOf(redirect(301, "/n"), new Response("ok"));
    await performHttp(b, req({ method: "PUT", body: "x" }), policy);
    expect(b.mock.calls[1]![1]).toMatchObject({ method: "PUT", body: "x" });
  });

  it.each([[307], [308]])("keeps method and body on %i", async (status) => {
    const fetchImpl = fetchOf(redirect(status, "/n"), new Response("ok"));
    await performHttp(fetchImpl, req({ method: "POST", body: "x" }), policy);
    expect(fetchImpl.mock.calls[1]![1]).toMatchObject({ method: "POST", body: "x" });
  });

  it("allows MAX_REDIRECTS hops but not more", async () => {
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
    const fake = { status: 200, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(MAX_HTTP_BODY + 1) } as unknown as Response;
    await expect(performHttp(fetchOf(fake), req(), policy)).rejects.toThrow("Response too large");
  });

  it("checks the final URL when the fetch followed redirects itself", async () => {
    const landed = new Response("x");
    Object.defineProperty(landed, "url", { value: "https://127.0.0.1/admin" });
    const fetchImpl = vi.fn(async () => landed);
    await expect(performHttp(fetchImpl, { url: "https://api.example.com/", method: "GET", headers: {} }, { schemes: ["https:"] }, "follow")).rejects.toThrow("Request blocked");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.example.com/", expect.objectContaining({ redirect: "follow" }));
  });
});
