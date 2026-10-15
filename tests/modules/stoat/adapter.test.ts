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

function setup(options: { token?: string; routes?: Handler[]; files?: StoatAdapterDeps["files"] } = {}) {
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
    expect(adapter.capabilities).toEqual({ directMessages: true, messagePreviews: true, voice: false, screenShare: false });
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
    expect(chat().sidebar).toEqual([{ id: CHAT, name: "chat", kind: "text", iconUrl: undefined, unread: true, mentions: 1, active: true }]);

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
      { id: LOBBY, name: "lobby", kind: "text", iconUrl: undefined, unread: false, mentions: 0, active: true },
      { id: "cat1", name: "Text", kind: "category", unread: false, mentions: 0, active: false },
      { id: GENERAL, name: "general", kind: "text", iconUrl: undefined, unread: true, mentions: 2, active: false },
      { id: RULES, name: "rules", kind: "text", iconUrl: undefined, unread: false, mentions: 0, active: false },
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
    expect(second!.reply).toEqual({ author: "Ana", content: ":party:" });
    expect(chat().emojiUrls).toEqual({});
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
    const [system, unknown, bridged, mine, rich] = chat().channel!.messages;
    expect(system).toMatchObject({ author: "System", content: "@Ana joined", canEdit: false, canDelete: false, mine: false });
    // Known emoji are drawn from the file server; the Messages list keeps their names.
    expect(chat().emojiUrls).toEqual({ [EMOJI]: `https://cdn.test/emojis/${EMOJI}` });
    expect(unknown).toMatchObject({ author: "Unknown user", avatarUrl: undefined });
    expect(bridged).toMatchObject({ author: "Bridged", avatarUrl: undefined, reply: undefined });
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
      mentionsMe: true,
      authorId: ANA_ID,
      authorMention: `<@${ANA_ID}>`,
      reply: { author: "System", content: "@Ana joined" },
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
    expect(chat().channel!.can).toEqual({ reply: true, react: true, attach: false, typing: true, members: false });
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
