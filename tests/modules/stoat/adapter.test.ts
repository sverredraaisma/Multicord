import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoatAdapter, type StoatAdapterDeps } from "../../../src/modules/stoat/adapter";
import type { EventSocket } from "../../../src/modules/stoat/events";
import type { FileSource } from "../../../src/engine/runtime";
import { customEmojiList, type NativeViewState } from "../../../src/shared/native";
import { idTime } from "../../../src/modules/stoat/types";
import { ALPHA, ANA, ANA_ID, BETA, BOB_ID, CHAT, DM, EMOJI, GENERAL, GROUP, LOBBY, ME_ID, RULES, message, readyPayload, ulid } from "./fixtures";

const CONFIG = { revolt: "0.15.7", ws: "wss://events.test", features: { autumn: { enabled: true, url: "https://cdn.test" } } };
const DEF = { id: "stoat-native", name: "Stoat", url: "https://stoat.test" };
const KEY = "stoat.test:token";

type Reply = { status: number; body?: unknown };
type Handler = (url: string, init: RequestInit) => Reply | undefined;

class FakeSocket implements EventSocket {
  sent: Record<string, unknown>[] = [];
  closed: number | undefined;
  private listeners: Record<string, ((event: never) => void)[]> = {};
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number): void {
    this.closed = code;
  }
  addEventListener(type: string, listener: (event: never) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  open(): void {
    for (const l of this.listeners.open ?? []) l(undefined as never);
  }
  receive(payload: unknown): void {
    for (const l of this.listeners.message ?? []) l({ data: JSON.stringify(payload) } as never);
  }
  serverClose(): void {
    for (const l of this.listeners.close ?? []) l({ code: 1006 } as never);
  }
}

const channelOf = (url: string) => url.split("/channels/")[1]!.split(/[/?]/)[0]!;

function setup(options: { token?: string; routes?: Handler[]; files?: StoatAdapterDeps["files"]; settings?: StoatAdapterDeps["settings"] } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const routes: Handler[] = [...(options.routes ?? [])];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    let reply: Reply | undefined;
    for (const route of routes) if ((reply = route(url, init))) break;
    reply ??= url === "https://stoat.test/api/"
      ? { status: 200, body: CONFIG }
      : url.includes("/messages?")
        ? { status: 200, body: { messages: [message(450, channelOf(url))], users: [ANA] } }
        : url.endsWith("/messages") && init.method === "POST"
          ? { status: 200, body: message(990, channelOf(url), { author: ME_ID, content: JSON.parse(init.body as string).content ?? "" }) }
          : url.endsWith("/sync/settings/fetch")
            ? { status: 200, body: { notifications: [1, "{}"] } }
            : url.endsWith("/sync/unreads")
              ? { status: 200, body: [] }
              : url === "https://cdn.test/attachments"
                ? { status: 200, body: { id: `up${calls.length}` } }
                : { status: 204 };
    const { status, body } = reply;
    return { ok: status < 300, status, headers: new Headers(), json: async () => body } as Response;
  });
  const sockets: FakeSocket[] = [];
  const secrets = new Map<string, string>(options.token ? [[KEY, options.token]] : []);
  const renders: NativeViewState[] = [];
  const adapter = new StoatAdapter({
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
  const socket = () => sockets.at(-1)!;
  /** Opens the events socket and delivers Ready. */
  const goOnline = async (payload: Record<string, unknown> = readyPayload()) => {
    socket().open();
    socket().receive({ type: "Authenticated" });
    socket().receive(payload);
    await vi.advanceTimersByTimeAsync(100);
  };
  const event = async (payload: Record<string, unknown>) => {
    socket().receive(payload);
    await vi.advanceTimersByTimeAsync(100);
  };
  const online = async () => {
    await adapter.start();
    await goOnline();
  };
  const requests = (match: string) => calls.filter((c) => c.url.includes(match));
  return { adapter, calls, routes, sockets, socket, secrets, renders, last, chat, goOnline, event, online, requests };
}

function file(name: string, size = 3): FileSource {
  return { filename: name, size, contentType: "image/png", read: async (start, end) => new Uint8Array(end - start) };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-14T12:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StoatAdapter sign-in", () => {
  it("shows the sign-in screen when there is no saved session", async () => {
    const { adapter, last, sockets } = setup();
    await adapter.start();
    expect(last()).toEqual({ screen: "login", platform: "Stoat", identity: "email", busy: false, status: undefined, error: undefined });
    expect(sockets).toHaveLength(0);
    expect(adapter.mode).toBe("native");
    expect(adapter.capabilities).toEqual({ directMessages: true, messagePreviews: true, voice: true, screenShare: true });
    expect(adapter.accountStatus()).toEqual({ state: "signed-out" });
  });

  it("reports an unreachable instance and tries again on sign-in", async () => {
    let down = true;
    const { adapter, last, secrets, socket, renders } = setup({
      routes: [
        (url) => (down && url === "https://stoat.test/api/" ? { status: 503 } : undefined),
        (url) => (url.endsWith("/auth/session/login") ? { status: 200, body: { result: "Success", token: "tok", user_id: ME_ID } } : undefined),
      ],
    });
    await adapter.start();
    expect(last()).toMatchObject({ screen: "login", error: "Could not reach Stoat: Instance discovery failed (HTTP 503)" });

    await adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    expect(renders).toContainEqual(expect.objectContaining({ screen: "login", busy: true, status: "Signing in…" }));
    expect(last()).toMatchObject({ screen: "login", busy: false, error: expect.stringContaining("Could not reach") });

    down = false;
    await adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    expect(secrets.get(KEY)).toBe("tok");
    expect(last()).toEqual({ screen: "connecting", platform: "Stoat", status: "Connecting…" });
    expect(adapter.accountStatus()).toEqual({ state: "signed-in" });
    socket().open();
    expect(socket().sent[0]).toEqual({ type: "Authenticate", token: "tok" });
  });

  it("shows wrong passwords and ignores a second attempt while busy", async () => {
    const { adapter, last, requests } = setup({ routes: [(url) => (url.endsWith("/auth/session/login") ? { status: 401, body: { type: "InvalidCredentials" } } : undefined)] });
    await adapter.start();
    const first = adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    await adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    await first;
    expect(requests("/auth/session/login")).toHaveLength(1);
    expect(last()).toMatchObject({ screen: "login", busy: false, error: "Wrong email or password." });
  });

  it("asks for an authenticator or recovery code and sends the right one", async () => {
    let answer: unknown = { result: "MFA", ticket: "t1", allowed_methods: ["Totp", "Recovery"] };
    const { adapter, last, requests, secrets } = setup({ routes: [(url) => (url.endsWith("/auth/session/login") ? { status: 200, body: answer } : undefined)] });
    await adapter.start();
    await adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    expect(last()).toEqual({ screen: "mfa", platform: "Stoat", codes: "totp", busy: false, error: undefined });

    answer = { type: "InvalidToken" };
    const pending = adapter.handleAction({ type: "mfa", code: "123 456" });
    await adapter.handleAction({ type: "mfa", code: "654321" }); // busy: ignored
    await pending;
    expect(requests("/auth/session/login")).toHaveLength(2);
    const body = (i: number) => JSON.parse(requests("/auth/session/login")[i]!.init.body as string);
    expect(body(1)).toEqual({ mfa_ticket: "t1", mfa_response: { totp_code: "123456" }, friendly_name: "Multicord" });
    expect(last()).toMatchObject({ screen: "mfa", error: "Unexpected login response" });

    answer = { result: "Success", token: "tok2" };
    await adapter.handleAction({ type: "mfa", code: " abcd-efgh " });
    expect(body(2).mfa_response).toEqual({ recovery_code: "abcd-efgh" });
    expect(secrets.get(KEY)).toBe("tok2");
    expect(last()).toMatchObject({ screen: "connecting" });
  });

  it("takes only recovery codes when the account has no authenticator", async () => {
    let answer: unknown = { result: "MFA", ticket: "t1", allowed_methods: ["Recovery"] };
    const { adapter, last, requests } = setup({ routes: [(url) => (url.endsWith("/auth/session/login") ? { status: 200, body: answer } : undefined)] });
    await adapter.start();
    await adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    expect(last()).toMatchObject({ screen: "mfa", codes: "backup" });
    answer = { result: "Success", token: "tok" };
    await adapter.handleAction({ type: "mfa", code: "123456" });
    expect(JSON.parse(requests("/auth/session/login")[1]!.init.body as string).mfa_response).toEqual({ recovery_code: "123456" });
  });

  it("explains a second factor it cannot offer, and lets the user go back", async () => {
    let answer: unknown = { result: "MFA", ticket: "t1", allowed_methods: ["Password"] };
    const { adapter, last, requests } = setup({ routes: [(url) => (url.endsWith("/auth/session/login") ? { status: 200, body: answer } : undefined)] });
    await adapter.start();
    await adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    expect(last()).toMatchObject({ screen: "login", error: "This account's two-factor method is not supported here." });
    await adapter.handleAction({ type: "mfa", code: "123456" }); // no ticket: ignored
    expect(requests("/auth/session/login")).toHaveLength(1);

    answer = { result: "MFA", ticket: "t2", allowed_methods: ["Totp"] };
    await adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    await adapter.handleAction({ type: "cancelMfa" });
    expect(last()).toMatchObject({ screen: "login", error: undefined });
    await adapter.handleAction({ type: "mfa", code: "123456" });
    expect(requests("/auth/session/login")).toHaveLength(2);
  });
});

describe("StoatAdapter session", () => {
  it("resumes a saved session and builds the rail and DMs from Ready", async () => {
    const { adapter, socket, goOnline, chat, requests } = setup({ token: "saved" });
    const servers = vi.fn();
    const directs = vi.fn();
    adapter.onServersChanged(servers);
    adapter.onDirectsChanged(directs);
    await adapter.start();
    expect(adapter.accountStatus()).toEqual({ state: "signed-in" });
    await goOnline();
    expect(socket().sent[0]).toEqual({ type: "Authenticate", token: "saved" });
    expect(chat()).toMatchObject({ screen: "chat", platform: "Stoat", title: "Direct Messages", me: "me", channel: null, voice: null });
    expect(adapter.accountStatus()).toEqual({ state: "signed-in", name: "me" });

    const account = { platform: "stoat-native", instance: "stoat.test", accountId: "default" };
    expect(servers.mock.calls.at(-1)![0]).toEqual([
      { key: ALPHA, account, name: "Alpha", iconUrl: "https://cdn.test/icons/ic1", unread: true, mentions: 2 },
      { key: BETA, account, name: "Beta", iconUrl: undefined, unread: false, mentions: 0 },
    ]);
    expect(directs.mock.calls.at(-1)![0]).toEqual([
      { key: DM, account, title: "Ana", avatarUrl: "https://cdn.test/avatars/av1", lastActivity: expect.any(Number), unread: true, mentions: 1 },
      { key: GROUP, account, title: "Group", avatarUrl: undefined, lastActivity: expect.any(Number), unread: false, mentions: 0 },
    ]);
    expect(await adapter.listDirectConversations()).toHaveLength(2);
    expect(adapter.homeBadge()).toEqual({ unread: false, mentions: 0 });
    // Ready carried unread state; the notification settings are fetched.
    expect(requests("/sync/unreads")).toHaveLength(0);
    expect(requests("/sync/settings/fetch")).toHaveLength(1);
    expect(chat().sidebar.map((s) => [s.name, s.kind, s.iconUrl])).toEqual([
      ["Saved Notes", "dm", undefined],
      ["Ana", "dm", "https://cdn.test/avatars/av1"],
      ["Group", "dm", undefined],
    ]);
  });

  it("fetches unread state when Ready lacks it, and survives failures", async () => {
    const { adapter, goOnline, chat, requests, routes } = setup({ token: "saved" });
    routes.push((url) => (url.endsWith("/sync/unreads") ? { status: 200, body: [{ _id: { channel: CHAT, user: ME_ID }, last_id: ulid(600), mentions: [ulid(650)] }] } : undefined));
    await adapter.start();
    await goOnline(readyPayload({ channel_unreads: undefined }));
    expect(requests("/sync/unreads")).toHaveLength(1);
    await adapter.openServer(BETA);
    expect(chat().sidebar).toEqual([{ id: CHAT, name: "chat", kind: "text", iconUrl: undefined, unread: true, mentions: 1, active: true, muted: false, canMute: true }]);

    const failing = setup({ token: "saved", routes: [(url) => (url.includes("/sync/") ? { status: 500 } : undefined)] });
    await failing.adapter.start();
    await failing.goOnline(readyPayload({ channel_unreads: undefined }));
    expect(failing.chat().screen).toBe("chat");
  });

  it("shows reconnects and reloads the open channel after a new Ready", async () => {
    const { adapter, socket, goOnline, chat, last, requests, online } = setup({ token: "saved" });
    await online();
    await adapter.openServer(ALPHA);
    expect(requests("/messages?")).toHaveLength(1);
    socket().serverClose();
    expect(chat().error).toBe("Connection lost. Reconnecting…");
    await vi.advanceTimersByTimeAsync(1000);
    await goOnline();
    expect(requests("/messages?")).toHaveLength(2);
    expect(last()).toMatchObject({ screen: "chat", error: undefined, channel: { id: LOBBY, messages: [expect.objectContaining({ id: ulid(450) })] } });
  });

  it("says Reconnecting… before the first Ready of a retried connection", async () => {
    const { adapter, socket, last } = setup({ token: "saved" });
    await adapter.start();
    socket().serverClose();
    expect(last()).toEqual({ screen: "connecting", platform: "Stoat", status: "Reconnecting…" });
  });

  it("signs out when the server rejects the token", async () => {
    const { adapter, socket, secrets, last, online } = setup({ token: "saved" });
    const servers = vi.fn();
    const directs = vi.fn();
    adapter.onServersChanged(servers);
    adapter.onDirectsChanged(directs);
    await online();
    socket().receive({ type: "Error", data: { type: "InvalidSession" } });
    expect(secrets.has(KEY)).toBe(false);
    expect(last()).toMatchObject({ screen: "login", error: "Your session has ended. Please sign in again." });
    expect(servers).toHaveBeenLastCalledWith([]);
    expect(directs).toHaveBeenLastCalledWith([]);
    expect(adapter.accountStatus()).toEqual({ state: "signed-out" });
  });

  it("deletes the session on the server when signing out", async () => {
    const { adapter, secrets, last, requests, online, routes } = setup({ token: "saved" });
    await online();
    await adapter.signOut();
    expect(requests("/auth/session/logout")[0]!.init).toMatchObject({ method: "POST", headers: { "X-Session-Token": "saved" } });
    expect(secrets.has(KEY)).toBe(false);
    expect(last()).toMatchObject({ screen: "login", error: undefined });

    // A failing logout request still ends the session here.
    const other = setup({ token: "saved" });
    other.routes.push((url) => (url.endsWith("/logout") ? { status: 500 } : undefined));
    await other.online();
    await other.adapter.handleAction({ type: "logout" });
    expect(other.secrets.has(KEY)).toBe(false);
    expect(routes).toHaveLength(0);

    // Signing out before the instance was reached does nothing remote.
    const offline = setup({ routes: [(url) => (url.endsWith("/api/") ? { status: 503 } : undefined)] });
    await offline.adapter.start();
    await offline.adapter.signOut();
    expect(offline.requests("/logout")).toHaveLength(0);
  });
});

describe("StoatAdapter navigation", () => {
  it("opens a server on its first text channel, with categories in the sidebar", async () => {
    const { adapter, chat, online, requests } = setup({ token: "saved" });
    await online();
    await adapter.openServer(ALPHA);
    expect(requests("/messages?")[0]!.url).toBe(`https://stoat.test/api/channels/${LOBBY}/messages?limit=50&include_users=true&sort=Latest`);
    const view = chat();
    expect(view.title).toBe("Alpha");
    expect(view.sidebar).toEqual([
      { id: LOBBY, name: "lobby", kind: "text", iconUrl: undefined, unread: false, mentions: 0, active: true, muted: false, canMute: true },
      { id: "cat1", name: "Text", kind: "category", unread: false, mentions: 0, active: false },
      { id: GENERAL, name: "general", kind: "text", iconUrl: undefined, unread: true, mentions: 2, active: false, muted: false, canMute: true },
      { id: RULES, name: "rules", kind: "text", iconUrl: undefined, unread: false, mentions: 0, active: false, muted: false, canMute: true },
    ]);
    expect(view.channel).toMatchObject({ id: LOBBY, name: "lobby", loading: false, hasOlder: false, typing: [], pending: [], uploading: false });
    await expect(adapter.openServer("nope")).rejects.toThrow("Unknown Stoat server: nope");
  });

  it("remembers the last channel per server and at home", async () => {
    const { adapter, chat, online } = setup({ token: "saved" });
    await online();
    await adapter.openServer(ALPHA);
    await adapter.handleAction({ type: "select", channelId: GENERAL });
    await adapter.openConversation(DM);
    expect(chat()).toMatchObject({ title: "Direct Messages", channel: { id: DM, name: "Ana" } });
    await adapter.openServer(ALPHA);
    expect(chat().channel?.id).toBe(GENERAL);
    await adapter.openHome();
    expect(chat().channel?.id).toBe(DM);
    await adapter.openConversation(CHAT);
    expect(chat()).toMatchObject({ title: "Beta", channel: { id: CHAT } });
  });

  it("loads a channel's history once, however often it is opened", async () => {
    const { adapter, online, requests } = setup({ token: "saved" });
    await online();
    adapter.setVisible(true); // nothing open yet: nothing to ack
    const first = adapter.openConversation(DM);
    await adapter.openConversation(DM);
    await first;
    expect(requests("/messages?")).toHaveLength(1);
  });

  it("shows a server without text channels, and ignores channels it cannot open", async () => {
    const { adapter, chat, event, online, requests } = setup({ token: "saved" });
    await online();
    await adapter.openConversation(ulid(999));
    expect(chat()).toMatchObject({ title: "Direct Messages", channel: null });
    await event({ type: "ServerCreate", id: ulid(300), server: { _id: ulid(300), name: "Empty", channels: [] }, channels: [], emojis: [] });
    await adapter.openServer(ulid(300));
    expect(chat()).toMatchObject({ title: "Empty", sidebar: [], channel: null });
    await adapter.handleAction({ type: "select", channelId: ulid(112) }); // voice-only
    await adapter.handleAction({ type: "select", channelId: ulid(999) });
    expect(chat().channel).toBeNull();
    expect(requests("/messages?")).toHaveLength(0);
  });

  it("pages back through history while full pages come", async () => {
    const page = Array.from({ length: 50 }, (_, i) => message(1000 - i, LOBBY));
    let older = false;
    const { adapter, chat, online, requests } = setup({
      token: "saved",
      routes: [(url) => (url.includes("/messages?") ? { status: 200, body: { messages: older ? [message(10, LOBBY)] : page, users: [] } } : undefined)],
    });
    await online();
    await adapter.openServer(ALPHA);
    expect(chat().channel).toMatchObject({ hasOlder: true });
    older = true;
    await adapter.handleAction({ type: "loadOlder" });
    expect(requests("/messages?")[1]!.url).toContain(`before=${ulid(951)}`);
    expect(chat().channel!.messages[0]!.id).toBe(ulid(10));
    expect(chat().channel).toMatchObject({ hasOlder: false });
    await adapter.handleAction({ type: "loadOlder" });
    expect(requests("/messages?")).toHaveLength(2);
  });

  it("shows history that fails to load", async () => {
    const { adapter, chat, online } = setup({ token: "saved", routes: [(url) => (url.includes("/messages?") ? { status: 403, body: { type: "MissingPermission" } } : undefined)] });
    await online();
    await adapter.openServer(ALPHA);
    expect(chat().error).toBe("Could not load messages: You do not have permission to do that.");
    await adapter.handleAction({ type: "loadOlder" });
  });
});

describe("StoatAdapter custom emoji", () => {
  it("offers the emoji usable in the open conversation, in Stoat's own syntax", async () => {
    const { adapter, chat, event, online, requests } = setup({ token: "saved" });
    await online();
    await event({ type: "EmojiCreate", _id: ulid(53), name: "wave", animated: true, parent: { type: "Server", id: BETA } });
    expect(chat().customEmoji).toEqual([]);
    const party = { id: EMOJI, name: "party", animated: false, url: `https://cdn.test/emojis/${EMOJI}`, source: "Alpha", text: `:${EMOJI}:`, key: EMOJI };
    const wave = { id: ulid(53), name: "wave", animated: true, url: `https://cdn.test/emojis/${ulid(53)}`, source: "Beta", text: `:${ulid(53)}:`, key: ulid(53) };
    await adapter.openConversation(GENERAL);
    expect(chat().customEmoji).toEqual([party]);
    await adapter.openConversation(DM);
    expect(chat().customEmoji).toEqual([party, wave]);
    // The view takes them as they are, reactions included.
    expect(customEmojiList(chat().customEmoji, chat().emojiBase)).toEqual([{ ...party, react: true }, { ...wave, react: true }]);
    // Picking one for a reaction sends its id as the key.
    await adapter.handleAction({ type: "react", messageId: ulid(450), emoji: EMOJI, add: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(requests(`/reactions/${EMOJI}`)).toHaveLength(1);
    expect(chat().channel!.messages[0]!.reactions).toEqual([{ key: EMOJI, label: ":party:", imageUrl: `https://cdn.test/emojis/${EMOJI}`, count: 1, me: true }]);
    await event({ type: "EmojiDelete", id: EMOJI });
    expect(chat().customEmoji).toEqual([wave]);
  });
});

describe("StoatAdapter messages", () => {
  it("names custom emoji in messages where no file server can draw them", async () => {
    const { adapter, chat, online } = setup({
      token: "saved",
      routes: [
        (url) => (url.endsWith("/api/") ? { status: 200, body: { ws: "wss://events.test" } } : undefined),
        (url) => (url.includes("/messages?") ? { status: 200, body: { messages: [message(461, GENERAL, { content: "yes", replies: [ulid(460)] }), message(460, GENERAL, { content: `:${EMOJI}:` })], users: [ANA] } } : undefined),
      ],
    });
    await online();
    await adapter.openConversation(GENERAL);
    const [first, second] = chat().channel!.messages;
    expect(first!.content).toBe(":party:");
    // Replies quote plain text: the name.
    expect(second!.reply).toEqual({ author: "Ana", content: ":party:", id: ulid(460), timestamp: new Date(idTime(ulid(460))).toISOString() });
    expect(chat().emojiUrls).toEqual({});
  });

  it("fetches the originals of replies that are not loaded, a page's latest few at a time", async () => {
    const { ORIGINALS_PER_PAGE } = await import("../../../src/modules/stoat/adapter");
    const replies = Array.from({ length: ORIGINALS_PER_PAGE + 2 }, (_, i) => message(470 + i, GENERAL, { replies: [ulid(10 + i)] }));
    let failing = true;
    const { adapter, chat, event, online, requests } = setup({
      token: "saved",
      routes: [
        (url) => (url.includes("/messages?") ? { status: 200, body: { messages: [...replies].reverse(), users: [ANA] } } : undefined),
        // One is gone, one fails until later, the others come back.
        (url) => (url.endsWith(`/messages/${ulid(20)}`) ? { status: 404, body: { type: "NotFound" } } : undefined),
        (url) => (url.endsWith(`/messages/${ulid(21)}`) && failing ? { status: 500 } : undefined),
        (url) => {
          const n = Number(url.split("/messages/")[1]?.slice(4));
          return n > 0 && n < 100 ? { status: 200, body: message(n, GENERAL, { author: BOB_ID, content: `was ${n}` }) } : undefined;
        },
      ],
    });
    await online();
    await adapter.openConversation(GENERAL);
    await vi.advanceTimersByTimeAsync(100);
    const fetched = () => requests("/messages/01HZ").map((c) => c.url.split("/messages/")[1]);
    // The latest ten, each once; the two oldest are not asked for.
    expect(fetched()).toEqual(Array.from({ length: ORIGINALS_PER_PAGE }, (_, i) => ulid(12 + i)));
    const shown = chat().channel!.messages;
    expect(shown[0]!.reply).toBeUndefined();
    expect(shown[2]!.reply).toEqual({ author: "bob", content: "was 12", id: ulid(12), timestamp: new Date(idTime(ulid(12))).toISOString() });
    expect(shown[10]!.reply).toBeNull();
    expect(shown[11]!.reply).toBeUndefined();
    // A new message asks again for what failed, and for nothing fetched already.
    failing = false;
    await event({ type: "Message", ...message(499, GENERAL, { replies: [ulid(12)] }) });
    await vi.advanceTimersByTimeAsync(100);
    // With room again, the two oldest are asked for too.
    expect(fetched().slice(ORIGINALS_PER_PAGE)).toEqual([ulid(10), ulid(11), ulid(21)]);
    expect(chat().channel!.messages[11]!.reply).toMatchObject({ content: "was 21" });
  });

  it("drops originals fetched for a session that has ended", async () => {
    let renewed = false;
    const { adapter, chat, online, routes, requests, socket } = setup({ token: "saved" });
    routes.push(
      (url) => (url.includes("/messages?") ? { status: 200, body: { messages: [message(470, GENERAL, { replies: [ulid(10)] })], users: [ANA] } } : undefined),
      (url) => {
        if (!url.endsWith(`/messages/${ulid(10)}`)) return undefined;
        // Ready starts a new session while the original is on its way.
        if (!renewed) socket().receive(readyPayload());
        renewed = true;
        return { status: 200, body: message(10, GENERAL) };
      },
    );
    await online();
    await adapter.openConversation(GENERAL);
    await vi.advanceTimersByTimeAsync(100);
    // The first answer was dropped; the new session asked again.
    expect(requests(`/messages/${ulid(10)}`)).toHaveLength(2);
    expect(chat().channel!.messages.at(-1)!.reply).toMatchObject({ id: ulid(10) });
  });

  it("marks where a channel's news began when it was opened, from its read position", async () => {
    const { adapter, chat, online } = setup({ token: "saved" });
    await online();
    await adapter.openConversation(GENERAL);
    expect(chat().channel!.unread).toEqual({ firstId: ulid(450) });
    // A channel without news has no marker.
    await adapter.openConversation(CHAT);
    expect(chat().channel).not.toHaveProperty("unread");
    // The DM was read past what is loaded, and nothing older is left: no marker.
    await adapter.openConversation(DM);
    expect(chat().channel!.unread).toBeUndefined();

    // A full page of news: it began above the loaded messages.
    const full = setup({ token: "saved" });
    full.routes.push((url) =>
      url.includes(`/channels/${GENERAL}/messages?`) ? { status: 200, body: { messages: Array.from({ length: 50 }, (_, i) => message(1000 - i, GENERAL)), users: [ANA] } } : undefined,
    );
    await full.online();
    await full.adapter.openConversation(GENERAL);
    expect(full.chat().channel!.unread).toEqual({});

    // Never read, but mentioned in: from its first message on.
    const fresh = setup({ token: "saved" });
    await fresh.adapter.start();
    await fresh.goOnline(readyPayload({ channel_unreads: [{ _id: { channel: GENERAL, user: ME_ID }, mentions: [ulid(450)] }] }));
    await fresh.adapter.openConversation(GENERAL);
    expect(fresh.chat().channel!.unread).toEqual({ firstId: ulid(450) });
  });

  it("renders authors, mentions, emoji, replies, reactions and attachments", async () => {
    const { adapter, chat, event, online, routes } = setup({ token: "saved" });
    routes.push((url) =>
      url.includes("/messages?")
        ? {
            status: 200,
            body: {
              messages: [
                message(460, GENERAL, {
                  content: `hi <@${ME_ID}> <@${ulid(77)}> see <#${LOBBY}> <#${ulid(78)}> :${EMOJI}: :${ulid(79)}:`,
                  replies: [ulid(450)],
                  mentions: [ME_ID],
                  reactions: { "👍": [ME_ID, ANA_ID], [EMOJI]: [ANA_ID], [ulid(79)]: [ME_ID] },
                  attachments: [
                    { _id: "f1", tag: "attachments", filename: "cat.png", content_type: "image/png", metadata: { type: "Image" } },
                    { _id: "f2", tag: "attachments", filename: "doc.pdf", content_type: "application/pdf", metadata: { type: "File" } },
                  ],
                  edited: "2026-10-14T12:00:00Z",
                }),
                message(455, GENERAL, { author: ME_ID, content: "mine", mentions: [ME_ID] }),
                message(452, GENERAL, { author: ulid(88), masquerade: { name: "Bridged" }, replies: [ulid(1)] }),
                message(451, GENERAL, { author: ulid(89) }),
                message(450, GENERAL, { author: "00000000000000000000000000", system: { type: "user_joined", id: ANA_ID } }),
              ],
              users: [ANA],
            },
          }
        : undefined,
    );
    await online();
    await adapter.openConversation(GENERAL);
    await vi.advanceTimersByTimeAsync(100);
    const [system, unknown, bridged, mine, rich] = chat().channel!.messages;
    expect(system).toMatchObject({ author: "System", content: "@Ana joined", canEdit: false, canDelete: false, mine: false });
    // Known emoji are drawn from the file server; the Messages list keeps their names.
    expect(chat().emojiUrls).toEqual({ [EMOJI]: `https://cdn.test/emojis/${EMOJI}` });
    expect(unknown).toMatchObject({ author: "Unknown user", avatarUrl: undefined });
    // Its original is not loaded, and Stoat has none to fetch: deleted.
    expect(bridged).toMatchObject({ author: "Bridged", avatarUrl: undefined, reply: null });
    expect(mine).toMatchObject({ author: "me", mine: true, canEdit: true, canDelete: true, source: "mine" });
    expect([system, unknown, bridged, mine].some((m) => m!.mentionsMe)).toBe(false);
    expect([system, bridged].some((m) => m!.authorId ?? m!.authorMention)).toBe(false);
    expect(mine).toMatchObject({ authorId: ME_ID, authorMention: `<@${ME_ID}>` });
    expect(rich).toEqual({
      id: ulid(460),
      author: "Ana",
      avatarUrl: "https://cdn.test/avatars/av1",
      content: `hi @me <@${ulid(77)}> see #lobby <#${ulid(78)}> <:party:${EMOJI}> :${ulid(79)}:`,
      timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      edited: true,
      mine: false,
      canEdit: false,
      source: undefined,
      canDelete: false,
      canPin: true,
      mentionsMe: true,
      authorId: ANA_ID,
      authorMention: `<@${ANA_ID}>`,
      reply: { author: "System", content: "@Ana joined", id: ulid(450), timestamp: new Date(idTime(ulid(450))).toISOString() },
      reactions: [
        { key: "👍", label: "👍", imageUrl: undefined, count: 2, me: true },
        { key: EMOJI, label: ":party:", imageUrl: `https://cdn.test/emojis/${EMOJI}`, count: 1, me: false },
        { key: ulid(79), label: ":emoji:", imageUrl: `https://cdn.test/emojis/${ulid(79)}`, count: 1, me: true },
      ],
      attachments: [
        expect.objectContaining({ name: "cat.png", kind: "image", url: "https://cdn.test/attachments/f1" }),
        expect.objectContaining({ name: "doc.pdf", kind: "file", url: "https://cdn.test/attachments/f2" }),
      ],
    });
    // Our own Ready user can disappear (e.g. a wiped account); names fall back.
    await event({ type: "UserUpdate", id: ANA_ID, data: { display_name: "Ana B" } });
    expect(chat().channel!.messages[4]!.author).toBe("Ana B");
  });

  it("shows link previews, sites' pictures only through the instance's proxy", async () => {
    const embeds = [
      { type: "Website", url: "https://site/a", title: "Site page", image: { url: "https://site/i.png?a=1&b", size: "Preview" } },
      { type: "Text", title: "Bot", media: { _id: "f9", tag: "attachments", filename: "p.png", content_type: "image/png", metadata: { type: "Image", width: 4, height: 3 } } },
    ];
    const history = (url: string): Reply | undefined => (url.includes("/messages?") ? { status: 200, body: { messages: [message(460, GENERAL, { embeds }), message(459, GENERAL)], users: [ANA] } } : undefined);
    const proxied = setup({ token: "saved", routes: [(url) => (url === "https://stoat.test/api/" ? { status: 200, body: { ...CONFIG, features: { ...CONFIG.features, january: { enabled: true, url: "https://proxy.test" } } } } : undefined), history] });
    await proxied.online();
    await proxied.adapter.openConversation(GENERAL);
    const [plain, rich] = proxied.chat().channel!.messages;
    expect(plain!.embeds).toBeUndefined();
    expect(rich!.embeds).toEqual([
      { url: "https://site/a", title: "Site page", image: { url: "https://proxy.test/proxy?url=https%3A%2F%2Fsite%2Fi.png%3Fa%3D1%26b", width: undefined, height: undefined, thumbnail: true } },
      { title: "Bot", image: { url: "https://cdn.test/attachments/f9", width: 4, height: 3 } },
    ]);
    // Without a proxy, a site's picture is left out rather than loaded from the site.
    const direct = setup({ token: "saved", routes: [history] });
    await direct.online();
    await direct.adapter.openConversation(GENERAL);
    expect(direct.chat().channel!.messages[1]!.embeds![0]).toEqual({ url: "https://site/a", title: "Site page" });
  });

  it("sends messages with an idempotency key and adds them at once", async () => {
    const { adapter, chat, online, requests } = setup({ token: "saved" });
    await online();
    await adapter.openConversation(DM);
    await adapter.handleAction({ type: "send", content: "hello", replyTo: ulid(450) });
    const post = requests("/messages").find((c) => c.init.method === "POST")!;
    expect(JSON.parse(post.init.body as string)).toEqual({ content: "hello", replies: [{ id: ulid(450), mention: false }] });
    expect((post.init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(/^multicord-\d+-\d+$/);
    expect(chat().channel!.messages.at(-1)).toMatchObject({ id: ulid(990), content: "hello", mine: true });
    await adapter.handleAction({ type: "send", content: "   " });
    expect(requests("/messages").filter((c) => c.init.method === "POST")).toHaveLength(1);
  });

  it("records its own sent message as the channel's latest and read, and acks it", async () => {
    const { adapter, chat, event, online, requests } = setup({
      token: "saved",
      routes: [(url) => (url.includes(`/ack/${ulid(990)}`) ? { status: 500, body: { type: "InternalError" } } : undefined)],
    });
    await online();
    await adapter.openConversation(DM);
    // The server's reply can come before the live echo; a failed ack is not the user's problem.
    await adapter.handleAction({ type: "send", content: "hello" });
    await vi.advanceTimersByTimeAsync(100);
    expect(adapter.directs().find((d) => d.key === DM)).toMatchObject({ preview: "hello", lastActivity: idTime(ulid(990)), unread: false, mentions: 0 });
    expect(requests("/ack/").map((c) => c.url)).toEqual([`https://stoat.test/api/channels/${DM}/ack/${ulid(990)}`]);
    await event({ type: "Message", ...message(990, DM, { author: ME_ID, content: "hello" }) });
    expect(chat().channel!.messages.filter((m) => m.id === ulid(990))).toHaveLength(1);
    expect(chat().error).toBeUndefined();
  });

  it("shows a message that could not be sent", async () => {
    const { adapter, chat, online } = setup({ token: "saved", routes: [(url, init) => (url.endsWith("/messages") && init.method === "POST" ? { status: 400, body: { type: "PayloadTooLarge" } } : undefined)] });
    await online();
    await adapter.openConversation(DM);
    await adapter.handleAction({ type: "send", content: "x" });
    expect(chat().error).toBe("Message not sent: The message is too long.");
    expect(chat().channel!.uploading).toBe(false);
  });

  it("does nothing without an open channel", async () => {
    const { adapter, online, calls } = setup({ token: "saved" });
    await online();
    const before = calls.length;
    for (const action of [
      { type: "send", content: "x" },
      { type: "edit", messageId: ulid(1), content: "x" },
      { type: "delete", messageId: ulid(1) },
      { type: "react", messageId: ulid(1), emoji: "👍", add: true },
      { type: "typing" },
      { type: "attach" },
      { type: "loadOlder" },
      { type: "removeAttachment", index: 0 },
      { type: "joinVoice", channelId: ulid(1) },
    ] as const) {
      await adapter.handleAction(action);
    }
    expect(calls.length).toBe(before);
  });

  it("edits, deletes and reacts to messages", async () => {
    const { adapter, chat, online, requests, routes } = setup({ token: "saved" });
    routes.push((url, init) => (init.method === "PATCH" ? { status: 200, body: message(450, DM, { content: "edited", edited: "2026-10-14" }) } : undefined));
    await online();
    await adapter.openConversation(DM);
    await adapter.handleAction({ type: "edit", messageId: ulid(450), content: "edited" });
    await vi.advanceTimersByTimeAsync(100);
    expect(chat().channel!.messages[0]).toMatchObject({ content: "edited", edited: true });

    await adapter.handleAction({ type: "react", messageId: ulid(450), emoji: "🎉", add: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(requests("/reactions/")[0]!.init.method).toBe("PUT");
    expect(chat().channel!.messages[0]!.reactions).toEqual([{ key: "🎉", label: "🎉", imageUrl: undefined, count: 1, me: true }]);
    await adapter.handleAction({ type: "react", messageId: ulid(450), emoji: "🎉", add: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(chat().channel!.messages[0]!.reactions).toEqual([]);

    await adapter.handleAction({ type: "delete", messageId: ulid(450) });
    await vi.advanceTimersByTimeAsync(100);
    expect(requests(`/messages/${ulid(450)}`).map((c) => c.init.method)).toContain("DELETE");
    expect(chat().channel!.messages).toEqual([]);
  });

  it("shows failed edits, deletes and reactions", async () => {
    const { adapter, chat, online } = setup({ token: "saved", routes: [(_url, init) => (init.method === "PATCH" || init.method === "DELETE" || init.method === "PUT" ? { status: 403, body: { type: "CannotEditMessage" } } : undefined)] });
    await online();
    await adapter.openConversation(DM);
    await adapter.handleAction({ type: "edit", messageId: ulid(450), content: "x" });
    expect(chat().error).toBe("Message not edited: Request failed (CannotEditMessage)");
    await adapter.handleAction({ type: "delete", messageId: ulid(450) });
    await vi.advanceTimersByTimeAsync(100);
    expect(chat().error).toMatch(/^Message not deleted/);
    await adapter.handleAction({ type: "react", messageId: ulid(450), emoji: "👍", add: true });
    expect(chat().error).toMatch(/^Reaction failed/);
    expect(chat().channel!.messages).toHaveLength(1);
  });

  it("ignores an edit the server does not confirm", async () => {
    const { adapter, chat, online, routes } = setup({ token: "saved" });
    routes.push((_url, init) => (init.method === "PATCH" ? { status: 200, body: {} } : undefined));
    await online();
    await adapter.openConversation(DM);
    await adapter.handleAction({ type: "edit", messageId: ulid(450), content: "x" });
    expect(chat().channel!.messages[0]!.content).toBe("m450");
  });
});

describe("StoatAdapter attachments", () => {
  it("attaches picked files and uploads them before sending", async () => {
    const pick = vi.fn(async () => [file("a.png"), file("b.png")]);
    const { adapter, chat, online, requests } = setup({ token: "saved", files: { pick } });
    await online();
    await adapter.openConversation(DM);
    expect(chat().channel!.can.attach).toBe(true);
    await adapter.handleAction({ type: "attach" });
    expect(chat().channel!.pending).toEqual([
      { name: "a.png", size: 3 },
      { name: "b.png", size: 3 },
    ]);
    await adapter.handleAction({ type: "removeAttachment", index: 0 });
    expect(chat().channel!.pending).toEqual([{ name: "b.png", size: 3 }]);
    await adapter.handleAction({ type: "send", content: "" });
    const uploads = requests("https://cdn.test/attachments");
    expect(uploads).toHaveLength(1);
    const post = requests("/messages").find((c) => c.init.method === "POST")!;
    expect(JSON.parse(post.init.body as string)).toEqual({ attachments: [expect.stringMatching(/^up\d+$/)] });
    expect(chat().channel!.pending).toEqual([]);
  });

  it("sends a file the shell hands over at once, or with the files waiting", async () => {
    const open = vi.fn((f: { name: string }) => file(f.name));
    const pick = vi.fn(async () => [file("1"), file("2"), file("3"), file("4")]);
    const { adapter, chat, online, requests } = setup({ token: "saved", files: { pick, open } });
    await online();
    await adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "dance.gif", size: 3, type: "image/gif" } }); // no conversation open
    await adapter.openConversation(DM);
    await adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "dance.gif", size: 3, type: "image/gif" }, replyTo: ulid(450) });
    const post = requests("/messages").find((c) => c.init.method === "POST")!;
    expect(JSON.parse(post.init.body as string)).toMatchObject({ attachments: [expect.stringMatching(/^up\d+$/)], replies: [{ id: ulid(450), mention: false }] });
    expect(chat().channel!.pending).toEqual([]);
    await adapter.handleAction({ type: "attach" });
    await adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "dance.gif", size: 3, type: "image/gif" } });
    expect(chat().channel!.pending.map((f) => f.name)).toEqual(["1", "2", "3", "4", "dance.gif"]);
    await adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "more.gif", size: 3, type: "image/gif" } });
    expect(chat().error).toBe("At most 5 files per message.");
  });

  it("keeps at most five files and reports picker failures", async () => {
    let fail = false;
    const pick = vi.fn(async () => {
      if (fail) throw new Error("dialog closed");
      return [file("1"), file("2"), file("3"), file("4"), file("5"), file("6")];
    });
    const { adapter, chat, online } = setup({ token: "saved", files: { pick } });
    await online();
    await adapter.openConversation(DM);
    await adapter.handleAction({ type: "attach" });
    expect(chat().channel!.pending).toHaveLength(5);
    expect(chat().error).toBe("At most 5 files per message.");
    fail = true;
    await adapter.handleAction({ type: "attach" });
    expect(chat().error).toBe("Could not attach: dialog closed");
  });

  it("does not send while uploading, and keeps the files when an upload fails", async () => {
    let fail = false;
    const { adapter, chat, online } = setup({
      token: "saved",
      files: { pick: async () => [file("a.png")] },
      routes: [(url) => (url === "https://cdn.test/attachments" && fail ? { status: 413, body: { type: "FileTooLarge" } } : undefined)],
    });
    await online();
    await adapter.openConversation(DM);
    await adapter.handleAction({ type: "attach" });
    fail = true;
    await adapter.handleAction({ type: "send", content: "x" });
    expect(chat().error).toBe("Message not sent: The file is too large for this instance.");
    expect(chat().channel!.pending).toHaveLength(1);

    // A second send while the first is still uploading is dropped.
    fail = false;
    const sending = adapter.handleAction({ type: "send", content: "x" });
    expect(chat().channel!.uploading).toBe(true);
    await adapter.handleAction({ type: "send", content: "y" });
    await sending;
    const posts = adapter.state.messages.get(DM)!.filter((m) => m.authorId === ME_ID);
    expect(posts.map((m) => m.content)).toEqual(["x"]);
    expect(chat().channel).toMatchObject({ uploading: false, pending: [] });
  });

  it("explains an instance without a file server, and works without a picker", async () => {
    const { adapter, chat, online } = setup({ token: "saved", files: { pick: async () => [], open: (f) => file(f.name) }, routes: [(url) => (url.endsWith("/api/") ? { status: 200, body: { ws: "wss://events.test" } } : undefined)] });
    await online();
    await adapter.openConversation(DM);
    await adapter.handleAction({ type: "attach" });
    expect(chat().error).toBe("This Stoat instance does not accept files.");
    await adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "a.gif", size: 3, type: "image/gif" } });
    expect(chat().channel!.pending).toEqual([]);
    expect(chat().channel!.can).toEqual({ reply: true, react: true, attach: false, typing: true, members: true, pins: true, search: true, forward: true, call: false });
    // Without a file server there are no avatar or icon URLs either, nor emoji pictures to pick.
    expect(chat().sidebar[0]!.iconUrl).toBeUndefined();
    expect(chat().customEmoji).toEqual([]);

    const bare = setup({ token: "saved" });
    await bare.online();
    await bare.adapter.openConversation(DM);
    await bare.adapter.handleAction({ type: "attach" });
    expect(bare.chat().error).toBeUndefined();
    expect(bare.chat().channel!.can.attach).toBe(false);
  });
});

describe("StoatAdapter live updates", () => {
  it("shows who is typing and clears it when it expires", async () => {
    const { adapter, chat, event, online, renders } = setup({ token: "saved" });
    await online();
    await adapter.openConversation(DM);
    await event({ type: "ChannelStartTyping", id: DM, user: ANA_ID });
    expect(chat().channel!.typing).toEqual(["Ana"]);
    const count = renders.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renders.length).toBeGreaterThan(count);
    expect(chat().channel!.typing).toEqual([]);
  });

  it("announces our typing, repeats it while typing goes on and ends it", async () => {
    const { adapter, socket, online } = setup({ token: "saved" });
    await online();
    await adapter.openConversation(DM);
    const typing = () => socket().sent.filter((m) => m.type === "BeginTyping" || m.type === "EndTyping");
    await adapter.handleAction({ type: "typing" });
    await adapter.handleAction({ type: "typing" }); // the same millisecond: no second notice
    await vi.advanceTimersByTimeAsync(3000);
    await adapter.handleAction({ type: "typing" });
    expect(typing()).toEqual([{ type: "BeginTyping", channel: DM }]);
    await vi.advanceTimersByTimeAsync(3000);
    await adapter.handleAction({ type: "typing" });
    await vi.advanceTimersByTimeAsync(3000);
    await adapter.handleAction({ type: "typing" });
    expect(typing()).toEqual([
      { type: "BeginTyping", channel: DM },
      { type: "BeginTyping", channel: DM },
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(typing().at(-1)).toEqual({ type: "EndTyping", channel: DM });

    await adapter.handleAction({ type: "typing" });
    await adapter.openConversation(GROUP);
    await adapter.handleAction({ type: "typing" });
    await adapter.handleAction({ type: "send", content: "done" });
    expect(typing().slice(-4)).toEqual([
      { type: "BeginTyping", channel: DM },
      { type: "EndTyping", channel: DM },
      { type: "BeginTyping", channel: GROUP },
      { type: "EndTyping", channel: GROUP },
    ]);
  });

  it("sends no typing while Settings turns it off, ending a notice in progress", async () => {
    const off = setup({ token: "saved", settings: { typing: false } });
    await off.online();
    await off.adapter.openConversation(DM);
    await off.adapter.handleAction({ type: "typing" });
    expect(off.socket().sent.filter((m) => m.type === "BeginTyping")).toEqual([]);
    expect(off.chat().channel!.can.typing).toBe(false);

    const { adapter, socket, online } = setup({ token: "saved" });
    await online();
    await adapter.openConversation(DM);
    const typing = () => socket().sent.filter((m) => m.type === "BeginTyping" || m.type === "EndTyping");
    await adapter.handleAction({ type: "typing" });
    adapter.applySettings({ typing: false });
    await adapter.handleAction({ type: "typing" });
    expect(typing()).toEqual([
      { type: "BeginTyping", channel: DM },
      { type: "EndTyping", channel: DM },
    ]);
    adapter.applySettings({});
    await adapter.handleAction({ type: "typing" });
    expect(typing()).toHaveLength(3);
  });

  it("marks the open channel read while the view is visible", async () => {
    const { adapter, event, online, requests } = setup({ token: "saved" });
    await online();
    await adapter.openConversation(DM);
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests("/ack/")).toHaveLength(0);
    adapter.setVisible(true);
    await vi.advanceTimersByTimeAsync(750);
    expect(requests("/ack/")[0]!.url).toBe(`https://stoat.test/api/channels/${DM}/ack/${ulid(800)}`);
    expect(requests("/ack/")[0]!.init.method).toBe("PUT");
    // Read now: nothing more to ack.
    adapter.setVisible(true);
    await vi.advanceTimersByTimeAsync(750);
    expect(requests("/ack/")).toHaveLength(1);
    await event({ type: "Message", ...message(810, DM) });
    await vi.advanceTimersByTimeAsync(750);
    expect(requests("/ack/")[1]!.url).toContain(`/ack/${ulid(810)}`);
    adapter.setVisible(false);
    await event({ type: "Message", ...message(811, DM) });
    await vi.advanceTimersByTimeAsync(750);
    expect(requests("/ack/")).toHaveLength(2);
  });

  it("shows muted channels and mutes or unmutes them in the user's settings, keeping the rest", async () => {
    const { adapter, chat, event, online, routes, requests } = setup({ token: "saved" });
    let saved = JSON.stringify({ server: { [ALPHA]: "muted" }, channel: { [DM]: "muted", [GROUP]: "all" }, extra: 1 });
    routes.push((url, init) => {
      if (url.endsWith("/sync/settings/fetch")) return { status: 200, body: { notifications: [1, saved] } };
      if (url.includes("/sync/settings/set")) saved = JSON.parse(init.body as string).notifications;
      return undefined;
    });
    await online();
    const row = (id: string) => chat().sidebar.find((i) => i.id === id)!;
    expect(row(DM)).toMatchObject({ muted: true, canMute: true });
    expect(row(GROUP)).toMatchObject({ muted: false, canMute: true });
    await adapter.handleAction({ type: "mute", channelId: GROUP, mute: true });
    const set = requests("/sync/settings/set").at(-1)!;
    expect(set.url).toBe(`https://stoat.test/api/sync/settings/set?timestamp=${Date.now()}`);
    expect(JSON.parse(saved)).toEqual({ server: { [ALPHA]: "muted" }, channel: { [DM]: "muted", [GROUP]: "muted" }, extra: 1 });
    await vi.advanceTimersByTimeAsync(100);
    expect(chat().sidebar.find((i) => i.id === GROUP)!.muted).toBe(true);
    await adapter.handleAction({ type: "mute", channelId: DM, mute: false });
    expect(JSON.parse(saved).channel).toEqual({ [GROUP]: "muted" });
    // A channel of a muted server is unmuted with a level of its own.
    await adapter.openServer(ALPHA);
    expect(chat().sidebar.find((i) => i.id === GENERAL)!.muted).toBe(true);
    await adapter.handleAction({ type: "mute", channelId: GENERAL, mute: false });
    expect(JSON.parse(saved).channel[GENERAL]).toBe("mention");
    await vi.advanceTimersByTimeAsync(100);
    expect(chat().sidebar.find((i) => i.id === GENERAL)!.muted).toBe(false);
    // Already so, or unknown: nothing is sent.
    const before = requests("/sync/settings/set").length;
    await adapter.handleAction({ type: "mute", channelId: GENERAL, mute: false });
    await adapter.handleAction({ type: "mute", channelId: ulid(999), mute: true });
    expect(requests("/sync/settings/set")).toHaveLength(before);
    // Failures say so.
    routes.unshift((url) => (url.includes("/sync/settings/set") ? { status: 500, body: { type: "InternalError" } } : undefined));
    await adapter.handleAction({ type: "mute", channelId: GENERAL, mute: true });
    expect(chat().error).toMatch(/^Could not mute: /);
    await adapter.handleAction({ type: "mute", channelId: LOBBY, mute: false });
    expect(chat().error).toMatch(/^Could not unmute: /);
    await event({ type: "Pong" });
  });

  it("notifies as the user's settings say, naming where the message came from", async () => {
    const { adapter, event, online, routes } = setup({ token: "saved" });
    const notifications = vi.fn();
    adapter.onNotification(notifications);
    routes.push((url) => (url.endsWith("/sync/settings/fetch") ? { status: 200, body: { notifications: [1, JSON.stringify({ channel: { [CHAT]: "all" } })] } } : undefined));
    await online();
    await event({ type: "Message", ...message(810, DM, { content: `hey <@${ME_ID}>` }) });
    await event({ type: "Message", ...message(811, GROUP, { content: "", attachments: [{ _id: "f", tag: "attachments", filename: "x.png" }] }) });
    await event({ type: "Message", ...message(812, GENERAL, { mentions: [ME_ID], content: "  " }) });
    await event({ type: "Message", ...message(813, LOBBY) });
    await event({ type: "Message", ...message(814, CHAT, { author: BOB_ID, system: { type: "user_left", id: BOB_ID } }) });
    await event({ type: "Message", ...message(815, CHAT, { author: ME_ID }) });
    expect(notifications.mock.calls.map(([n]) => n)).toEqual([
      { title: "Ana", body: "hey @me", target: DM, railKey: `dm:${DM}`, inView: false },
      { title: "Ana in Group", body: "Sent an attachment", target: GROUP, railKey: `dm:${GROUP}`, inView: false },
      { title: "Ana in #general (Alpha)", body: "New message", target: GENERAL, railKey: ALPHA, inView: false },
      { title: "bob in #chat (Beta)", body: "@bob left", target: CHAT, railKey: BETA, inView: false },
    ]);
    adapter.setVisible(true);
    await adapter.openConversation(DM);
    await event({ type: "Message", ...message(820, DM) });
    expect(notifications.mock.calls.at(-1)![0]).toMatchObject({ target: DM, inView: true });
  });

  it("keeps previews and titles current", async () => {
    const { adapter, event, online } = setup({ token: "saved" });
    const directs = vi.fn();
    adapter.onDirectsChanged(directs);
    await online();
    await event({ type: "Message", ...message(810, DM, { content: "  line one\n\nline two  " }) });
    expect(directs.mock.calls.at(-1)![0][0]).toMatchObject({ key: DM, preview: "line one line two", unread: true, mentions: 2 });
    await event({ type: "Message", ...message(811, DM, { content: "", attachments: [{ _id: "f", tag: "attachments", filename: "x.png" }, { _id: "g", tag: "attachments", filename: "y.txt" }] }) });
    expect(directs.mock.calls.at(-1)![0][0].preview).toBe("📎 x.png, 📎 y.txt");
    await event({ type: "ChannelUpdate", id: GROUP, data: { name: "Renamed", icon: { _id: "gi", tag: "icons", filename: "g" } } });
    expect(directs.mock.calls.at(-1)![0][1]).toMatchObject({ title: "Renamed", avatarUrl: "https://cdn.test/icons/gi" });
    await event({ type: "ChannelCreate", _id: ulid(904), channel_type: "Group", name: "", owner: ME_ID, recipients: [ME_ID, ANA_ID, BOB_ID], last_message_id: ulid(990) });
    expect(directs.mock.calls.at(-1)![0][0]).toMatchObject({ key: ulid(904), title: "Ana, bob" });
    await event({ type: "ChannelCreate", _id: ulid(905), channel_type: "Group", owner: ME_ID, recipients: [ME_ID], last_message_id: ulid(991) });
    expect(directs.mock.calls.at(-1)![0][0]).toMatchObject({ key: ulid(905), title: "Group" });
    await event({ type: "ChannelCreate", _id: ulid(906), channel_type: "DirectMessage", active: true, recipients: [ME_ID, ulid(77)], last_message_id: ulid(992) });
    expect(directs.mock.calls.at(-1)![0][0]).toMatchObject({ key: ulid(906), title: "Unknown user", avatarUrl: undefined });
  });

  it("names a DM with ourselves after us, and server channels without names by id", async () => {
    const { adapter, chat, event, online } = setup({ token: "saved" });
    await online();
    await event({ type: "ChannelCreate", _id: ulid(907), channel_type: "DirectMessage", active: true, recipients: [ME_ID], last_message_id: ulid(993) });
    await adapter.openConversation(ulid(907));
    expect(chat().channel!.name).toBe("me");
    await event({ type: "ChannelCreate", _id: ulid(121), channel_type: "TextChannel", server: ALPHA });
    await event({ type: "ServerUpdate", id: ALPHA, data: { channels: [ulid(121)] } });
    await adapter.openConversation(ulid(121));
    expect(chat().channel!.name).toBe(ulid(121));
    await event({ type: "Message", ...message(994, ulid(121), { mentions: [ME_ID] }) });
  });
});

describe("StoatAdapter display state", () => {
  it("shows the chat with no open channel and no user yet", async () => {
    const { adapter, goOnline, chat } = setup({ token: "saved" });
    await adapter.start();
    await goOnline({ type: "Ready", users: [], servers: [], channels: [] });
    expect(chat()).toMatchObject({ me: "", sidebar: [], channel: null });
    await adapter.handleAction({ type: "ready" });
    expect(chat().screen).toBe("chat");
  });
});

describe("StoatAdapter pins", () => {
  const STRANGER = { _id: ulid(70), username: "zed", avatar: { _id: "av7", tag: "avatars", filename: "z.png" } };

  it("lists the open channel's pins by search while the panel is open, following pin changes", async () => {
    let found: unknown = {
      messages: [
        message(440, GENERAL, { author: ulid(70), content: `hi <@${ME_ID}>`, pinned: true }),
        message(441, GENERAL, { author: ulid(71), content: "", attachments: [{ _id: "f1", tag: "attachments", filename: "a.png" }] }),
        message(442, GENERAL, { author: ulid(72), content: "", masquerade: { name: "Bridged" } }),
        message(443, GENERAL, { content: "" }),
      ],
      users: [STRANGER],
    };
    const { adapter, chat, event, online, requests } = setup({ token: "saved", routes: [(url) => (url.endsWith(`/channels/${GENERAL}/search`) ? { status: 200, body: found } : undefined)] });
    await online();
    await adapter.openConversation(GENERAL);
    expect(chat().channel!.can.pins).toBe(true);
    const pending = adapter.handleAction({ type: "pins", open: true });
    expect(chat().channel!.pins).toEqual({ messages: [], loading: true });
    await pending;
    expect(JSON.parse(requests("/search")[0]!.init.body as string)).toEqual({ pinned: true, limit: 100, sort: "Latest", include_users: true });
    expect(chat().channel!.pins!.messages).toEqual([
      { id: ulid(440), author: "zed", avatarUrl: "https://cdn.test/avatars/av7", content: "hi @me", timestamp: expect.any(String) },
      expect.objectContaining({ author: "Unknown user", content: "📎 a.png" }),
      { id: ulid(442), author: "Bridged", content: "", timestamp: expect.any(String) },
      expect.objectContaining({ author: "Ana", content: "" }),
    ]);
    // Pinned or unpinned here: fetched again (the answer can be a plain list); edits and other channels change nothing.
    found = [message(444, GENERAL)];
    await event({ type: "MessageUpdate", id: ulid(450), channel: GENERAL, data: { content: "edited" } });
    await event({ type: "MessageUpdate", id: ulid(450), channel: LOBBY, data: { pinned: true } });
    expect(requests("/search")).toHaveLength(1);
    await event({ type: "MessageUpdate", id: ulid(450), channel: GENERAL, data: { pinned: true } });
    expect(chat().channel!.messages.at(-1)!.pinned).toBe(true);
    expect(chat().channel!.pins!.messages.map((m) => m.id)).toEqual([ulid(444)]);
    await event({ type: "MessageUpdate", id: ulid(450), channel: GENERAL, data: {}, clear: ["Pinned"] });
    expect(requests("/search")).toHaveLength(3);
    expect(chat().channel!.messages.at(-1)!.pinned).toBeUndefined();
    await event({ type: "MessageUpdate", id: ulid(450), channel: GENERAL, data: {}, clear: "Pinned" });
    expect(requests("/search")).toHaveLength(3);
    // Closed, or another channel: no list.
    await adapter.handleAction({ type: "pins", open: false });
    expect(chat().channel!.pins).toBeUndefined();
    await event({ type: "MessageUpdate", id: ulid(450), channel: GENERAL, data: { pinned: true } });
    await adapter.handleAction({ type: "pins", open: true });
    await adapter.openConversation(GENERAL);
    expect(chat().channel!.pins).toBeDefined();
    await adapter.openConversation(LOBBY);
    expect(chat().channel!.pins).toBeUndefined();
  });

  it("says when the pins cannot be loaded, and drops answers for a closed panel", async () => {
    let fail = true;
    const { adapter, chat, online, routes } = setup({ token: "saved", routes: [(url) => (url.endsWith("/search") && fail ? { status: 403, body: { type: "MissingPermission" } } : undefined)] });
    await online();
    await adapter.openConversation(GENERAL);
    await adapter.handleAction({ type: "pins", open: true });
    expect(chat().channel!.pins).toEqual({ messages: [], loading: false, error: "Could not load pinned messages: You do not have permission to do that." });
    fail = false;
    routes.unshift((url) => (url.endsWith("/search") ? { status: 200, body: { messages: [] } } : undefined));
    const reopening = adapter.handleAction({ type: "pins", open: true });
    await adapter.handleAction({ type: "pins", open: false });
    await reopening;
    expect(chat().channel!.pins).toBeUndefined();
  });

  it("pins and unpins, and shows a refusal", async () => {
    let refuse = false;
    const { adapter, chat, online, requests, calls } = setup({
      token: "saved",
      routes: [(url) => (url.endsWith("/pin") ? (refuse ? { status: 403, body: { type: "MissingPermission" } } : { status: 204 }) : undefined)],
    });
    await online();
    await adapter.openConversation(GENERAL);
    expect(chat().channel!.messages[0]).toMatchObject({ canPin: true });
    await adapter.handleAction({ type: "pin", messageId: ulid(450), pin: true });
    expect(requests("/pin")[0]).toMatchObject({ url: `https://stoat.test/api/channels/${GENERAL}/messages/${ulid(450)}/pin`, init: { method: "POST" } });
    expect(chat().channel!.messages[0]!.pinned).toBe(true);
    await adapter.handleAction({ type: "pin", messageId: ulid(450), pin: false });
    expect(requests("/pin")[1]!.init.method).toBe("DELETE");
    await adapter.handleAction({ type: "pin", messageId: ulid(451), pin: true });
    refuse = true;
    await adapter.handleAction({ type: "pin", messageId: ulid(450), pin: true });
    expect(chat().error).toBe("Message not pinned: You do not have permission to do that.");
    await adapter.handleAction({ type: "pin", messageId: ulid(450), pin: false });
    expect(chat().error).toBe("Message not unpinned: You do not have permission to do that.");
    await adapter.openHome();
    const before = calls.length;
    await adapter.handleAction({ type: "pin", messageId: ulid(450), pin: true });
    await adapter.handleAction({ type: "pins", open: true });
    expect(calls.length).toBe(before);
  });
});

describe("StoatAdapter search", () => {
  it("searches the open channel on the instance, newest first", async () => {
    let answer: unknown = { messages: [message(440, GENERAL, { content: "found it" })], users: [ANA] };
    const { adapter, chat, online, requests } = setup({ token: "saved", routes: [(url) => (url.endsWith("/search") ? { status: 200, body: answer } : undefined)] });
    await online();
    await adapter.openConversation(GENERAL);
    expect(chat().channel!.can.search).toBe(true);
    const pending = adapter.handleAction({ type: "search", query: " found " });
    expect(chat().channel!.search).toEqual({ query: "found", messages: [], loading: true });
    await pending;
    expect(JSON.parse(requests("/search")[0]!.init.body as string)).toEqual({ query: "found", limit: 100, sort: "Latest", include_users: true });
    expect(chat().channel!.search).toEqual({ query: "found", messages: [expect.objectContaining({ id: ulid(440), author: "Ana", content: "found it" })], loading: false });
    // Too long for Stoat: the start of it is searched, and the results say so.
    answer = [];
    const long = "w".repeat(70);
    await adapter.handleAction({ type: "search", query: long });
    expect(JSON.parse(requests("/search")[1]!.init.body as string).query).toBe("w".repeat(64));
    expect(chat().channel!.search).toEqual({ query: long, messages: [], loading: false, note: "Stoat searches for the first 64 characters only." });
    await adapter.handleAction({ type: "search", query: "" });
    expect(chat().channel!.search).toBeUndefined();
    await adapter.handleAction({ type: "search", query: "x" });
    await adapter.openConversation(GENERAL);
    expect(chat().channel!.search).toBeDefined();
    await adapter.openConversation(LOBBY);
    expect(chat().channel!.search).toBeUndefined();
  });

  it("shows failures, and drops answers to earlier searches", async () => {
    let fail = true;
    const { adapter, chat, online, calls } = setup({ token: "saved", routes: [(url) => (url.endsWith("/search") ? (fail ? { status: 403, body: { type: "MissingPermission" } } : { status: 200, body: [] }) : undefined)] });
    await online();
    await adapter.openConversation(GENERAL);
    await adapter.handleAction({ type: "search", query: "a" });
    expect(chat().channel!.search).toEqual({ query: "a", messages: [], loading: false, error: "Search failed: You do not have permission to do that." });
    fail = false;
    const first = adapter.handleAction({ type: "search", query: "first" });
    const second = adapter.handleAction({ type: "search", query: "second" });
    await first;
    expect(chat().channel!.search).toMatchObject({ query: "second", loading: true });
    await second;
    expect(chat().channel!.search).toMatchObject({ query: "second", loading: false });
    const ending = adapter.handleAction({ type: "search", query: "third" });
    await adapter.handleAction({ type: "search", query: "" });
    await ending;
    expect(chat().channel!.search).toBeUndefined();
    await adapter.openHome();
    const before = calls.length;
    await adapter.handleAction({ type: "search", query: "nowhere" });
    expect(calls.length).toBe(before);
  });
});

describe("StoatAdapter forwarding", () => {
  it("sends a copy saying who wrote it, quoting the text with links to the files, pinging nobody", async () => {
    const history = message(460, GENERAL, {
      content: `hi <@${ME_ID}> and <@${ulid(77)}>, @everyone\nsecond line`,
      attachments: [{ _id: "f1", tag: "attachments", filename: "cat.png", content_type: "image/png", metadata: { type: "Image" } }],
    });
    const { adapter, chat, online, requests, routes } = setup({ token: "saved", routes: [(url) => (url.includes(`/channels/${GENERAL}/messages?`) ? { status: 200, body: { messages: [history, message(461, GENERAL, { content: "" })], users: [ANA] } } : undefined)] });
    await online();
    await adapter.openConversation(GENERAL);
    expect(chat().channel!.can.forward).toBe(true);
    await adapter.handleAction({ type: "forward", messageId: ulid(460), channelId: DM });
    const post = requests(`/channels/${DM}/messages`).at(-1)!;
    const zw = String.fromCharCode(0x200b);
    expect(JSON.parse(post.init.body as string).content).toBe(`Forwarded from Ana:\n> hi @me and @someone, @${zw}everyone\n> second line\nhttps://cdn.test/attachments/f1`);
    await adapter.handleAction({ type: "forward", messageId: ulid(461), channelId: DM });
    expect(JSON.parse(requests(`/channels/${DM}/messages`).at(-1)!.init.body as string).content).toBe("Forwarded from Ana:");
    // Unknown messages or targets send nothing.
    const sent = requests("/messages").filter((c) => c.init.method === "POST").length;
    await adapter.handleAction({ type: "forward", messageId: ulid(999), channelId: DM });
    await adapter.handleAction({ type: "forward", messageId: ulid(460), channelId: ulid(998) });
    await adapter.handleAction({ type: "forward", messageId: ulid(460), channelId: ulid(112) });
    expect(requests("/messages").filter((c) => c.init.method === "POST").length).toBe(sent);
    routes.unshift((url, init) => (init.method === "POST" && url.endsWith("/messages") ? { status: 403, body: { type: "MissingPermission" } } : undefined));
    await adapter.handleAction({ type: "forward", messageId: ulid(460), channelId: DM });
    expect(chat().error).toBe("Message not forwarded: You do not have permission to do that.");
  });
});

describe("StoatAdapter role mentions", () => {
  it("names mentioned roles, highlights mentions of the user's own, and forwards them without pinging", async () => {
    const ROLE = ulid(60);
    const servers = readyPayload().servers.map((s) => (s._id === ALPHA ? { ...s, roles: { [ROLE]: { name: "Mods" } } } : s));
    const history = message(460, GENERAL, { content: `hi <%${ROLE}> and <%${ulid(61)}>`, role_mentions: [ROLE] });
    const { adapter, chat, goOnline, requests, routes } = setup({ token: "saved" });
    routes.push((url) => (url.includes(`/channels/${GENERAL}/messages?`) ? { status: 200, body: { messages: [history], users: [ANA] } } : undefined));
    await adapter.start();
    await goOnline(readyPayload({ servers, members: [{ _id: { server: ALPHA, user: ME_ID }, roles: [ROLE] }] }));
    await adapter.openConversation(GENERAL);
    expect(chat().channel!.messages[0]).toMatchObject({ content: `hi @Mods and <%${ulid(61)}>`, mentionsMe: true });
    await adapter.handleAction({ type: "forward", messageId: ulid(460), channelId: DM });
    expect(JSON.parse(requests(`/channels/${DM}/messages`).at(-1)!.init.body as string).content).toBe("Forwarded from Ana:\n> hi @Mods and @a role");
  });
});

describe("StoatAdapter voice", () => {
  const LIVEKIT = { ...CONFIG, features: { ...CONFIG.features, livekit: { enabled: true, nodes: [{ name: "hel1", public_url: "wss://lk.test" }] } } };
  const withVoice = () => readyPayload({ channels: readyPayload().channels.map((c) => (c._id === LOBBY ? { ...c, voice: { max_users: 10 } } : c)) });
  async function online(config: unknown = LIVEKIT, grant: () => Reply = () => ({ status: 200, body: { token: "lk", url: "wss://lk.test" } })) {
    const ctx = setup({
      token: "saved",
      routes: [(url) => (url === "https://stoat.test/api/" ? { status: 200, body: config } : undefined), (url) => (url.endsWith("/join_call") ? grant() : undefined)],
    });
    await ctx.adapter.start();
    await ctx.goOnline(withVoice());
    return ctx;
  }

  it("offers a call in channels that are also voice channels, and joins it through the instance's voice server", async () => {
    const { adapter, chat, requests } = await online();
    await adapter.openConversation(GENERAL);
    expect(chat().channel!.can.call).toBe(false);
    await adapter.openConversation(LOBBY);
    expect(chat().channel!.can.call).toBe(true);
    await adapter.handleAction({ type: "joinVoice", channelId: LOBBY });
    expect(JSON.parse(requests("/join_call")[0]!.init.body as string)).toEqual({ node: "hel1" });
    expect(chat().voice).toEqual({ channelId: LOBBY, channelName: "lobby", guildName: "Alpha", url: "wss://lk.test", token: "lk", mute: false, deaf: false, video: false, stream: false });
    // Already there: nothing more is asked.
    await adapter.handleAction({ type: "joinVoice", channelId: LOBBY });
    expect(requests("/join_call")).toHaveLength(1);
    await adapter.handleAction({ type: "voiceState", mute: true, deaf: false, video: true, stream: false });
    expect(chat().voice).toMatchObject({ mute: true, video: true });
    await adapter.handleAction({ type: "voiceNotice", message: "The camera could not start", off: "video" });
    expect(chat()).toMatchObject({ voice: { video: false }, error: "The camera could not start" });
    await adapter.handleAction({ type: "voiceNotice", message: "Speakers gone" });
    expect(chat()).toMatchObject({ voice: { channelId: LOBBY }, error: "Speakers gone" });
    await adapter.handleAction({ type: "voiceError", message: "ICE failed" });
    expect(chat()).toMatchObject({ voice: null, error: "Voice failed: ICE failed" });
    await adapter.handleAction({ type: "voiceNotice", message: "late" });
    await adapter.handleAction({ type: "voiceState", mute: true, deaf: true, video: false, stream: false });
    expect(chat().error).toBe("Voice failed: ICE failed");
    // Joined again, then left.
    await adapter.handleAction({ type: "joinVoice", channelId: LOBBY });
    await adapter.handleAction({ type: "leaveVoice" });
    expect(chat().voice).toBeNull();
    // Channels that are not voice channels, unknown ones: nothing.
    await adapter.handleAction({ type: "joinVoice", channelId: GENERAL });
    await adapter.handleAction({ type: "joinVoice", channelId: ulid(999) });
    expect(requests("/join_call")).toHaveLength(2);
    // Signing out leaves the call.
    await adapter.handleAction({ type: "joinVoice", channelId: LOBBY });
    await adapter.handleAction({ type: "logout" });
    await adapter.start();
    expect(adapter.viewState()).toMatchObject({ screen: "login" });
  });

  it("refuses grants for servers the instance does not name, and says when Stoat refuses", async () => {
    let answer: Reply = { status: 200, body: { token: "lk", url: "wss://elsewhere.test" } };
    const { adapter, chat } = await online(LIVEKIT, () => answer);
    await adapter.handleAction({ type: "joinVoice", channelId: LOBBY });
    expect(chat()).toMatchObject({ voice: null, error: "Could not join voice: the voice server is not one this instance names" });
    answer = { status: 403, body: { type: "MissingPermission" } };
    await adapter.handleAction({ type: "joinVoice", channelId: LOBBY });
    expect(chat()).toMatchObject({ voice: null, error: "Could not join voice: You do not have permission to do that." });
  });

  it("drops a grant for a join given up meanwhile", async () => {
    let leave: (() => Promise<void>) | undefined;
    const { adapter, chat } = await online(LIVEKIT, () => {
      void leave?.();
      return { status: 200, body: { token: "lk", url: "wss://lk.test" } };
    });
    leave = () => adapter.handleAction({ type: "leaveVoice" });
    await adapter.handleAction({ type: "joinVoice", channelId: LOBBY });
    expect(chat().voice).toBeNull();
    // A failure for a join given up is not shown either.
    const failing = await online(LIVEKIT, () => {
      void failing.adapter.handleAction({ type: "leaveVoice" });
      return { status: 500 };
    });
    await failing.adapter.handleAction({ type: "joinVoice", channelId: LOBBY });
    expect(failing.chat()).toMatchObject({ voice: null, error: undefined });
  });

  const person = (id: string, joined: string, extra: Record<string, unknown> = {}) => ({ id, joined_at: joined, is_receiving: true, is_publishing: true, screensharing: false, camera: false, ...extra });

  it("calls in DMs and groups, ringing the others only when starting the call", async () => {
    const { adapter, chat, requests, event } = await online();
    await adapter.openConversation(DM);
    expect(chat().channel!.can.call).toBe(true);
    await adapter.handleAction({ type: "joinVoice", channelId: DM });
    expect(JSON.parse(requests("/join_call")[0]!.init.body as string)).toEqual({ node: "hel1", recipients: [ANA_ID] });
    expect(chat().voice).toMatchObject({ channelId: DM, channelName: "Ana", guildName: "Call", token: "lk" });
    await adapter.handleAction({ type: "leaveVoice" });
    // Someone is in the group's call already: joining it rings nobody.
    await event({ type: "VoiceChannelJoin", id: GROUP, state: person(ANA_ID, "2026-10-14T11:00:00Z") });
    await adapter.handleAction({ type: "joinVoice", channelId: GROUP });
    expect(JSON.parse(requests("/join_call")[1]!.init.body as string)).toEqual({ node: "hel1" });
    expect(chat().voice).toMatchObject({ channelId: GROUP, guildName: "Call" });
    // Saved Notes has no call.
    await adapter.handleAction({ type: "joinVoice", channelId: ulid(903) });
    expect(requests("/join_call")).toHaveLength(2);
  });

  it("lists who is in each call under its conversation, from Ready and the voice events", async () => {
    const { adapter, chat, event } = await online();
    await event({ type: "VoiceChannelJoin", id: DM, state: person(ANA_ID, "2026-10-14T11:00:00Z", { is_publishing: false }) });
    expect(chat().sidebar.find((i) => i.id === DM)!.members).toEqual([{ name: "Ana", avatarUrl: expect.stringContaining("av1"), muted: true, video: false }]);
    await adapter.openConversation(LOBBY);
    await event({ type: "VoiceChannelJoin", id: LOBBY, state: person(BOB_ID, "2026-10-14T11:00:00Z", { screensharing: true }) });
    expect(chat().sidebar.find((i) => i.id === LOBBY)!.members).toEqual([{ name: "bob", muted: false, video: true }]);
    expect(chat().sidebar.find((i) => i.id === GENERAL)!.members).toBeUndefined();
    await event({ type: "VoiceChannelLeave", id: LOBBY, user: BOB_ID });
    expect(chat().sidebar.find((i) => i.id === LOBBY)!.members).toBeUndefined();
  });

  it("rings for a DM or group call started by someone else until it is joined, declined or over", async () => {
    const { adapter, chat, event } = await online();
    const incoming = vi.fn();
    adapter.onIncomingCall(incoming);
    const ring = (channel: string, initiator = ANA_ID) => event({ type: "VoiceCallUpdate", initiator_id: initiator, channel_id: channel, started_at: "2026-10-14T12:00:00Z", ended: false });
    const end = (channel: string) => event({ type: "VoiceCallUpdate", initiator_id: ANA_ID, channel_id: channel, started_at: null, ended: true });
    await ring(DM);
    expect(chat().incomingCall).toEqual({ channelId: DM, from: "Ana" });
    expect(incoming).toHaveBeenCalledExactlyOnceWith({ conversationKey: DM, from: "Ana", video: false });
    // The same call again does not ring the shell again.
    await ring(DM);
    expect(incoming).toHaveBeenCalledTimes(1);
    // Declined: here only, as Stoat has no way to decline.
    await adapter.handleAction({ type: "declineCall", channelId: DM });
    expect(chat().incomingCall).toBeUndefined();
    await adapter.handleAction({ type: "declineCall", channelId: GROUP });
    await end(DM);
    // A new call there rings again; joining it stops the ringing.
    await ring(DM);
    expect(incoming).toHaveBeenCalledTimes(2);
    await adapter.handleAction({ type: "joinVoice", channelId: DM });
    expect(chat().incomingCall).toBeUndefined();
    await end(DM);
    // Calls the user started, and calls in channels not known, do not ring.
    await ring(GROUP, ME_ID);
    await ring(ulid(999));
    expect(chat().incomingCall).toBeUndefined();
    expect(incoming).toHaveBeenCalledTimes(2);
  });

  it("says when the instance runs no voice", async () => {
    const { adapter, chat } = await online(CONFIG);
    await adapter.openConversation(LOBBY);
    expect(chat().channel!.can.call).toBe(false);
    await adapter.handleAction({ type: "joinVoice", channelId: LOBBY });
    expect(chat()).toMatchObject({ voice: null, error: "This Stoat instance runs no voice." });
  });
});

describe("StoatAdapter Saved Notes", () => {
  const NOTES = ulid(903);
  const withoutNotes = () => readyPayload({ channels: readyPayload().channels.filter((c) => c.channel_type !== "SavedMessages") });

  it("lists the user's notes first in the home sidebar, as a conversation with nobody else in it", async () => {
    const { adapter, chat, online } = setup({ token: "saved" });
    await online();
    await adapter.openHome();
    expect(chat().sidebar[0]).toEqual({ id: NOTES, name: "Saved Notes", kind: "dm", iconUrl: undefined, unread: false, mentions: 0, active: false, muted: false, canMute: false });
    await adapter.handleAction({ type: "select", channelId: NOTES });
    expect(chat().channel).toMatchObject({ id: NOTES, name: "Saved Notes" });
    expect(chat().channel!.can).toMatchObject({ typing: false, members: false, reply: true, forward: true });
    // Not a DM bubble.
    expect((await adapter.listDirectConversations()).map((d) => d.key)).not.toContain(NOTES);
  });

  it("asks Stoat for the channel when it does not exist yet, on opening it or forwarding into it", async () => {
    const opened = { _id: ulid(904), channel_type: "SavedMessages", user: ME_ID };
    const { adapter, chat, goOnline, requests, routes } = setup({ token: "saved" });
    routes.push(
      (url) => (url.endsWith(`/users/${ME_ID}/dm`) ? { status: 200, body: opened } : undefined),
      (url) => (url.includes(`/channels/${GENERAL}/messages?`) ? { status: 200, body: { messages: [message(460, GENERAL)], users: [ANA] } } : undefined),
    );
    await adapter.start();
    await goOnline({ ...withoutNotes(), users: [{ ...readyPayload().users[0], avatar: { _id: "me1", tag: "avatars", filename: "m.png" } }, ...readyPayload().users.slice(1)] });
    await adapter.openHome();
    expect(chat().sidebar[0]).toEqual({ id: ME_ID, name: "Saved Notes", kind: "dm", iconUrl: "https://cdn.test/avatars/me1", unread: false, mentions: 0, active: false, canMute: false });
    // Forwarding into it makes it.
    await adapter.openConversation(GENERAL);
    await adapter.handleAction({ type: "forward", messageId: ulid(460), channelId: ME_ID });
    expect(requests(`/users/${ME_ID}/dm`)).toHaveLength(1);
    expect(requests(`/channels/${ulid(904)}/messages`).filter((c) => c.init.method === "POST")).toHaveLength(1);
    // Now known: opening it asks nothing more.
    await adapter.handleAction({ type: "select", channelId: ME_ID });
    await adapter.handleAction({ type: "select", channelId: ulid(904) });
    expect(chat().channel).toMatchObject({ id: ulid(904), name: "Saved Notes" });
    expect(requests(`/users/${ME_ID}/dm`)).toHaveLength(1);
  });

  it("opens it once made, and says when Stoat could not make it", async () => {
    const answers: Reply[] = [{ status: 500 }, { status: 200, body: { _id: ulid(905), channel_type: "DirectMessage", recipients: [ME_ID] } }, { status: 200, body: { _id: ulid(904), channel_type: "SavedMessages", user: ME_ID } }];
    const { adapter, chat, goOnline, routes } = setup({ token: "saved" });
    routes.push((url) => (url.endsWith(`/users/${ME_ID}/dm`) ? answers.shift() : undefined));
    await adapter.start();
    await goOnline(withoutNotes());
    await adapter.handleAction({ type: "select", channelId: ME_ID });
    expect(chat().error).toBe("Could not open Saved Notes: Request failed (HTTP_500)");
    // Not a notes channel: nothing opens.
    await adapter.handleAction({ type: "select", channelId: ME_ID });
    expect(chat().channel).toBeNull();
    await adapter.handleAction({ type: "select", channelId: ME_ID });
    expect(chat().channel).toMatchObject({ id: ulid(904), name: "Saved Notes" });
  });
});

describe("StoatAdapter members and profiles", () => {
  const MODS = ulid(60);
  const FANCY = ulid(61);
  const BLUE = ulid(62);
  const ZED = { _id: ulid(70), username: "zed", online: true, status: { presence: "Busy", text: "working" }, bot: { owner: ME_ID } };
  const roles = { [MODS]: { name: "Mods", colour: "#FF0000", hoist: true, rank: 1 }, [FANCY]: { name: "Fancy", colour: "linear-gradient(red, blue)", hoist: true, rank: 0 }, [BLUE]: { name: "Blue", colour: "#0000ff", rank: 2 } };
  const member = (user: string, extra: Record<string, unknown> = {}) => ({ _id: { server: ALPHA, user }, ...extra });
  const list = {
    members: [member(ME_ID), member(ANA_ID, { nickname: "Annie", roles: [BLUE, MODS] }), member(BOB_ID, { roles: [MODS] }), member(ulid(70)), member(ulid(71)), { _id: "junk" }],
    users: [ANA, ZED],
  };
  const ready = () => {
    const payload = readyPayload();
    (payload.servers[0] as Record<string, unknown>).roles = roles;
    return payload;
  };
  async function opened(routes: Handler[]) {
    const ctx = setup({ token: "saved", routes });
    await ctx.adapter.start();
    await ctx.goOnline(ready());
    await ctx.adapter.openConversation(GENERAL);
    return ctx;
  }

  it("fetches a server's members once the panel opens, grouped and kept current", async () => {
    let refuse = true;
    const ctx = await opened([(url) => (url === `https://stoat.test/api/servers/${ALPHA}/members?exclude_offline=false` ? (refuse ? { status: 403, body: { type: "MissingPermission" } } : { status: 200, body: list }) : undefined)]);
    const { adapter, chat, event, requests } = ctx;
    expect(chat().channel!.can.members).toBe(true);
    expect(chat().channel!.members).toBeUndefined();
    const pending = adapter.handleAction({ type: "members", open: true });
    expect(chat().channel!.members).toEqual({ sections: [], hasMore: false, loading: true });
    await pending;
    expect(chat().channel!.members).toEqual({ sections: [], hasMore: false, loading: false, error: expect.stringMatching(/^Could not load members: /) });
    refuse = false;
    await adapter.handleAction({ type: "members", open: true });
    const shown = chat().channel!.members!;
    expect(shown.sections.map((s) => [s.name, s.members.map((m) => m.name)])).toEqual([["Mods — 1", ["Annie"]], ["Online — 2", ["me", "zed"]], ["Offline — 1", ["bob"]]]);
    expect(shown.sections[0]!.members[0]).toEqual({ id: ANA_ID, name: "Annie", avatarUrl: "https://cdn.test/avatars/av1", presence: "online", color: "#ff0000", mention: `<@${ANA_ID}>` });
    expect(shown.sections[1]!.members[1]).toEqual({ id: ulid(70), name: "zed", presence: "dnd", status: "working", mention: `<@${ulid(70)}>` });
    expect(shown).toMatchObject({ hasMore: false, loading: false });
    expect(shown.more).toBeUndefined();

    // Another channel of the server needs no new fetch; member, role and user events keep the list current.
    await adapter.openConversation(LOBBY);
    expect(requests("/members?")).toHaveLength(2);
    await event({ type: "ServerMemberUpdate", id: { server: ALPHA, user: ANA_ID }, data: { avatar: { _id: "av9", tag: "avatars", filename: "b.png" } }, clear: ["Nickname"] });
    await event({ type: "ServerRoleUpdate", id: ALPHA, role_id: MODS, data: { name: "Moderators" }, clear: ["Colour"] });
    await event({ type: "UserUpdate", id: ulid(70), data: { status: { presence: "Idle" } }, clear: ["StatusText"] });
    await event({ type: "ServerMemberLeave", id: ALPHA, user: BOB_ID });
    await event({ type: "ServerMemberJoin", id: ALPHA, user: BOB_ID, member: member(BOB_ID, { nickname: "Robert", roles: [MODS] }) });
    await event({ type: "UserUpdate", id: BOB_ID, data: { online: true, status: { presence: "Invisible" } } });
    const updated = chat().channel!.members!;
    expect(updated.sections.map((s) => [s.name, s.members.map((m) => m.name)])).toEqual([["Moderators — 1", ["Ana"]], ["Online — 2", ["me", "zed"]], ["Offline — 1", ["Robert"]]]);
    expect(updated.sections[0]!.members[0]).toMatchObject({ avatarUrl: "https://cdn.test/avatars/av9", color: "#0000ff" });
    expect(updated.sections[1]!.members[1]).toMatchObject({ presence: "idle", status: "Bot" });

    // A profile of a listed member needs no member fetch.
    await adapter.handleAction({ type: "profile", id: BOB_ID });
    expect(chat().profile).toEqual({ id: BOB_ID, name: "Robert", username: "bob#0003", presence: "offline", roles: [{ name: "Moderators" }] });
    expect(requests(`/members/${BOB_ID}`)).toHaveLength(0);

    // A new session fetches again; closing hides the list.
    await ctx.goOnline(ready());
    expect(requests("/members?")).toHaveLength(3);
    await adapter.handleAction({ type: "members", open: false });
    expect(chat().channel!.members).toBeUndefined();
    await adapter.handleAction({ type: "logout" });
    expect(adapter.state.members.size).toBe(0);
  });

  it("shows at most 200 members of a big server and counts the rest", async () => {
    const users = Array.from({ length: 205 }, (_, i) => ({ _id: ulid(1000 + i), username: `u${String(i).padStart(3, "0")}`, online: true }));
    const ctx = await opened([(url) => (url.includes("/members?") ? { status: 200, body: { members: users.map((u) => member(u._id)), users } } : undefined)]);
    await ctx.adapter.handleAction({ type: "members", open: true });
    const shown = ctx.chat().channel!.members!;
    expect(shown.sections.map((s) => [s.name, s.members.length])).toEqual([["Online — 205", 200]]);
    expect(shown).toMatchObject({ more: 5, hasMore: false });
  });

  it("lists a DM's and a group's people, fetching only users it does not know", async () => {
    const STRANGER = ulid(80);
    let release: () => void = () => {};
    const ctx = await opened([(url) => (url === `https://stoat.test/api/channels/${GROUP}/members` ? (release(), { status: 200, body: [{ _id: STRANGER, username: "newbie" }, "junk"] }) : undefined)]);
    const { adapter, chat, event, requests } = ctx;
    await adapter.handleAction({ type: "members", open: true });
    await adapter.openConversation(DM);
    expect(chat().channel!.members).toEqual({
      sections: [{ name: "Members", members: [expect.objectContaining({ id: ANA_ID, name: "Ana", presence: "online" }), expect.objectContaining({ id: ME_ID, name: "me", presence: "online" })] }],
      hasMore: false,
      loading: false,
    });
    await adapter.openConversation(GROUP);
    expect(chat().channel!.members!.sections[0]!.members.map((m) => m.name)).toEqual(["Ana", "me", "bob"]);
    expect(requests(`/channels/${GROUP}/members`)).toHaveLength(0);
    await event({ type: "ChannelGroupJoin", id: GROUP, user: STRANGER });
    // A new session meanwhile drops the answer.
    release = () => {
      release = () => {};
      ctx.socket().receive(ready());
    };
    await adapter.handleAction({ type: "members", open: true });
    expect(adapter.state.users.has(STRANGER)).toBe(false);

    const again = setup({ token: "saved", routes: [(url) => (url === `https://stoat.test/api/channels/${GROUP}/members` ? { status: 200, body: [{ _id: STRANGER, username: "newbie" }] } : undefined)] });
    await again.adapter.start();
    await again.goOnline(ready());
    // Opened before any conversation: nothing to fetch until one opens.
    await again.adapter.handleAction({ type: "members", open: true });
    await again.event({ type: "ChannelGroupJoin", id: GROUP, user: STRANGER });
    await again.adapter.openConversation(GROUP);
    await vi.advanceTimersByTimeAsync(0);
    expect(again.chat().channel!.members!.sections[0]!.members.map((m) => m.name)).toEqual(["Ana", "me", "bob", "newbie"]);
  });

  it("answers profile cards with the user, their roles in the open server and their about text", async () => {
    let release: () => void = () => {};
    const ctx = await opened([
      (url) => (url === `https://stoat.test/api/servers/${ALPHA}/members/${ANA_ID}` ? { status: 200, body: member(ANA_ID, { nickname: "Annie", roles: [BLUE, MODS] }) } : undefined),
      (url) => (url === `https://stoat.test/api/users/${ANA_ID}/profile` ? { status: 200, body: { content: "About me" } } : undefined),
      (url) => (url === `https://stoat.test/api/users/${ulid(70)}` ? (release(), { status: 200, body: ZED }) : undefined),
      (url) => (url === `https://stoat.test/api/users/${ulid(70)}/profile` ? { status: 200, body: { content: " " } } : undefined),
      (url) => (url === `https://stoat.test/api/users/${ulid(71)}` ? { status: 404, body: { type: "NotFound" } } : undefined),
    ]);
    const { adapter, chat } = ctx;
    await adapter.handleAction({ type: "profile", id: "nope" });
    expect(chat().profile).toBeUndefined();
    const pending = adapter.handleAction({ type: "profile", id: ANA_ID });
    expect(chat().profile).toEqual({ id: ANA_ID, loading: true, name: "Ana", username: "ana#0002", avatarUrl: "https://cdn.test/avatars/av1", presence: "online" });
    await pending;
    expect(chat().profile).toEqual({
      id: ANA_ID,
      name: "Annie",
      username: "ana#0002",
      avatarUrl: "https://cdn.test/avatars/av1",
      presence: "online",
      about: "About me",
      roles: [{ name: "Mods", color: "#ff0000" }, { name: "Blue", color: "#0000ff" }],
    });

    // Someone not known yet, in a DM: no roles; a card replaced meanwhile is dropped.
    await adapter.openConversation(DM);
    release = () => {
      release = () => {};
      void adapter.handleAction({ type: "profile", id: ulid(71) });
    };
    await adapter.handleAction({ type: "profile", id: ulid(70) });
    await vi.advanceTimersByTimeAsync(0);
    expect(chat().profile).toEqual({ id: ulid(71) });
    await adapter.handleAction({ type: "profile", id: ulid(70) });
    expect(chat().profile).toEqual({ id: ulid(70), name: "zed", username: "@zed", presence: "dnd", status: "working" });
    // Someone Stoat says nothing about.
    await adapter.handleAction({ type: "profile", id: ulid(72) });
    expect(chat().profile).toEqual({ id: ulid(72) });
    await adapter.handleAction({ type: "logout" });
    expect(adapter.state.users.size).toBe(0);
  });
});
