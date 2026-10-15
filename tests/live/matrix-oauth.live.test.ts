// Live check of Multicord's Matrix sign-in in the browser (Matrix's OAuth 2.0
// API with the device authorization grant, RFC 8628) against a real Synapse
// that hands its accounts to the Matrix Authentication Service (MAS), as
// matrix.org does. Skipped unless these name the homeserver and an account on
// MAS (plain http, as Docker publishes them):
//
//   MULTICORD_LIVE_MAS=http://localhost:19008 \
//   MULTICORD_LIVE_MAS_USER=alice MULTICORD_LIVE_MAS_PASSWORD=... \
//     npx vitest run tests/live/matrix-oauth.live.test.ts
//
// The servers:
// - MAS (ghcr.io/element-hq/matrix-authentication-service) with a config from
//   `mas-cli config generate`, on Postgres, with http.public_base and
//   http.issuer set to https://localhost:<its port>/, matrix.homeserver the
//   server name and matrix.endpoint Synapse's address inside Docker, and
//   experimental.access_token_ttl short (e.g. 120) so the refresh tests do
//   not wait long. The account is made with
//   `mas-cli manage register-user -c <config> --yes --password ... -e <email> <user>`.
// - Synapse with public_baseurl https://localhost:<its port>/ and
//   matrix_authentication_service { enabled: true, endpoint: <MAS inside
//   Docker>, secret: <MAS's matrix.secret> }.
//
// Multicord only talks https; the test's fetch carries its https requests to
// the plain http servers, as a TLS proxy would, and sends the homeserver's
// login, logout and refresh endpoints to MAS, as the reverse proxy in MAS's
// docs does. The user's browser is played by plain HTTP requests with a
// cookie jar, which fill in MAS's own pages (code, password, consent). The
// Electron shell (opening the link in the system browser) is not part of
// this: the module's code runs here on Node's fetch.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MxSession } from "../../src/modules/matrix/api";
import { MatrixAdapter } from "../../src/modules/matrix/adapter";
import { createMatrixClient } from "../../src/modules/matrix/client";
import { createOAuthClient, newDeviceId, OAuthError, type MatrixOAuth, type OAuthServer } from "../../src/modules/matrix/oauth";
import type { NativeViewState } from "../../src/shared/native";

const LIVE = process.env.MULTICORD_LIVE_MAS ?? "";
const USER = process.env.MULTICORD_LIVE_MAS_USER ?? "";
const PASSWORD = process.env.MULTICORD_LIVE_MAS_PASSWORD ?? "";

/** An http(s) URL on localhost as plain http on IPv4 (Docker publishes there). */
const plain = (url: string) => url.replace(/^https:/, "http:").replace("//localhost", "//127.0.0.1").replace(/\/+$/, "");
/** The homeserver as Multicord is given it. */
const HTTPS = LIVE ? `https://${new URL(LIVE).host}` : "";
const HS = plain(LIVE);
/** MAS's plain http address, found from the homeserver. */
let AUTH = "";
/** Whether the homeserver's compatibility endpoints go to MAS, as MAS's docs have the reverse proxy do. */
let compatProxy = true;
const COMPAT = /^\/_matrix\/client\/(?:api\/v1|r0|v3|unstable)\/(?:login|logout|refresh)(?:\/|$|\?)/;

/** Multicord's fetch: https to localhost goes to the plain http servers; the compatibility endpoints to MAS. */
const liveFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/^https:\/\/localhost[:/]/.test(url)) return fetch(url, init);
  let target = url.replace(/^https:\/\/localhost/, "http://127.0.0.1");
  if (compatProxy && url.startsWith(`${HTTPS}/`) && COMPAT.test(url.slice(HTTPS.length))) target = AUTH + url.slice(HTTPS.length);
  return fetch(target, init);
};

async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const unescape = (value: string) => value.replaceAll("&amp;", "&").replaceAll("&#x2f;", "/").replaceAll("&#x2F;", "/");

/**
 * The user in their browser: opens MAS's link page, enters the code, signs in
 * if asked and allows (or declines) the device. Returns the last page's text.
 */
async function browser(userCode: string, decision: "consent" | "reject" = "consent", user = USER, password = PASSWORD): Promise<string> {
  const jar = new Map<string, string>();
  async function go(url: string, init: RequestInit = {}): Promise<{ url: string; html: string }> {
    for (let hop = 0; hop < 10; hop++) {
      const response = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!;
        jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        url = plain(new URL(location, url).href);
        init = {};
        continue;
      }
      return { url, html: await response.text() };
    }
    throw new Error("Too many redirects");
  }
  let page = await go(`${AUTH}/link?code=${encodeURIComponent(userCode)}`);
  // Each page is answered once: a form that comes back means MAS refused it (and MAS rate-limits code attempts).
  const answered = new Set<string>();
  for (let step = 0; step < 6; step++) {
    const forms = [...page.html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map(([, attrs, body]) => ({
      action: unescape(/action="([^"]*)"/.exec(attrs!)?.[1] ?? ""),
      inputs: [...body!.matchAll(/<(?:input|button)\b([^>]*)>/g)].map(([, a]) => ({ name: /name="([^"]*)"/.exec(a!)?.[1] ?? "", value: /value="([^"]*)"/.exec(a!)?.[1] ?? "", type: /type="([^"]*)"/.exec(a!)?.[1] ?? "" })),
    }));
    const has = (form: (typeof forms)[number], name: string, value?: string) => form.inputs.some((i) => i.name === name && (value === undefined || i.value === value));
    const form = forms.find((f) => has(f, "action", decision)) ?? forms.find((f) => has(f, "username") && has(f, "password")) ?? forms.find((f) => has(f, "code"));
    const kind = form && (has(form, "action") ? "consent" : has(form, "password") ? "password" : "code");
    if (!form || answered.has(kind!)) return text(page.html);
    answered.add(kind!);
    const body = new URLSearchParams();
    for (const input of form.inputs) {
      if (!input.name) continue;
      if (input.name === "action" && input.value !== decision) continue;
      const filled: Record<string, string> = { code: userCode, username: user, password, confirm_device: "on" };
      body.set(input.name, filled[input.name] ?? input.value);
    }
    page = await go(form.action ? plain(new URL(form.action, page.url).href) : page.url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  }
  return text(page.html);
}

/** A raw client-server call with this token, as another app would make it. */
async function whoami(token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${HS}/_matrix/client/v3/account/whoami`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A token request at MAS as another app would make it. */
async function tokenRequest(form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${AUTH}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Multicord's Matrix adapter, as the engine builds it (the client refreshes tokens through the adapter). */
function multicord(secrets = new Map<string, string>()) {
  const renders: NativeViewState[] = [];
  const registrations: string[] = [];
  const oauthClient = createOAuthClient(liveFetch);
  const oauth: MatrixOAuth = {
    ...oauthClient,
    register: async (server) => {
      const id = await oauthClient.register(server);
      registrations.push(id);
      return id;
    },
  };
  let adapter: MatrixAdapter | undefined;
  const api = createMatrixClient(liveFetch, { refresh: (session) => adapter!.refreshSession(session) });
  adapter = new MatrixAdapter({
    def: { id: "matrix-oauth-live", name: "Matrix", url: HTTPS },
    secrets: {
      load: async (k) => secrets.get(k),
      save: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    },
    render: (state) => renders.push(state),
    api,
    oauth,
    log: () => undefined,
  });
  const last = () => renders.at(-1);
  const prompt = (id: string) => {
    const state = last();
    return state?.screen === "prompt" && state.prompt.id === id && !state.busy ? state : undefined;
  };
  const chat = () => (last()?.screen === "chat" ? last() : undefined);
  const stored = () => JSON.parse(secrets.get("session") ?? "null") as MxSession | null;
  /** The session the adapter is using (the client refreshes it in place). */
  const live = () => (adapter as unknown as { session?: MxSession }).session;
  /** Presses "Sign in with the browser" and returns the code Multicord shows. */
  async function getCode(): Promise<string> {
    await until(() => prompt("oauth"), "the browser sign-in screen");
    await adapter!.handleAction({ type: "prompt", id: "oauth", values: {} });
    const device = await until(() => prompt("device"), "the sign-in code");
    const code = /^Your code: (.+)$/.exec(device.prompt.title)?.[1];
    expect(code).toBeTruthy();
    expect(device.prompt.link?.url).toMatch(/^https:\/\/localhost:\d+\/link/);
    return code!;
  }
  return { adapter, api, secrets, renders, registrations, last, prompt, chat, stored, live, getCode };
}

describe.skipIf(!LIVE || !USER || !PASSWORD)("Matrix browser sign-in against a live Matrix Authentication Service", { timeout: 120_000 }, () => {
  const oauth = createOAuthClient(liveFetch);
  let server: OAuthServer;
  let clientId: string;
  const adapters: MatrixAdapter[] = [];

  beforeAll(async () => {
    const metadata = (await (await fetch(`${HS}/_matrix/client/v1/auth_metadata`)).json()) as { issuer: string };
    AUTH = plain(metadata.issuer);
  });

  afterAll(async () => {
    // Stops their sync loops; the sessions they still hold are ended by the sign-out test or expire.
    for (const adapter of adapters) (adapter as unknown as { generation: number }).generation++;
  });

  it("finds the account server from the homeserver and registers Multicord with it", async () => {
    server = (await oauth.discover(HTTPS))!;
    expect(server).toMatchObject({
      issuer: `${new URL(server.issuer).origin}/`,
      deviceEndpoint: expect.stringMatching(/^https:\/\/localhost:\d+\/oauth2\/device$/),
      tokenEndpoint: expect.stringMatching(/\/oauth2\/token$/),
      registrationEndpoint: expect.stringMatching(/\/oauth2\/registration$/),
      revocationEndpoint: expect.stringMatching(/\/oauth2\/revoke$/),
    });
    // MAS accepts Multicord's metadata as it is (native, public, device grant without redirect URIs).
    clientId = await oauth.register(server);
    expect(clientId).toMatch(/^[0-9A-Z]{26}$/);
  });

  it("keeps an unapproved code pending, and gives its tokens only once, to the app that asked", async () => {
    // MAS gives identical registrations the same client id (every Multicord shares one), so the other app differs in name.
    expect(await oauth.register(server)).toBe(clientId);
    const registered = await fetch(plain(server.registrationEndpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Another app", application_type: "native", token_endpoint_auth_method: "none", grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"] }),
    });
    const other = ((await registered.json()) as { client_id: string }).client_id;
    expect(other).not.toBe(clientId);
    const grant = await oauth.authorizeDevice(server, clientId, newDeviceId());
    expect(grant.userCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(grant.verificationUri).toMatch(/^https:\/\/localhost:\d+\/link$/);
    expect(await oauth.pollDevice(server, clientId, grant.deviceCode)).toEqual({ state: "pending" });
    // Codes that are not this app's are refused, not pending.
    await expect(oauth.pollDevice(server, other, grant.deviceCode)).rejects.toBeInstanceOf(OAuthError);
    await expect(oauth.pollDevice(server, clientId, "not-a-device-code")).rejects.toBeInstanceOf(OAuthError);
    // A wrong code typed in the browser grants nothing.
    expect(await browser("ZZZZZZ")).not.toMatch(/Access granted/);
    expect(await oauth.pollDevice(server, clientId, grant.deviceCode)).toEqual({ state: "pending" });

    expect(await browser(grant.userCode)).toMatch(/Access granted/);
    // Another app holding the device code still gets nothing.
    await expect(oauth.pollDevice(server, other, grant.deviceCode)).rejects.toBeInstanceOf(OAuthError);
    const done = await oauth.pollDevice(server, clientId, grant.deviceCode);
    expect(done.state).toBe("done");
    const tokens = done.state === "done" ? done.tokens : undefined;
    expect(tokens).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String), expiresAt: expect.any(Number) });
    await expect(oauth.pollDevice(server, clientId, grant.deviceCode)).rejects.toBeInstanceOf(OAuthError);
    expect((await whoami(tokens!.accessToken)).status).toBe(200);
    // Another app cannot revoke it: the refresh token still works at MAS (and gives new tokens).
    const session = { clientId: other, tokenEndpoint: server.tokenEndpoint, revocationEndpoint: server.revocationEndpoint!, refreshToken: tokens!.refreshToken! };
    await expect(oauth.revoke(session, tokens!.refreshToken!, "refresh_token")).rejects.toBeInstanceOf(OAuthError);
    const fresh = await oauth.refresh({ ...session, clientId });
    expect(fresh.accessToken).not.toBe(tokens!.accessToken);
    // Revoking it as Multicord ends the session: at MAS at once, at the homeserver once it hears.
    await oauth.revoke({ ...session, clientId }, fresh.refreshToken!, "refresh_token");
    expect(await tokenRequest({ grant_type: "refresh_token", refresh_token: fresh.refreshToken!, client_id: clientId })).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    await until(async () => (await whoami(fresh.accessToken)).body.errcode === "M_UNKNOWN_TOKEN", "the homeserver to refuse the revoked token", 30_000);
  });

  it("reports a declined sign-in", async () => {
    const mc = multicord();
    adapters.push(mc.adapter);
    await mc.adapter.start();
    const code = await mc.getCode();
    expect(await browser(code, "reject")).not.toMatch(/Access granted/);
    const back = await until(() => mc.prompt("oauth"), "the sign-in screen again", 30_000);
    expect(back.error).toBe("The sign-in was declined.");
    expect(mc.stored()).toBeNull();
  });

  let mc: ReturnType<typeof multicord>;

  it("signs in with a code approved in the browser and gets a device of its own", async () => {
    mc = multicord();
    adapters.push(mc.adapter);
    await mc.adapter.start();
    // MAS offers password sign-in to other apps too (through its compatibility layer).
    const signIn = await until(() => mc.prompt("oauth"), "the browser sign-in screen");
    expect(signIn.prompt.cancel).toBe("Use a password instead");
    const code = await mc.getCode();
    expect(await browser(code)).toMatch(/Access granted/);
    await until(() => mc.chat(), "Multicord's first sync");
    const session = mc.stored()!;
    expect(session).toMatchObject({
      baseUrl: HTTPS,
      userId: expect.stringMatching(new RegExp(`^@${USER}:`)),
      deviceId: expect.stringMatching(/^[A-Z0-9]{10}$/),
      ownDevice: true,
      oauth: { clientId: mc.registrations[0], tokenEndpoint: server.tokenEndpoint, revocationEndpoint: server.revocationEndpoint, refreshToken: expect.any(String), expiresAt: expect.any(Number) },
    });
    // The device the scope asked for is the one the homeserver knows.
    expect((await whoami(session.accessToken)).body).toMatchObject({ user_id: session.userId, device_id: session.deviceId });
    expect(mc.adapter.accountStatus()).toEqual({ state: "signed-in", name: session.userId });
  });

  it("refreshes the token before it expires and keeps syncing", async () => {
    const session = mc.live()!;
    const before = session.accessToken;
    const refreshBefore = session.oauth!.refreshToken;
    // Due now: the next call refreshes first.
    session.oauth!.expiresAt = Date.now();
    await mc.api.check(session);
    expect(session.accessToken).not.toBe(before);
    expect(session.oauth!.refreshToken).not.toBe(refreshBefore);
    expect(session.oauth!.expiresAt).toBeGreaterThan(Date.now());
    // Stored for the next start.
    expect(mc.stored()).toMatchObject({ accessToken: session.accessToken, oauth: { refreshToken: session.oauth!.refreshToken } });
    expect((await whoami(session.accessToken)).status).toBe(200);
    expect(mc.chat()).toBeTruthy();
  });

  // Waits out the token's lifetime: MAS's experimental.access_token_ttl, 300 s unless set shorter.
  it("refreshes when the homeserver says the token expired (a clock that runs behind)", { timeout: 420_000 }, async () => {
    const session = mc.live()!;
    const token = session.accessToken;
    const lifetime = session.oauth!.expiresAt! - Date.now();
    // The local clock thinks the token is good for an hour; the server's says otherwise.
    session.oauth!.expiresAt = Date.now() + 3600_000;
    await until(async () => (await whoami(token)).status === 401, "the access token to expire at the server", Math.min(lifetime + 30_000, 340_000));
    // The sync loop's next request is refused; Multicord refreshes and carries on.
    await until(() => mc.live()?.accessToken !== token || mc.prompt("oauth"), "Multicord to notice", 60_000);
    expect(mc.prompt("oauth")).toBeUndefined();
    expect(mc.live()!.accessToken).not.toBe(token);
    expect((await whoami(mc.live()!.accessToken)).status).toBe(200);
    expect(mc.stored()?.accessToken).toBe(mc.live()!.accessToken);
  });

  it("resumes the stored session on the next start, reusing its client registration", async () => {
    // The first adapter stops, as the app would on quitting.
    (mc.adapter as unknown as { generation: number }).generation++;
    const next = multicord(mc.secrets);
    adapters.push(next.adapter);
    await next.adapter.start();
    await until(() => next.chat(), "the resumed session's sync");
    expect(next.registrations).toEqual([]);
    mc = next;
  });

  it("ends the session at the account server on sign-out", async () => {
    const session = mc.live()!;
    const { accessToken, oauth: grant } = session;
    await mc.adapter.handleAction({ type: "logout" });
    await until(() => mc.prompt("oauth"), "the sign-in screen after signing out");
    expect(mc.stored()).toBeNull();
    // Neither token works any more (the homeserver hears of it from MAS shortly after).
    await until(async () => (await whoami(accessToken)).body.errcode === "M_UNKNOWN_TOKEN", "the homeserver to refuse the revoked token", 30_000);
    const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: grant!.refreshToken!, client_id: grant!.clientId });
    expect(refreshed).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
  });

  it("signs in again with the stored client registration", async () => {
    const code = await mc.getCode();
    expect(await browser(code)).toMatch(/Access granted/);
    await until(() => mc.chat(), "the second sign-in's sync");
    expect(mc.registrations).toEqual([]);
    expect(mc.stored()?.oauth?.clientId).toBe(JSON.parse(mc.secrets.get("oauth-client")!).clientId);
    await mc.adapter.handleAction({ type: "logout" });
    await until(() => mc.prompt("oauth"), "the sign-in screen after signing out");
  });

  it("still offers browser sign-in when the homeserver's login endpoint is not routed to the account server", async () => {
    compatProxy = false;
    try {
      const bare = multicord();
      adapters.push(bare.adapter);
      await bare.adapter.start();
      await until(() => bare.prompt("oauth") || bare.prompt("retry"), "a sign-in screen");
      expect(bare.prompt("oauth")).toBeTruthy();
    } finally {
      compatProxy = true;
    }
  });
});
