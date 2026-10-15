import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverInstance, instanceHosts } from "../../../src/modules/spacebar/discovery";
import { SpacebarGateway, type GatewaySocket } from "../../../src/modules/spacebar/gateway";
import { CAPTCHA_REQUIRED, SpacebarApiError, SpacebarRest } from "../../../src/modules/spacebar/rest";
import { ANA, DISCOVERY, message } from "./fixtures";

type Reply = { status: number; body?: unknown } | Error;

function fakeFetch(routes: Record<string, Reply | ((init: RequestInit) => Reply)>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    const reply = typeof route === "function" ? route(init) : (route ?? { status: 404, body: { message: "Not found" } });
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.status < 300,
      status: reply.status,
      json: async () => (reply.body === undefined ? Promise.reject(new Error("no body")) : reply.body),
    } as Response;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("Spacebar discovery", () => {
  it("reads the instance's client endpoints, dropping default ports", async () => {
    const { fetch } = fakeFetch({ "https://spacebar.chat/.well-known/spacebar/client": { status: 200, body: DISCOVERY } });
    const instance = await discoverInstance("https://spacebar.chat", fetch);
    expect(instance).toEqual({ api: "https://api.sb/api/v9", cdn: "https://cdn.sb", gateway: "wss://gw.sb" });
    expect(instanceHosts(instance)).toEqual(["api.sb", "gw.sb", "cdn.sb"]);
    expect(instanceHosts({ api: "https://sb.example/api/v9", cdn: "https://sb.example/cdn", gateway: "wss://sb.example/gw" })).toEqual(["sb.example"]);
  });

  it("falls back to the older well-known address and the instance's domains", async () => {
    const { fetch, calls } = fakeFetch({
      "https://old.sb/.well-known/spacebar/client": { status: 200, body: { api: "https://api.old.sb", cdn: "https://cdn.old.sb" } },
      "https://old.sb/.well-known/spacebar": { status: 200, body: { api: "https://api.old.sb:443/api/" } },
      "https://api.old.sb/api/v9/policies/instance/domains": { status: 200, body: { cdn: "https://cdn.old.sb:443", gateway: "wss://gw.old.sb:443" } },
    });
    expect(await discoverInstance("https://old.sb", fetch)).toEqual({ api: "https://api.old.sb/api/v9", cdn: "https://cdn.old.sb", gateway: "wss://gw.old.sb" });
    expect(calls.map((c) => c.url)).toHaveLength(3);
    // A client document that does not answer, or is not JSON, also falls back.
    const answers = fakeFetch({
      "https://old.sb/.well-known/spacebar/client": { status: 200 },
      "https://old.sb/.well-known/spacebar": { status: 200, body: { api: "https://api.old.sb/api/v9" } },
      "https://api.old.sb/api/v9/policies/instance/domains": { status: 200, body: { cdn: "https://cdn.old.sb", gateway: "wss://gw.old.sb" } },
    });
    expect((await discoverInstance("https://old.sb", answers.fetch)).api).toBe("https://api.old.sb/api/v9");
  });

  it("refuses incomplete or unsafe endpoints", async () => {
    const legacy = (body: unknown, domains: unknown) =>
      fakeFetch({
        "https://x.sb/.well-known/spacebar": { status: 200, body },
        "https://api.x.sb/api/v9/policies/instance/domains": { status: 200, body: domains },
      }).fetch;
    await expect(discoverInstance("https://x.sb", legacy({ api: "https://api.x.sb/api" }, { cdn: "https://cdn", gateway: "ws://gw" }))).rejects.toThrow("incomplete endpoints");
    await expect(discoverInstance("https://x.sb", legacy({ api: "https://u:p@api.x.sb" }, {}))).rejects.toThrow("no API address");
    await expect(discoverInstance("https://x.sb", legacy({ api: "https://api.x.sb/?q" }, {}))).rejects.toThrow("no API address");
    await expect(discoverInstance("https://x.sb", legacy({ api: "not a url" }, {}))).rejects.toThrow("no API address");
    await expect(discoverInstance("https://x.sb", legacy({ api: 5 }, {}))).rejects.toThrow("no API address");
    await expect(discoverInstance("https://x.sb", legacy([1], {}))).rejects.toThrow("returned no endpoints");
    await expect(discoverInstance("https://x.sb", fakeFetch({}).fetch)).rejects.toThrow("Instance discovery failed (HTTP 404)");
  });
});

class FakeSocket implements GatewaySocket {
  sent: { op: number; d: unknown }[] = [];
  closed: number[] = [];
  private listeners: Record<string, ((event: never) => void)[]> = {};
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000): void {
    this.closed.push(code);
  }
  addEventListener(type: string, listener: (event: never) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  receive(payload: unknown): void {
    for (const l of this.listeners.message ?? []) l({ data: typeof payload === "string" ? payload : JSON.stringify(payload) } as never);
  }
  serverClose(code: number): void {
    for (const l of this.listeners.close ?? []) l({ code } as never);
  }
}

describe("Spacebar gateway", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    const handlers = { dispatch: vi.fn(), status: vi.fn(), authFailed: vi.fn() };
    const gateway = new SpacebarGateway(
      "wss://gw.sb",
      "tok",
      (url) => {
        urls.push(url);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      handlers,
      "win32",
    );
    return { gateway, sockets, urls, handlers };
  }

  it("identifies, heartbeats and dispatches", async () => {
    const { gateway, sockets, urls, handlers } = setup();
    gateway.connect();
    expect(urls).toEqual(["wss://gw.sb/?encoding=json&v=9"]);
    expect(handlers.status).toHaveBeenLastCalledWith("connecting");
    const socket = sockets[0]!;
    socket.receive("not json");
    socket.receive({ nope: true });
    socket.receive({ op: 10, d: { heartbeat_interval: 5 } });
    expect(socket.sent[0]).toEqual({ op: 2, d: { token: "tok", properties: { os: "win32", browser: "Multicord", device: "Multicord" }, compress: false } });
    socket.receive({ op: 0, s: 1, t: "READY", d: { session_id: "sess" } });
    expect(handlers.status).toHaveBeenLastCalledWith("ready");
    expect(handlers.dispatch).toHaveBeenCalledWith("READY", { session_id: "sess" });
    socket.receive({ op: 0, s: 2 });
    socket.receive({ op: 0, t: "TYPING_START", d: {} });
    socket.receive({ op: 1 });
    expect(socket.sent.at(-1)).toEqual({ op: 1, d: 2 });
    // A heartbeat interval below a second is not trusted: 30 s.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent.at(-1)).toEqual({ op: 1, d: 2 });
    socket.receive({ op: 11 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent.filter((p) => p.op === 1)).toHaveLength(3);
    // No ACK for the last beat: the connection is dropped and resumed.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.closed).toEqual([4000]);
    expect(handlers.status).toHaveBeenLastCalledWith("reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    const next = sockets[1]!;
    next.receive({ op: 10, d: { heartbeat_interval: 40_000 } });
    expect(next.sent[0]).toEqual({ op: 6, d: { token: "tok", session_id: "sess", seq: 2 } });
    next.receive({ op: 0, s: 3, t: "RESUMED", d: {} });
    expect(handlers.status).toHaveBeenLastCalledWith("ready");
    // Messages from an old socket are ignored.
    socket.receive({ op: 0, s: 9, t: "MESSAGE_CREATE", d: {} });
    socket.serverClose(1006);
    expect(handlers.dispatch).not.toHaveBeenCalledWith("MESSAGE_CREATE", {});
    gateway.disconnect();
    expect(next.closed).toEqual([1000]);
    expect(handlers.status).toHaveBeenLastCalledWith("closed");
  });

  it("starts afresh on an invalid session and reconnects when asked", async () => {
    const { gateway, sockets } = setup();
    gateway.connect();
    const socket = sockets[0]!;
    socket.receive({ op: 10, d: {} });
    socket.receive({ op: 0, s: 1, t: "READY", d: { session_id: "sess" } });
    socket.receive({ op: 9 });
    expect(socket.sent.at(-1)!.op).toBe(2);
    socket.receive({ op: 7 });
    expect(socket.closed).toEqual([4000]);
    await vi.advanceTimersByTimeAsync(1000);
    // The invalid session was forgotten: identify again.
    sockets[1]!.receive({ op: 10, d: {} });
    expect(sockets[1]!.sent[0]!.op).toBe(2);
    // A dropped connection backs off longer each time.
    sockets[1]!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    gateway.disconnect();
  });

  it("stops on a rejected token and on fatal close codes", () => {
    const first = setup();
    first.gateway.connect();
    first.sockets[0]!.serverClose(4004);
    expect(first.handlers.authFailed).toHaveBeenCalled();
    expect(first.handlers.status).toHaveBeenLastCalledWith("closed");
    const second = setup();
    second.gateway.connect();
    second.sockets[0]!.serverClose(4013);
    expect(second.handlers.authFailed).not.toHaveBeenCalled();
    expect(second.handlers.status).toHaveBeenLastCalledWith("closed");
    vi.advanceTimersByTime(60_000);
    expect(second.sockets).toHaveLength(1);
  });
});

describe("Spacebar REST", () => {
  const BASE = "https://api.sb/api/v9";
  const rest = (routes: Parameters<typeof fakeFetch>[0]) => {
    const { fetch, calls } = fakeFetch(routes);
    const sleep = vi.fn(async () => {});
    return { rest: new SpacebarRest(BASE, { fetch, sleep, minIntervalMs: 0 }), calls, sleep };
  };

  it("signs in, with a second step and with captchas told apart", async () => {
    const { rest: client, calls } = rest({
      [`${BASE}/auth/login`]: (init) => {
        const body = JSON.parse(String(init.body));
        if (body.login === "mfa@x") return { status: 200, body: { token: null, mfa: true, ticket: "t1", sms: false } };
        if (body.login === "key@x") return { status: 200, body: { token: null, mfa: true, ticket: "t2", webauthn: "{}" } };
        if (body.login === "bot@x") return { status: 400, body: { captcha_key: ["captcha-required"], captcha_sitekey: "k", captcha_service: "hcaptcha" } };
        if (body.login === "odd@x") return { status: 200, body: { user_id: "1" } };
        if (body.login === "none@x") return { status: 204 };
        if (body.login === "deep@x") return { status: 400, body: { errors: { a: { _errors: [{ code: "X" }, "y"] }, b: { c: { _errors: [{ message: "Deep" }] } } } } };
        if (body.login === "bad@x")
          return { status: 400, body: { code: 50035, message: "Invalid Form Body", errors: { login: { _errors: [{ code: "INVALID_LOGIN", message: "Login or password is invalid." }] } } } };
        return { status: 200, body: { token: "tok", user_id: "1" } };
      },
      [`${BASE}/auth/mfa/totp`]: { status: 200, body: { token: "tok2" } },
    });
    expect(await client.login("me@x", "pw")).toEqual({ token: "tok" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ login: "me@x", password: "pw", undelete: false });
    expect(calls[0]!.init.headers).toEqual({ "Content-Type": "application/json" });
    expect(await client.login("mfa@x", "pw")).toEqual({ mfa: true, ticket: "t1", webauthnOnly: false });
    expect(await client.login("key@x", "pw")).toEqual({ mfa: true, ticket: "t2", webauthnOnly: true });
    expect(await client.login("bot@x", "pw")).toEqual({ captcha: true });
    await expect(client.login("odd@x", "pw")).rejects.toThrow("Unexpected sign-in response");
    await expect(client.login("none@x", "pw")).rejects.toThrow("Unexpected sign-in response");
    await expect(client.login("deep@x", "pw")).rejects.toThrow("Deep");
    const refused = await client.login("bad@x", "pw").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SpacebarApiError);
    expect(refused).toMatchObject({ status: 400, code: "50035", message: "Login or password is invalid." });
    expect(await client.loginTotp("123456", "t1")).toEqual({ token: "tok2" });
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ code: "123456", ticket: "t1" });
    expect(CAPTCHA_REQUIRED).toBe("CAPTCHA_REQUIRED");
  });

  it("sends the token, retries rate limits and reads errors", async () => {
    let limited = 0;
    const { rest: client, calls, sleep } = rest({
      [`${BASE}/users/@me`]: () => (limited++ < 1 ? { status: 429, body: { retry_after: 2.5 } } : { status: 200, body: ANA }),
      [`${BASE}/channels/5/typing`]: { status: 429, body: {} },
      [`${BASE}/auth/logout`]: { status: 204 },
      [`${BASE}/channels/6/typing`]: { status: 500 },
      [`${BASE}/channels/7/typing`]: { status: 403, body: { code: "DENIED", message: "" } },
      [`${BASE}/channels/8/typing`]: new Error("offline"),
    });
    client.token = "tok";
    expect(await client.me()).toEqual({ id: "2", username: "ana", globalName: "Ana", avatar: "abc123" });
    expect(sleep).toHaveBeenCalledWith(2500);
    expect(calls[0]!.init.headers).toEqual({ Authorization: "tok" });
    await expect(client.typing("5")).rejects.toMatchObject({ status: 429, code: "HTTP_429" });
    expect(sleep).toHaveBeenCalledWith(1000);
    await client.logout();
    expect(calls.at(-1)!.init).toMatchObject({ method: "POST", body: "{}" });
    await expect(client.typing("6")).rejects.toThrow("Request failed (HTTP 500)");
    await expect(client.typing("7")).rejects.toMatchObject({ code: "DENIED", message: "Request failed (HTTP 403)" });
    await expect(client.typing("8")).rejects.toThrow("offline");
    // The queue goes on after a failure.
    expect(await client.me()).toBeDefined();
  });

  it("waits between requests by itself", async () => {
    const { fetch } = fakeFetch({ [`${BASE}/channels/5/typing`]: { status: 204 } });
    await new SpacebarRest(BASE, { fetch, minIntervalMs: 1 }).typing("5");
  });

  it("pages history, and edits, deletes, reacts, acks and lists members", async () => {
    const { rest: client, calls } = rest({
      [`${BASE}/channels/5/messages?limit=50`]: { status: 200, body: [message("12", "5"), message("11", "5"), { bad: 1 }] },
      [`${BASE}/channels/5/messages?limit=50&before=11`]: { status: 200, body: { not: "a list" } },
      [`${BASE}/channels/5/messages/12`]: (init) => (init.method === "PATCH" ? { status: 200, body: message("12", "5", { content: "new" }) } : { status: 204 }),
      [`${BASE}/channels/5/messages/12/reactions/party%3A9/@me`]: { status: 204 },
      [`${BASE}/channels/5/messages/12/ack`]: { status: 200, body: { token: null } },
      [`${BASE}/guilds/100/members?limit=100`]: { status: 200, body: [{ user: ANA, roles: [] }, {}] },
      [`${BASE}/guilds/100/members?limit=100&after=2`]: { status: 200, body: [] },
    });
    expect((await client.messages("5")).map((m) => m.id)).toEqual(["11", "12"]);
    expect(await client.messages("5", "11")).toEqual([]);
    expect((await client.editMessage("5", "12", "new"))!.content).toBe("new");
    expect(calls.at(-1)!.init).toMatchObject({ method: "PATCH", body: JSON.stringify({ content: "new" }) });
    await client.deleteMessage("5", "12");
    expect(calls.at(-1)!.init.method).toBe("DELETE");
    await client.react("5", "12", "party:9", true);
    expect(calls.at(-1)!.init.method).toBe("PUT");
    await client.react("5", "12", "party:9", false);
    expect(calls.at(-1)!.init.method).toBe("DELETE");
    await client.ack("5", "12");
    expect(calls.at(-1)!.init).toMatchObject({ method: "POST", body: "{}" });
    expect((await client.members("100")).map((m) => m.user.id)).toEqual(["2"]);
    expect(await client.members("100", "2")).toEqual([]);
  });

  it("sends messages as JSON, or with files as multipart form data", async () => {
    const { rest: client, calls } = rest({ [`${BASE}/channels/5/messages`]: { status: 200, body: message("13", "5") } });
    expect((await client.sendMessage("5", "hi", "n1"))!.id).toBe("13");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ content: "hi", nonce: "n1" });
    await client.sendMessage("5", "re", "n2", "12");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ content: "re", nonce: "n2", message_reference: { message_id: "12", channel_id: "5" } });
    const bytes = new TextEncoder().encode("hello");
    const file = { filename: 'a"b.txt', size: 5, contentType: "text/plain", read: vi.fn(async (start: number, end: number) => bytes.slice(start, end)) };
    const odd = { filename: "c.bin", size: 2, contentType: "not a type", read: async () => new Uint8Array([1, 2, 3]) };
    await client.sendMessage("5", "files", "n3", undefined, [file, odd]);
    const { headers, body } = calls[2]!.init as { headers: Record<string, string>; body: Uint8Array };
    const boundary = /boundary=(.+)$/.exec(headers["Content-Type"]!)![1]!;
    const text = new TextDecoder().decode(body);
    expect(text).toContain(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n{"content":"files","nonce":"n3"}\r\n`);
    expect(text).toContain('name="files[0]"; filename="a_b.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n');
    // Only the bytes the file says it has, and a type that is not one goes as octet-stream.
    expect(text).toContain(`name="files[1]"; filename="c.bin"\r\nContent-Type: application/octet-stream\r\n\r\n${String.fromCharCode(1, 2)}\r\n`);
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });
});
