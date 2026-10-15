import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_INTERVAL_MS, NerimityAdapter, mediaKind, presenceOf, type NerimityAdapterDeps } from "../../../src/modules/nerimity/adapter";
import type { EventSocket } from "../../../src/modules/nerimity/socket";
import type { FileSource } from "../../../src/engine/runtime";
import type { NativeViewState } from "../../../src/shared/native";
import { ANA, BOB, ME, at, authenticatedPayload, message } from "./fixtures";

const API = "https://nerimity.com/api";
const CDN = "https://cdn.nerimity.com";
const DEF = { id: "nerimity-native", name: "Nerimity", url: "https://nerimity.com" };

type Reply = { status: number; body?: unknown };
type Handler = (url: string, init: RequestInit) => Reply | Error | undefined;

class FakeSocket implements EventSocket {
  sent: string[] = [];
  private listeners: Record<string, ((event: never) => void)[]> = {};
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  addEventListener(type: string, listener: (event: never) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  receive(data: string): void {
    for (const l of this.listeners.message ?? []) l({ data } as never);
  }
  serverClose(): void {
    for (const l of this.listeners.close ?? []) l({ code: 1006 } as never);
  }
  event(name: string, data: unknown): void {
    this.receive(`42${JSON.stringify([name, data])}`);
  }
  emitted(): unknown[] {
    return this.sent.filter((s) => s.startsWith("42")).map((s) => JSON.parse(s.slice(2)));
  }
}

function setup(options: { token?: string; routes?: Handler[]; files?: NerimityAdapterDeps["files"]; settings?: NerimityAdapterDeps["settings"]; lockHosts?: NerimityAdapterDeps["lockHosts"] | null } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const routes: Handler[] = [...(options.routes ?? [])];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    let reply: Reply | Error | undefined;
    for (const route of routes) if ((reply = route(url, init))) break;
    const channel = url.split("/channels/")[1]?.split("/")[0] ?? "";
    reply ??= url.includes("/messages?")
      ? { status: 200, body: [message("450", channel)] }
      : url.endsWith("/messages") && init.method === "POST"
        ? { status: 200, body: message("990", channel, { createdBy: ME, createdAt: at(990) }) }
        : url.endsWith("/cdn/token")
          ? { status: 200, body: { token: `cdn${calls.length}` } }
          : url.startsWith(`${CDN}/attachments/`)
            ? { status: 200, body: { fileId: String(500 + calls.length) } }
            : url === `${CDN}/`
              ? { status: 200, body: "Nerimity CDN Online." }
              : url === `${API}/`
                ? { status: 404, body: "Cannot GET /api/" }
                : { status: 204 };
    if (reply instanceof Error) throw reply;
    const text = reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return { ok: reply.status < 300, status: reply.status, text: async () => text } as Response;
  });
  const sockets: FakeSocket[] = [];
  const secrets = new Map<string, string>(options.token ? [["token", options.token]] : []);
  const renders: NativeViewState[] = [];
  const lockHosts = options.lockHosts === null ? undefined : (options.lockHosts ?? vi.fn(async () => {}));
  const adapter = new NerimityAdapter({
    def: DEF,
    fetch: fetch as unknown as typeof globalThis.fetch,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
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
  /** Engine.IO open, socket.io connect, and the session. */
  const goOnline = async (payload: unknown = authenticatedPayload()) => {
    const socket = sockets.at(-1)!;
    socket.receive('0{"sid":"e","pingInterval":25000,"pingTimeout":20000}');
    socket.receive("40");
    socket.event("user:authenticated", payload);
    await vi.advanceTimersByTimeAsync(100);
  };
  const dispatch = async (name: string, data: unknown) => {
    sockets.at(-1)!.event(name, data);
    await vi.advanceTimersByTimeAsync(100);
  };
  const online = async () => {
    await adapter.start();
    await goOnline();
  };
  return { adapter, calls, routes, sockets, secrets, renders, last, chat, channel, goOnline, dispatch, online, lockHosts };
}

const body = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>;
const prompt = (state: NativeViewState) => (state.screen === "prompt" ? state.prompt.id : state.screen);

function file(name: string, bytes = 3, type = "image/png"): FileSource {
  return { filename: name, size: bytes, contentType: type, read: async (start, end) => new Uint8Array(end - start) };
}

beforeEach(() => {
  vi.useFakeTimers({ now: at(100) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NerimityAdapter sign-in", () => {
  it("shows the sign-in form and locks the engine to the site and its CDN", async () => {
    const { adapter, last, sockets, lockHosts } = setup();
    expect(adapter.mode).toBe("native");
    expect(adapter.accountStatus()).toEqual({ state: "signed-out" });
    expect(adapter.health()).toEqual([]);
    await adapter.start();
    expect(last()).toEqual({
      screen: "prompt",
      platform: "Nerimity",
      prompt: {
        id: "signin",
        title: "Sign in to Nerimity",
        description: "Use your email address, or your username and tag as name:1234.",
        fields: [
          { name: "identity", label: "Email or username:tag", type: "text", autocomplete: "username" },
          { name: "password", label: "Password", type: "password", autocomplete: "current-password" },
        ],
        submit: "Sign in",
        cancel: "Sign in with a token",
      },
      busy: false,
      error: undefined,
    });
    expect(sockets).toHaveLength(0);
    expect(lockHosts).toHaveBeenCalledWith(["nerimity.com", "cdn.nerimity.com"]);
    await adapter.start();
    expect(lockHosts).toHaveBeenCalledTimes(1);
    expect(adapter.homeBadge()).toEqual({ unread: false, mentions: 0 });
    await adapter.handleAction({ type: "ready" });
    expect(prompt(last())).toBe("signin");
  });

  it("goes on when the host lock is refused, or there is none", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Whatever the shell throws is shown as text.
    const refused = setup({ lockHosts: async () => Promise.reject("private address") });
    await refused.adapter.start();
    expect(warn).toHaveBeenCalledWith("[nerimity] host lock refused: private address");
    expect(prompt(refused.last())).toBe("signin");
    const none = setup({ lockHosts: null });
    await none.adapter.start();
    expect(prompt(none.last())).toBe("signin");
  });

  it("checks that the API and the CDN answer, for Diagnostics", async () => {
    let api: Reply | Error = { status: 503 };
    let cdn: Reply | Error = { status: 200 };
    const { adapter } = setup({ routes: [(url) => (url === `${API}/` ? api : undefined), (url) => (url === `${CDN}/` ? cdn : undefined)] });
    await adapter.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.health()).toEqual([
      { name: "API answers", ok: false, detail: "It answered HTTP 503. Signing in, history and sending fail." },
      { name: "CDN answers", ok: true },
    ]);
    api = { status: 404 };
    cdn = new Error("offline");
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    expect(adapter.health()).toEqual([
      { name: "API answers", ok: true },
      { name: "CDN answers", ok: false, detail: "It could not be reached (offline). Pictures, avatars and files do not load, and files cannot be sent." },
    ]);
    cdn = { status: 301 };
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    expect(adapter.health()[1]).toMatchObject({ ok: false, detail: expect.stringContaining("HTTP 301") });
  });

  it("signs in with a password, keeps the token and connects", async () => {
    const { adapter, last, secrets, sockets, calls, goOnline, renders } = setup({ routes: [(url) => (url === `${API}/users/login` ? { status: 200, body: { token: "tok" } } : undefined)] });
    await adapter.start();
    await adapter.handleAction({ type: "prompt", id: "signin", values: { identity: " me@x.org ", password: "pw" } });
    expect(renders.some((r) => r.screen === "prompt" && r.busy)).toBe(true);
    expect(body(calls.find((c) => c.url === `${API}/users/login`)!.init)).toEqual({ email: "me@x.org", password: "pw" });
    expect(secrets.get("token")).toBe("tok");
    expect(last()).toEqual({ screen: "connecting", platform: "Nerimity", status: "Connecting…" });
    expect(adapter.accountStatus()).toEqual({ state: "signed-in" });
    expect(sockets[0]!.url).toBe("wss://nerimity.com/socket.io/?EIO=4&transport=websocket");
    await goOnline();
    expect(last().screen).toBe("chat");
    expect(adapter.accountStatus()).toEqual({ state: "signed-in", name: "me" });
    expect(sockets[0]!.emitted()[0]).toEqual(["user:authenticate", { token: "tok" }]);
  });

  it("takes username:tag, and says what is wrong with other names or a refused password", async () => {
    const { adapter, last, calls } = setup({ routes: [(url) => (url === `${API}/users/login` ? { status: 400, body: { message: "Invalid password.", path: "password" } } : undefined)] });
    await adapter.start();
    await adapter.handleAction({ type: "prompt", id: "signin", values: { identity: "me", password: "pw" } });
    expect(last()).toMatchObject({ screen: "prompt", error: "Enter your email address, or your username and tag as name:1234." });
    await adapter.handleAction({ type: "prompt", id: "signin", values: {} });
    expect(calls.some((c) => c.url.endsWith("/users/login"))).toBe(false);
    await adapter.handleAction({ type: "prompt", id: "signin", values: { identity: "me:0001", password: "bad" } });
    expect(body(calls.at(-1)!.init)).toEqual({ usernameAndTag: "me:0001", password: "bad" });
    expect(last()).toMatchObject({ screen: "prompt", busy: false, error: "Invalid password." });
    // An unknown prompt does nothing.
    await adapter.handleAction({ type: "prompt", id: "other", values: {} });
    expect(calls.filter((c) => c.url.endsWith("/users/login"))).toHaveLength(1);
  });

  it("ignores a second sign-in while one is running", async () => {
    let release!: () => void;
    const { adapter, calls } = setup({
      routes: [(url) => (url === `${API}/users/login` ? (new Promise<void>((r) => (release = r)), { status: 200, body: { token: "tok" } }) : undefined)],
    });
    await adapter.start();
    const first = adapter.handleAction({ type: "prompt", id: "signin", values: { identity: "me@x", password: "pw" } });
    await adapter.handleAction({ type: "prompt", id: "signin", values: { identity: "me@x", password: "pw" } });
    release();
    await first;
    expect(calls.filter((c) => c.url.endsWith("/users/login"))).toHaveLength(1);
  });

  it("signs in with a token once the server knows it", async () => {
    let answer: Reply = { status: 401, body: { message: "Invalid token." } };
    const { adapter, last, calls, secrets, sockets } = setup({ routes: [(url) => (url === `${API}/users` ? answer : undefined)] });
    await adapter.start();
    await adapter.handleAction({ type: "cancelPrompt", id: "signin" });
    expect(last()).toMatchObject({
      screen: "prompt",
      prompt: { id: "token", title: "Sign in with a token", description: "Paste a session token from Nerimity's own app. Multicord checks it with the server first.", submit: "Sign in", cancel: "Back" },
    });
    await adapter.handleAction({ type: "prompt", id: "token", values: { token: "a b" } });
    expect(last()).toMatchObject({ error: "Paste the whole token, without spaces." });
    await adapter.handleAction({ type: "prompt", id: "token", values: {} });
    expect(last()).toMatchObject({ error: "Paste the whole token, without spaces." });
    await adapter.handleAction({ type: "prompt", id: "token", values: { token: " tok " } });
    expect(calls.at(-1)!.init.headers).toEqual({ Authorization: "tok" });
    expect(last()).toMatchObject({ screen: "prompt", error: "The server did not accept this token." });
    answer = { status: 500, body: { message: "Database down" } };
    await adapter.handleAction({ type: "prompt", id: "token", values: { token: "tok" } });
    expect(last()).toMatchObject({ error: "Database down" });
    answer = { status: 200, body: { nobody: true } };
    await adapter.handleAction({ type: "prompt", id: "token", values: { token: "tok" } });
    expect(last()).toMatchObject({ error: "The server did not say who this token belongs to." });
    expect(sockets).toHaveLength(0);
    answer = { status: 200, body: { user: ME } };
    await adapter.handleAction({ type: "prompt", id: "token", values: { token: "tok" } });
    expect(secrets.get("token")).toBe("tok");
    expect(last().screen).toBe("connecting");
    // Back from the token form goes to the password form.
    const other = setup();
    await other.adapter.start();
    await other.adapter.handleAction({ type: "cancelPrompt", id: "signin" });
    await other.adapter.handleAction({ type: "cancelPrompt", id: "token" });
    expect(prompt(other.last())).toBe("signin");
  });

  it("resumes a saved session, waits in the sign-in queue and takes a new token", async () => {
    const { adapter, sockets, last, secrets, goOnline } = setup({ token: "saved" });
    await adapter.start();
    expect(adapter.accountStatus()).toEqual({ state: "signed-in" });
    sockets[0]!.receive("0");
    sockets[0]!.receive("40");
    sockets[0]!.event("user:auth_queue_position", { pos: 4 });
    expect(last()).toEqual({ screen: "connecting", platform: "Nerimity", status: "Waiting to sign in (4 ahead)…" });
    sockets[0]!.event("user:authenticated", { ...authenticatedPayload(), newToken: "fresh" });
    await vi.advanceTimersByTimeAsync(100);
    expect(secrets.get("token")).toBe("fresh");
    expect(last().screen).toBe("chat");
    // Reconnections sign in with it.
    sockets[0]!.serverClose();
    expect(last()).toMatchObject({ screen: "chat", error: "Connection lost. Reconnecting…" });
    await vi.advanceTimersByTimeAsync(1000);
    sockets[1]!.receive("0");
    sockets[1]!.receive("40");
    expect(sockets[1]!.emitted()[0]).toEqual(["user:authenticate", { token: "fresh" }]);
    // A token that does not fit is not taken; a payload that is not an object neither.
    await goOnline({ ...authenticatedPayload(), newToken: "has space" });
    sockets[1]!.event("user:authenticated", null);
    expect(secrets.get("token")).toBe("fresh");
  });

  it("shows reconnecting before the session is back", async () => {
    const { adapter, sockets, last } = setup({ token: "saved" });
    await adapter.start();
    sockets[0]!.serverClose();
    expect(last()).toEqual({ screen: "connecting", platform: "Nerimity", status: "Reconnecting…" });
  });

  it("ends the session when the server refuses it", async () => {
    const { adapter, online, sockets, last, secrets } = setup({ token: "saved" });
    const servers = vi.fn();
    adapter.onServersChanged(servers);
    await online();
    sockets[0]!.event("user:authenticate_error", { message: "Invalid token." });
    expect(last()).toMatchObject({ screen: "prompt", error: "Your session has ended. Please sign in again." });
    expect(secrets.has("token")).toBe(false);
    expect(servers).toHaveBeenLastCalledWith([]);
    const suspended = setup({ token: "saved" });
    await suspended.adapter.start();
    suspended.sockets[0]!.event("user:authenticate_error", { message: "You are suspended." });
    expect(suspended.last()).toMatchObject({ screen: "prompt", error: "Nerimity refused the session: You are suspended." });
  });

  it("signs out on the server and forgets the token", async () => {
    const { adapter, online, calls, secrets, last, routes } = setup({ token: "saved" });
    const directs = vi.fn();
    adapter.onDirectsChanged(directs);
    await online();
    await adapter.signOut();
    expect(calls.at(-1)).toMatchObject({ url: `${API}/users/logout`, init: { method: "DELETE", headers: { Authorization: "saved" } } });
    expect(secrets.has("token")).toBe(false);
    expect(last()).toMatchObject({ screen: "prompt", error: undefined });
    expect(directs).toHaveBeenLastCalledWith([]);
    expect(adapter.accountStatus()).toEqual({ state: "signed-out" });
    // Signed out already: nothing to tell the server.
    const before = calls.length;
    await adapter.handleAction({ type: "logout" });
    expect(calls.length).toBe(before);
    // Signing out with the server unreachable still ends the session here.
    const offline = setup({ token: "saved" });
    await offline.online();
    offline.routes.unshift(() => new Error("offline"));
    await offline.adapter.handleAction({ type: "logout" });
    expect(prompt(offline.last())).toBe("signin");
  });
});

describe("NerimityAdapter rail and conversations", () => {
  it("lists servers in the user's order and DMs, with unread state and previews", async () => {
    const { adapter, online, dispatch } = setup({ token: "saved" });
    await online();
    expect(adapter.railServers()).toEqual([
      { key: "200", account: { platform: "nerimity-native", instance: "nerimity.com", accountId: "default" }, name: "Beta", iconUrl: undefined, unread: true, mentions: 0 },
      { key: "100", account: expect.any(Object), name: "Alpha", iconUrl: `${CDN}/avatars/100/5.webp`, unread: true, mentions: 2 },
    ]);
    expect(await adapter.listServers()).toHaveLength(2);
    expect(await adapter.listDirectConversations()).toEqual([
      { key: "900", account: expect.any(Object), title: "ana", avatarUrl: `${CDN}/avatars/2/9.webp`, lastActivity: at(60), unread: true, mentions: 2 },
    ]);
    await dispatch("message:created", { message: message("1000", "900", { content: "hi [@:1] in [#:111] for [r:120] [ce:130:party]", createdAt: at(101) }) });
    expect(adapter.directs()[0]).toMatchObject({ preview: "hi @me in #general for @Admins :party:", lastActivity: at(101), mentions: 3 });
    await dispatch("message:created", { message: message("1001", "900", { content: "", attachments: [{ id: "5", path: "attachments/900/5/a.png" }], createdAt: at(102) }) });
    expect(adapter.directs()[0]!.preview).toBe("📎 Attachment");
    await dispatch("message:created", { message: message("1002", "900", { content: "", createdAt: at(103) }) });
    expect(adapter.directs()[0]!.preview).toBe("");
    // A DM whose last message is not known yet has no preview.
    await dispatch("message:mark_unread", { channelId: "900", at: at(1) });
    await dispatch("inbox:opened", { channelId: "902", recipient: BOB, channel: { id: "902", type: 0, lastMessagedAt: at(104) } });
    expect(adapter.directs()[0]).toEqual({ key: "902", account: expect.any(Object), title: "bob", avatarUrl: undefined, lastActivity: at(104), unread: true, mentions: 0 });
    // A DM that never had a message; once its history is loaded, its preview shows.
    await dispatch("inbox:opened", { channelId: "905", recipient: { id: "9", username: "cy" }, channel: { id: "905", type: 0 } });
    expect(adapter.directs().at(-1)).toMatchObject({ key: "905", lastActivity: 0 });
    await adapter.openConversation("905");
    expect(adapter.directs().at(-1)).toMatchObject({ key: "905", preview: "m450" });
    // Someone the session no longer lists keeps the name they came with.
    adapter.state.users.delete("9");
    expect(adapter.directs().at(-1)!.title).toBe("cy");
  });

  it("opens a server at its first text channel, with its sidebar, emoji and unread marker", async () => {
    const { adapter, online, chat, channel, calls } = setup({
      token: "saved",
      routes: [(url) => (url === `${API}/channels/113/messages?limit=50` ? { status: 200, body: [message("300", "113")] } : undefined)],
    });
    await online();
    await expect(adapter.openServer("999")).rejects.toThrow("Unknown Nerimity server: 999");
    await adapter.openServer("100");
    expect(chat().title).toBe("Alpha");
    expect(chat().sidebar.map((i) => [i.id, i.kind, i.unread, i.mentions, i.active])).toEqual([
      ["113", "text", false, 0, true],
      ["114", "text", false, 0, false],
      ["110", "category", false, 0, false],
      ["111", "text", true, 2, false],
    ]);
    expect(channel()).toMatchObject({ id: "113", name: "lobby", loading: false, hasOlder: false, can: { reply: true, react: true, attach: false, typing: true, members: true } });
    expect(chat()).toMatchObject({
      emojiBase: `${CDN}/emojis`,
      voice: null,
      customEmoji: [
        { id: "130", name: "party", animated: false, url: `${CDN}/emojis/130.webp`, text: "[ce:130:party]", key: "party:130", source: "Alpha" },
        { id: "131", name: "old", animated: true, url: `${CDN}/emojis/131.gif`, text: "[ace:131:old]", key: "old:131", source: "Alpha" },
      ],
    });
    // An unread channel marks where its news begins.
    await adapter.handleAction({ type: "select", channelId: "111" });
    expect(channel().unread).toEqual({ firstId: "450" });
    await adapter.handleAction({ type: "select", channelId: "111" });
    expect(channel().unread).toEqual({ firstId: "450" });
    expect(calls.filter((c) => c.url.includes("/channels/111/messages?"))).toHaveLength(1);
    // Hidden channels, categories and unknown ones do not open.
    for (const id of ["112", "110", "999"]) await adapter.handleAction({ type: "select", channelId: id });
    expect(channel().id).toBe("111");
    await adapter.openHome();
    expect(chat()).toMatchObject({ title: "Direct Messages", channel: null, customEmoji: [] });
    await adapter.openServer("100");
    expect(channel().id).toBe("111");
    await adapter.openServer("200");
    expect(channel().id).toBe("211");
    expect(chat().customEmoji).toEqual([]);
    adapter.state.emojis.delete("200");
    await adapter.handleAction({ type: "ready" });
    expect(chat().customEmoji).toEqual([]);
  });

  it("opens no channel in a server without one the user may see", async () => {
    const payload = { ...authenticatedPayload(), channels: [{ id: "112", serverId: "100", type: 1, name: "staff", permissions: [] }] };
    const { adapter, goOnline, chat } = setup({ token: "saved" });
    await adapter.start();
    await goOnline(payload);
    await adapter.openServer("100");
    expect(chat()).toMatchObject({ title: "Alpha", channel: null, sidebar: [] });
  });

  it("opens DMs at home, marking where the news begins once older messages reach it", async () => {
    const page = Array.from({ length: 50 }, (_, i) => message(String(1100 + i), "900", { createdAt: at(50 + i) }));
    const { adapter, online, chat, channel, calls, goOnline } = setup({
      token: "saved",
      routes: [
        (url) => (url === `${API}/channels/900/messages?limit=50` ? { status: 200, body: page } : undefined),
        (url) => (url === `${API}/channels/900/messages?limit=50&before=1100` ? { status: 200, body: [message("1050", "900", { createdAt: at(10) })] } : undefined),
      ],
    });
    await online();
    await adapter.openConversation("900");
    expect(chat().title).toBe("Direct Messages");
    expect(chat().sidebar.map((i) => [i.id, i.kind, i.iconUrl])).toEqual([["900", "dm", `${CDN}/avatars/2/9.webp`]]);
    expect(channel()).toMatchObject({ name: "ana", hasOlder: true, unread: {} });
    await Promise.all([adapter.handleAction({ type: "loadOlder" }), adapter.handleAction({ type: "loadOlder" })]);
    expect(channel().hasOlder).toBe(false);
    expect(channel().unread).toEqual({ firstId: "1100" });
    await adapter.handleAction({ type: "loadOlder" });
    expect(calls.filter((c) => c.url.includes("/channels/900/messages?"))).toHaveLength(2);
    await adapter.openConversation("111");
    expect(chat().title).toBe("Alpha");
    // A DM channel the inbox does not name.
    await goOnline({ ...authenticatedPayload(), channels: [{ id: "950", type: 0 }] });
    await adapter.openConversation("950");
    expect(channel().name).toBe("Direct message");
    expect(chat().sidebar).toEqual([]);
  });

  it("shows history that cannot load as an error", async () => {
    const { adapter, online, last } = setup({ token: "saved", routes: [(url) => (url.includes("/messages?") ? { status: 403, body: { message: "You are not allowed" } } : undefined)] });
    await online();
    await adapter.openConversation("111");
    expect(last()).toMatchObject({ error: "Could not load messages: You are not allowed" });
  });

  it("marks the open channel read while the view is in front", async () => {
    const { adapter, online, sockets, dispatch } = setup({ token: "saved" });
    const dismissals = () => sockets[0]!.emitted().filter((e) => (e as unknown[])[0] === "notification:dismiss");
    await online();
    await adapter.openConversation("111");
    await vi.advanceTimersByTimeAsync(1000);
    expect(dismissals()).toHaveLength(0);
    adapter.setVisible(true);
    adapter.setVisible(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(dismissals()).toEqual([["notification:dismiss", { channelId: "111" }]]);
    expect(adapter.railServers()[1]!.mentions).toBe(0);
    await dispatch("message:created", { message: message("600", "111", { createdAt: at(200) }) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(dismissals()).toHaveLength(2);
    // A channel already read is not marked again; a deleted one is left alone.
    await adapter.openConversation("113");
    await vi.advanceTimersByTimeAsync(1000);
    expect(dismissals()).toHaveLength(2);
    adapter.setVisible(false);
    await dispatch("server:channel_deleted", { serverId: "100", channelId: "113" });
    adapter.setVisible(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(dismissals()).toHaveLength(2);
  });

  it("notifies of DMs and mentions, not of other server messages", async () => {
    const { adapter, online, dispatch } = setup({ token: "saved" });
    const notes = vi.fn();
    adapter.onNotification(notes);
    await online();
    await dispatch("message:created", { message: message("1000", "900", { content: "hello //you//" }) });
    expect(notes).toHaveBeenLastCalledWith({ title: "ana", body: "hello *you*", target: "900", railKey: "dm:900", inView: false });
    await dispatch("message:created", { message: message("1001", "900", { content: "", createdBy: null }) });
    expect(notes).toHaveBeenLastCalledWith({ title: "Someone", body: "New message", target: "900", railKey: "dm:900", inView: false });
    await dispatch("message:created", { message: message("1002", "113", { content: "plain" }) });
    expect(notes).toHaveBeenCalledTimes(2);
    await adapter.openConversation("113");
    adapter.setVisible(true);
    await dispatch("message:created", { message: message("1003", "113", { content: "", mentions: [ME], attachments: [{ id: "5", path: "attachments/113/5/a.png" }] }) });
    expect(notes).toHaveBeenLastCalledWith({ title: "Anna in #lobby (Alpha)", body: "Sent an attachment", target: "113", railKey: "100", inView: true });
    await dispatch("server:channel_created", { channel: { id: "116", serverId: "100", type: 1, permissions: [{ roleId: "101", permissions: 1 }] } });
    await dispatch("message:created", { message: message("1004", "116", { content: "[@:e]" }) });
    expect(notes).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Anna in #116 (Alpha)", body: "@everyone" }));
    await dispatch("message:created", { message: message("1005", "998", { mentions: [ME] }) });
    expect(notes).toHaveBeenCalledTimes(4);
  });
});

describe("NerimityAdapter messages", () => {
  async function opened(options: Parameters<typeof setup>[0] = {}, channelId = "111") {
    const ctx = setup({ token: "saved", ...options });
    await ctx.online();
    await ctx.adapter.openConversation(channelId);
    return ctx;
  }

  it("shows messages: authors, mentions, replies, quotes, reactions and files", async () => {
    const history = [
      message("440", "111", { createdBy: { id: "8", username: "cy", tag: "1" }, content: "hi", replyMessages: [{ replyToMessage: { id: "1", content: "x [@:1]" } }] }),
      message("445", "111", { createdBy: ME, type: 7 }),
      message("450", "111", {
        content: "see [q:3] [q:4] for [@:404]",
        mentions: [{ id: "1" }],
        editedAt: at(451),
        reactions: [{ name: "👍", count: 1, reacted: true }, { name: "party", emojiId: "130", webp: true, count: 2 }, { name: "old", emojiId: "131", gif: true, count: 1 }],
        attachments: [
          { id: "8", path: "attachments/111/8/a%20b.png", mime: "image/png", width: 4, height: 3, filesize: 9, provider: "local" },
          { id: "9", path: "attachments/111/9/%E0%A4%A.bin", provider: "local" },
          { id: "10", provider: "google_drive", fileId: "g" },
        ],
        quotedMessages: [{ id: "3", content: "quoted [q:3]", createdBy: BOB }, { id: "4", content: "anon" }],
      }),
      message("460", "111", { createdBy: ME, content: "mine", replyMessages: [{ replyToMessage: { id: "450", content: "see", createdBy: ANA, createdAt: at(450) } }] }),
      message("470", "111", { createdBy: null, content: "ghost" }),
    ];
    const ctx = await opened({ routes: [(url) => (url === `${API}/channels/111/messages?limit=50` ? { status: 200, body: history } : undefined)] });
    const [m440, m445, m450, m460, m470] = ctx.channel().messages;
    expect(m440).toMatchObject({ author: "cy", authorId: "8", mine: false, canEdit: false, canDelete: false, reply: { id: "1", author: "Deleted user", content: "x @me" } });
    expect(m440!.reply).not.toHaveProperty("timestamp");
    expect(m440).not.toHaveProperty("avatarUrl");
    expect(m445).toMatchObject({ mine: true, canEdit: false, canDelete: true, content: "*pinned a message.*" });
    expect(m445).not.toHaveProperty("source");
    expect(m450).toEqual({
      id: "450",
      author: "Anna",
      authorId: "2",
      authorMention: "[@:2]",
      avatarUrl: `${CDN}/avatars/2/9.webp`,
      content: "see \n> **bob**: quoted \n \n> anon\n for [@:404]",
      timestamp: new Date(at(450)).toISOString(),
      edited: true,
      mine: false,
      canEdit: false,
      canDelete: false,
      // Pinning in Alpha takes Manage Channels, which the user's roles lack.
      canPin: false,
      mentionsMe: true,
      reactions: [
        { key: "👍", label: "👍", imageUrl: undefined, count: 1, me: true },
        { key: "party:130", label: ":party:", imageUrl: `${CDN}/emojis/130.webp`, count: 2, me: false },
        { key: "old:131", label: ":old:", imageUrl: `${CDN}/emojis/131.gif`, count: 1, me: false },
      ],
      attachments: [
        { name: "a b.png", kind: "image", url: `${CDN}/attachments/111/8/a%20b.png`, width: 4, height: 3, size: 9, mime: "image/png" },
        { name: "%E0%A4%A.bin", kind: "file", url: `${CDN}/attachments/111/9/%E0%A4%A.bin` },
        { name: "File on Google Drive", kind: "file", unavailable: "It is stored on Google Drive, which Multicord does not open." },
      ],
    });
    expect(m460).toMatchObject({ mine: true, canEdit: true, source: "mine", reply: { id: "450", author: "Anna", content: "see", timestamp: new Date(at(450)).toISOString() } });
    expect(m470).toMatchObject({ author: "Deleted user", content: "ghost", mine: false });
    expect(m470).not.toHaveProperty("authorId");
    // Someone the session no longer lists keeps the name and picture they came with.
    ctx.adapter.state.users.delete("8");
    ctx.adapter.state.users.delete("2");
    await ctx.adapter.handleAction({ type: "ready" });
    expect(ctx.channel().messages[0]).toMatchObject({ author: "cy" });
    expect(ctx.channel().messages[2]).toMatchObject({ author: "Anna", avatarUrl: `${CDN}/avatars/2/9.webp` });
    expect(mediaKind("video/mp4")).toBe("video");
    expect(mediaKind("audio/ogg")).toBe("audio");
    expect(mediaKind(undefined)).toBe("file");
    expect([0, 1, 2, 3, 4, undefined].map(presenceOf)).toEqual(["offline", "online", "online", "idle", "dnd", "offline"]);
  });

  it("shows link previews, their pictures through the CDN's proxy, as they arrive", async () => {
    const embed = { type: "website", url: "https://example.org/a", siteName: "Example", title: "A page", imageUrl: "https://example.org/i.png?x=1", imageMime: "image/png" };
    const ctx = await opened({ routes: [(url) => (url === `${API}/channels/111/messages?limit=50` ? { status: 200, body: [message("450", "111", { embed })] } : undefined)] });
    expect(ctx.channel().messages[0]!.embeds).toEqual([
      { url: "https://example.org/a", site: "Example", title: "A page", image: { url: `${CDN}/proxy/https%3A%2F%2Fexample.org%2Fi.png%3Fx%3D1/embed.png`, width: undefined, height: undefined, thumbnail: true } },
    ]);
    // The server adds a preview once it has read the page, or takes it away.
    await ctx.dispatch("message:updated", { channelId: "111", messageId: "450", updated: { embed: null } });
    expect(ctx.channel().messages[0]).not.toHaveProperty("embeds");
    await ctx.dispatch("message:updated", { channelId: "111", messageId: "450", updated: { embed: { title: "Later" } } });
    expect(ctx.channel().messages[0]!.embeds).toEqual([{ title: "Later" }]);
    await ctx.dispatch("message:updated", { channelId: "111", messageId: "450", updated: { content: "edited" } });
    expect(ctx.channel().messages[0]).toMatchObject({ content: "edited", embeds: [{ title: "Later" }] });
  });

  it("lists pins in pages while the panel is open, and follows them live", async () => {
    let total = 30;
    let failing = false;
    const pinned = (from: number) => Array.from({ length: Math.max(0, Math.min(10, total - (from - 600))) }, (_, i) => message(String(from + i), "900"));
    const ctx = await opened(
      {
        routes: [
          (url, init) => {
            if (!url.startsWith(`${API}/channels/900/messages/pins`) || init.method !== "GET") return undefined;
            if (failing) return { status: 429, body: { message: "Too many requests" } };
            const after = new URL(url).searchParams.get("afterId");
            return { status: 200, body: { messages: [...pinned(after ? Number(after) + 1 : 600), { bad: true }] } };
          },
        ],
      },
      "900",
    );
    const lists = () => ctx.calls.filter((c) => c.url.startsWith(`${API}/channels/900/messages/pins`) && c.init.method === "GET").map((c) => c.url);
    expect(ctx.channel().can.pins).toBe(true);
    await ctx.adapter.handleAction({ type: "pins", open: true });
    expect(lists()).toEqual([`${API}/channels/900/messages/pins`, `${API}/channels/900/messages/pins?afterId=609`, `${API}/channels/900/messages/pins?afterId=619`]);
    expect(ctx.channel().pins).toMatchObject({ loading: false, note: "Only the latest 30 pins are listed." });
    expect(ctx.channel().pins!.messages).toHaveLength(30);
    expect(ctx.channel().pins!.messages[0]).toEqual({ id: "600", author: "ana", avatarUrl: `${CDN}/avatars/2/9.webp`, content: "m600", timestamp: new Date(at(600)).toISOString() });
    // Someone pins in this channel: the message shows pinned and the list is fetched again.
    total = 12;
    await ctx.dispatch("message:updated", { channelId: "900", messageId: "450", updated: { pinned: true } });
    expect(ctx.channel().messages[0]).toMatchObject({ pinned: true });
    expect(ctx.channel().pins).toEqual({ messages: expect.any(Array), loading: false });
    expect(ctx.channel().pins!.messages).toHaveLength(12);
    await ctx.dispatch("message:updated", { channelId: "900", messageId: "450", updated: { pinned: false } });
    expect(ctx.channel().messages[0]).not.toHaveProperty("pinned");
    // Other channels' updates and other changes fetch nothing.
    const fetched = lists().length;
    await ctx.dispatch("message:updated", { channelId: "111", messageId: "1", updated: { pinned: true } });
    await ctx.dispatch("message:updated", { channelId: "900", messageId: "450", updated: { content: "x" } });
    await ctx.dispatch("message:updated", { channelId: "900", messageId: "450" });
    expect(lists()).toHaveLength(fetched);
    // A failure shows in the panel; a deleted author's pin still lists.
    failing = true;
    await ctx.adapter.handleAction({ type: "pins", open: true });
    expect(ctx.channel().pins).toEqual({ messages: [], loading: false, error: "Could not load pinned messages: Too many requests" });
    failing = false;
    total = 0;
    ctx.routes.unshift((url) => (url === `${API}/channels/900/messages/pins` ? { status: 200, body: { messages: [message("700", "900", { createdBy: null, content: "", attachments: [{ id: "8", path: "a/b.png", provider: "local" }] })] } } : undefined));
    await ctx.adapter.handleAction({ type: "pins", open: true });
    expect(ctx.channel().pins!.messages).toEqual([{ id: "700", author: "Deleted user", content: "📎 Attachment", timestamp: new Date(at(700)).toISOString() }]);
    ctx.routes.unshift((url) => (url === `${API}/channels/900/messages/pins` ? { status: 200, body: "odd" } : undefined));
    await ctx.adapter.handleAction({ type: "pins", open: true });
    expect(ctx.channel().pins).toEqual({ messages: [], loading: false });
    // Closed, or another channel opened: no list, and late answers are dropped.
    const late = ctx.adapter.handleAction({ type: "pins", open: true });
    await ctx.adapter.handleAction({ type: "pins", open: false });
    await late;
    expect(ctx.channel()).not.toHaveProperty("pins");
    await ctx.adapter.handleAction({ type: "pins", open: true });
    await ctx.adapter.openConversation("111");
    expect(ctx.channel()).not.toHaveProperty("pins");
    await ctx.adapter.handleAction({ type: "pins", open: false });
  });

  it("pins and unpins where the user may, and shows the server's refusal", async () => {
    const ctx = await opened({}, "900");
    await ctx.adapter.handleAction({ type: "pin", messageId: "450", pin: true });
    expect(ctx.calls.at(-1)).toMatchObject({ url: `${API}/channels/900/messages/pins/450`, init: { method: "POST" } });
    expect(ctx.channel().messages[0]).toMatchObject({ pinned: true, canPin: true });
    await ctx.adapter.handleAction({ type: "pin", messageId: "450", pin: false });
    expect(ctx.calls.at(-1)).toMatchObject({ url: `${API}/channels/900/messages/pins/450`, init: { method: "DELETE" } });
    expect(ctx.channel().messages[0]).not.toHaveProperty("pinned");
    await ctx.adapter.handleAction({ type: "pin", messageId: "999", pin: true });
    ctx.routes.unshift((url) => (url.includes("/messages/pins/") ? { status: 500, body: { message: "Message already pinned!" } } : undefined));
    await ctx.adapter.handleAction({ type: "pin", messageId: "450", pin: true });
    expect(ctx.last()).toMatchObject({ error: "Message not pinned: Message already pinned!" });
    await ctx.adapter.handleAction({ type: "pin", messageId: "450", pin: false });
    expect(ctx.last()).toMatchObject({ error: "Message not unpinned: Message already pinned!" });
    // In a server, only its owner and whoever may manage its channels; system lines never.
    await ctx.adapter.openConversation("211");
    expect(ctx.channel().messages[0]!.canPin).toBe(true);
    await ctx.adapter.openConversation("111");
    expect(ctx.channel().messages[0]!.canPin).toBe(false);
    await ctx.dispatch("server:role_updated", { serverId: "100", roleId: "122", updated: { permissions: 4 } });
    expect(ctx.channel().messages[0]!.canPin).toBe(true);
    await ctx.dispatch("message:created", { message: message("460", "111", { type: 1 }) });
    expect(ctx.channel().messages.at(-1)!.canPin).toBe(false);
    expect(ctx.adapter.state.canManageChannels("404")).toBe(false);
  });

  it("sends, replies, edits and deletes", async () => {
    let edit: Reply = { status: 200, body: message("450", "111", { content: "edited", editedAt: at(500) }) };
    const ctx = await opened({ routes: [(url, init) => (url === `${API}/channels/111/messages/450` && init.method === "PATCH" ? edit : undefined)] });
    await ctx.adapter.handleAction({ type: "send", content: "  " });
    expect(ctx.calls.some((c) => c.init.method === "POST" && c.url.endsWith("/messages"))).toBe(false);
    await ctx.adapter.handleAction({ type: "send", content: "x".repeat(2001) });
    expect(ctx.last()).toMatchObject({ error: "Nerimity takes messages up to 2,000 characters." });
    await ctx.adapter.handleAction({ type: "send", content: "hello", replyTo: "450" });
    expect(body(ctx.calls.at(-1)!.init)).toEqual({ content: "hello", replyToMessageIds: ["450"], mentionReplies: true });
    expect(ctx.channel().messages.map((m) => m.id)).toEqual(["450", "990"]);
    await ctx.adapter.handleAction({ type: "edit", messageId: "450", content: "edited" });
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.channel().messages[0]).toMatchObject({ content: "edited", edited: true });
    // An answer that is not a message changes nothing until the event comes.
    edit = { status: 200, body: { updated: true } };
    await ctx.adapter.handleAction({ type: "edit", messageId: "450", content: "again" });
    expect(ctx.channel().messages[0]!.content).toBe("edited");
    await ctx.adapter.handleAction({ type: "delete", messageId: "990" });
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.channel().messages.map((m) => m.id)).toEqual(["450"]);
    // Sent but not understood: nothing added.
    ctx.routes.unshift((url, init) => (url.endsWith("/messages") && init.method === "POST" ? { status: 200, body: {} } : undefined));
    await ctx.adapter.handleAction({ type: "send", content: "odd" });
    expect(ctx.channel().messages.map((m) => m.id)).toEqual(["450"]);
  });

  it("shows what went wrong sending, editing or deleting", async () => {
    const ctx = await opened({ routes: [(url, init) => (init.method !== "GET" && url.includes("/messages") ? { status: 400, body: { message: "You must confirm your email to send messages." } } : undefined)] });
    await ctx.adapter.handleAction({ type: "send", content: "hi" });
    expect(ctx.last()).toMatchObject({ error: "Message not sent: You must confirm your email to send messages." });
    await ctx.adapter.handleAction({ type: "edit", messageId: "450", content: "x" });
    expect(ctx.last()).toMatchObject({ error: "Message not edited: You must confirm your email to send messages." });
    await ctx.adapter.handleAction({ type: "delete", messageId: "450" });
    expect(ctx.last()).toMatchObject({ error: "Message not deleted: You must confirm your email to send messages." });
  });

  it("does nothing with messages while no channel is open", async () => {
    const { adapter, online, calls } = setup({ token: "saved", files: { pick: vi.fn(async () => [file("a.png")]), open: vi.fn() } });
    await online();
    const before = calls.length;
    for (const action of [
      { type: "send", content: "hi" },
      { type: "edit", messageId: "1", content: "x" },
      { type: "delete", messageId: "1" },
      { type: "react", messageId: "1", emoji: "👍", add: true },
      { type: "loadOlder" },
      { type: "typing" },
      { type: "attach" },
      { type: "sendFile", file: { handle: "h", name: "a.png", size: 1, type: "image/png" } },
      { type: "removeAttachment", index: 0 },
      { type: "joinVoice", channelId: "1" },
      { type: "pins", open: true },
      { type: "pin", messageId: "1", pin: true },
    ] as const)
      await adapter.handleAction(action as never);
    expect(calls.length).toBe(before);
  });

  it("reacts with Unicode and custom emoji, as the server counts them", async () => {
    const history = [message("450", "111", { reactions: [{ name: "far", emojiId: "777", gif: true, webp: true, count: 1 }] })];
    const ctx = await opened({
      routes: [
        (url) => (url === `${API}/channels/111/messages?limit=50` ? { status: 200, body: history } : undefined),
        (url, init) => (url.includes("/reactions") ? { status: 200, body: { ...body(init), count: url.endsWith("/remove") ? 0 : 3 } } : undefined),
      ],
    });
    await ctx.adapter.handleAction({ type: "react", messageId: "450", emoji: "👍", add: true });
    expect(body(ctx.calls.at(-1)!.init)).toEqual({ name: "👍" });
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.channel().messages[0]!.reactions.find((r) => r.key === "👍")).toMatchObject({ count: 3, me: true });
    await ctx.adapter.handleAction({ type: "react", messageId: "450", emoji: "old:131", add: true });
    expect(body(ctx.calls.at(-1)!.init)).toEqual({ name: "old", emojiId: "131", gif: true, webp: false });
    await ctx.adapter.handleAction({ type: "react", messageId: "450", emoji: "far:777", add: true });
    expect(body(ctx.calls.at(-1)!.init)).toEqual({ name: "far", emojiId: "777", gif: true, webp: true });
    await ctx.adapter.handleAction({ type: "react", messageId: "450", emoji: "new:888", add: true });
    expect(body(ctx.calls.at(-1)!.init)).toEqual({ name: "new", emojiId: "888", gif: false, webp: true });
    await ctx.adapter.handleAction({ type: "react", messageId: "450", emoji: "👍", add: false });
    expect(ctx.calls.at(-1)!.url).toBe(`${API}/channels/111/messages/450/reactions/remove`);
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.channel().messages[0]!.reactions.map((r) => r.key)).toEqual(["far:777", "old:131", "new:888"]);
    // On a message not loaded, the answer has nowhere to go; a failure is shown.
    await ctx.adapter.handleAction({ type: "react", messageId: "999", emoji: "👍", add: true });
    ctx.routes.unshift((url) => (url.includes("/reactions") ? { status: 403, body: { message: "You must confirm your email to react to messages." } } : undefined));
    await ctx.adapter.handleAction({ type: "react", messageId: "450", emoji: "👍", add: true });
    expect(ctx.last()).toMatchObject({ error: "Reaction failed: You must confirm your email to react to messages." });
    ctx.routes.unshift((url) => (url.includes("/reactions") ? { status: 200, body: "ok" } : undefined));
    await ctx.adapter.handleAction({ type: "react", messageId: "450", emoji: "👍", add: true });
  });

  it("sends typing indicators at most every 4 seconds, as Settings allow, and shows others typing", async () => {
    const ctx = await opened({ settings: { typing: true } });
    const typing = () => ctx.calls.filter((c) => c.url.endsWith("/typing"));
    await ctx.adapter.handleAction({ type: "typing" });
    await ctx.adapter.handleAction({ type: "typing" });
    expect(typing()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4000);
    await ctx.adapter.handleAction({ type: "typing" });
    expect(typing()).toHaveLength(2);
    ctx.adapter.applySettings({ typing: false });
    expect(ctx.channel().can.typing).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    await ctx.adapter.handleAction({ type: "typing" });
    expect(typing()).toHaveLength(2);
    ctx.adapter.applySettings({});
    ctx.routes.unshift((url) => (url.endsWith("/typing") ? new Error("offline") : undefined));
    await ctx.adapter.handleAction({ type: "typing" });
    expect(typing()).toHaveLength(3);
    await ctx.dispatch("channel:typing", { channelId: "111", userId: "2" });
    expect(ctx.channel().typing).toEqual(["Anna"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.channel().typing).toEqual([]);
    const off = setup({ token: "saved", settings: { typing: false } });
    await off.online();
    await off.adapter.openConversation("111");
    await off.adapter.handleAction({ type: "typing" });
    expect(off.calls.some((c) => c.url.endsWith("/typing"))).toBe(false);
  });
});

describe("NerimityAdapter files", () => {
  function withFiles(picked: FileSource[][] = [[file("a.png")]]) {
    const pick = vi.fn(async () => picked.shift() ?? []);
    const open = vi.fn((f: { name: string; size: number; type: string }) => file(f.name, f.size, f.type));
    return { pick, open };
  }

  it("uploads each file to the CDN and sends it as its own message, the text with the first", async () => {
    const files = withFiles([[file("a.png"), file("b.pdf", 5, "application/pdf")]]);
    const ctx = setup({ token: "saved", files });
    await ctx.online();
    await ctx.adapter.openConversation("111");
    await ctx.adapter.handleAction({ type: "attach" });
    expect(ctx.channel().pending).toEqual([
      { name: "a.png", size: 3 },
      { name: "b.pdf", size: 5 },
    ]);
    expect(ctx.channel().can.attach).toBe(true);
    await ctx.adapter.handleAction({ type: "send", content: "look", replyTo: "450" });
    const tokens = ctx.calls.filter((c) => c.url.endsWith("/cdn/token"));
    const uploads = ctx.calls.filter((c) => c.url.startsWith(`${CDN}/attachments/111`));
    const sends = ctx.calls.filter((c) => c.url === `${API}/channels/111/messages` && c.init.method === "POST");
    expect(tokens).toHaveLength(1);
    expect(uploads.map((u) => (u.init.headers as Record<string, string>)["File-Name"])).toEqual(["a.png", "b.pdf"]);
    expect((uploads[0]!.init.headers as Record<string, string>).Authorization).toMatch(/^cdn/);
    expect(sends.map((s) => body(s.init))).toEqual([
      { content: "look", replyToMessageIds: ["450"], mentionReplies: true, nerimityCdnFileId: expect.stringMatching(/^\d+$/) },
      { nerimityCdnFileId: expect.stringMatching(/^\d+$/) },
    ]);
    expect(ctx.channel().pending).toEqual([]);
    expect(ctx.channel().uploading).toBe(false);
    // The upload token is used again while fresh, then renewed.
    await ctx.adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "c.gif", size: 2, type: "image/gif" } });
    expect(ctx.calls.filter((c) => c.url.endsWith("/cdn/token"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await ctx.adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "d.gif", size: 2, type: "image/gif" } });
    expect(ctx.calls.filter((c) => c.url.endsWith("/cdn/token"))).toHaveLength(2);
  });

  it("keeps a file that failed, and says why", async () => {
    const files = withFiles([[file("a.png"), file("b.png")]]);
    let uploads = 0;
    const ctx = setup({
      token: "saved",
      files,
      routes: [(url) => (url.startsWith(`${CDN}/attachments/`) && ++uploads === 2 ? { status: 401, body: "Unauthorized" } : undefined)],
    });
    await ctx.online();
    await ctx.adapter.openConversation("111");
    await ctx.adapter.handleAction({ type: "attach" });
    await ctx.adapter.handleAction({ type: "send", content: "" });
    expect(ctx.last()).toMatchObject({ error: "File not sent: Unauthorized" });
    expect(ctx.channel().pending).toEqual([{ name: "b.png", size: 3 }]);
    // The server's own reason for refusing an upload, e.g. an unconfirmed email.
    ctx.routes.unshift((url) => (url.endsWith("/cdn/token") ? { status: 400, body: { message: "You must confirm your email to send attachment messages." } } : undefined));
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await ctx.adapter.handleAction({ type: "send", content: "" });
    expect(ctx.last()).toMatchObject({ error: "File not sent: You must confirm your email to send attachment messages." });
    ctx.adapter.handleAction({ type: "removeAttachment", index: 0 });
    expect(ctx.channel().pending).toEqual([]);
  });

  it("limits waiting files, sends one handed over at once, and does not send twice at a time", async () => {
    const many = Array.from({ length: 11 }, (_, i) => file(`f${i}.png`));
    const files = withFiles([many, [], []]);
    const ctx = setup({ token: "saved", files });
    await ctx.online();
    await ctx.adapter.openConversation("111");
    await ctx.adapter.handleAction({ type: "attach" });
    expect(ctx.channel().pending).toHaveLength(10);
    expect(ctx.last()).toMatchObject({ error: "At most 10 files at once." });
    await ctx.adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "x.gif", size: 1, type: "image/gif" } });
    expect(ctx.last()).toMatchObject({ error: "At most 10 files at once." });
    expect(ctx.channel().pending).toHaveLength(10);
    // While a send runs, another waits its turn.
    const first = ctx.adapter.handleAction({ type: "send", content: "" });
    await ctx.adapter.handleAction({ type: "send", content: "again" });
    await ctx.adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "x.gif", size: 1, type: "image/gif" } });
    await first;
    expect(ctx.calls.filter((c) => c.url.startsWith(`${CDN}/attachments/`))).toHaveLength(10);
    expect(ctx.calls.filter((c) => c.url.endsWith("/messages") && c.init.method === "POST")).toHaveLength(10);
    // A favourite waits with files already picked.
    ctx.routes.unshift((url) => (url.startsWith(`${CDN}/attachments/`) ? new Error("offline") : undefined));
    await ctx.adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "y.gif", size: 1, type: "image/gif" } });
    await ctx.adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "z.gif", size: 1, type: "image/gif" } });
    expect(ctx.channel().pending.map((p) => p.name)).toEqual(["y.gif", "z.gif"]);
    // A picker that fails says so.
    files.pick.mockRejectedValueOnce(new Error("busy"));
    await ctx.adapter.handleAction({ type: "attach" });
    expect(ctx.last()).toMatchObject({ error: "Could not attach: busy" });
  });

  it("offers no files without a picker", async () => {
    const ctx = await (async () => {
      const c = setup({ token: "saved" });
      await c.online();
      await c.adapter.openConversation("111");
      return c;
    })();
    await ctx.adapter.handleAction({ type: "attach" });
    await ctx.adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "x.gif", size: 1, type: "image/gif" } });
    expect(ctx.channel().pending).toEqual([]);
  });
});

describe("NerimityAdapter members and profiles", () => {
  it("lists a server's members as Nerimity does, and a DM's two people", async () => {
    const ctx = setup({ token: "saved" });
    await ctx.online();
    await ctx.adapter.openConversation("111");
    expect(ctx.channel().members).toBeUndefined();
    await ctx.adapter.handleAction({ type: "members", open: true });
    expect(ctx.channel().members).toEqual({
      sections: [
        { name: "Admins", members: [{ id: "2", name: "Anna", mention: "[@:2]", presence: "online", avatarUrl: `${CDN}/avatars/2/9.webp`, color: "#ff0000" }] },
        { name: "Online", members: [{ id: "3", name: "bob", mention: "[@:3]", presence: "dnd", status: "Bot" }] },
        { name: "Offline", members: [{ id: "1", name: "me", mention: "[@:1]", presence: "offline" }] },
      ],
      hasMore: false,
      loading: false,
    });
    await ctx.adapter.openConversation("900");
    expect(ctx.channel().members!.sections[0]!.members.map((m) => m.name)).toEqual(["me", "ana"]);
    await ctx.adapter.handleAction({ type: "members", open: false });
    expect(ctx.channel().members).toBeUndefined();
    // Big servers list 200 and count the rest; a server without roles or members lists what it has.
    const members = Array.from({ length: 205 }, (_, i) => ({ serverId: "200", user: { id: String(5000 + i), username: `u${i}` }, roleIds: [] }));
    await ctx.goOnline({ ...authenticatedPayload(), serverRoles: [], serverMembers: members });
    await ctx.adapter.openConversation("211");
    await ctx.adapter.handleAction({ type: "members", open: true });
    expect(ctx.channel().members).toMatchObject({ sections: [{ name: "Offline" }], more: 5 });
    expect(ctx.channel().members!.sections[0]!.members).toHaveLength(200);
    await ctx.goOnline({ ...authenticatedPayload(), serverMembers: [], inbox: [] });
    await ctx.adapter.openConversation("111");
    expect(ctx.channel().members).toEqual({ sections: [], hasMore: false, loading: false });
    await ctx.adapter.openConversation("900");
    expect(ctx.channel().members!.sections[0]!.members.map((m) => m.name)).toEqual(["me"]);
  });

  it("shows profile cards from what the session knows", async () => {
    const ctx = setup({ token: "saved" });
    await ctx.online();
    // With no conversation open, there are no roles to show.
    await ctx.adapter.handleAction({ type: "profile", id: "2" });
    expect(ctx.chat().profile).not.toHaveProperty("roles");
    await ctx.adapter.openConversation("111");
    await ctx.adapter.handleAction({ type: "profile", id: "2" });
    expect(ctx.chat().profile).toEqual({
      id: "2",
      name: "Anna",
      username: "ana:4242",
      presence: "online",
      avatarUrl: `${CDN}/avatars/2/9.webp`,
      roles: [{ name: "Admins", color: "#ff0000" }, { name: "Helpers", color: "#00ff00" }],
    });
    await ctx.adapter.handleAction({ type: "profile", id: "3" });
    expect(ctx.chat().profile).toEqual({ id: "3", name: "bob", username: "bob:7777", presence: "dnd", status: "Bot" });
    await ctx.adapter.handleAction({ type: "profile", id: "1" });
    expect(ctx.chat().profile).toEqual({ id: "1", name: "me", username: "me:0001", presence: "offline", roles: [{ name: "Mods" }] });
    await ctx.adapter.handleAction({ type: "profile", id: "404" });
    expect(ctx.chat().profile!.id).toBe("1");
    // Another conversation drops it; at home there are no roles.
    await ctx.adapter.openConversation("900");
    expect(ctx.chat().profile).toBeUndefined();
    await ctx.adapter.handleAction({ type: "profile", id: "2" });
    expect(ctx.chat().profile).toEqual({ id: "2", name: "ana", username: "ana:4242", presence: "online", avatarUrl: `${CDN}/avatars/2/9.webp` });
    await ctx.adapter.openHome();
    await ctx.adapter.handleAction({ type: "profile", id: "2" });
    expect(ctx.chat().profile!.name).toBe("ana");
  });
});
