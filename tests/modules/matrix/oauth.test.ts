import { describe, expect, it, vi } from "vitest";
import {
  CLIENT_METADATA,
  createOAuthClient,
  httpsUrl,
  newDeviceId,
  OAuthError,
  parseDeviceGrant,
  parseServer,
  parseTokens,
  SCOPES,
  type OAuthServer,
} from "../../../src/modules/matrix/oauth";

const NOW = 1_000_000;
const BASE = "https://hs.x.org";
const METADATA = {
  issuer: "https://account.x.org/",
  device_authorization_endpoint: "https://account.x.org/oauth2/device",
  token_endpoint: "https://account.x.org/oauth2/token",
  registration_endpoint: "https://account.x.org/oauth2/registration",
  revocation_endpoint: "https://account.x.org/oauth2/revoke",
  grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
};
const SERVER: OAuthServer = {
  issuer: "https://account.x.org/",
  deviceEndpoint: "https://account.x.org/oauth2/device",
  tokenEndpoint: "https://account.x.org/oauth2/token",
  registrationEndpoint: "https://account.x.org/oauth2/registration",
  revocationEndpoint: "https://account.x.org/oauth2/revoke",
};
const OAUTH = { clientId: "client1", tokenEndpoint: SERVER.tokenEndpoint, revocationEndpoint: SERVER.revocationEndpoint, refreshToken: "refresh1" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchFn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => respond(String(input), init));
  return { fetchFn, client: createOAuthClient(fetchFn as unknown as typeof fetch, () => NOW) };
}

/** The form fields of a call. */
const form = (fetchFn: ReturnType<typeof vi.fn>, index = 0) => Object.fromEntries(new URLSearchParams((fetchFn.mock.calls[index]![1] as RequestInit).body as string));

describe("parsing", () => {
  it("accepts https URLs without credentials only", () => {
    expect(httpsUrl("https://a.org/x")).toBe("https://a.org/x");
    expect(httpsUrl("http://a.org")).toBeUndefined();
    expect(httpsUrl("https://u:p@a.org")).toBeUndefined();
    expect(httpsUrl("nope")).toBeUndefined();
    expect(httpsUrl(`https://a.org/${"x".repeat(2000)}`)).toBeUndefined();
    expect(httpsUrl(5)).toBeUndefined();
  });

  it("makes device ids of ten letters and digits, evenly", () => {
    expect(newDeviceId()).toMatch(/^[A-Z0-9]{10}$/);
    // Bytes of 252 and over are skipped, the rest map onto the alphabet.
    let call = 0;
    const random = (bytes: Uint8Array) => bytes.fill(call++ === 0 ? 255 : 37);
    expect(newDeviceId(random)).toBe("BBBBBBBBBB");
  });

  it("reads server metadata usable for device sign-in", () => {
    expect(parseServer(METADATA)).toEqual(SERVER);
    const { revocation_endpoint: _r, grant_types_supported: _g, ...minimal } = METADATA;
    const { revocationEndpoint: _revocation, ...withoutRevocation } = SERVER;
    expect(parseServer(minimal)).toEqual(withoutRevocation);
    expect(parseServer({ ...METADATA, grant_types_supported: ["authorization_code"] })).toBeUndefined();
    expect(parseServer({ ...METADATA, device_authorization_endpoint: undefined })).toBeUndefined();
    expect(parseServer({ ...METADATA, token_endpoint: "http://account.x.org/token" })).toBeUndefined();
    expect(parseServer({ ...METADATA, registration_endpoint: 1 })).toBeUndefined();
    expect(parseServer({ ...METADATA, issuer: "nope" })).toBeUndefined();
    expect(parseServer({ ...METADATA, revocation_endpoint: "http://x" })).not.toHaveProperty("revocationEndpoint");
    expect(parseServer([])).toBeUndefined();
  });

  it("reads token responses", () => {
    expect(parseTokens({ access_token: "a", refresh_token: "r", expires_in: 300, token_type: "Bearer" }, NOW)).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: NOW + 300_000 });
    expect(parseTokens({ access_token: "a", token_type: "bearer", refresh_token: "bad token", expires_in: -1 }, NOW)).toEqual({ accessToken: "a" });
    expect(parseTokens({ access_token: "a", expires_in: 1e12 }, NOW).expiresAt).toBe(NOW + 10 * 365 * 24 * 3600 * 1000);
    expect(() => parseTokens({ access_token: "a", token_type: "mac" }, NOW)).toThrow("unreadable token");
    expect(() => parseTokens({ access_token: "with space" }, NOW)).toThrow();
    expect(() => parseTokens({ access_token: "x".repeat(5000) }, NOW)).toThrow();
    expect(() => parseTokens(null, NOW)).toThrow();
  });

  it("reads device grants, with defaults and bounds", () => {
    const grant = { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://account.x.org/link", expires_in: 1200, interval: 5 };
    expect(parseDeviceGrant(grant, NOW)).toEqual({ deviceCode: "dc", userCode: "ABCD-1234", verificationUri: "https://account.x.org/link", expiresAt: NOW + 1_200_000, interval: 5000 });
    expect(parseDeviceGrant({ ...grant, verification_uri_complete: "https://account.x.org/link?code=1", expires_in: undefined, interval: 0 }, NOW)).toMatchObject({
      verificationUriComplete: "https://account.x.org/link?code=1",
      expiresAt: NOW + 600_000,
      interval: 5000,
    });
    expect(parseDeviceGrant({ ...grant, expires_in: 99999, interval: 999 }, NOW)).toMatchObject({ expiresAt: NOW + 3_600_000, interval: 60_000 });
    expect(parseDeviceGrant({ ...grant, verification_uri_complete: "javascript:x" }, NOW)).not.toHaveProperty("verificationUriComplete");
    for (const bad of [{ user_code: "<b>hi</b>" }, { user_code: 5 }, { device_code: "" }, { device_code: 1 }, { verification_uri: "http://x.org" }]) {
      expect(() => parseDeviceGrant({ ...grant, ...bad }, NOW)).toThrow("unreadable sign-in code");
    }
    expect(() => parseDeviceGrant(undefined, NOW)).toThrow();
  });
});

describe("discovery", () => {
  it("uses the spec's auth_metadata", async () => {
    const { client, fetchFn } = fakeFetch(() => json(METADATA));
    expect(await client.discover(BASE)).toEqual(SERVER);
    expect(fetchFn.mock.calls[0]![0]).toBe(`${BASE}/_matrix/client/v1/auth_metadata`);
  });

  it("falls back to the unstable auth_metadata", async () => {
    const { client } = fakeFetch((url) => (url.includes("/unstable/org.matrix.msc2965/auth_metadata") ? json(METADATA) : json({ errcode: "M_UNRECOGNIZED" }, 404)));
    expect(await client.discover(BASE)).toEqual(SERVER);
  });

  it("falls back to auth_issuer and the issuer's OpenID configuration", async () => {
    const { client, fetchFn } = fakeFetch((url) => {
      if (url.endsWith("/auth_issuer")) return json({ issuer: "https://account.x.org/" });
      if (url === "https://account.x.org/.well-known/openid-configuration") return json(METADATA);
      return Promise.reject(new Error("offline"));
    });
    expect(await client.discover(BASE)).toEqual(SERVER);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("refuses a configuration for another issuer, and servers without one", async () => {
    const other = fakeFetch((url) => (url.endsWith("/auth_issuer") ? json({ issuer: "https://account.x.org/" }) : url.includes("openid") ? json({ ...METADATA, issuer: "https://evil.org/" }) : new Response("", { status: 404 })));
    expect(await other.client.discover(BASE)).toBeUndefined();
    const none = fakeFetch(() => new Response("", { status: 404 }));
    expect(await none.client.discover(BASE)).toBeUndefined();
    const junk = fakeFetch((url) => (url.endsWith("/auth_issuer") ? json({ issuer: "http://insecure" }) : new Response("{", { status: 200 })));
    expect(await junk.client.discover(BASE)).toBeUndefined();
  });
});

describe("registration", () => {
  it("registers Multicord as a native public client for the device grant", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ client_id: "client1", grant_types: ["refresh_token", "urn:ietf:params:oauth:grant-type:device_code"] }, 201));
    expect(await client.register(SERVER)).toBe("client1");
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(SERVER.registrationEndpoint);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(CLIENT_METADATA);
    expect(CLIENT_METADATA).toEqual({
      client_name: "Multicord",
      client_uri: "https://github.com/sverredraaisma/Multicord",
      application_type: "native",
      token_endpoint_auth_method: "none",
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    });
  });

  it("fails when the server drops the device grant or answers oddly", async () => {
    const dropped = fakeFetch(() => json({ client_id: "c", grant_types: [] }, 201));
    await expect(dropped.client.register(SERVER)).rejects.toMatchObject({ code: "unauthorized_client" });
    const noId = fakeFetch(() => json({}, 201));
    await expect(noId.client.register(SERVER)).rejects.toThrow("unreadable registration");
    const array = fakeFetch(() => json([], 201));
    await expect(array.client.register(SERVER)).rejects.toThrow("unreadable registration");
    const refused = fakeFetch(() => json({ error: "invalid_client_metadata", error_description: "bad uri" }, 400));
    await expect(refused.client.register(SERVER)).rejects.toEqual(new OAuthError("invalid_client_metadata", "bad uri"));
    const broken = fakeFetch(() => new Response("oops", { status: 500 }));
    await expect(broken.client.register(SERVER)).rejects.toMatchObject({ code: "server_error", message: "HTTP 500" });
  });
});

describe("device authorization", () => {
  const GRANT = { device_code: "dc", user_code: "ABC123", verification_uri: "https://account.x.org/link", expires_in: 1200, interval: 5 };

  it("asks for API access on a device of its own", async () => {
    const { client, fetchFn } = fakeFetch(() => json(GRANT));
    expect(await client.authorizeDevice(SERVER, "client1", "ABCDEFGHIJ")).toMatchObject({ deviceCode: "dc", userCode: "ABC123" });
    expect(fetchFn.mock.calls[0]![0]).toBe(SERVER.deviceEndpoint);
    expect(form(fetchFn)).toEqual({ client_id: "client1", scope: "openid urn:matrix:client:api:* urn:matrix:client:device:ABCDEFGHIJ" });
    expect((fetchFn.mock.calls[0]![1] as { headers: Record<string, string> }).headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("uses the MSC2967 scopes where the spec's are unknown", async () => {
    const { client, fetchFn } = fakeFetch((_url, init) => (String(init.body).includes("org.matrix.msc2967") ? json(GRANT) : json({ error: "invalid_scope" }, 400)));
    await client.authorizeDevice(SERVER, "client1", "ABCDEFGHIJ");
    expect(form(fetchFn, 1).scope).toBe(SCOPES.unstable("ABCDEFGHIJ"));
  });

  it("passes on other failures and refuses odd device ids", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ error: "unauthorized_client" }, 400));
    await expect(client.authorizeDevice(SERVER, "client1", "ABCDEFGHIJ")).rejects.toMatchObject({ code: "unauthorized_client" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await expect(client.authorizeDevice(SERVER, "client1", "a b")).rejects.toThrow("Invalid device id");
    const offline = fakeFetch(() => Promise.reject(new Error("offline")));
    await expect(offline.client.authorizeDevice(SERVER, "c", "ABCDEFGHIJ")).rejects.toThrow("offline");
  });

  it.each([
    ["authorization_pending", 403, "pending"],
    ["authorization_pending", 400, "pending"],
    ["slow_down", 400, "slow_down"],
    ["access_denied", 400, "denied"],
    ["expired_token", 400, "expired"],
  ])("polls: %s (%i) is %s", async (error, status, state) => {
    const { client, fetchFn } = fakeFetch(() => json({ error }, status));
    expect(await client.pollDevice(SERVER, "client1", "dc")).toEqual({ state });
    expect(form(fetchFn)).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "dc", client_id: "client1" });
  });

  it("polls until tokens arrive, and passes on other errors", async () => {
    const done = fakeFetch(() => json({ access_token: "at", refresh_token: "rt", expires_in: 300, token_type: "Bearer" }));
    expect(await done.client.pollDevice(SERVER, "client1", "dc")).toEqual({ state: "done", tokens: { accessToken: "at", refreshToken: "rt", expiresAt: NOW + 300_000 } });
    const odd = fakeFetch(() => json({ error: "invalid_client" }, 401));
    await expect(odd.client.pollDevice(SERVER, "client1", "dc")).rejects.toMatchObject({ code: "invalid_client" });
    const offline = fakeFetch(() => Promise.reject(new Error("offline")));
    await expect(offline.client.pollDevice(SERVER, "client1", "dc")).rejects.toThrow("offline");
  });
});

describe("tokens", () => {
  it("refreshes, keeping the refresh token when the server keeps it", async () => {
    const same = fakeFetch(() => json({ access_token: "at2", expires_in: 60 }));
    expect(await same.client.refresh(OAUTH)).toEqual({ accessToken: "at2", refreshToken: "refresh1", expiresAt: NOW + 60_000 });
    expect(form(same.fetchFn)).toEqual({ grant_type: "refresh_token", refresh_token: "refresh1", client_id: "client1" });
    const rotated = fakeFetch(() => json({ access_token: "at2", refresh_token: "refresh2" }));
    expect((await rotated.client.refresh(OAUTH)).refreshToken).toBe("refresh2");
  });

  it("cannot refresh without a refresh token, or when refused", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ error: "invalid_grant" }, 400));
    await expect(client.refresh({ ...OAUTH, refreshToken: undefined })).rejects.toMatchObject({ code: "invalid_grant" });
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(client.refresh(OAUTH)).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("revokes at the revocation endpoint, when there is one", async () => {
    const { client, fetchFn } = fakeFetch(() => new Response(null, { status: 200 }));
    await client.revoke(OAUTH, "refresh1", "refresh_token");
    expect(fetchFn.mock.calls[0]![0]).toBe(SERVER.revocationEndpoint);
    expect(form(fetchFn)).toEqual({ token: "refresh1", token_type_hint: "refresh_token", client_id: "client1" });
    await client.revoke({ ...OAUTH, revocationEndpoint: undefined }, "x", "access_token");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
