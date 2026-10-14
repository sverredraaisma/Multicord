import { describe, expect, it, vi } from "vitest";
import { MatrixError, matrixErrcode, type MxSession } from "../../../src/modules/matrix/api";
import { createMatrixClient, httpsBase, MAX_THUMBNAIL_BYTES, REFRESH_MARGIN_MS, SYNC_FILTER } from "../../../src/modules/matrix/client";

const BASE = "https://hs.x.org";
const SESSION: MxSession = { baseUrl: BASE, accessToken: "tok", userId: "@me:x.org", deviceId: "D", ownDevice: true };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fetch that answers with `respond` and records each call. */
function fakeFetch(respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const fetchFn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => respond(new URL(String(input)), init));
  return { fetchFn, client: createMatrixClient(fetchFn as unknown as typeof fetch) };
}

const callOf = (fetchFn: ReturnType<typeof vi.fn>, index = 0) => {
  const [url, init] = fetchFn.mock.calls[index] as [string, RequestInit & { headers: Record<string, string> }];
  return { url: new URL(url), init, body: init.body ? JSON.parse(init.body as string) : undefined };
};

describe("httpsBase", () => {
  it("keeps https URLs without credentials, query or trailing slash", () => {
    expect(httpsBase("https://x.org/")).toBe("https://x.org");
    expect(httpsBase("https://x.org/matrix//?a=1#b")).toBe("https://x.org/matrix");
    expect(httpsBase("http://x.org")).toBeUndefined();
    expect(httpsBase("https://u:p@x.org")).toBeUndefined();
    expect(httpsBase("not a url")).toBeUndefined();
    expect(httpsBase(5)).toBeUndefined();
  });
});

describe("discovery", () => {
  it("follows .well-known/matrix/client", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ "m.homeserver": { base_url: "https://matrix-client.x.org/" } }));
    expect(await client.discover("https://x.org/some/page")).toBe("https://matrix-client.x.org");
    expect(callOf(fetchFn).url.href).toBe("https://x.org/.well-known/matrix/client");
  });

  it.each([
    ["no document", () => new Response("", { status: 404 })],
    ["an unusable base URL", () => json({ "m.homeserver": { base_url: "http://insecure" } })],
    ["no homeserver entry", () => json({})],
    ["a non-object", () => json([1])],
    ["invalid JSON", () => new Response("{", { status: 200 })],
    ["a network failure", () => Promise.reject(new Error("offline"))],
  ])("uses the address itself with %s", async (_name, respond) => {
    const { client } = fakeFetch(respond);
    expect(await client.discover("https://hs.x.org/")).toBe("https://hs.x.org");
  });

  it("refuses addresses that are not https", async () => {
    const { client, fetchFn } = fakeFetch(() => json({}));
    await expect(client.discover("http://x.org")).rejects.toThrow("https");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("signing in", () => {
  it("reads the login flows", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ flows: [{ type: "m.login.sso" }, { type: "m.login.password" }] }));
    expect(await client.loginFlows(BASE)).toEqual({ password: true });
    expect(callOf(fetchFn).url.href).toBe(`${BASE}/_matrix/client/v3/login`);
    expect(callOf(fetchFn).init.headers).toEqual({ Accept: "application/json" });
    const sso = fakeFetch(() => json({ flows: [{ type: "m.login.sso" }, "junk"] }));
    expect(await sso.client.loginFlows(BASE)).toEqual({ password: false });
    const none = fakeFetch(() => json({}));
    expect(await none.client.loginFlows(BASE)).toEqual({ password: false });
  });

  it("logs in with a password as device Multicord", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ access_token: "T", user_id: "@me:x.org", device_id: "DEV" }));
    expect(await client.login(BASE, "me", "pw")).toEqual({ baseUrl: BASE, accessToken: "T", userId: "@me:x.org", deviceId: "DEV", ownDevice: true });
    const { init, body } = callOf(fetchFn);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(body).toEqual({ type: "m.login.password", identifier: { type: "m.id.user", user: "me" }, password: "pw", initial_device_display_name: "Multicord" });
  });

  it("takes a base URL the login response names", async () => {
    const { client } = fakeFetch(() => json({ access_token: "T", user_id: "@me:x.org", device_id: "D", well_known: { "m.homeserver": { base_url: "https://other.x.org" } } }));
    expect((await client.login(BASE, "me", "pw")).baseUrl).toBe("https://other.x.org");
    const bad = fakeFetch(() => json({ access_token: "T", user_id: "@me:x.org", device_id: "D", well_known: { "m.homeserver": { base_url: "ftp://x" } } }));
    expect((await bad.client.login(BASE, "me", "pw")).baseUrl).toBe(BASE);
    const odd = fakeFetch(() => json({ access_token: "T", user_id: "@me:x.org", device_id: "D", well_known: { other: 1 } }));
    expect((await odd.client.login(BASE, "me", "pw")).baseUrl).toBe(BASE);
  });

  it.each([
    { user_id: "@me:x.org", device_id: "D" },
    { access_token: "", user_id: "@me:x.org", device_id: "D" },
    { access_token: "x".repeat(5000), user_id: "@me:x.org", device_id: "D" },
    { access_token: "T", user_id: "me", device_id: "D" },
    { access_token: "T", user_id: "@me:x.org" },
    { access_token: "T", user_id: "@me:x.org", device_id: "" },
    { access_token: "T", user_id: "@me:x.org", device_id: "d".repeat(300) },
  ])("rejects a malformed login response %#", async (body) => {
    const { client } = fakeFetch(() => json(body));
    await expect(client.login(BASE, "me", "pw")).rejects.toThrow("unreadable sign-in");
  });

  it("raises Matrix errors with their code and message", async () => {
    const { client } = fakeFetch(() => json({ errcode: "M_FORBIDDEN", error: "Invalid password" }, 403));
    const error = await client.login(BASE, "me", "pw").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MatrixError);
    expect(error).toMatchObject({ status: 403, errcode: "M_FORBIDDEN", message: "Invalid password" });
    expect(matrixErrcode(error)).toBe("M_FORBIDDEN");
    expect(matrixErrcode(new Error("x"))).toBeUndefined();
  });

  it("names unknown errors by their HTTP status", async () => {
    const { client } = fakeFetch(() => new Response("<html>", { status: 502 }));
    await expect(client.loginFlows(BASE)).rejects.toMatchObject({ errcode: "M_UNKNOWN", message: "HTTP 502" });
    const empty = fakeFetch(() => json({ errcode: 5, error: "" }, 500));
    await expect(empty.client.loginFlows(BASE)).rejects.toMatchObject({ errcode: "M_UNKNOWN", message: "HTTP 500" });
  });

  it("rejects successful responses that are not JSON objects", async () => {
    const { client } = fakeFetch(() => json([]));
    await expect(client.loginFlows(BASE)).rejects.toThrow("unreadable response");
  });

  it("checks tokens with whoami", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ user_id: "@me:x.org", device_id: "D" }));
    expect(await client.whoami(BASE, "tok")).toEqual({ userId: "@me:x.org", deviceId: "D" });
    expect(callOf(fetchFn).init.headers).toMatchObject({ Authorization: "Bearer tok" });
    const noDevice = fakeFetch(() => json({ user_id: "@me:x.org", device_id: "" }));
    expect(await noDevice.client.whoami(BASE, "tok")).toEqual({ userId: "@me:x.org" });
    const longDevice = fakeFetch(() => json({ user_id: "@me:x.org", device_id: "d".repeat(300) }));
    expect(await longDevice.client.whoami(BASE, "tok")).toEqual({ userId: "@me:x.org" });
    const bad = fakeFetch(() => json({ user_id: 3 }));
    await expect(bad.client.whoami(BASE, "tok")).rejects.toThrow("unreadable account");
  });

  it("logs out", async () => {
    const { client, fetchFn } = fakeFetch(() => json({}));
    await client.logout(SESSION);
    expect(callOf(fetchFn).url.pathname).toBe("/_matrix/client/v3/logout");
    expect(callOf(fetchFn).init.method).toBe("POST");
  });
});

describe("syncing and history", () => {
  it("syncs with the filter, timeout and token, without changing presence", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ next_batch: "s2" }));
    expect(await client.sync(SESSION, undefined, 0)).toMatchObject({ nextBatch: "s2", joined: [], left: [] });
    let { url } = callOf(fetchFn);
    expect(url.pathname).toBe("/_matrix/client/v3/sync");
    expect(url.searchParams.get("filter")).toBe(SYNC_FILTER);
    expect(url.searchParams.get("timeout")).toBe("0");
    expect(url.searchParams.get("set_presence")).toBe("offline");
    expect(url.searchParams.has("since")).toBe(false);
    await client.sync(SESSION, "s2", 30000);
    ({ url } = callOf(fetchFn, 1));
    expect(url.searchParams.get("since")).toBe("s2");
    expect(url.searchParams.get("timeout")).toBe("30000");
  });

  it("pages back through history", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ chunk: [], end: "t3" }));
    expect(await client.messages(SESSION, "!r/1:x.org", "t2", 50)).toEqual({ events: [], state: { members: {} }, end: "t3" });
    const { url } = callOf(fetchFn);
    expect(url.pathname).toBe("/_matrix/client/v3/rooms/!r%2F1%3Ax.org/messages");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ dir: "b", from: "t2", limit: "50" });
    expect(JSON.parse(url.searchParams.get("filter")!)).toMatchObject({ lazy_load_members: true });
  });
});

describe("encryption check", () => {
  it("asks the server for the room's encryption state", async () => {
    const yes = fakeFetch(() => json({ algorithm: "m.megolm.v1.aes-sha2" }));
    expect(await yes.client.encryption(SESSION, "!r:x.org")).toEqual({ algorithm: "m.megolm.v1.aes-sha2" });
    expect(callOf(yes.fetchFn).url.pathname).toBe("/_matrix/client/v3/rooms/!r%3Ax.org/state/m.room.encryption/");
    const no = fakeFetch(() => json({ errcode: "M_NOT_FOUND", error: "no" }, 404));
    expect(await no.client.encryption(SESSION, "!r:x.org")).toBeUndefined();
  });

  it("does not take other failures for unencrypted", async () => {
    const forbidden = fakeFetch(() => json({ errcode: "M_FORBIDDEN" }, 403));
    await expect(forbidden.client.encryption(SESSION, "!r:x.org")).rejects.toMatchObject({ errcode: "M_FORBIDDEN" });
    const odd404 = fakeFetch(() => json({ errcode: "M_UNRECOGNIZED" }, 404));
    await expect(odd404.client.encryption(SESSION, "!r:x.org")).rejects.toMatchObject({ status: 404 });
    const offline = fakeFetch(() => Promise.reject(new Error("offline")));
    await expect(offline.client.encryption(SESSION, "!r:x.org")).rejects.toThrow("offline");
  });
});

describe("writing", () => {
  it("sends messages with unique transaction ids", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ event_id: "$new" }));
    expect(await client.send(SESSION, "!r:x.org", { msgtype: "m.text", body: "hi" })).toBe("$new");
    await client.send(SESSION, "!r:x.org", { msgtype: "m.text", body: "again" });
    const first = callOf(fetchFn, 0);
    const second = callOf(fetchFn, 1);
    expect(first.init.method).toBe("PUT");
    expect(first.url.pathname).toMatch(/^\/_matrix\/client\/v3\/rooms\/!r%3Ax\.org\/send\/m\.room\.message\/mc[a-z0-9]+\.1$/);
    expect(second.url.pathname).toMatch(/\.2$/);
    expect(first.body).toEqual({ msgtype: "m.text", body: "hi" });
  });

  it("rejects a send without an event id", async () => {
    const { client } = fakeFetch(() => json({ event_id: "nope" }));
    await expect(client.send(SESSION, "!r:x.org", {})).rejects.toThrow("unreadable response");
  });

  it("redacts and sets read markers", async () => {
    const { client, fetchFn } = fakeFetch(() => json({}));
    await client.redact(SESSION, "!r:x.org", "$e/1");
    expect(callOf(fetchFn).url.pathname).toMatch(/^\/_matrix\/client\/v3\/rooms\/!r%3Ax\.org\/redact\/%24e%2F1\/mc/);
    expect(callOf(fetchFn).init.method).toBe("PUT");
    await client.markRead(SESSION, "!r:x.org", "$e");
    const read = callOf(fetchFn, 1);
    expect(read.url.pathname).toBe("/_matrix/client/v3/rooms/!r%3Ax.org/read_markers");
    expect(read.body).toEqual({ "m.fully_read": "$e", "m.read": "$e" });
  });
});

describe("thumbnails", () => {
  const image = (bytes: Uint8Array<ArrayBuffer>, type = "image/png", status = 200) => new Response(bytes, { status, headers: { "Content-Type": type } });

  it("fetches authenticated thumbnails as data: URLs", async () => {
    const { client, fetchFn } = fakeFetch(() => image(new Uint8Array([1, 2, 3]), "image/PNG; charset=binary"));
    expect(await client.thumbnail(SESSION, "mxc://x.org/abc")).toBe("data:image/png;base64,AQID");
    const { url, init } = callOf(fetchFn);
    expect(url.pathname).toBe("/_matrix/client/v1/media/thumbnail/x.org/abc");
    expect(Object.fromEntries(url.searchParams)).toEqual({ width: "64", height: "64", method: "crop", animated: "false" });
    expect(init.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("encodes large thumbnails in chunks", async () => {
    const bytes = new Uint8Array(MAX_THUMBNAIL_BYTES).fill(65);
    const { client } = fakeFetch(() => image(bytes, "image/webp"));
    const url = await client.thumbnail(SESSION, "mxc://x.org/abc");
    expect(url!.startsWith("data:image/webp;base64,QUFB")).toBe(true);
    expect(atob(url!.split(",")[1]!)).toHaveLength(MAX_THUMBNAIL_BYTES);
  });

  it.each([
    ["a failed request", () => image(new Uint8Array([1]), "image/png", 404)],
    ["a non-image type", () => image(new Uint8Array([1]), "text/html")],
    ["no type", () => new Response(new Uint8Array([1]))],
    ["an empty image", () => image(new Uint8Array(0))],
    ["a too large image", () => image(new Uint8Array(MAX_THUMBNAIL_BYTES + 1))],
  ])("gives nothing for %s", async (_name, respond) => {
    const { client } = fakeFetch(respond);
    expect(await client.thumbnail(SESSION, "mxc://x.org/abc")).toBeUndefined();
  });

  it("does not fetch malformed mxc URIs", async () => {
    const { client, fetchFn } = fakeFetch(() => image(new Uint8Array([1])));
    expect(await client.thumbnail(SESSION, "mxc://x.org/../../admin")).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("encryption endpoints", () => {
  it("lists joined and invited members for key sharing", async () => {
    const { client, fetchFn } = fakeFetch(() =>
      json({ chunk: [{ type: "m.room.member", state_key: "@a:x.org", content: { membership: "join" } }, { type: "m.room.member", state_key: "@b:x.org", content: { membership: "invite" } }] }),
    );
    expect(await client.members(SESSION, "!r:x.org")).toEqual(["@a:x.org", "@b:x.org"]);
    const { url } = callOf(fetchFn);
    expect(url.pathname).toBe("/_matrix/client/v3/rooms/!r%3Ax.org/members");
    expect(url.searchParams.get("not_membership")).toBe("leave");
  });

  it("sends other event types", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ event_id: "$new" }));
    await client.send(SESSION, "!r:x.org", { algorithm: "m.megolm.v1.aes-sha2" }, "m.room.encrypted");
    expect(callOf(fetchFn).url.pathname).toMatch(/\/send\/m\.room\.encrypted\/mc/);
  });

  it("reads account data, with none as undefined", async () => {
    const { client, fetchFn } = fakeFetch((url) => (url.pathname.endsWith("m.secret_storage.default_key") ? json({ key: "K" }) : json({ errcode: "M_NOT_FOUND" }, 404)));
    expect(await client.accountData(SESSION, "m.secret_storage.default_key")).toEqual({ key: "K" });
    expect(callOf(fetchFn).url.pathname).toBe("/_matrix/client/v3/user/%40me%3Ax.org/account_data/m.secret_storage.default_key");
    expect(await client.accountData(SESSION, "m.cross_signing.master")).toBeUndefined();
    await expect(client.accountData(SESSION, "../../admin")).rejects.toThrow("Invalid account data type");
    const forbidden = fakeFetch(() => json({ errcode: "M_FORBIDDEN" }, 403));
    await expect(forbidden.client.accountData(SESSION, "m.x")).rejects.toMatchObject({ errcode: "M_FORBIDDEN" });
  });

  it("makes the crypto library's requests", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ one_time_key_counts: {} }));
    expect(await client.request(SESSION, "POST", "/v3/keys/upload", { device_keys: {} }, { version: "1" })).toEqual({ one_time_key_counts: {} });
    const { url, init, body } = callOf(fetchFn);
    expect(url.href).toBe("https://hs.x.org/_matrix/client/v3/keys/upload?version=1");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok" });
    expect(body).toEqual({ device_keys: {} });
  });

  it("reads the room's encryption settings", async () => {
    const { client } = fakeFetch(() => json({ algorithm: "m.megolm.v1.aes-sha2", rotation_period_ms: 1000, rotation_period_msgs: 10 }));
    expect(await client.encryption(SESSION, "!r:x.org")).toEqual({ algorithm: "m.megolm.v1.aes-sha2", rotationMs: 1000, rotationMsgs: 10 });
  });
});

describe("checking a stored session", () => {
  it("accepts the session's own account only", async () => {
    const ok = fakeFetch(() => json({ user_id: "@me:x.org" }));
    await ok.client.check(SESSION);
    expect(callOf(ok.fetchFn).init.headers).toMatchObject({ Authorization: "Bearer tok" });
    const other = fakeFetch(() => json({ user_id: "@other:x.org" }));
    await expect(other.client.check(SESSION)).rejects.toMatchObject({ status: 401, errcode: "M_UNKNOWN_TOKEN" });
  });
});

describe("OAuth token refresh", () => {
  const oauthSession = (extra: Partial<NonNullable<MxSession["oauth"]>> = {}): MxSession => ({
    ...SESSION,
    accessToken: "old",
    oauth: { clientId: "c", tokenEndpoint: "https://account.x.org/token", refreshToken: "r", ...extra },
  });

  function refreshing(respond: (url: URL, init: RequestInit) => Response | Promise<Response>, now = 1000) {
    const refresh = vi.fn(async (session: MxSession) => {
      session.accessToken = `new${refresh.mock.calls.length}`;
    });
    const fetchFn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => respond(new URL(String(input)), init));
    return { refresh, fetchFn, client: createMatrixClient(fetchFn as unknown as typeof fetch, { refresh, now: () => now }) };
  }
  const tokenOf = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;
  const expired = () => json({ errcode: "M_UNKNOWN_TOKEN", error: "expired", soft_logout: true }, 401);

  it("refreshes a token that is about to expire before using it", async () => {
    const { client, refresh, fetchFn } = refreshing(() => json({ event_id: "$e" }), 100_000);
    const session = oauthSession({ expiresAt: 100_000 + REFRESH_MARGIN_MS - 1 });
    await client.send(session, "!r:x.org", {});
    expect(refresh).toHaveBeenCalledWith(session);
    expect(tokenOf(fetchFn.mock.calls[0]![1]!)).toBe("Bearer new1");
    // Not yet due: no refresh.
    const later = oauthSession({ expiresAt: 100_000 + REFRESH_MARGIN_MS + 1 });
    await client.send(later, "!r:x.org", {});
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes once and retries when the server says the token expired", async () => {
    const { client, refresh, fetchFn } = refreshing((_url, init) => (tokenOf(init) === "Bearer old" ? expired() : json({ user_id: "@me:x.org" })));
    const session = oauthSession();
    await client.check(session);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(tokenOf(fetchFn.mock.calls[1]![1]!)).toBe("Bearer new1");
  });

  it("shares one refresh between concurrent calls", async () => {
    const { client, refresh } = refreshing((_url, init) => (tokenOf(init) === "Bearer old" ? expired() : json({ event_id: "$e" })));
    const session = oauthSession();
    await Promise.all([client.send(session, "!r:x.org", {}), client.send(session, "!r:x.org", {}), client.send(session, "!r:x.org", {})]);
    expect(refresh).toHaveBeenCalledTimes(1);
    // A later expiry refreshes again.
    session.accessToken = "old";
    await client.send(session, "!r:x.org", {});
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not refresh a hard logout, a session without refresh token, or without a refresher", async () => {
    const hard = refreshing(() => json({ errcode: "M_UNKNOWN_TOKEN", error: "gone" }, 401));
    await expect(hard.client.check(oauthSession())).rejects.toMatchObject({ errcode: "M_UNKNOWN_TOKEN", softLogout: false });
    expect(hard.refresh).not.toHaveBeenCalled();
    const soft = refreshing(() => expired());
    await expect(soft.client.check(oauthSession({ refreshToken: undefined }))).rejects.toMatchObject({ softLogout: true });
    await expect(soft.client.check(SESSION)).rejects.toMatchObject({ status: 401 });
    expect(soft.refresh).not.toHaveBeenCalled();
    const plain = fakeFetch(() => expired());
    await expect(plain.client.check(oauthSession({ expiresAt: 0 }))).rejects.toMatchObject({ status: 401 });
  });

  it("refreshes a due token before fetching thumbnails", async () => {
    const { client, refresh, fetchFn } = refreshing(() => new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/png" } }), 10);
    await client.thumbnail(oauthSession({ expiresAt: 0 }), "mxc://x.org/abc");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(tokenOf(fetchFn.mock.calls[0]![1]!)).toBe("Bearer new1");
  });
});

describe("refreshing before expiry", () => {
  it("shares one refresh between calls that find the token due", async () => {
    let finish!: () => void;
    const refresh = vi.fn(
      (session: MxSession) =>
        new Promise<void>((resolve) => {
          finish = () => {
            session.accessToken = "new";
            resolve();
          };
        }),
    );
    const fetchFn = vi.fn(async () => json({ event_id: "$e" }));
    const client = createMatrixClient(fetchFn as unknown as typeof fetch, { refresh, now: () => 1000 });
    const session: MxSession = { ...SESSION, oauth: { clientId: "c", tokenEndpoint: "https://a.org/t", refreshToken: "r", expiresAt: 0 } };
    const sends = [client.send(session, "!r:x.org", {}), client.send(session, "!r:x.org", {})];
    await Promise.resolve();
    finish();
    await Promise.all(sends);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
