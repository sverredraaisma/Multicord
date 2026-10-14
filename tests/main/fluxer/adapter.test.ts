import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FluxerAdapter } from "../../../src/main/adapters/fluxerAdapter";
import type { GatewaySocket } from "../../../src/main/fluxer/gateway";
import { FLUXER } from "../../../src/main/platforms";
import type { NativeViewState } from "../../../src/shared/native";
import { ANA, ME, readyPayload } from "./fixtures";

const DISCOVERY = {
  endpoints: { api_public: "https://api.fx", gateway: "wss://gw.fx", media: "https://media.fx" },
  features: { account_identity: "email" },
};

type Handler = (url: string, init: RequestInit) => { status: number; body?: unknown } | undefined;

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

function message(id: string, channelId: string, extra: Record<string, unknown> = {}) {
  return { id, channel_id: channelId, author: ANA, content: `m${id}`, timestamp: "2026-10-14T12:00:00Z", ...extra };
}

function setup(options: { token?: string; routes?: Handler[] } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const routes: Handler[] = [...(options.routes ?? [])];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    let reply: { status: number; body?: unknown } | undefined;
    for (const route of routes) if ((reply = route(url, init))) break;
    reply ??= url.endsWith("/.well-known/fluxer")
      ? { status: 200, body: DISCOVERY }
      : url.includes("/messages?")
        ? { status: 200, body: [message("450", url.split("/channels/")[1]!.split("/")[0]!)] }
        : url.endsWith("/messages")
          ? { status: 200, body: message("990", url.split("/channels/")[1]!.split("/")[0]!, { author: ME }) }
          : { status: 204 };
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.body } as Response;
  });
  const sockets: FakeSocket[] = [];
  const secrets = new Map<string, string>(options.token ? [["fluxer:fluxer.app:token", options.token]] : []);
  const renders: NativeViewState[] = [];
  const adapter = new FluxerAdapter({
    def: FLUXER,
    fetch: fetch as unknown as typeof globalThis.fetch,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    secrets: {
      load: (k) => secrets.get(k),
      save: (k, v) => void secrets.set(k, v),
      delete: (k) => void secrets.delete(k),
    },
    render: (state) => renders.push(state),
    rest: { sleep: async () => {}, solveCaptcha: async () => ({ counter: 1, derivedKey: "00", time: 1 }) },
    platform: "win32",
  });
  const last = () => renders.at(-1)!;
  const chat = () => {
    const state = last();
    if (state.screen !== "chat") throw new Error(`expected chat, got ${state.screen}`);
    return state;
  };
  /** Completes the gateway handshake with the READY fixture. */
  const goOnline = async () => {
    const socket = sockets.at(-1)!;
    socket.receive({ op: 10, d: { heartbeat_interval: 40_000 } });
    socket.receive({ op: 0, s: 1, t: "READY", d: readyPayload() });
    await vi.advanceTimersByTimeAsync(100);
  };
  return { adapter, calls, routes, sockets, secrets, renders, last, chat, goOnline };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FluxerAdapter session", () => {
  it("shows the login screen when there is no saved session", async () => {
    const { adapter, last, sockets } = setup();
    await adapter.start();
    expect(last()).toEqual({ screen: "login", platform: "Fluxer", identity: "email", busy: false, status: undefined, error: undefined });
    expect(sockets).toHaveLength(0);
    expect(adapter.mode).toBe("native");
  });

  it("reports an unreachable instance and retries discovery on login", async () => {
    let down = true;
    const { adapter, last, secrets } = setup({
      routes: [(url) => (down && url.endsWith("/.well-known/fluxer") ? { status: 503 } : undefined),
        (url) => (url.endsWith("/auth/login") ? { status: 200, body: { token: "flx_new" } } : undefined)],
    });
    await adapter.start();
    expect(last()).toMatchObject({ screen: "login", error: "Could not reach Fluxer: Instance discovery failed (HTTP 503)" });

    await adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    expect(last()).toMatchObject({ screen: "login", busy: false, error: expect.stringContaining("Could not reach") });

    down = false;
    await adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    expect(secrets.get("fluxer:fluxer.app:token")).toBe("flx_new");
    expect(last()).toMatchObject({ screen: "connecting", status: "Connecting…" });
  });

  it("resumes a saved session and builds the rail from READY", async () => {
    const { adapter, sockets, goOnline, chat } = setup({ token: "flx_saved" });
    const servers = vi.fn();
    const directs = vi.fn();
    adapter.onServersChanged(servers);
    adapter.onDirectsChanged(directs);
    await adapter.start();
    expect(sockets).toHaveLength(1);
    await goOnline();
    expect(sockets[0]!.sent[0]).toMatchObject({ op: 2, d: { token: "flx_saved", properties: { os: "win32" } } });

    expect(chat()).toMatchObject({ screen: "chat", title: "Direct Messages", me: "me", channel: null });
    const rail = servers.mock.calls.at(-1)![0];
    expect(rail).toEqual([
      expect.objectContaining({
        key: "folder:5",
        kind: "group",
        name: "Folder",
        color: "#123456",
        expanded: false,
        children: [expect.objectContaining({ key: "200", name: "Beta", unread: false, mentions: 0, iconUrl: undefined })],
        previewIconUrls: [],
      }),
      expect.objectContaining({ key: "100", name: "Alpha", unread: true, mentions: 2, iconUrl: "https://media.fx/icons/100/ic.png?size=96" }),
    ]);
    expect(directs.mock.calls.at(-1)![0]).toEqual([
      expect.objectContaining({ key: "900", title: "Ana", avatarUrl: "https://media.fx/avatars/2/av.png?size=64", unread: true, mentions: 1 }),
      expect.objectContaining({ key: "901", title: "Group", unread: false, mentions: 0 }),
    ]);
    expect(await adapter.listDirectConversations()).toHaveLength(2);
    expect(adapter.homeBadge()).toEqual({ unread: false, mentions: 0 });
  });

  it("logs in through the captcha and stores the token", async () => {
    let captchaShown = false;
    const challenge = { parameters: { algorithm: "PBKDF2/SHA-256" }, signature: "s" };
    const { adapter, renders, secrets, sockets, calls } = setup({
      routes: [
        (url, init) => {
          if (!url.endsWith("/auth/login")) return undefined;
          const headers = init.headers as Record<string, string>;
          if (headers["X-Captcha-Token"]) return { status: 200, body: { token: "flx_cap" } };
          return { status: 400, body: { code: "CAPTCHA_REQUIRED", message: "captcha", altcha_challenge: challenge } };
        },
      ],
    });
    await adapter.start();
    await adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    captchaShown = renders.some((r) => r.screen === "login" && r.status === "Checking you are human…");
    expect(captchaShown).toBe(true);
    expect(renders.some((r) => r.screen === "login" && r.busy && r.status === "Signing in…")).toBe(true);
    expect(secrets.get("fluxer:fluxer.app:token")).toBe("flx_cap");
    expect(sockets).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith("/auth/login"))).toHaveLength(2);
  });

  it("walks through two-factor authentication", async () => {
    const { adapter, last, secrets } = setup({
      routes: [
        (url) => (url.endsWith("/auth/login") ? { status: 200, body: { mfa: true, ticket: "t1", totp: true } } : undefined),
        (url, init) =>
          url.endsWith("/mfa/totp")
            ? JSON.parse(String(init.body)).code === "000000"
              ? { status: 400, body: { code: "INVALID_MFA_CODE", message: "Invalid code" } }
              : { status: 200, body: { token: "flx_mfa" } }
            : undefined,
      ],
    });
    await adapter.start();
    await adapter.handleAction({ type: "mfa", code: "123456" }); // no ticket yet: ignored
    await adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    expect(last()).toEqual({ screen: "mfa", platform: "Fluxer", busy: false, error: undefined });

    await adapter.handleAction({ type: "mfa", code: "000000" });
    expect(last()).toMatchObject({ screen: "mfa", error: "Invalid code" });
    await adapter.handleAction({ type: "cancelMfa" });
    expect(last()).toMatchObject({ screen: "login", error: undefined });

    await adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    await adapter.handleAction({ type: "mfa", code: "123456" });
    expect(secrets.get("fluxer:fluxer.app:token")).toBe("flx_mfa");
  });

  it("explains accounts that need a security key", async () => {
    const { adapter, last } = setup({
      routes: [(url) => (url.endsWith("/auth/login") ? { status: 200, body: { mfa: true, ticket: "t", totp: false } } : undefined)],
    });
    await adapter.start();
    await adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    expect(last()).toMatchObject({ screen: "login", error: expect.stringContaining("security key") });
  });

  it("ignores a second login while one is in flight", async () => {
    const { adapter, calls } = setup({
      routes: [(url) => (url.endsWith("/auth/login") ? { status: 400, body: { code: "X", message: "Wrong password" } } : undefined)],
    });
    await adapter.start();
    const first = adapter.handleAction({ type: "login", identity: "a", password: "b" });
    await adapter.handleAction({ type: "login", identity: "a", password: "b" });
    await first;
    expect(calls.filter((c) => c.url.endsWith("/auth/login"))).toHaveLength(1);
  });

  it("returns to login when the gateway rejects the token", async () => {
    const { adapter, sockets, secrets, last, goOnline } = setup({ token: "flx_old" });
    const servers = vi.fn();
    adapter.onServersChanged(servers);
    await adapter.start();
    await goOnline();
    sockets[0]!.serverClose(4004);
    expect(secrets.has("fluxer:fluxer.app:token")).toBe(false);
    expect(last()).toMatchObject({ screen: "login", error: "Your session has ended. Please sign in again." });
    expect(servers).toHaveBeenLastCalledWith([]);
  });

  it("logs out even when the server call fails", async () => {
    const { adapter, last, calls, secrets, goOnline } = setup({
      token: "flx_x",
      routes: [(url) => (url.endsWith("/auth/logout") ? { status: 500 } : undefined)],
    });
    await adapter.start();
    await goOnline();
    await adapter.handleAction({ type: "logout" });
    expect(calls.some((c) => c.url.endsWith("/auth/logout"))).toBe(true);
    expect(secrets.size).toBe(0);
    expect(last()).toMatchObject({ screen: "login", error: undefined });
    expect(adapter.state.guilds.size).toBe(0);
  });

  it("shows reconnects on the connecting screen and in chat", async () => {
    const { adapter, sockets, last, goOnline, chat } = setup({ token: "flx" });
    await adapter.start();
    sockets[0]!.serverClose(1006);
    expect(last()).toEqual({ screen: "connecting", platform: "Fluxer", status: "Reconnecting…" });
    await vi.advanceTimersByTimeAsync(1000);
    await goOnline();
    sockets[1]!.serverClose(1006);
    expect(chat().error).toBe("Connection lost. Reconnecting…");
  });
});

describe("FluxerAdapter chat", () => {
  async function online() {
    const ctx = setup({ token: "flx" });
    await ctx.adapter.start();
    await ctx.goOnline();
    return ctx;
  }

  it("opens a guild on its first text channel and loads history", async () => {
    const { adapter, chat, calls } = await online();
    await adapter.handleAction({ type: "ready" });
    await adapter.openServer("100");
    const state = chat();
    expect(state.title).toBe("Alpha");
    expect(state.sidebar.map((i) => [i.kind, i.name, i.active])).toEqual([
      ["text", "lobby", true],
      ["text", "orphan", false],
      ["category", "Text", false],
      ["text", "general", false],
    ]);
    expect(state.sidebar[3]).toMatchObject({ unread: true, mentions: 2 });
    expect(state.channel).toMatchObject({ id: "113", name: "lobby", loading: false, hasOlder: false });
    expect(state.channel!.messages[0]).toMatchObject({ id: "450", author: "Ana", content: "m450", mine: false });
    expect(calls.some((c) => c.url.includes("/channels/113/messages?limit=50"))).toBe(true);

    await expect(adapter.openServer("404")).rejects.toThrow("Unknown Fluxer guild");
  });

  it("remembers the last channel per guild and handles guilds without text channels", async () => {
    const { adapter, chat } = await online();
    await adapter.openServer("100");
    await adapter.handleAction({ type: "select", channelId: "111" });
    await adapter.openServer("200");
    await adapter.openServer("100");
    expect(chat().channel!.id).toBe("111");

    adapter.state.apply("GUILD_CREATE", { id: "600", properties: { name: "Voice only" }, channels: [{ id: "601", type: 2 }] });
    await adapter.openServer("600");
    expect(chat()).toMatchObject({ title: "Voice only", channel: null });
  });

  it("ignores selecting unknown or non-text channels", async () => {
    const { adapter, chat } = await online();
    await adapter.openServer("100");
    await adapter.handleAction({ type: "select", channelId: "112" });
    await adapter.handleAction({ type: "select", channelId: "404" });
    expect(chat().channel!.id).toBe("113");
  });

  it("marks the open channel read while visible, debounced", async () => {
    const { adapter, calls } = await online();
    const acks = () => calls.filter((c) => c.url.endsWith("/read-states/ack"));
    await adapter.openServer("100");
    await adapter.handleAction({ type: "select", channelId: "111" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(acks()).toHaveLength(0); // not visible

    adapter.setVisible(true);
    adapter.setVisible(true);
    await vi.advanceTimersByTimeAsync(750);
    expect(acks()).toHaveLength(1);
    expect(JSON.parse(String(acks()[0]!.init.body))).toEqual({ read_states: [{ channel_id: "111", message_id: "500" }] });
    expect(adapter.state.isUnread(adapter.state.channels.get("111")!)).toBe(false);

    // A new message from someone else in the open channel is acked too.
    adapter.state.apply("MESSAGE_CREATE", message("510", "111"));
    adapter.state.apply("MESSAGE_CREATE", message("720", "211")); // elsewhere: not acked
    await vi.advanceTimersByTimeAsync(750);
    expect(acks()).toHaveLength(2);

    // Nothing unread: no ack.
    adapter.setVisible(true);
    await vi.advanceTimersByTimeAsync(750);
    expect(acks()).toHaveLength(2);

    adapter.setVisible(false);
    adapter.state.apply("MESSAGE_CREATE", message("511", "111"));
    await vi.advanceTimersByTimeAsync(750);
    expect(acks()).toHaveLength(2);
  });

  it("does not ack a channel that disappeared", async () => {
    const { adapter, calls } = await online();
    await adapter.openServer("100");
    await adapter.handleAction({ type: "select", channelId: "111" });
    adapter.setVisible(true);
    adapter.state.apply("CHANNEL_DELETE", { id: "111" });
    await vi.advanceTimersByTimeAsync(750);
    expect(calls.some((c) => c.url.endsWith("/read-states/ack"))).toBe(false);
  });

  it("sends messages and surfaces failures", async () => {
    let fail = false;
    const ctx = setup({
      token: "flx",
      routes: [(url, init) => (fail && init.method === "POST" && url.endsWith("/messages") ? { status: 403, body: { code: "MISSING_PERMISSIONS", message: "Missing permissions" } } : undefined)],
    });
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.handleAction({ type: "send", content: "nowhere" }); // no channel yet
    await ctx.adapter.openServer("100");
    await ctx.adapter.handleAction({ type: "send", content: "hello" });
    const sent = ctx.calls.find((c) => c.init.method === "POST" && c.url.endsWith("/channels/113/messages"))!;
    expect(JSON.parse(String(sent.init.body))).toMatchObject({ content: "hello", nonce: expect.stringMatching(/^\d+$/) });
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.chat().channel!.messages.at(-1)).toMatchObject({ id: "990", mine: true, author: "me" });

    fail = true;
    await ctx.adapter.handleAction({ type: "send", content: "again" });
    expect(ctx.chat().error).toBe("Message not sent: Missing permissions");
  });

  it("pages back through history", async () => {
    const page = (start: number) => Array.from({ length: 50 }, (_, i) => message(String(start - i), "113"));
    const ctx = setup({
      token: "flx",
      routes: [
        (url) => (url.includes("/channels/113/messages?") && !url.includes("before") ? { status: 200, body: page(2000) } : undefined),
        (url) => (url.includes("before=1951") ? { status: 200, body: [message("1900", "113")] } : undefined),
      ],
    });
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.openServer("100");
    expect(ctx.chat().channel).toMatchObject({ hasOlder: true });
    await ctx.adapter.handleAction({ type: "loadOlder" });
    await vi.advanceTimersByTimeAsync(100);
    const channel = ctx.chat().channel!;
    expect(channel.hasOlder).toBe(false);
    expect(channel.messages[0]!.id).toBe("1900");
    expect(channel.messages).toHaveLength(51);
    await ctx.adapter.handleAction({ type: "loadOlder" }); // nothing older
    expect(ctx.calls.filter((c) => c.url.includes("before="))).toHaveLength(1);
  });

  it("does nothing on loadOlder without a channel", async () => {
    const { adapter, calls } = await online();
    await adapter.handleAction({ type: "loadOlder" });
    expect(calls.some((c) => c.url.includes("/messages?"))).toBe(false);
  });

  it("reports history that fails to load", async () => {
    const ctx = setup({ token: "flx", routes: [(url) => (url.includes("/messages?") ? { status: 500 } : undefined)] });
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.openServer("100");
    expect(ctx.chat().error).toBe("Could not load messages: Request failed (HTTP 500)");
  });

  it("does not fetch the same history twice at once", async () => {
    const { adapter, calls } = await online();
    await Promise.all([adapter.openServer("100"), adapter.handleAction({ type: "select", channelId: "113" })]);
    expect(calls.filter((c) => c.url.includes("/channels/113/messages?"))).toHaveLength(1);
  });

  it("lists DMs at home and opens conversations", async () => {
    const { adapter, chat } = await online();
    await adapter.openConversation("900");
    let state = chat();
    expect(state.title).toBe("Direct Messages");
    expect(state.sidebar).toEqual([
      { id: "900", name: "Ana", kind: "dm", iconUrl: "https://media.fx/avatars/2/av.png?size=64", unread: true, mentions: 1, active: true },
      { id: "901", name: "Group", kind: "dm", iconUrl: undefined, unread: false, mentions: 0, active: false },
    ]);
    await adapter.openServer("100");
    await adapter.openHome();
    state = chat();
    expect(state.channel!.id).toBe("900");
  });

  it("names unnamed group DMs after their members", async () => {
    const { adapter } = await online();
    adapter.state.apply("CHANNEL_CREATE", { id: "902", type: 3, recipients: [ANA, { id: "3", username: "bo" }] });
    adapter.state.apply("CHANNEL_CREATE", { id: "903", type: 3, recipients: [] });
    const titles = adapter.directs().map((d) => d.title);
    expect(titles).toContain("Ana, bo");
    expect(titles).toContain("Direct message");
  });

  it("renders mentions, attachments and edits for the view", async () => {
    const ctx = setup({
      token: "flx",
      routes: [
        (url) =>
          url.includes("/channels/113/messages?")
            ? {
                status: 200,
                body: [
                  message("460", "113", {
                    content: "hi <@2> and <@!404> in <#111> or <#404>",
                    edited_timestamp: "t",
                    attachments: [
                      { id: "1", filename: "cat.png", content_type: "image/png", proxy_url: "https://media.fx/a/cat.png" },
                      { id: "2", filename: "notes.txt", url: "https://media.fx/a/notes.txt" },
                      { id: "3", filename: "old.png", content_type: "image/png" },
                    ],
                  }),
                ],
              }
            : undefined,
      ],
    });
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.openServer("100");
    expect(ctx.chat().channel!.messages[0]).toEqual({
      id: "460",
      author: "Ana",
      avatarUrl: "https://media.fx/avatars/2/av.png?size=64",
      content: "hi @Ana and <@!404> in #general or <#404>",
      timestamp: "2026-10-14T12:00:00Z",
      edited: true,
      mine: false,
      attachments: [
        { name: "cat.png", url: "https://media.fx/a/cat.png", image: true },
        { name: "notes.txt", url: "https://media.fx/a/notes.txt", image: false },
        { name: "old.png", url: undefined, image: false },
      ],
    });
  });

  it("expands and collapses folders locally", async () => {
    const { adapter } = await online();
    const servers = vi.fn();
    adapter.onServersChanged(servers);
    await adapter.toggleGroup("folder:5");
    expect(servers.mock.calls.at(-1)![0][0]).toMatchObject({ key: "folder:5", expanded: true });
    await adapter.toggleGroup("folder:5");
    expect(servers.mock.calls.at(-1)![0][0]).toMatchObject({ expanded: false });
    await expect(adapter.toggleGroup("folder:6")).rejects.toThrow("Unknown Fluxer folder");
    await expect(adapter.toggleGroup("5")).rejects.toThrow("Unknown Fluxer folder");
  });

  it("names unnamed folders after their guilds and previews icons", async () => {
    const { adapter } = await online();
    adapter.state.apply("USER_SETTINGS_UPDATE", { guild_folders: [{ id: 8, guild_ids: ["100", "200"] }] });
    expect(adapter.railServers()[0]).toMatchObject({
      name: "Alpha, Beta",
      unread: true,
      mentions: 2,
      previewIconUrls: ["https://media.fx/icons/100/ic.png?size=96"],
    });
  });

  it("handles a READY without a user", async () => {
    const ctx = setup({ token: "flx" });
    await ctx.adapter.start();
    ctx.sockets[0]!.receive({ op: 0, s: 1, t: "READY", d: { guilds: [] } });
    expect(ctx.chat().me).toBe("");
  });
});

describe("FluxerAdapter notifications", () => {
  async function online() {
    const ctx = setup({ token: "flx" });
    await ctx.adapter.start();
    await ctx.goOnline();
    const notes = vi.fn();
    ctx.adapter.onNotification(notes);
    return { ...ctx, notes };
  }

  it("notifies for DMs, mentions and @everyone but not other chatter", async () => {
    const { adapter, notes } = await online();
    adapter.state.apply("MESSAGE_CREATE", message("801", "900", { content: "hi <@1>" }));
    adapter.state.apply("MESSAGE_CREATE", message("802", "901", { content: "", attachments: [{ id: "5", filename: "a.png" }] }));
    adapter.state.apply("MESSAGE_CREATE", message("803", "111", { mentions: [{ id: "1" }] }));
    adapter.state.apply("MESSAGE_CREATE", message("804", "113", { mention_everyone: true, content: "" }));
    adapter.state.apply("MESSAGE_CREATE", message("805", "211")); // plain guild message
    adapter.state.apply("MESSAGE_CREATE", message("806", "900", { author: ME })); // our own
    expect(notes.mock.calls.map(([n]) => n)).toEqual([
      { title: "Ana", body: "hi @me", target: "900", railKey: "dm:900", inView: false },
      { title: "Ana in Group", body: "Sent an attachment", target: "901", railKey: "dm:901", inView: false },
      { title: "Ana in #general (Alpha)", body: "m803", target: "111", railKey: "100", inView: false },
      { title: "Ana in #lobby (Alpha)", body: "New message", target: "113", railKey: "100", inView: false },
    ]);
  });

  it("marks notifications for the open, visible conversation", async () => {
    const { adapter, notes } = await online();
    await adapter.openConversation("900");
    adapter.setVisible(true);
    adapter.state.apply("MESSAGE_CREATE", message("801", "900"));
    expect(notes.mock.calls[0]![0]).toMatchObject({ inView: true });
  });

  it("skips messages in unknown channels or before READY", async () => {
    const { adapter, notes } = await online();
    adapter.state.apply("MESSAGE_CREATE", message("801", "404", { mention_everyone: true }));
    adapter.state.me = undefined;
    adapter.state.apply("MESSAGE_CREATE", message("802", "900"));
    expect(notes).not.toHaveBeenCalled();
  });

  it("opens guild channels from a notification inside their guild", async () => {
    const { adapter, chat } = await online();
    await adapter.openConversation("111");
    expect(chat()).toMatchObject({ title: "Alpha", channel: { id: "111" } });
  });
});

describe("FluxerAdapter guild subscriptions", () => {
  it("makes the open guild active so large guilds deliver every message", async () => {
    const ctx = setup({ token: "flx" });
    await ctx.adapter.start();
    await ctx.goOnline();
    const lazy = () => ctx.sockets.at(-1)!.sent.filter((p) => p.op === 14);
    await ctx.adapter.openServer("100");
    expect(lazy()).toEqual([{ op: 14, d: { subscriptions: { "100": { active: true, typing: true } } } }]);
    await ctx.adapter.openConversation("211");
    await ctx.adapter.openConversation("900"); // DM: no subscription
    expect(lazy().map((p) => Object.keys((p.d as { subscriptions: object }).subscriptions))).toEqual([["100"], ["200"]]);

    // After a reconnect the subscription is renewed.
    ctx.sockets[0]!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    await ctx.adapter.openServer("200");
    ctx.sockets[1]!.receive({ op: 10, d: { heartbeat_interval: 40_000 } });
    ctx.sockets[1]!.receive({ op: 0, s: 2, t: "RESUMED", d: {} });
    // Nothing is sent before the session is ready again; RESUMED renews the subscription.
    expect(lazy().map((p) => Object.keys((p.d as { subscriptions: object }).subscriptions))).toEqual([["200"]]);
  });
});
