import { request } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { isSsoUrl, LOGIN_TOKEN, receiveLoginToken } from "../../src/main/ssoLoopback";

const SSO = "https://hs.x.org/_matrix/client/v3/login/sso/redirect";

/** A GET to the loopback server as a browser would make it, with the Host header given. */
function get(url: string, host?: string, method = "GET", path?: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: target.port, path: path ?? `${target.pathname}${target.search}`, method, headers: { Host: host ?? target.host } }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Starts a sign-on and gives the loopback address the browser was sent back to. */
async function start(options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  let opened = "";
  const open = vi.fn(async (url: string) => void (opened = url));
  const token = receiveLoginToken(SSO, { open, timeoutMs: options.timeoutMs }, options.signal);
  // Handled here too, so a failure before the test looks is no unhandled rejection.
  token.catch(() => undefined);
  await vi.waitFor(() => expect(open).toHaveBeenCalled());
  const redirect = new URL(new URL(opened).searchParams.get("redirectUrl")!);
  return { token, open, opened, redirect };
}

describe("single sign-on addresses", () => {
  it("takes a homeserver's SSO redirect over https only, without a query of its own", () => {
    expect(isSsoUrl(SSO)).toBe(true);
    expect(isSsoUrl("https://hs.x.org/_matrix/client/r0/login/sso/redirect/oidc-github")).toBe(true);
    for (const bad of [
      "http://hs.x.org/_matrix/client/v3/login/sso/redirect",
      `${SSO}?redirectUrl=https://evil.example`,
      `${SSO}#x`,
      "https://user:pw@hs.x.org/_matrix/client/v3/login/sso/redirect",
      "https://hs.x.org/_matrix/client/v3/login",
      "https://hs.x.org/_matrix/client/v3/login/sso/redirect/a/b",
      "not a url",
    ]) {
      expect(isSsoUrl(bad)).toBe(false);
    }
    expect(LOGIN_TOKEN.test("syl_abc123_DEF+/=")).toBe(true);
    expect(LOGIN_TOKEN.test("a b")).toBe(false);
  });
});

describe("receiving a login token on loopback", () => {
  it("sends the browser to the homeserver with a random loopback address, and takes exactly one token there", async () => {
    const { token, opened, redirect } = await start();
    expect(opened.startsWith(`${SSO}?redirectUrl=`)).toBe(true);
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(redirect.pathname).toMatch(/^\/sso\/[0-9a-f]{48}$/);
    // Other paths, other methods and other host names get nothing, and change nothing.
    expect((await get(`http://${redirect.host}/sso/guess?loginToken=x`)).status).toBe(404);
    expect((await get(redirect.href, undefined, "GET", "http://[")).status).toBe(404);
    expect((await get(`${redirect.href}?loginToken=x`, undefined, "POST")).status).toBe(404);
    expect((await get(`${redirect.href}?loginToken=x`, "evil.example")).status).toBe(404);
    const answer = await get(`${redirect.href}?loginToken=syl_good`);
    expect(answer.status).toBe(200);
    expect(answer.body).toContain("Signed in");
    expect(answer.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(await token).toBe("syl_good");
    // Closed after it: no second request gets through.
    await expect(get(`${redirect.href}?loginToken=syl_again`)).rejects.toThrow();
  });

  it("fails on a missing or malformed token, after time runs out, and when cancelled", async () => {
    const missing = await start();
    const failing = expect(missing.token).rejects.toThrow("no usable login token");
    expect((await get(missing.redirect.href)).status).toBe(400);
    await failing;
    const malformed = await start();
    const bad = expect(malformed.token).rejects.toThrow("no usable login token");
    expect((await get(`${malformed.redirect.href}?loginToken=a%20b`)).body).toContain("did not work");
    await bad;
    const slow = await start({ timeoutMs: 20 });
    await expect(slow.token).rejects.toThrow("timed out");
    const controller = new AbortController();
    const cancelled = await start({ signal: controller.signal });
    controller.abort();
    await expect(cancelled.token).rejects.toThrow("cancelled");
    await expect(receiveLoginToken(SSO, { open: vi.fn(async () => {}) }, AbortSignal.abort())).rejects.toThrow("cancelled");
  });

  it("fails when the browser cannot be opened", async () => {
    await expect(receiveLoginToken(SSO, { open: async () => Promise.reject(new Error("no browser")) })).rejects.toThrow("no browser");
    await expect(receiveLoginToken(SSO, { open: async () => Promise.reject("odd") })).rejects.toThrow("odd");
  });
});
