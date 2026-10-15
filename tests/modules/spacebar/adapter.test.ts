import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_INTERVAL_MS, SpacebarAdapter, mediaKind, type SpacebarAdapterDeps } from "../../../src/modules/spacebar/adapter";
import type { GatewaySocket } from "../../../src/modules/spacebar/gateway";
import type { NativeViewState } from "../../../src/shared/native";
import { ANA, DISCOVERY, ME, message, readyPayload } from "./fixtures";

const API = "https://api.sb/api/v9";
const DEF = { id: "spacebar-native", name: "Spacebar", url: "https://spacebar.chat" };

type Reply = { status: number; body?: unknown };
type Handler = (url: string, init: RequestInit) => Reply | Error | undefined;

class FakeSocket implements GatewaySocket {
  sent: { op: number; d: unknown }[] = [];
  private listeners: Record<string, ((event: never) => void)[]> = {};
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {}
  addEventListener(type: string, listener: (event: never) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  receive(payload: unknown): void {
    for (const l of this.listeners.message ?? []) l({ data: JSON.stringify(payload) } as never);
  }
  serverClose(code: number): void {
    for (const l of this.listeners.close ?? []) l({ code } as never);
  }
}

function setup(options: { token?: string; routes?: Handler[]; files?: SpacebarAdapterDeps["files"]; settings?: SpacebarAdapterDeps["settings"]; lockHosts?: SpacebarAdapterDeps["lockHosts"] | null } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const routes: Handler[] = [...(options.routes ?? [])];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    let reply: Reply | Error | undefined;
    for (const route of routes) if ((reply = route(url, init))) break;
    const channel = url.split("/channels/")[1]?.split("/")[0] ?? "";
    reply ??= url.endsWith("/.well-known/spacebar/client")
      ? { status: 200, body: DISCOVERY }
      : url.includes("/messages?")
        ? { status: 200, body: [message("450", channel)] }
        : url.endsWith("/messages") && init.method === "POST"
          ? { status: 200, body: message("990", channel, { author: ME }) }
          : { status: 204 };
    if (reply instanceof Error) throw reply;
    const body = reply.body;
    return { ok: reply.status < 300, status: reply.status, json: async () => body } as Response;
  });
  const sockets: FakeSocket[] = [];
  const secrets = new Map<string, string>(options.token ? [["token", options.token]] : []);
  const renders: NativeViewState[] = [];
  const lockHosts = options.lockHosts === null ? undefined : (options.lockHosts ?? vi.fn(async () => {}));
  const adapter = new SpacebarAdapter({
    def: DEF,
    fetch: fetch as unknown as typeof globalThis.fetch,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    secrets: {
      load: async (k) => secrets.get(k),
      save: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    },
    render: (state) => renders.push(state),
    lockHosts,
    rest: { sleep: async () => {} },
    platform: "win32",
    files: options.files,
    settings: options.settings,
  });
  const last = () => renders.at(-1)!;
  const chat = () => {
    const state = last();
    if (state.screen !== "chat") throw new Error(`expected chat, got ${state.screen}`);
    return state;
  };
  const channel = () => chat().channel!;
  /** Completes the gateway handshake with the READY fixture. */
  const goOnline = async (ready: unknown = readyPayload()) => {
    const socket = sockets.at(-1)!;
    socket.receive({ op: 10, d: { heartbeat_interval: 40_000 } });
    socket.receive({ op: 0, s: 1, t: "READY", d: ready });
    await vi.advanceTimersByTimeAsync(100);
  };
  const dispatch = async (t: string, d: unknown) => {
    sockets.at(-1)!.receive({ op: 0, s: 2, t, d });
    await vi.advanceTimersByTimeAsync(100);
  };
  const online = async () => {
    await adapter.start();
    await goOnline();
  };
  return { adapter, calls, routes, sockets, secrets, renders, last, chat, channel, goOnline, dispatch, online, lockHosts };
}

const body = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-16T12:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SpacebarAdapter sign-in", () => {
  it("shows the login screen and locks the engine to the instance's hosts", async () => {
    const { adapter, last, sockets, lockHosts, calls } = setup();
    expect(adapter.mode).toBe("native");
    expect(adapter.accountStatus()).toEqual({ state: "signed-out" });
    await adapter.start();
    expect(last()).toEqual({ screen: "login", platform: "Spacebar", identity: "email", busy: false, error: undefined });
    expect(sockets).toHaveLength(0);
    expect(lockHosts).toHaveBeenCalledWith(["api.sb", "gw.sb", "cdn.sb"]);
    expect(calls[0]!.url).toBe("https://spacebar.chat/.well-known/spacebar/client");
    // Discovery happens once.
    await adapter.start();
    expect(calls.filter((c) => c.url.includes("well-known"))).toHaveLength(1);
    expect(adapter.homeBadge()).toEqual({ unread: false, mentions: 0 });
  });

  it("goes on when the host lock is refused, or there is none", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Whatever the shell throws is shown as text.
    const refused = setup({ lockHosts: async () => Promise.reject("private address") });
    await refused.adapter.start();
    expect(warn).toHaveBeenCalledWith("[spacebar] host lock refused: private address");
    expect(refused.last().screen).toBe("login");
    const none = setup({ lockHosts: null });
    await none.adapter.start();
    expect(none.last().screen).toBe("login");
  });

  it("checks that the instance's API and CDN answer, for Diagnostics", async () => {
    let found = false;
    let cdn: Reply | Error = { status: 502 };
    const { adapter, calls } = setup({
      routes: [
        (url) => (url.includes("well-known") && !found ? { status: 503 } : undefined),
        (url) => (url === "https://cdn.sb/ping" ? cdn : undefined),
        (url) => (url === "https://api.sb/api/ping" ? { status: 200, body: { ping: "pong!" } } : undefined),
      ],
    });
    expect(adapter.health()).toEqual([]);
    await adapter.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.health()).toEqual([{ name: "Instance found", ok: false, detail: "Could not reach Spacebar: Instance discovery failed (HTTP 503) Nothing works until it does." }]);
    found = true;
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    expect(calls.filter((c) => c.url.endsWith("/ping")).map((c) => c.url)).toEqual(["https://api.sb/api/ping", "https://cdn.sb/ping"]);
    expect(adapter.health()).toEqual([
      { name: "API answers", ok: true },
      { name: "CDN answers", ok: false, detail: "It answered HTTP 502. Pictures, avatars and files do not load." },
    ]);
    cdn = new Error("offline");
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    expect(adapter.health()[1]).toEqual({ name: "CDN answers", ok: false, detail: "It could not be reached (offline). Pictures, avatars and files do not load." });
  });

  it("says when the instance cannot be found, also when signing in", async () => {
    const { adapter, last } = setup({ routes: [(url) => (url.includes("well-known") ? new Error("no route") : undefined)] });
    await adapter.start();
    expect(last()).toMatchObject({ screen: "login", error: "Could not reach Spacebar: no route" });
    await adapter.handleAction({ type: "login", identity: "me@x", password: "pw" });
    expect(last()).toMatchObject({ screen: "login", busy: false, error: "Could not reach Spacebar: no route" });
    // Signing out needs no instance.
    await adapter.signOut();
    expect(last()).toMatchObject({ screen: "login", error: undefined });
  });

  it("signs in with a password, keeps the token and connects", async () => {
    const { adapter, last, secrets, sockets, calls, goOnline, renders } = setup({
      routes: [(url, init) => (url === `${API}/auth/login` ? { status: 200, body: { token: "tok", user_id: "1", login: body(init).login } } : undefined)],
    });
    await adapter.start();
    await adapter.handleAction({ type: "login", identity: "me@x", password: "pw" });
    expect(renders.some((r) => r.screen === "login" && r.busy)).toBe(true);
    expect(body(calls.find((c) => c.url === `${API}/auth/login`)!.init)).toEqual({ login: "me@x", password: "pw", undelete: false });
    expect(secrets.get("token")).toBe("tok");
    expect(last()).toEqual({ screen: "connecting", platform: "Spacebar", status: "Connecting…" });
    expect(adapter.accountStatus()).toEqual({ state: "signed-in" });
    expect(sockets).toHaveLength(1);
    await goOnline();
    expect(last().screen).toBe("chat");
    expect(adapter.accountStatus()).toEqual({ state: "signed-in", name: "me" });
    expect(sockets[0]!.sent[0]).toMatchObject({ op: 2, d: { token: "tok" } });
  });

  it("shows why a password was refused", async () => {
    const { adapter, last } = setup({
      routes: [(url) => (url === `${API}/auth/login` ? { status: 400, body: { errors: { login: { _errors: [{ message: "Login or password is invalid." }] } } } } : undefined)],
    });
    await adapter.start();
    await adapter.handleAction({ type: "login", identity: "me@x", password: "bad" });
    expect(last()).toMatchObject({ screen: "login", busy: false, error: "Login or password is invalid." });
  });

  it("asks for an authenticator or backup code, and goes back on cancel", async () => {
    const { adapter, last, calls, secrets } = setup({
      routes: [
        (url) => (url === `${API}/auth/login` ? { status: 200, body: { token: null, mfa: true, ticket: "t1" } } : undefined),
        (url, init) => (url === `${API}/auth/mfa/totp` ? (body(init).code === "123456" ? { status: 200, body: { token: "tok" } } : { status: 400, body: { message: "Invalid two-factor code" } }) : undefined),
      ],
    });
    await adapter.start();
    // No code is taken before the password.
    await adapter.handleAction({ type: "mfa", code: "123456" });
    expect(calls.some((c) => c.url.endsWith("/totp"))).toBe(false);
    await adapter.handleAction({ type: "login", identity: "me@x", password: "pw" });
    expect(last()).toEqual({ screen: "mfa", platform: "Spacebar", codes: "totp", busy: false, error: undefined });
    await adapter.handleAction({ type: "mfa", code: "000 000" });
    expect(body(calls.at(-1)!.init)).toEqual({ code: "000000", ticket: "t1" });
    expect(last()).toMatchObject({ screen: "mfa", error: "Invalid two-factor code" });
    await adapter.handleAction({ type: "cancelMfa" });
    expect(last()).toMatchObject({ screen: "login", error: undefined });
    await adapter.handleAction({ type: "login", identity: "me@x", password: "pw" });
    await adapter.handleAction({ type: "mfa", code: "123456" });
    expect(secrets.get("token")).toBe("tok");
    expect(last().screen).toBe("connecting");
  });

  it("refuses accounts that sign in with a security key", async () => {
    const { adapter, last } = setup({ routes: [(url) => (url === `${API}/auth/login` ? { status: 200, body: { token: null, mfa: true, ticket: "t", webauthn: "{}" } } : undefined)] });
    await adapter.start();
    await adapter.handleAction({ type: "login", identity: "me@x", password: "pw" });
    expect(last()).toMatchObject({ screen: "login", error: "This account signs in with a security key, which only works in Spacebar's own apps." });
  });

  it("takes a token instead where the instance asks for a captcha", async () => {
    let accepted = false;
    const { adapter, last, secrets, calls } = setup({
      routes: [
        (url) => (url === `${API}/auth/login` ? { status: 400, body: { captcha_key: ["captcha-required"], captcha_sitekey: "k", captcha_service: "hcaptcha" } } : undefined),
        (url, init) => (url === `${API}/users/@me` ? (accepted && (init.headers as Record<string, string>).Authorization === "good" ? { status: 200, body: ME } : { status: 401, body: { message: "Unauthorized" } }) : undefined),
      ],
    });
    await adapter.start();
    await adapter.handleAction({ type: "login", identity: "me@x", password: "pw" });
    const prompt = last();
    expect(prompt).toMatchObject({ screen: "prompt", busy: false, error: undefined, prompt: { id: "token", submit: "Sign in", cancel: "Back", fields: [{ name: "token", type: "password" }] } });
    await adapter.handleAction({ type: "prompt", id: "token", values: { token: "has space" } });
    expect(last()).toMatchObject({ screen: "prompt", error: "Paste the whole token, without spaces." });
    await adapter.handleAction({ type: "prompt", id: "token", values: {} });
    expect(last()).toMatchObject({ error: "Paste the whole token, without spaces." });
    await adapter.handleAction({ type: "prompt", id: "token", values: { token: " bad " } });
    expect(last()).toMatchObject({ screen: "prompt", error: "The instance did not accept this token." });
    expect((calls.at(-1)!.init.headers as Record<string, string>).Authorization).toBe("bad");
    accepted = true;
    // Steps of other forms are not this module's.
    await adapter.handleAction({ type: "prompt", id: "other", values: { token: "good" } });
    expect(secrets.has("token")).toBe(false);
    await adapter.handleAction({ type: "prompt", id: "token", values: { token: "good" } });
    expect(secrets.get("token")).toBe("good");
    expect(last().screen).toBe("connecting");
  });

  it("shows other failures checking a token, and goes back from the token step", async () => {
    const { adapter, last } = setup({
      routes: [
        (url) => (url === `${API}/auth/login` ? { status: 400, body: { captcha_key: ["captcha-required"] } } : undefined),
        (url) => (url === `${API}/users/@me` ? { status: 500 } : undefined),
      ],
    });
    await adapter.start();
    await adapter.handleAction({ type: "login", identity: "me@x", password: "pw" });
    await adapter.handleAction({ type: "prompt", id: "token", values: { token: "tok" } });
    expect(last()).toMatchObject({ screen: "prompt", error: "Request failed (HTTP 500)" });
    await adapter.handleAction({ type: "cancelPrompt", id: "token" });
    expect(last()).toMatchObject({ screen: "login", error: undefined });
  });

  it("ignores a second sign-in while one runs", async () => {
    let release: (reply: Reply) => void = () => {};
    const { adapter } = setup();
    await adapter.start();
    const pending = new Promise<Reply>((resolve) => (release = resolve));
    const request = vi.fn(async () => (await pending).body);
    adapter["rest"]!.request = request;
    const first = adapter.handleAction({ type: "login", identity: "me@x", password: "pw" });
    await adapter.handleAction({ type: "login", identity: "me@x", password: "pw" });
    release({ status: 200, body: { token: "tok" } });
    await first;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("resumes a saved session, and ends it when the token is refused", async () => {
    const { adapter, sockets, secrets, last, goOnline } = setup({ token: "saved" });
    const servers = vi.fn();
    adapter.onServersChanged(servers);
    await adapter.start();
    expect(adapter.accountStatus()).toEqual({ state: "signed-in" });
    await goOnline();
    sockets[0]!.receive({ op: 0, s: 2, t: "RESUMED", d: {} });
    sockets[0]!.serverClose(1006);
    expect(last()).toMatchObject({ screen: "chat", error: "Connection lost. Reconnecting…" });
    await vi.advanceTimersByTimeAsync(1000);
    sockets[1]!.serverClose(4004);
    expect(last()).toMatchObject({ screen: "login", error: "Your session has ended. Please sign in again." });
    expect(secrets.has("token")).toBe(false);
    expect(servers).toHaveBeenLastCalledWith([]);
  });

  it("shows reconnecting before the session is back", async () => {
    const { adapter, sockets, last } = setup({ token: "saved" });
    await adapter.start();
    sockets[0]!.serverClose(1006);
    expect(last()).toEqual({ screen: "connecting", platform: "Spacebar", status: "Reconnecting…" });
  });

  it("signs out on the server and forgets the token", async () => {
    const { adapter, online, calls, secrets, last, routes } = setup({ token: "saved" });
    const directs = vi.fn();
    adapter.onDirectsChanged(directs);
    await online();
    await adapter.signOut();
    expect(calls.at(-1)).toMatchObject({ url: `${API}/auth/logout`, init: { method: "POST" } });
    expect(secrets.has("token")).toBe(false);
    expect(last()).toMatchObject({ screen: "login", error: undefined });
    expect(directs).toHaveBeenLastCalledWith([]);
    expect(adapter.accountStatus()).toEqual({ state: "signed-out" });
    // Signing out with the server unreachable still ends the session here.
    routes.unshift(() => new Error("offline"));
    await adapter.handleAction({ type: "logout" });
    expect(last().screen).toBe("login");
  });
});

describe("SpacebarAdapter rail and conversations", () => {
  it("lists guilds and DMs, with unread state and previews", async () => {
    const { adapter, online, dispatch } = setup({ token: "saved" });
    await online();
    expect(adapter.railServers()).toEqual([
      { key: "100", account: { platform: "spacebar-native", instance: "spacebar.chat", accountId: "default" }, name: "Alpha", iconUrl: "https://cdn.sb/icons/100/1c0.png?size=96", unread: true, mentions: 2 },
      { key: "200", account: expect.any(Object), name: "Beta", iconUrl: undefined, unread: false, mentions: 0 },
    ]);
    expect(await adapter.listServers()).toHaveLength(2);
    expect(await adapter.listDirectConversations()).toEqual([
      { key: "900", account: expect.any(Object), title: "Ana", avatarUrl: "https://cdn.sb/avatars/2/abc123.png?size=64", lastActivity: expect.any(Number), unread: true, mentions: 1 },
      { key: "901", account: expect.any(Object), title: "Group", avatarUrl: undefined, lastActivity: expect.any(Number), unread: false, mentions: 0 },
    ]);
    await dispatch("MESSAGE_CREATE", message("1000", "900", { content: "hi <@1> in <#111> for <@&120> and <@9> <#5> <@&5>" }));
    expect(adapter.directs()[0]!.preview).toBe("hi @me in #general for @Admins and <@9> <#5> <@&5>");
    await dispatch("MESSAGE_CREATE", message("1001", "900", { content: "", attachments: [{ id: "5", filename: "a.png" }] }));
    expect(adapter.directs()[0]!.preview).toBe("📎 a.png");
    await dispatch("CHANNEL_CREATE", { id: "902", type: 3, recipients: [ME] });
    expect(adapter.directs().find((d) => d.key === "902")!.title).toBe("Direct message");
  });

  it("opens a guild at its first text channel, with its sidebar and unread marker", async () => {
    const { adapter, online, chat, channel, calls } = setup({
      token: "saved",
      routes: [(url) => (url === `${API}/channels/113/messages?limit=50` ? { status: 200, body: [message("300", "113")] } : undefined)],
    });
    await online();
    await expect(adapter.openServer("999")).rejects.toThrow("Unknown Spacebar guild: 999");
    await adapter.openServer("100");
    expect(chat().title).toBe("Alpha");
    expect(chat().sidebar.map((i) => [i.id, i.kind, i.unread, i.mentions, i.active])).toEqual([
      ["113", "text", false, 0, true],
      ["114", "text", false, 0, false],
      ["110", "category", false, 0, false],
      ["111", "text", true, 2, false],
      ["112", "voice", false, 0, false],
    ]);
    expect(channel()).toMatchObject({ id: "113", name: "lobby", loading: false, hasOlder: false, can: { reply: true, react: true, attach: false, typing: true, members: true } });
    expect(chat()).toMatchObject({ emojiBase: "https://cdn.sb/emojis", voice: null, customEmoji: [{ id: "130", name: "party", animated: false, source: "Alpha" }] });
    // An unread channel marks where its news begins.
    await adapter.handleAction({ type: "select", channelId: "111" });
    expect(channel().unread).toEqual({ firstId: "450" });
    // Opened again, it keeps its marker and history.
    await adapter.handleAction({ type: "select", channelId: "111" });
    expect(channel().unread).toEqual({ firstId: "450" });
    expect(calls.filter((c) => c.url.includes("/channels/111/messages?"))).toHaveLength(1);
    // Voice channels and unknown ones do not open.
    await adapter.handleAction({ type: "select", channelId: "112" });
    await adapter.handleAction({ type: "select", channelId: "999" });
    expect(channel().id).toBe("111");
    // Back to the guild: the last channel there.
    await adapter.openHome();
    expect(chat()).toMatchObject({ title: "Direct Messages", channel: null });
    await adapter.openServer("100");
    expect(channel().id).toBe("111");
    // A guild without text channels opens without one.
    await adapter.openServer("200");
    expect(channel().id).toBe("211");
  });

  it("opens no channel in a guild without text channels", async () => {
    const ready = { ...readyPayload(), guilds: [{ id: "100", name: "Alpha", channels: [{ id: "112", type: 2, name: "voice" }] }] };
    const { adapter, goOnline, chat } = setup({ token: "saved" });
    await adapter.start();
    await goOnline(ready);
    await adapter.openServer("100");
    expect(chat()).toMatchObject({ title: "Alpha", channel: null });
  });

  it("opens DMs at home, marking where the news begins once older messages reach it", async () => {
    const page = Array.from({ length: 50 }, (_, i) => message(String(1100 - i), "900"));
    const { adapter, online, chat, channel, calls, dispatch } = setup({
      token: "saved",
      routes: [
        (url) => (url === `${API}/channels/900/messages?limit=50` ? { status: 200, body: page } : undefined),
        (url) => (url === `${API}/channels/900/messages?limit=50&before=1051` ? { status: 200, body: [message("700", "900"), message("650", "900")] } : undefined),
      ],
    });
    await online();
    await adapter.openConversation("900");
    expect(chat().title).toBe("Direct Messages");
    expect(chat().sidebar.map((i) => [i.id, i.kind, i.iconUrl])).toEqual([
      ["900", "dm", "https://cdn.sb/avatars/2/abc123.png?size=64"],
      ["901", "dm", undefined],
    ]);
    expect(channel()).toMatchObject({ name: "Ana", hasOlder: true, unread: {} });
    // One page at a time.
    await Promise.all([adapter.handleAction({ type: "loadOlder" }), adapter.handleAction({ type: "loadOlder" })]);
    expect(channel().hasOlder).toBe(false);
    expect(channel().unread).toEqual({ firstId: "1051" });
    // Nothing more to load.
    await adapter.handleAction({ type: "loadOlder" });
    expect(calls.filter((c) => c.url.includes("/channels/900/messages?"))).toHaveLength(2);
    await adapter.openConversation("111");
    expect(chat().title).toBe("Alpha");
    // A group never read, with news: its marker starts at the first message from someone else.
    await dispatch("MESSAGE_CREATE", message("1200", "901"));
    await adapter.openConversation("901");
    expect(channel().unread).toEqual({ firstId: "450" });
  });

  it("shows history that cannot load as an error", async () => {
    const { adapter, online, last } = setup({ token: "saved", routes: [(url) => (url.includes("/messages?") ? { status: 403, body: { message: "Missing Access" } } : undefined)] });
    await online();
    await adapter.openConversation("111");
    expect(last()).toMatchObject({ error: "Could not load messages: Missing Access" });
  });

  it("marks the open channel read while the view is in front", async () => {
    // A failed ack is not shown: the next one catches up.
    const { adapter, online, calls, dispatch } = setup({ token: "saved", routes: [(url) => (url.endsWith("/ack") ? { status: 500 } : undefined)] });
    await online();
    await adapter.openConversation("111");
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.some((c) => c.url.endsWith("/ack"))).toBe(false);
    adapter.setVisible(true);
    adapter.setVisible(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((c) => c.url.endsWith("/ack")).map((c) => c.url)).toEqual([`${API}/channels/111/messages/500/ack`]);
    expect(adapter.railServers()[0]!.mentions).toBe(0);
    // A new message while it is open is read too; one from someone else in a read channel is not acked again.
    await dispatch("MESSAGE_CREATE", message("600", "111"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((c) => c.url.endsWith("/ack"))).toHaveLength(2);
    await adapter.openConversation("113");
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((c) => c.url.endsWith("/ack"))).toHaveLength(2);
    adapter.setVisible(false);
    await dispatch("CHANNEL_DELETE", { id: "113" });
    adapter.setVisible(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((c) => c.url.endsWith("/ack"))).toHaveLength(2);
  });

  it("notifies of DMs and mentions, not of other guild messages", async () => {
    const { adapter, online, dispatch } = setup({ token: "saved" });
    const notes = vi.fn();
    adapter.onNotification(notes);
    await online();
    await dispatch("MESSAGE_CREATE", message("1000", "900", { content: "hello" }));
    expect(notes).toHaveBeenLastCalledWith({ title: "Ana", body: "hello", target: "900", railKey: "dm:900", inView: false });
    await dispatch("MESSAGE_CREATE", message("1001", "901", { content: "" }));
    expect(notes).toHaveBeenLastCalledWith({ title: "Ana in Group", body: "New message", target: "901", railKey: "dm:901", inView: false });
    await dispatch("MESSAGE_CREATE", message("1002", "113", { content: "plain" }));
    expect(notes).toHaveBeenCalledTimes(2);
    await adapter.openConversation("113");
    adapter.setVisible(true);
    await dispatch("MESSAGE_CREATE", message("1003", "113", { content: "", mentions: [ME], attachments: [{ id: "5", filename: "a.png" }] }));
    expect(notes).toHaveBeenLastCalledWith({ title: "Ana in #lobby (Alpha)", body: "Sent an attachment", target: "113", railKey: "100", inView: true });
    await dispatch("CHANNEL_CREATE", { id: "115", type: 0, guild_id: "100" });
    await dispatch("MESSAGE_CREATE", message("1004", "115", { mention_everyone: true }));
    expect(notes).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Ana in #115 (Alpha)" }));
    await dispatch("MESSAGE_CREATE", message("1005", "998", { mention_everyone: true }));
    expect(notes).toHaveBeenCalledTimes(4);
  });
});

describe("SpacebarAdapter messages", () => {
  async function opened(options: Parameters<typeof setup>[0] = {}) {
    const ctx = setup({ token: "saved", ...options });
    await ctx.online();
    await ctx.adapter.openConversation("111");
    return ctx;
  }

  it("shows messages: authors, mentions, replies, reactions and files", async () => {
    const ctx = await opened({
      routes: [
        (url) =>
          url === `${API}/channels/111/messages?limit=50`
            ? {
                status: 200,
                body: [
                  message("470", "111", { author: ME, type: 19, referenced_message: { id: "450", author: ANA, content: "hi <@1>", timestamp: "2026-10-14T11:00:00Z" } }),
                  message("460", "111", {
                    mentions: [ME],
                    reactions: [{ emoji: { name: "👍" }, count: 1, me: true }, { emoji: { id: "130", name: "party" }, count: 2 }],
                    attachments: [{ id: "8", filename: "a.png", content_type: "image/png", url: "https://cdn.sb/a.png", width: 4, height: 3, size: 9 }],
                    edited_timestamp: "2026-10-14T12:05:00Z",
                  }),
                  message("455", "111", { author: ME, type: 7, referenced_message: null }),
                  message("450", "111", { author: { id: "3", username: "cy" }, referenced_message: { id: "1", author: { id: "4", username: "dee" }, content: "x" } }),
                ],
              }
            : undefined,
      ],
    });
    const [m450, m455, m460, m470] = ctx.channel().messages;
    expect(m450).toMatchObject({ author: "cy", mine: false, canEdit: false, canDelete: false, reply: { id: "1", author: "dee", content: "x" } });
    expect(m450!.reply).not.toHaveProperty("timestamp");
    expect(m450).not.toHaveProperty("avatarUrl");
    expect(m455).toMatchObject({ mine: true, canEdit: false, canDelete: true, reply: null });
    expect(m455).not.toHaveProperty("source");
    expect(m460).toEqual({
      id: "460",
      author: "Ana",
      authorId: "2",
      authorMention: "<@2>",
      avatarUrl: "https://cdn.sb/avatars/2/abc123.png?size=64",
      content: "m460",
      timestamp: "2026-10-14T12:00:00Z",
      edited: true,
      mine: false,
      canEdit: false,
      canDelete: false,
      canPin: true,
      mentionsMe: true,
      reactions: [
        { key: "👍", label: "👍", imageUrl: undefined, count: 1, me: true },
        { key: "party:130", label: ":party:", imageUrl: "https://cdn.sb/emojis/130.png", count: 2, me: false },
      ],
      attachments: [{ name: "a.png", kind: "image", url: "https://cdn.sb/a.png", width: 4, height: 3, size: 9, mime: "image/png" }],
    });
    expect(m470).toMatchObject({ mine: true, canEdit: true, source: "m470", reply: { id: "450", author: "Ana", content: "hi @me", timestamp: "2026-10-14T11:00:00Z" } });
    expect(mediaKind("video/mp4")).toBe("video");
    expect(mediaKind("audio/ogg")).toBe("audio");
    expect(mediaKind(undefined)).toBe("file");
  });

  it("shows link previews, with pictures only from the instance's own hosts", async () => {
    const embeds = [
      { type: "link", url: "https://example.org/a", title: "Proxied", thumbnail: { url: "https://example.org/t.png", proxy_url: "https://cdn.sb/proxy/t.png", width: 8, height: 6 } },
      { type: "link", url: "https://example.org/b", title: "Direct", image: { url: "https://example.org/i.png" } },
      { type: "rich", image: { url: "https://example.org/only.png" } },
    ];
    const ctx = await opened({ routes: [(url) => (url === `${API}/channels/111/messages?limit=50` ? { status: 200, body: [message("450", "111", { embeds })] } : undefined)] });
    expect(ctx.channel().messages[0]!.embeds).toEqual([
      { url: "https://example.org/a", title: "Proxied", image: { url: "https://cdn.sb/proxy/t.png", width: 8, height: 6, thumbnail: true } },
      { url: "https://example.org/b", title: "Direct" },
    ]);
    // Embeds the instance adds later arrive as an update of the whole message.
    await ctx.dispatch("MESSAGE_UPDATE", message("450", "111", { embeds: [] }));
    expect(ctx.channel().messages[0]).not.toHaveProperty("embeds");
  });

  it("lists pins while the panel is open, follows them live, and pins from a message", async () => {
    let pins: Reply = {
      status: 200,
      body: [message("450", "111", { pinned: true, content: "<@1> look" }), message("440", "111", { content: "", attachments: [{ id: "5", filename: "a.png" }] }), message("430", "111", { author: ME, content: "" }), { bad: true }],
    };
    const ctx = await opened({ routes: [(url) => (url === `${API}/channels/111/pins` ? pins : undefined)] });
    expect(ctx.channel().can.pins).toBe(true);
    expect(ctx.channel()).not.toHaveProperty("pins");
    await ctx.adapter.handleAction({ type: "pins", open: true });
    expect(ctx.channel().pins).toEqual({
      messages: [
        { id: "450", author: "Ana", avatarUrl: "https://cdn.sb/avatars/2/abc123.png?size=64", content: "@me look", timestamp: "2026-10-14T12:00:00Z" },
        { id: "440", author: "Ana", avatarUrl: "https://cdn.sb/avatars/2/abc123.png?size=64", content: "📎 a.png", timestamp: "2026-10-14T12:00:00Z" },
        { id: "430", author: "me", content: "", timestamp: "2026-10-14T12:00:00Z" },
      ],
      loading: false,
    });
    // Pinning from the message menu: the message shows pinned, and the list is fetched again.
    await ctx.adapter.handleAction({ type: "pin", messageId: "450", pin: true });
    expect(ctx.calls.at(-2)).toMatchObject({ url: `${API}/channels/111/pins/450`, init: { method: "PUT" } });
    expect(ctx.channel().messages[0]).toMatchObject({ pinned: true, canPin: true });
    await ctx.adapter.handleAction({ type: "pin", messageId: "450", pin: false });
    expect(ctx.calls.at(-2)).toMatchObject({ url: `${API}/channels/111/pins/450`, init: { method: "DELETE" } });
    expect(ctx.channel().messages[0]).not.toHaveProperty("pinned");
    // Someone else pins: the list follows; events for other channels are left alone.
    pins = { status: 200, body: Array.from({ length: 101 }, (_, i) => message(String(1000 + i), "111")) };
    const fetched = () => ctx.calls.filter((c) => c.url === `${API}/channels/111/pins`).length;
    const before = fetched();
    await ctx.dispatch("CHANNEL_PINS_UPDATE", { channel_id: "113" });
    await ctx.dispatch("CHANNEL_PINS_UPDATE", null);
    expect(fetched()).toBe(before);
    await ctx.dispatch("CHANNEL_PINS_UPDATE", { channel_id: "111" });
    expect(ctx.channel().pins).toMatchObject({ loading: false, note: "Only the latest 100 pins are listed." });
    expect(ctx.channel().pins!.messages).toHaveLength(100);
    // A failure shows in the panel; Spacebar's pin line says what happened.
    pins = { status: 403, body: { message: "Missing Access" } };
    await ctx.adapter.handleAction({ type: "pins", open: true });
    expect(ctx.channel().pins).toEqual({ messages: [], loading: false, error: "Could not load pinned messages: Missing Access" });
    await ctx.dispatch("MESSAGE_CREATE", message("1200", "111", { type: 6, content: "" }));
    expect(ctx.channel().messages.at(-1)).toMatchObject({ content: "*pinned a message.*", canPin: false });
    // Closed, or another channel opened: no list, and late answers are dropped.
    const late = ctx.adapter.handleAction({ type: "pins", open: true });
    await ctx.adapter.handleAction({ type: "pins", open: false });
    await late;
    expect(ctx.channel()).not.toHaveProperty("pins");
    await ctx.adapter.handleAction({ type: "pins", open: true });
    await ctx.adapter.handleAction({ type: "select", channelId: "113" });
    expect(ctx.channel()).not.toHaveProperty("pins");
    await ctx.dispatch("CHANNEL_PINS_UPDATE", { channel_id: "111" });
    expect(fetched()).toBe(before + 4);
  });

  it("searches a server channel on the instance, dropping answers to earlier searches", async () => {
    let answer: Reply = { status: 200, body: { messages: [[message("460", "111", { content: "hi there" })], [{ bad: true }], "x", []], total_results: 1 } };
    const ctx = await opened({ routes: [(url) => (url.startsWith(`${API}/guilds/100/messages/search?`) ? answer : undefined)] });
    expect(ctx.channel().can.search).toBe(true);
    await ctx.adapter.handleAction({ type: "search", query: "  hi there " });
    expect(ctx.calls.at(-1)!.url).toBe(`${API}/guilds/100/messages/search?channel_id=111&content=hi+there&limit=25`);
    expect(ctx.channel().search).toEqual({
      query: "hi there",
      messages: [{ id: "460", author: "Ana", avatarUrl: "https://cdn.sb/avatars/2/abc123.png?size=64", content: "hi there", timestamp: "2026-10-14T12:00:00Z" }],
      loading: false,
    });
    answer = { status: 403, body: { message: "Missing Access" } };
    await ctx.adapter.handleAction({ type: "search", query: "x" });
    expect(ctx.channel().search).toEqual({ query: "x", messages: [], loading: false, error: "Search failed: Missing Access" });
    answer = { status: 200, body: null };
    await ctx.adapter.handleAction({ type: "search", query: "y" });
    expect(ctx.channel().search).toMatchObject({ query: "y", messages: [], loading: false });
    // An earlier search answering late, or an ended one, changes nothing.
    const early = ctx.adapter.handleAction({ type: "search", query: "a" });
    await ctx.adapter.handleAction({ type: "search", query: "b" });
    await early;
    expect(ctx.channel().search!.query).toBe("b");
    const ended = ctx.adapter.handleAction({ type: "search", query: "c" });
    await ctx.adapter.handleAction({ type: "search", query: " " });
    await ended;
    expect(ctx.channel()).not.toHaveProperty("search");
    // Another channel ends it; DMs are not searched.
    await ctx.adapter.handleAction({ type: "search", query: "z" });
    await ctx.adapter.handleAction({ type: "select", channelId: "113" });
    expect(ctx.channel()).not.toHaveProperty("search");
    await ctx.adapter.openConversation("900");
    expect(ctx.channel().can.search).toBe(false);
    const calls = ctx.calls.length;
    await ctx.adapter.handleAction({ type: "search", query: "z" });
    expect(ctx.calls.length).toBe(calls);
    expect(ctx.channel()).not.toHaveProperty("search");
  });

  it("shows when pinning is refused, and pins nothing without a channel", async () => {
    const ctx = setup({ token: "saved", routes: [(url) => (url.includes("/pins/") ? { status: 403, body: { message: "Missing Permissions" } } : undefined)] });
    await ctx.online();
    await ctx.adapter.handleAction({ type: "pin", messageId: "450", pin: true });
    await ctx.adapter.handleAction({ type: "pins", open: true });
    await ctx.adapter.handleAction({ type: "search", query: "x" });
    expect(ctx.calls.some((c) => c.url.includes("/pins") || c.url.includes("/search"))).toBe(false);
    await ctx.adapter.openConversation("111");
    await ctx.adapter.handleAction({ type: "pin", messageId: "450", pin: true });
    expect(ctx.last()).toMatchObject({ error: "Message not pinned: Missing Permissions" });
    await ctx.adapter.handleAction({ type: "pin", messageId: "999", pin: false });
    expect(ctx.last()).toMatchObject({ error: "Message not unpinned: Missing Permissions" });
    ctx.routes.unshift((url) => (url.includes("/pins/") ? { status: 204 } : undefined));
    await ctx.adapter.handleAction({ type: "pin", messageId: "999", pin: true });
    expect(ctx.channel()).not.toHaveProperty("pins");
  });

  it("sends, replies, edits and deletes", async () => {
    const ctx = await opened({ routes: [(url, init) => (url === `${API}/channels/111/messages/450` && init.method === "PATCH" ? { status: 200, body: message("450", "111", { content: "edited" }) } : undefined)] });
    await ctx.adapter.handleAction({ type: "send", content: "  " });
    expect(ctx.calls.some((c) => c.init.method === "POST" && c.url.endsWith("/messages"))).toBe(false);
    await ctx.adapter.handleAction({ type: "send", content: "hello", replyTo: "450" });
    const sent = ctx.calls.at(-1)!;
    expect(body(sent.init)).toMatchObject({ content: "hello", message_reference: { message_id: "450", channel_id: "111" } });
    expect(ctx.channel().messages.map((m) => m.id)).toEqual(["450", "990"]);
    await ctx.adapter.handleAction({ type: "edit", messageId: "450", content: "edited" });
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.channel().messages[0]!.content).toBe("edited");
    await ctx.adapter.handleAction({ type: "edit", messageId: "451", content: "edited" });
    // An answer that is not a message adds none.
    ctx.routes.unshift((url, init) => (url.endsWith("/messages") && init.method === "POST" ? { status: 200, body: {} } : undefined));
    await ctx.adapter.handleAction({ type: "send", content: "odd" });
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.channel().messages.map((m) => m.id)).toEqual(["450", "990"]);
    await ctx.adapter.handleAction({ type: "delete", messageId: "450" });
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.channel().messages.map((m) => m.id)).toEqual(["990"]);
  });

  it("shows failures in the banner", async () => {
    const ctx = await opened({ routes: [(url, init) => (init.method && init.method !== "GET" ? { status: 403, body: { message: "Missing Permissions" } } : undefined)] });
    await ctx.adapter.handleAction({ type: "send", content: "hello" });
    expect(ctx.last()).toMatchObject({ error: "Message not sent: Missing Permissions" });
    await ctx.adapter.handleAction({ type: "edit", messageId: "450", content: "x" });
    expect(ctx.last()).toMatchObject({ error: "Message not edited: Missing Permissions" });
    await ctx.adapter.handleAction({ type: "delete", messageId: "450" });
    expect(ctx.last()).toMatchObject({ error: "Message not deleted: Missing Permissions" });
    await ctx.adapter.handleAction({ type: "react", messageId: "450", emoji: "👍", add: true });
    expect(ctx.last()).toMatchObject({ error: "Reaction failed: Missing Permissions" });
    // Opening a channel clears it.
    await ctx.adapter.handleAction({ type: "select", channelId: "113" });
    expect(ctx.last()).toMatchObject({ error: undefined });
  });

  it("reacts with Unicode and custom emoji", async () => {
    const ctx = await opened();
    await ctx.adapter.handleAction({ type: "react", messageId: "450", emoji: "party:130", add: true });
    expect(ctx.calls.at(-1)).toMatchObject({ url: `${API}/channels/111/messages/450/reactions/party%3A130/@me`, init: { method: "PUT" } });
    await ctx.adapter.handleAction({ type: "react", messageId: "450", emoji: "👍", add: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.channel().messages[0]!.reactions.map((r) => [r.key, r.count, r.me])).toEqual([
      ["party:130", 1, true],
      ["👍", 1, true],
    ]);
    await ctx.adapter.handleAction({ type: "react", messageId: "450", emoji: "👍", add: false });
    expect(ctx.calls.at(-1)!.init.method).toBe("DELETE");
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.channel().messages[0]!.reactions).toHaveLength(1);
  });

  it("attaches files and sends them with the message", async () => {
    const file = (name: string) => ({ filename: name, size: 3, contentType: "text/plain", read: async () => new Uint8Array([1, 2, 3]) });
    let picked = [file("a.txt"), file("b.txt")];
    const files = { pick: vi.fn(async () => picked), open: vi.fn((f: { name: string }) => file(f.name)) };
    const ctx = await opened({ files });
    expect(ctx.channel().can.attach).toBe(true);
    await ctx.adapter.handleAction({ type: "attach" });
    expect(ctx.channel().pending).toEqual([
      { name: "a.txt", size: 3 },
      { name: "b.txt", size: 3 },
    ]);
    await ctx.adapter.handleAction({ type: "removeAttachment", index: 0 });
    expect(ctx.channel().pending).toEqual([{ name: "b.txt", size: 3 }]);
    await ctx.adapter.handleAction({ type: "send", content: "" });
    const sent = ctx.calls.at(-1)!;
    expect((sent.init.headers as Record<string, string>)["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(new TextDecoder().decode(sent.init.body as Uint8Array)).toContain('filename="b.txt"');
    expect(ctx.channel().pending).toEqual([]);
    // At most ten per message.
    picked = Array.from({ length: 12 }, (_, i) => file(`${i}.txt`));
    await ctx.adapter.handleAction({ type: "attach" });
    expect(ctx.channel().pending).toHaveLength(10);
    expect(ctx.last()).toMatchObject({ error: "At most 10 files per message." });
    await ctx.adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "fav.gif", size: 3, type: "image/gif" } });
    expect(ctx.last()).toMatchObject({ error: "At most 10 files per message." });
    files.pick.mockRejectedValueOnce(new Error("no window"));
    await ctx.adapter.handleAction({ type: "attach" });
    expect(ctx.last()).toMatchObject({ error: "Could not attach: no window" });
  });

  it("sends a file the shell hands over at once, or with those already picked", async () => {
    const file = (name: string) => ({ filename: name, size: 1, contentType: "image/gif", read: async () => new Uint8Array([1]) });
    const files = { pick: vi.fn(async () => [file("a.png")]), open: vi.fn((f: { name: string }) => file(f.name)) };
    const ctx = await opened({ files });
    await ctx.adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "fav.gif", size: 1, type: "image/gif" }, replyTo: "450" });
    const sent = ctx.calls.at(-1)!;
    expect(new TextDecoder().decode(sent.init.body as Uint8Array)).toContain('"message_reference":{"message_id":"450","channel_id":"111"}');
    await ctx.adapter.handleAction({ type: "attach" });
    const before = ctx.calls.length;
    await ctx.adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "fav.gif", size: 1, type: "image/gif" } });
    expect(ctx.calls.length).toBe(before);
    expect(ctx.channel().pending.map((p) => p.name)).toEqual(["a.png", "fav.gif"]);
  });

  it("offers no files without the file bridge, and does nothing without a channel", async () => {
    const ctx = setup({ token: "saved" });
    await ctx.online();
    for (const action of [
      { type: "attach" },
      { type: "sendFile", file: { handle: "h", name: "a", size: 1, type: "image/png" } },
      { type: "send", content: "x" },
      { type: "edit", messageId: "1", content: "x" },
      { type: "delete", messageId: "1" },
      { type: "react", messageId: "1", emoji: "👍", add: true },
      { type: "typing" },
      { type: "loadOlder" },
      { type: "removeAttachment", index: 0 },
      { type: "joinVoice", channelId: "112" },
    ] as const)
      await ctx.adapter.handleAction(action);
    expect(ctx.calls.filter((c) => c.init.method && c.init.method !== "GET")).toEqual([]);
    await ctx.adapter.openConversation("111");
    await ctx.adapter.handleAction({ type: "attach" });
    await ctx.adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "a", size: 1, type: "image/png" } });
    expect(ctx.channel().pending).toEqual([]);
  });

  it("tells others while the user types, as Settings say", async () => {
    // A failed typing notice is not shown.
    const ctx = await opened({ settings: { typing: false }, routes: [(url) => (url.endsWith("/typing") ? { status: 500 } : undefined)] });
    expect(ctx.channel().can.typing).toBe(false);
    await ctx.adapter.handleAction({ type: "typing" });
    expect(ctx.calls.some((c) => c.url.endsWith("/typing"))).toBe(false);
    ctx.adapter.applySettings({ typing: true });
    expect(ctx.channel().can.typing).toBe(true);
    await ctx.adapter.handleAction({ type: "typing" });
    await ctx.adapter.handleAction({ type: "typing" });
    expect(ctx.calls.filter((c) => c.url.endsWith("/typing"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8_000);
    await ctx.adapter.handleAction({ type: "typing" });
    expect(ctx.calls.filter((c) => c.url.endsWith("/typing"))).toHaveLength(2);
  });

  it("shows who is typing until it runs out", async () => {
    const ctx = await opened();
    await ctx.dispatch("TYPING_START", { channel_id: "111", user_id: "2" });
    expect(ctx.channel().typing).toEqual(["Ana"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.channel().typing).toEqual([]);
  });

  it("answers the ready and other actions it does not offer", async () => {
    const ctx = await opened();
    const shown = ctx.renders.length;
    await ctx.adapter.handleAction({ type: "ready" });
    expect(ctx.renders.length).toBe(shown + 1);
    await ctx.adapter.handleAction({ type: "thread", rootId: "450" });
    expect(ctx.renders.length).toBe(shown + 1);
  });
});

describe("SpacebarAdapter members and profiles", () => {
  const MEMBERS = [
    { user: ME, roles: ["121"] },
    { user: ANA, nick: "Annie", roles: ["120", "121"] },
    { user: { id: "3", username: "cy", bot: true }, roles: ["122"] },
  ];

  it("lists a guild's members under their hoisted roles, in pages", async () => {
    const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ user: { id: String(from + i), username: `u${from + i}` }, roles: [] }));
    const ctx = setup({
      token: "saved",
      routes: [
        (url) => (url === `${API}/guilds/100/members?limit=100` ? { status: 200, body: [...MEMBERS, ...page(10, 97)] } : undefined),
        (url) => (url === `${API}/guilds/100/members?limit=100&after=106` ? { status: 200, body: page(200, 100) } : undefined),
      ],
    });
    await ctx.online();
    await ctx.adapter.openConversation("111");
    expect(ctx.channel()).not.toHaveProperty("members");
    await ctx.adapter.handleAction({ type: "members", open: true });
    const list = ctx.channel().members!;
    expect(list.sections.map((s) => [s.name, s.members.length])).toEqual([
      ["Mods", 1],
      ["Admins", 1],
      ["Members", 98],
    ]);
    expect(list.sections[0]!.members).toEqual([{ id: "3", name: "cy", mention: "<@3>", status: "Bot" }]);
    expect(list.sections[1]!.members[0]).toEqual({ id: "2", name: "Annie", mention: "<@2>", avatarUrl: "https://cdn.sb/avatars/2/abc123.png?size=64", color: "#ff0000" });
    expect(list.sections[2]!.members.slice(0, 2)).toEqual([
      { id: "1", name: "me", mention: "<@1>", color: "#00ff00" },
      { id: "10", name: "u10", mention: "<@10>" },
    ]);
    expect(list).toMatchObject({ hasMore: true, loading: false });
    // Only the next page of what is listed.
    await ctx.adapter.handleAction({ type: "loadMembers", offset: 5 });
    expect(ctx.calls.filter((c) => c.url.includes("/members?"))).toHaveLength(1);
    await ctx.adapter.handleAction({ type: "loadMembers", offset: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.channel().members).toMatchObject({ hasMore: false });
    expect(ctx.channel().members!.sections[2]!.members).toHaveLength(198);
    // The same guild's list is kept when another of its channels opens.
    await ctx.adapter.handleAction({ type: "select", channelId: "113" });
    expect(ctx.calls.filter((c) => c.url.includes("/members?"))).toHaveLength(2);
    // Profiles from what is known: the nickname, the username and roles there.
    await ctx.adapter.handleAction({ type: "profile", id: "2" });
    expect(ctx.chat().profile).toEqual({
      id: "2",
      name: "Annie",
      username: "@ana",
      avatarUrl: "https://cdn.sb/avatars/2/abc123.png?size=64",
      roles: [
        { name: "Admins", color: "#ff0000" },
        { name: "Helpers", color: "#00ff00" },
      ],
    });
    await ctx.adapter.handleAction({ type: "profile", id: "3" });
    expect(ctx.chat().profile).toEqual({ id: "3", name: "cy", username: "@cy", status: "Bot", roles: [{ name: "Mods" }] });
    await ctx.adapter.handleAction({ type: "profile", id: "404" });
    expect(ctx.chat().profile!.id).toBe("3");
    // Another conversation drops the card; closing the panel drops the list.
    await ctx.adapter.handleAction({ type: "select", channelId: "111" });
    expect(ctx.chat()).not.toHaveProperty("profile");
    await ctx.adapter.handleAction({ type: "members", open: false });
    expect(ctx.channel()).not.toHaveProperty("members");
    await ctx.adapter.handleAction({ type: "loadMembers", offset: 0 });
  });

  it("says when members cannot be listed, and drops answers for a closed panel", async () => {
    let fail = true;
    let release: () => void = () => {};
    const ctx = setup({
      token: "saved",
      routes: [
        (url) => (url.includes("/guilds/100/members") && fail ? { status: 403, body: { message: "Missing Access" } } : undefined),
        (url) => (url.includes("/guilds/200/members") ? { status: 200, body: MEMBERS } : undefined),
      ],
    });
    await ctx.online();
    await ctx.adapter.openConversation("111");
    await ctx.adapter.handleAction({ type: "members", open: true });
    expect(ctx.channel().members).toEqual({ sections: [], hasMore: false, loading: false, error: "Could not load members: Missing Access" });
    fail = false;
    const rest = ctx.adapter["rest"]!;
    const original = rest.members.bind(rest);
    rest.members = vi.fn(async (guildId: string, after?: string) => {
      await new Promise<void>((resolve) => (release = resolve));
      return original(guildId, after);
    });
    await ctx.adapter.handleAction({ type: "members", open: false });
    const opening = ctx.adapter.handleAction({ type: "members", open: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.channel().members).toMatchObject({ loading: true, sections: [] });
    await ctx.adapter.handleAction({ type: "members", open: false });
    release();
    await opening;
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.channel()).not.toHaveProperty("members");
  });

  it("lists a DM's people, and nothing outside guilds is fetched", async () => {
    const ctx = setup({ token: "saved", routes: [(url) => (url.includes("/guilds/200/members") ? { status: 200, body: [{ user: ANA, roles: [] }] } : undefined)] });
    await ctx.online();
    await ctx.adapter.openConversation("900");
    await ctx.adapter.handleAction({ type: "members", open: true });
    expect(ctx.channel().members).toEqual({
      sections: [
        {
          name: "Members",
          members: [
            { id: "1", name: "me", mention: "<@1>" },
            { id: "2", name: "Ana", mention: "<@2>", avatarUrl: "https://cdn.sb/avatars/2/abc123.png?size=64" },
          ],
        },
      ],
      hasMore: false,
      loading: false,
    });
    expect(ctx.calls.some((c) => c.url.includes("/members"))).toBe(false);
    await ctx.adapter.handleAction({ type: "profile", id: "2" });
    expect(ctx.chat().profile).toEqual({ id: "2", name: "Ana", username: "@ana", avatarUrl: "https://cdn.sb/avatars/2/abc123.png?size=64" });
    // A guild channel opened with the panel open fetches its guild's list.
    await ctx.adapter.openConversation("211");
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.channel().members!.sections.map((s) => s.name)).toEqual(["Members"]);
  });
});

describe("SpacebarAdapter edge cases", () => {
  it("lists no members and makes no card where nothing is open", async () => {
    const ctx = setup({ token: "saved" });
    await ctx.online();
    await ctx.adapter.handleAction({ type: "members", open: true });
    await ctx.adapter.handleAction({ type: "profile", id: "2" });
    expect(ctx.chat()).toMatchObject({ channel: null, profile: { id: "2", name: "Ana", username: "@ana" } });
    expect(ctx.calls.some((c) => c.url.includes("/members"))).toBe(false);
  });

  it("works from a READY without the user's own account", async () => {
    const ctx = setup({ token: "saved" });
    await ctx.adapter.start();
    await ctx.goOnline({ ...readyPayload(), user: undefined });
    await ctx.adapter.openConversation("900");
    await ctx.adapter.handleAction({ type: "members", open: true });
    expect(ctx.chat().me).toBe("");
    expect(ctx.channel().members!.sections[0]!.members.map((m) => m.id)).toEqual(["2"]);
    expect(ctx.channel().name).toBe("Ana");
  });
});
