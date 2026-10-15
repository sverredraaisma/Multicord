import { describe, expect, it, vi } from "vitest";
import { MatrixError, matrixErrcode, type MxSession } from "../../../src/modules/matrix/api";
import { createMatrixClient, httpsBase, liveKitUrl, MAX_THUMBNAIL_BYTES, REFRESH_MARGIN_MS, SYNC_FILTER } from "../../../src/modules/matrix/client";

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
    expect(await client.loginFlows(BASE)).toEqual({ password: true, sso: true });
    expect(callOf(fetchFn).url.href).toBe(`${BASE}/_matrix/client/v3/login`);
    expect(callOf(fetchFn).init.headers).toEqual({ Accept: "application/json" });
    const sso = fakeFetch(() => json({ flows: [{ type: "m.login.sso" }, "junk"] }));
    expect(await sso.client.loginFlows(BASE)).toEqual({ password: false, sso: true });
    const none = fakeFetch(() => json({}));
    expect(await none.client.loginFlows(BASE)).toEqual({ password: false, sso: false });
  });

  it("signs in with a login token from single sign-on as device Multicord", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ access_token: "T", user_id: "@me:x.org", device_id: "DEV" }));
    expect(await client.loginToken(BASE, "syl_t")).toEqual({ baseUrl: BASE, accessToken: "T", userId: "@me:x.org", deviceId: "DEV", ownDevice: true });
    expect(callOf(fetchFn).body).toEqual({ type: "m.login.token", token: "syl_t", initial_device_display_name: "Multicord" });
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
    // Without a token, the sync lists every invitation there is; with one, only new ones.
    expect(await client.sync(SESSION, undefined, 0)).toMatchObject({ nextBatch: "s2", joined: [], left: [], invitesFull: true });
    expect(await client.sync(SESSION, "s1", 0)).not.toHaveProperty("invitesFull");
    fetchFn.mockClear();
    await client.sync(SESSION, undefined, 0);
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

  it("asks the homeserver for its upload limit, through authenticated media first", async () => {
    const v1 = fakeFetch(() => json({ "m.upload.size": 50_000_000 }));
    expect(await v1.client.uploadLimit(SESSION)).toBe(50_000_000);
    expect(callOf(v1.fetchFn).url.pathname).toBe("/_matrix/client/v1/media/config");
    expect(callOf(v1.fetchFn).init.headers.Authorization).toBe("Bearer tok");
    for (const missing of [json({ errcode: "M_UNRECOGNIZED" }, 400), json({ errcode: "M_NOT_FOUND" }, 404)]) {
      const old = fakeFetch((url) => (url.pathname.startsWith("/_matrix/client/") ? missing.clone() : json({ "m.upload.size": 10 })));
      expect(await old.client.uploadLimit(SESSION)).toBe(10);
      expect(callOf(old.fetchFn, 1).url.pathname).toBe("/_matrix/media/v3/config");
    }
    for (const limit of [0, -1, 1.5, "10", undefined]) expect(await fakeFetch(() => json({ "m.upload.size": limit })).client.uploadLimit(SESSION)).toBeUndefined();
    await expect(fakeFetch(() => json({ errcode: "M_FORBIDDEN" }, 403)).client.uploadLimit(SESSION)).rejects.toMatchObject({ errcode: "M_FORBIDDEN" });
    await expect(fakeFetch(() => Promise.reject(new Error("offline"))).client.uploadLimit(SESSION)).rejects.toThrow("offline");
  });

  it("uploads raw bytes to the homeserver's media repository", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ content_uri: "mxc://x.org/abc" }));
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await client.upload(SESSION, bytes, "image/png", "cat & dog.png")).toBe("mxc://x.org/abc");
    // Not JSON: callOf would parse it.
    const [href, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe(`${BASE}/_matrix/media/v3/upload`);
    expect(url.searchParams.get("filename")).toBe("cat & dog.png");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(bytes);
    expect(init.headers).toEqual({ Accept: "application/json", Authorization: "Bearer tok", "Content-Type": "image/png" });
    await client.upload(SESSION, bytes, "application/octet-stream");
    expect(new URL(fetchFn.mock.calls[1]![0] as string).search).toBe("");
  });

  it("reports refused uploads and unreadable answers", async () => {
    await expect(fakeFetch(() => json({ errcode: "M_TOO_LARGE", error: "Too large" }, 413)).client.upload(SESSION, new Uint8Array(1), "a/b")).rejects.toMatchObject({ status: 413, errcode: "M_TOO_LARGE" });
    await expect(fakeFetch(() => new Response("<html>", { status: 502 })).client.upload(SESSION, new Uint8Array(1), "a/b")).rejects.toMatchObject({ status: 502 });
    for (const answer of [{ content_uri: "https://evil.example/x" }, {}, []]) {
      await expect(fakeFetch(() => json(answer)).client.upload(SESSION, new Uint8Array(1), "a/b")).rejects.toThrow("unreadable upload response");
    }
  });

  it("asks for typing notices but no other ephemeral events", () => {
    expect(JSON.parse(SYNC_FILTER).room.ephemeral).toEqual({ types: ["m.typing"] });
  });

  it("says when we type and when we stop", async () => {
    const { client, fetchFn } = fakeFetch(() => json({}));
    await client.typing(SESSION, "!r:x.org", true, 30_000);
    await client.typing(SESSION, "!r:x.org", false, 30_000);
    const first = callOf(fetchFn);
    expect(first.url.pathname).toBe(`/_matrix/client/v3/rooms/!r%3Ax.org/typing/${encodeURIComponent(SESSION.userId)}`);
    expect(first.init.method).toBe("PUT");
    expect(JSON.parse(first.init.body as string)).toEqual({ typing: true, timeout: 30_000 });
    expect(JSON.parse(callOf(fetchFn, 1).init.body as string)).toEqual({ typing: false });
  });

  it("asks for reactions in the timeline and in history", async () => {
    expect(JSON.parse(SYNC_FILTER).room.timeline.types).toContain("m.reaction");
    const { client, fetchFn } = fakeFetch(() => json({ chunk: [] }));
    await client.messages(SESSION, "!r:x.org", "t2", 50);
    expect(JSON.parse(callOf(fetchFn).url.searchParams.get("filter")!).types).toContain("m.reaction");
  });

  it("asks for polls, their votes and ends, in both forms", () => {
    const polls = ["m.poll.start", "m.poll.response", "m.poll.end", "org.matrix.msc3381.poll.start", "org.matrix.msc3381.poll.response", "org.matrix.msc3381.poll.end"];
    expect(JSON.parse(SYNC_FILTER).room.timeline.types).toEqual(expect.arrayContaining(polls));
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
    await client.markRead(SESSION, "!r:x.org", "$f", true);
    expect(callOf(fetchFn, 2).body).toEqual({ "m.fully_read": "$f", "m.read.private": "$f" });
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

describe("media downloads", () => {
  const file = (bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}, status = 200) => new Response(bytes, { status, headers });

  it("downloads through authenticated media with the session's token", async () => {
    const { client, fetchFn } = fakeFetch(() => file(new Uint8Array([1, 2, 3]), { "Content-Type": "Image/GIF; charset=binary" }));
    expect(await client.download(SESSION, "mxc://other.org:8448/abc_D-1", 10)).toEqual({ bytes: new Uint8Array([1, 2, 3]), type: "image/gif" });
    const { url, init } = callOf(fetchFn);
    expect(url.href).toBe("https://hs.x.org/_matrix/client/v1/media/download/other.org%3A8448/abc_D-1");
    expect(init.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("leaves out a type that is not one", async () => {
    const { client } = fakeFetch(() => file(new Uint8Array([1]), { "Content-Type": "nonsense" }));
    expect(await client.download(SESSION, "mxc://x.org/a", 10)).toEqual({ bytes: new Uint8Array([1]) });
  });

  it("gives nothing for files larger than allowed, by header or by count", async () => {
    const declared = fakeFetch(() => file(new Uint8Array([1]), { "Content-Length": "11" }));
    expect(await declared.client.download(SESSION, "mxc://x.org/a", 10)).toBeUndefined();
    const counted = fakeFetch(() => file(new Uint8Array(11)));
    expect(await counted.client.download(SESSION, "mxc://x.org/a", 10)).toBeUndefined();
    const exact = fakeFetch(() => file(new Uint8Array(10), { "Content-Length": "10" }));
    expect((await exact.client.download(SESSION, "mxc://x.org/a", 10))!.bytes).toHaveLength(10);
  });

  it("throws the homeserver's error", async () => {
    const { client } = fakeFetch(() => json({ errcode: "M_NOT_FOUND", error: "No such media" }, 404));
    await expect(client.download(SESSION, "mxc://x.org/a", 10)).rejects.toMatchObject({ status: 404, errcode: "M_NOT_FOUND", message: "No such media" });
    const bare = fakeFetch(() => new Response("oops", { status: 502 }));
    await expect(bare.client.download(SESSION, "mxc://x.org/a", 10)).rejects.toMatchObject({ status: 502, errcode: "M_UNKNOWN", message: "HTTP 502" });
  });

  it("does not fetch malformed mxc URIs", async () => {
    const { client, fetchFn } = fakeFetch(() => file(new Uint8Array([1])));
    await expect(client.download(SESSION, "mxc://x.org/../../admin", 10)).rejects.toThrow("Invalid media address");
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

  it("mutes a room with an override push rule of its own, and unmutes it by removing the rule", async () => {
    const { client, fetchFn } = fakeFetch(() => json({}));
    await client.muteRoom(SESSION, "!r:x.org", true);
    const put = callOf(fetchFn);
    expect(put.url.pathname).toBe("/_matrix/client/v3/pushrules/global/override/!r%3Ax.org");
    expect(put.init.method).toBe("PUT");
    expect(put.body).toEqual({ conditions: [{ kind: "event_match", key: "room_id", pattern: "!r:x.org" }], actions: ["dont_notify"] });
    await client.muteRoom(SESSION, "!r:x.org", false);
    expect(callOf(fetchFn, 1).init.method).toBe("DELETE");
    // A rule already gone is no error; others are.
    await expect(fakeFetch(() => json({ errcode: "M_NOT_FOUND" }, 404)).client.muteRoom(SESSION, "!r:x.org", false)).resolves.toBeUndefined();
    await expect(fakeFetch(() => json({ errcode: "M_FORBIDDEN" }, 403)).client.muteRoom(SESSION, "!r:x.org", false)).rejects.toMatchObject({ errcode: "M_FORBIDDEN" });
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

  it("refreshes a token refused without soft_logout, as Synapse behind MAS refuses expired ones", async () => {
    const mas = () => json({ errcode: "M_UNKNOWN_TOKEN", error: "Token is not active", soft_logout: false }, 401);
    const { client, refresh, fetchFn } = refreshing((_url, init) => (tokenOf(init) === "Bearer old" ? mas() : json({ user_id: "@me:x.org" })));
    await client.check(oauthSession());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(tokenOf(fetchFn.mock.calls[1]![1]!)).toBe("Bearer new1");
    // An ended session: the account server refuses the refresh, and that error is what the caller sees.
    const ended = refreshing(() => mas());
    ended.refresh.mockRejectedValueOnce(new MatrixError(401, "M_UNKNOWN_TOKEN", "Your Matrix session has ended"));
    await expect(ended.client.check(oauthSession())).rejects.toMatchObject({ errcode: "M_UNKNOWN_TOKEN", message: "Your Matrix session has ended" });
    // Refreshed but still refused: no second refresh.
    const still = refreshing(() => mas());
    await expect(still.client.check(oauthSession())).rejects.toMatchObject({ errcode: "M_UNKNOWN_TOKEN" });
    expect(still.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh other errors, a session without refresh token, or without a refresher", async () => {
    const forbidden = refreshing(() => json({ errcode: "M_FORBIDDEN", error: "no" }, 403));
    await expect(forbidden.client.check(oauthSession())).rejects.toMatchObject({ errcode: "M_FORBIDDEN" });
    expect(forbidden.refresh).not.toHaveBeenCalled();
    const soft = refreshing(() => expired());
    await expect(soft.client.check(oauthSession({ refreshToken: undefined }))).rejects.toMatchObject({ softLogout: true });
    await expect(soft.client.check(SESSION)).rejects.toMatchObject({ status: 401 });
    expect(soft.refresh).not.toHaveBeenCalled();
    const plain = fakeFetch(() => expired());
    await expect(plain.client.check(oauthSession({ expiresAt: 0 }))).rejects.toMatchObject({ status: 401 });
  });

  it("refreshes a due token before downloading media", async () => {
    const { client, refresh, fetchFn } = refreshing(() => new Response(new Uint8Array([1])), 10);
    await client.download(oauthSession({ expiresAt: 0 }), "mxc://x.org/abc", 10);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(tokenOf(fetchFn.mock.calls[0]![1]!)).toBe("Bearer new1");
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

describe("calls", () => {
  const TOKEN = { access_token: "oid", token_type: "Bearer", matrix_server_name: "x.org", expires_in: 3600 };

  it("asks for space changes in the sync timeline, and every state type in the state section", () => {
    const { room } = JSON.parse(SYNC_FILTER);
    expect(room.timeline.types).toEqual(expect.arrayContaining(["m.room.create", "m.space.child"]));
    expect(room.state).toEqual({ lazy_load_members: true });
  });

  it("asks for image packs: room packs in the timeline, the user's own and enabled rooms in account data", () => {
    const filter = JSON.parse(SYNC_FILTER);
    expect(filter.room.timeline.types).toContain("im.ponies.room_emotes");
    expect(filter.account_data).toEqual({ types: ["m.direct", "im.ponies.user_emotes", "im.ponies.emote_rooms", "m.push_rules"] });
  });

  it("asks for call memberships of both kinds in the sync timeline", () => {
    expect(JSON.parse(SYNC_FILTER).room.timeline.types).toEqual(expect.arrayContaining(["org.matrix.msc3401.call.member", "org.matrix.msc4143.rtc.member"]));
  });

  it("reads the call services a server's .well-known names", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ "org.matrix.msc4143.rtc_foci": [{ type: "livekit", livekit_service_url: "https://jwt.call.x.org" }, { type: "nextgen" }] }));
    expect(await client.rtcFoci("https://x.org/page")).toEqual(["https://jwt.call.x.org"]);
    expect(callOf(fetchFn).url.href).toBe("https://x.org/.well-known/matrix/client");
  });

  it.each([
    ["no document", () => new Response("", { status: 404 })],
    ["invalid JSON", () => new Response("{", { status: 200 })],
    ["no foci", () => json({ "m.homeserver": {} })],
    ["a list", () => json([])],
  ])("finds no call service with %s", async (_name, respond) => {
    const { client } = fakeFetch(respond);
    expect(await client.rtcFoci("https://x.org")).toEqual([]);
  });

  it("does not look up servers that are not https", async () => {
    const { client, fetchFn } = fakeFetch(() => json({}));
    expect(await client.rtcFoci("http://x.org")).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reads the homeserver's own call services and LiveKit servers, if it has the endpoint", async () => {
    const { client, fetchFn } = fakeFetch(() =>
      json({ rtc_transports: [{ type: "livekit", livekit_service_url: "https://mrtc.x.org/livekit/jwt" }, { type: "livekit", livekit_service_url: "https://mrtc.x.org/livekit/jwt", url: "wss://mrtc.x.org/livekit/sfu" }] }),
    );
    expect(await client.rtcTransports(SESSION)).toEqual([{ service: "https://mrtc.x.org/livekit/jwt" }, { service: "https://mrtc.x.org/livekit/jwt", sfu: "wss://mrtc.x.org/livekit/sfu" }]);
    const { url, init } = callOf(fetchFn);
    expect(url.href).toBe(`${BASE}/_matrix/client/unstable/org.matrix.msc4143/rtc/transports`);
    expect(init.headers.Authorization).toBe("Bearer tok");
    for (const status of [400, 404, 405]) {
      const { client: missing } = fakeFetch(() => json({ errcode: "M_UNRECOGNIZED" }, status));
      expect(await missing.rtcTransports(SESSION)).toEqual([]);
    }
    const { client: down } = fakeFetch(() => json({ errcode: "M_UNKNOWN" }, 502));
    await expect(down.rtcTransports(SESSION)).rejects.toMatchObject({ status: 502 });
  });

  it("checks unstable features", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ versions: ["v1.11"], unstable_features: { "org.matrix.msc4140": true, "org.matrix.msc4354": false } }));
    expect(await client.supports(SESSION, "org.matrix.msc4140")).toBe(true);
    expect(await client.supports(SESSION, "org.matrix.msc4354")).toBe(false);
    expect(callOf(fetchFn).url.href).toBe(`${BASE}/_matrix/client/versions`);
    const { client: bare } = fakeFetch(() => json({ versions: [] }));
    expect(await bare.supports(SESSION, "org.matrix.msc4140")).toBe(false);
  });

  it("gets an OpenID token, checking its fields", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ ...TOKEN, extra: 1 }));
    expect(await client.openIdToken(SESSION)).toEqual(TOKEN);
    const { url, init, body } = callOf(fetchFn);
    expect(url.pathname).toBe("/_matrix/client/v3/user/%40me%3Ax.org/openid/request_token");
    expect([init.method, body]).toEqual(["POST", {}]);
    for (const bad of [{ access_token: "" }, { token_type: 5 }, { matrix_server_name: "x".repeat(256) }, { expires_in: 0 }, { expires_in: 1.5 }, { expires_in: "1" }]) {
      const { client: broken } = fakeFetch(() => json({ ...TOKEN, ...bad }));
      await expect(broken.openIdToken(SESSION)).rejects.toThrow("unreadable OpenID token");
    }
  });

  it("sets state events, now or delayed", async () => {
    const { client, fetchFn } = fakeFetch((url) => json(url.searchParams.has("org.matrix.msc4140.delay") ? { delay_id: "d1" } : { event_id: "$s1" }));
    expect(await client.sendState(SESSION, "!r:x.org", "org.matrix.msc3401.call.member", "_@me:x.org_D_m.call", { a: 1 })).toBe("$s1");
    let call = callOf(fetchFn);
    expect(call.url.pathname).toBe("/_matrix/client/v3/rooms/!r%3Ax.org/state/org.matrix.msc3401.call.member/_%40me%3Ax.org_D_m.call");
    expect([call.init.method, call.body]).toEqual(["PUT", { a: 1 }]);
    expect(await client.sendDelayedState(SESSION, "!r:x.org", "t", "k", {}, 18000)).toBe("d1");
    call = callOf(fetchFn, 1);
    expect(call.url.searchParams.get("org.matrix.msc4140.delay")).toBe("18000");
    const { client: broken } = fakeFetch(() => json({}));
    await expect(broken.sendState(SESSION, "!r:x.org", "t", "k", {})).rejects.toThrow("unreadable");
    await expect(broken.sendDelayedState(SESSION, "!r:x.org", "t", "k", {}, 1)).rejects.toThrow("unreadable");
  });

  it("restarts, sends and cancels delayed events, with the action in the body on older servers", async () => {
    const { client, fetchFn } = fakeFetch(() => json({}));
    await client.updateDelayed(SESSION, "d/1", "restart");
    expect(callOf(fetchFn).url.pathname).toBe("/_matrix/client/unstable/org.matrix.msc4140/delayed_events/d%2F1/restart");
    const old = fakeFetch((url) => (url.pathname.endsWith("/send") ? json({ errcode: "M_UNRECOGNIZED" }, 404) : json({})));
    await old.client.updateDelayed(SESSION, "d1", "send");
    const retry = callOf(old.fetchFn, 1);
    expect([retry.url.pathname, retry.body]).toEqual(["/_matrix/client/unstable/org.matrix.msc4140/delayed_events/d1", { action: "send" }]);
    const gone = fakeFetch(() => json({ errcode: "M_NOT_FOUND" }, 404));
    await expect(gone.client.updateDelayed(SESSION, "d1", "cancel")).rejects.toMatchObject({ errcode: "M_NOT_FOUND" });
    expect(gone.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("asks the call service for access, without the homeserver token", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ url: "wss://sfu.call.x.org", jwt: "a.b-c_d" }));
    expect(await client.liveKitGrant("https://jwt.call.x.org", "!r:x.org", "D", TOKEN)).toEqual({ url: "wss://sfu.call.x.org/", jwt: "a.b-c_d" });
    const { url, init, body } = callOf(fetchFn);
    expect(url.href).toBe("https://jwt.call.x.org/sfu/get");
    expect(init.headers.Authorization).toBeUndefined();
    expect(body).toEqual({ room: "!r:x.org", openid_token: TOKEN, device_id: "D" });
    const refused = fakeFetch(() => json({ errcode: "M_FORBIDDEN", error: "no" }, 403));
    await expect(refused.client.liveKitGrant("https://jwt.call.x.org", "!r:x.org", "D", TOKEN)).rejects.toMatchObject({ status: 403, errcode: "M_FORBIDDEN" });
    for (const bad of [{ url: "ws://sfu.x.org", jwt: "a" }, { url: "wss://u:p@sfu.x.org", jwt: "a" }, { url: "nope", jwt: "a" }, { url: 5, jwt: "a" }, { url: "wss://sfu.x.org", jwt: "a b" }, { url: "wss://sfu.x.org" }]) {
      const { client: broken } = fakeFetch(() => json(bad));
      await expect(broken.liveKitGrant("https://jwt.call.x.org", "!r:x.org", "D", TOKEN)).rejects.toThrow("unreadable answer");
    }
  });

  it("sends sticky events, now or delayed, at most an hour sticky", async () => {
    const { client, fetchFn } = fakeFetch((url) => json(url.searchParams.has("org.matrix.msc4140.delay") ? { delay_id: "d1" } : { event_id: "$s1" }));
    expect(await client.sendSticky(SESSION, "!r:x.org", "org.matrix.msc4143.rtc.member", { a: 1 }, 3_600_000)).toBe("$s1");
    let call = callOf(fetchFn);
    expect(call.url.pathname).toMatch(/^\/_matrix\/client\/v3\/rooms\/!r%3Ax.org\/send\/org.matrix.msc4143.rtc.member\/mc[a-z0-9]+\.1$/);
    expect(call.url.searchParams.get("org.matrix.msc4354.sticky_duration_ms")).toBe("3600000");
    expect([call.init.method, call.body]).toEqual(["PUT", { a: 1 }]);
    expect(await client.sendDelayedSticky(SESSION, "!r:x.org", "m.room.encrypted", { b: 2 }, 18000, 1e9)).toBe("d1");
    call = callOf(fetchFn, 1);
    expect(call.url.pathname).toContain("/send/m.room.encrypted/");
    expect([call.url.searchParams.get("org.matrix.msc4140.delay"), call.url.searchParams.get("org.matrix.msc4354.sticky_duration_ms"), call.body]).toEqual(["18000", "3600000", { b: 2 }]);
    const { client: broken } = fakeFetch(() => json({ event_id: "nope", delay_id: "" }));
    await expect(broken.sendSticky(SESSION, "!r:x.org", "t", {}, 1)).rejects.toThrow("unreadable");
    await expect(broken.sendDelayedSticky(SESSION, "!r:x.org", "t", {}, 1, 1)).rejects.toThrow("unreadable");
  });

  it("asks the homeserver for access to its LiveKit server for a membership, keeping the address as named", async () => {
    const { client, fetchFn } = fakeFetch(() => json({ jwt: "a.b-c_d" }));
    const request = { sfu: "wss://sfu.x.org", roomId: "!r:x.org", slotId: "m.call#ROOM", memberId: "uuid-1", deviceId: "D" };
    expect(await client.liveKitToken(SESSION, request)).toEqual({ url: "wss://sfu.x.org", jwt: "a.b-c_d" });
    const { url, init, body } = callOf(fetchFn);
    expect(url.href).toBe(`${BASE}/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token`);
    expect([init.method, init.headers.Authorization]).toEqual(["POST", "Bearer tok"]);
    expect(body).toEqual({ url: "wss://sfu.x.org", room_id: "!r:x.org", slot_id: "m.call#ROOM", member_id: "uuid-1", member: { id: "uuid-1", claimed_device_id: "D" } });
    // Never to a LiveKit server we may not use, and nothing but a JWT back.
    await expect(client.liveKitToken(SESSION, { ...request, sfu: "ws://sfu.x.org" })).rejects.toThrow("not a wss address");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    for (const bad of [{ jwt: "a b" }, { jwt: 5 }, {}]) {
      const { client: broken } = fakeFetch(() => json(bad));
      await expect(broken.liveKitToken(SESSION, request)).rejects.toThrow("unreadable call access token");
    }
    const refused = fakeFetch(() => json({ errcode: "M_FORBIDDEN", error: "not joined" }, 403));
    await expect(refused.client.liveKitToken(SESSION, request)).rejects.toMatchObject({ status: 403, errcode: "M_FORBIDDEN" });
  });

  it("checks LiveKit server addresses", () => {
    expect(liveKitUrl("https://sfu.x.org/lk")).toBe("https://sfu.x.org/lk");
    expect(liveKitUrl(`wss://sfu.x.org/${"a".repeat(2048)}`)).toBeUndefined();
  });
});
