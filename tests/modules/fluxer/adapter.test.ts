import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FluxerAdapter, type FluxerAdapterDeps } from "../../../src/modules/fluxer/adapter";
import type { GatewaySocket } from "../../../src/modules/fluxer/gateway";
import { FLUXER, type PlatformDef } from "../../../src/main/platforms";
import type { NativeViewState } from "../../../src/shared/native";
import { parseMessage } from "../../../src/modules/fluxer/types";
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

function setup(options: { token?: string; routes?: Handler[]; files?: FluxerAdapterDeps["files"]; def?: PlatformDef; secrets?: [string, string][] } = {}) {
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
  const secrets = new Map<string, string>(options.secrets ?? (options.token ? [["fluxer.app:token", options.token]] : []));
  const renders: NativeViewState[] = [];
  const adapter = new FluxerAdapter({
    def: options.def ?? FLUXER,
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
    rest: { sleep: async () => {}, solveCaptcha: async () => ({ counter: 1, derivedKey: "00", time: 1 }) },
    platform: "win32",
    files: options.files,
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
    expect(secrets.get("fluxer.app:token")).toBe("flx_new");
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
    expect(secrets.get("fluxer.app:token")).toBe("flx_cap");
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
    expect(last()).toEqual({ screen: "mfa", platform: "Fluxer", codes: "totp", busy: false, error: undefined });

    await adapter.handleAction({ type: "mfa", code: "000000" });
    expect(last()).toMatchObject({ screen: "mfa", error: "Invalid code" });
    await adapter.handleAction({ type: "cancelMfa" });
    expect(last()).toMatchObject({ screen: "login", error: undefined });

    await adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    await adapter.handleAction({ type: "mfa", code: "123456" });
    expect(secrets.get("fluxer.app:token")).toBe("flx_mfa");
  });

  it("offers backup codes to accounts protected only by a security key", async () => {
    const { adapter, last } = setup({
      routes: [(url) => (url.endsWith("/auth/login") ? { status: 200, body: { mfa: true, ticket: "t", totp: false, backup_codes: true } } : undefined)],
    });
    await adapter.start();
    await adapter.handleAction({ type: "login", identity: "a@b.c", password: "pw" });
    expect(last()).toMatchObject({ screen: "mfa", codes: "backup" });
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
    expect(secrets.has("fluxer.app:token")).toBe(false);
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
      ["voice", "voice", false],
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
      canEdit: false,
      canDelete: false,
      source: undefined,
      reply: undefined,
      reactions: [],
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

describe("FluxerAdapter message actions", () => {
  async function inChannel(routes: Handler[] = []) {
    const ctx = setup({
      token: "flx",
      routes: [
        ...routes,
        (url, init) =>
          url.includes("/channels/113/messages?")
            ? {
                status: 200,
                // Newest first, as the API returns them.
                body: [
                  message("462", "113", { author: ME, type: 7, referenced_message: null }),
                  message("461", "113", {
                    type: 19,
                    referenced_message: { id: "460", author: ME, content: "orig <@2>" },
                    reactions: [
                      { emoji: { name: "👍" }, count: 2, me: true },
                      { emoji: { id: "55", name: "party" }, count: 1 },
                    ],
                  }),
                  message("460", "113", { author: ME, content: "mine <@2>", type: 0 }),
                ],
              }
            : init.method === "PATCH"
              ? { status: 200, body: message("460", "113", { author: ME, content: "edited", edited_timestamp: "t" }) }
              : undefined,
      ],
    });
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.openServer("100");
    const messages = () => ctx.chat().channel!.messages;
    return { ...ctx, messages };
  }

  it("exposes edit rights, raw source, reply previews and reactions to the view", async () => {
    const { messages } = await inChannel();
    const [own, reply, system] = messages();
    expect(own).toMatchObject({ canEdit: true, canDelete: true, source: "mine <@2>", content: "mine @Ana" });
    expect(reply).toMatchObject({
      canEdit: false,
      canDelete: false,
      source: undefined,
      reply: { author: "me", content: "orig @Ana" },
      reactions: [
        { key: "👍", label: "👍", imageUrl: undefined, count: 2, me: true },
        { key: "party:55", label: ":party:", imageUrl: "https://media.fx/emojis/55.webp?size=32", count: 1, me: false },
      ],
    });
    expect(system).toMatchObject({ canEdit: false, canDelete: true, reply: null });
  });

  it("sends replies, edits and deletes", async () => {
    const { adapter, calls, messages } = await inChannel();
    await adapter.handleAction({ type: "send", content: "re", replyTo: "461" });
    const sent = calls.find((c) => c.init.method === "POST" && c.url.endsWith("/channels/113/messages"))!;
    expect(JSON.parse(String(sent.init.body)).message_reference).toEqual({ message_id: "461" });

    await adapter.handleAction({ type: "edit", messageId: "460", content: "edited" });
    await vi.advanceTimersByTimeAsync(100);
    expect(messages()[0]).toMatchObject({ content: "edited", edited: true });

    await adapter.handleAction({ type: "delete", messageId: "460" });
    await vi.advanceTimersByTimeAsync(100);
    expect(messages().map((m) => m.id)).not.toContain("460");
    expect(calls.some((c) => c.init.method === "DELETE" && c.url.endsWith("/channels/113/messages/460"))).toBe(true);
  });

  it("applies our own reactions once the server accepts them", async () => {
    const { adapter, messages, calls } = await inChannel();
    await adapter.handleAction({ type: "react", messageId: "461", emoji: "party:55", add: true });
    await adapter.handleAction({ type: "react", messageId: "461", emoji: "👍", add: false });
    await adapter.handleAction({ type: "react", messageId: "460", emoji: "🎉", add: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(messages()[1]!.reactions).toEqual([
      expect.objectContaining({ key: "👍", count: 1, me: false }),
      expect.objectContaining({ key: "party:55", count: 2, me: true }),
    ]);
    expect(messages()[0]!.reactions).toEqual([expect.objectContaining({ key: "🎉", count: 1, me: true })]);
    expect(calls.filter((c) => c.url.includes("/reactions/")).map((c) => c.init.method)).toEqual(["PUT", "DELETE", "PUT"]);
  });

  it("reports failed actions in the banner", async () => {
    const forbidden = { status: 403, body: { code: "MISSING_PERMISSIONS", message: "Missing permissions" } };
    const { adapter, chat } = await inChannel([(url, init) => (init.method === "PUT" || init.method === "DELETE" ? forbidden : undefined)]);
    await adapter.handleAction({ type: "react", messageId: "461", emoji: "🎉", add: true });
    expect(chat().error).toBe("Reaction failed: Missing permissions");
    await adapter.handleAction({ type: "delete", messageId: "460" });
    expect(chat().error).toBe("Message not deleted: Missing permissions");
  });

  it("ignores edits that return nothing usable and actions without a channel", async () => {
    const ctx = setup({ token: "flx", routes: [(_url, init) => (init.method === "PATCH" ? { status: 200, body: {} } : undefined)] });
    await ctx.adapter.start();
    await ctx.goOnline();
    for (const action of [
      { type: "edit", messageId: "1", content: "x" },
      { type: "delete", messageId: "1" },
      { type: "react", messageId: "1", emoji: "👍", add: true },
    ] as const) {
      await ctx.adapter.handleAction(action);
    }
    expect(ctx.calls.some((c) => c.url.includes("/messages/1"))).toBe(false);
    await ctx.adapter.openServer("100");
    await ctx.adapter.handleAction({ type: "edit", messageId: "450", content: "x" });
    expect(ctx.chat().error).toBeUndefined();
  });
});

describe("FluxerAdapter typing", () => {
  it("sends typing at most every 8 seconds per channel and shows others typing", async () => {
    const ctx = setup({ token: "flx" });
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.handleAction({ type: "typing" }); // no channel yet
    await ctx.adapter.openServer("100");
    const typingCalls = () => ctx.calls.filter((c) => c.url.endsWith("/typing"));
    await ctx.adapter.handleAction({ type: "typing" });
    await ctx.adapter.handleAction({ type: "typing" });
    expect(typingCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8_000);
    await ctx.adapter.handleAction({ type: "typing" });
    expect(typingCalls()).toHaveLength(2);

    ctx.adapter.state.apply("TYPING_START", { channel_id: "113", user_id: "2" });
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.chat().channel!.typing).toEqual(["Ana"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.chat().channel!.typing).toEqual([]);
  });
});

describe("FluxerAdapter attachments", () => {
  const source = (name: string) => ({ filename: name, size: 2, contentType: "text/plain", read: async () => new Uint8Array([104, 105]) });

  async function withFiles(picked: string[][], routes: Handler[] = [], discovery?: unknown) {
    const pick = vi.fn(async () => (picked.shift() ?? []).map(source));
    const ctx = setup({
      token: "flx",
      files: { pick },
      routes: [
        ...(discovery ? [(url: string) => (url.endsWith("/.well-known/fluxer") ? { status: 200, body: discovery } : undefined)] : []),
        ...routes,
        (url) =>
          url.endsWith("/channels/113/attachments")
            ? { status: 200, body: { attachments: [{ upload_filename: "up/a", upload_url: "https://store/a" }, { upload_filename: "up/b", upload_url: "https://store/b" }] } }
            : url.startsWith("https://store/")
              ? { status: 200 }
              : undefined,
      ],
    });
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.openServer("100");
    return { ...ctx, pick };
  }

  it("queues picked files, removes them on request and uploads them with the message", async () => {
    const { adapter, chat, calls } = await withFiles([["a.txt", "b.txt", "c.txt"]]);
    await adapter.handleAction({ type: "attach" });
    expect(chat().channel!.pending).toEqual([
      { name: "a.txt", size: 2 },
      { name: "b.txt", size: 2 },
      { name: "c.txt", size: 2 },
    ]);
    await adapter.handleAction({ type: "removeAttachment", index: 2 });
    expect(chat().channel!.pending.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);

    const sending = adapter.handleAction({ type: "send", content: "" });
    expect(chat().channel!.uploading).toBe(true);
    await adapter.handleAction({ type: "send", content: "again" }); // ignored while uploading
    await sending;
    const sent = calls.filter((c) => c.init.method === "POST" && c.url.endsWith("/channels/113/messages"));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0]!.init.body)).attachments.map((a: { upload_filename: string }) => a.upload_filename)).toEqual(["up/a", "up/b"]);
    expect(chat().channel).toMatchObject({ pending: [], uploading: false });
  });

  it("caps attachments per message", async () => {
    const { adapter, chat } = await withFiles([Array.from({ length: 12 }, (_, i) => `f${i}.txt`)]);
    await adapter.handleAction({ type: "attach" });
    expect(chat().channel!.pending).toHaveLength(10);
    expect(chat().error).toBe("At most 10 files per message.");
  });

  it("keeps files queued when sending fails, and reports picker errors", async () => {
    const { adapter, chat, pick } = await withFiles([["a.txt"]], [(url) => (url.endsWith("/channels/113/attachments") ? { status: 413, body: { code: "FILE_TOO_LARGE", message: "Too large" } } : undefined)]);
    await adapter.handleAction({ type: "attach" });
    await adapter.handleAction({ type: "send", content: "x" });
    expect(chat().error).toBe("Message not sent: Too large");
    expect(chat().channel!.pending).toHaveLength(1);

    pick.mockRejectedValueOnce(new Error("dialog failed"));
    await adapter.handleAction({ type: "attach" });
    expect(chat().error).toBe("Could not attach: dialog failed");
  });

  it("explains instances without presigned uploads", async () => {
    const discovery = {
      endpoints: { api_public: "https://api.fx", gateway: "wss://gw.fx", media: "https://media.fx" },
      features: { presigned_attachment_uploads: false },
    };
    const { adapter, chat } = await withFiles([["a.txt"]], [], discovery);
    await adapter.handleAction({ type: "attach" });
    await adapter.handleAction({ type: "send", content: "" });
    expect(chat().error).toContain("inline uploads");
  });

  it("ignores empty sends and attach without a picker or channel", async () => {
    const ctx = setup({ token: "flx" });
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.handleAction({ type: "attach" });
    await ctx.adapter.openServer("100");
    await ctx.adapter.handleAction({ type: "attach" }); // no picker
    await ctx.adapter.handleAction({ type: "send", content: "   " });
    await ctx.adapter.handleAction({ type: "removeAttachment", index: 0 });
    expect(ctx.calls.some((c) => c.init.method === "POST" && c.url.endsWith("/messages"))).toBe(false);
  });
});

describe("FluxerAdapter threads and forums", () => {
  async function withForum(routes: Handler[] = []) {
    const ctx = setup({ token: "flx", routes });
    await ctx.adapter.start();
    await ctx.goOnline();
    ctx.adapter.state.apply("GUILD_CREATE", {
      id: "100",
      properties: { name: "Alpha" },
      channels: [
        { id: "113", type: 0, name: "lobby", position: 0, last_message_id: "300" },
        { id: "120", type: 15, name: "ideas", position: 1 },
      ],
      threads: [
        { id: "130", type: 11, name: "side chat", parent_id: "113", last_message_id: "301" },
        { id: "140", type: 11, name: "Dark mode", parent_id: "120", last_message_id: "900", message_count: 4 },
      ],
    });
    ctx.adapter.state.apply("MESSAGE_ACK", { channel_id: "140", message_id: "800", mention_count: 2 });
    await ctx.adapter.openServer("100");
    return ctx;
  }

  it("shows threads and forums in the sidebar, with forum unread from its posts", async () => {
    const { chat } = await withForum();
    expect(chat().sidebar.map((i) => [i.kind, i.name])).toEqual([
      ["text", "lobby"],
      ["thread", "side chat"],
      ["forum", "ideas"],
    ]);
    expect(chat().sidebar[2]).toMatchObject({ unread: true, mentions: 2 });
  });

  it("opens a forum as a list of posts without fetching messages", async () => {
    const { adapter, chat, calls } = await withForum();
    await adapter.handleAction({ type: "select", channelId: "120" });
    expect(chat().channel).toMatchObject({
      id: "120",
      name: "ideas",
      messages: [],
      posts: [{ id: "140", name: "Dark mode", messageCount: 4, unread: true, mentions: 2 }],
    });
    expect(calls.some((c) => c.url.includes("/channels/120/messages"))).toBe(false);

    await adapter.handleAction({ type: "select", channelId: "140" });
    expect(chat().channel).toMatchObject({ id: "140", name: "Dark mode", posts: undefined });
  });

  it("creates forum posts and opens them", async () => {
    const { adapter, chat, calls } = await withForum([
      (url, init) =>
        init.method === "POST" && url.endsWith("/channels/120/threads") ? { status: 201, body: { id: "150", type: 11, name: "New idea" } } : undefined,
    ]);
    await adapter.handleAction({ type: "createPost", name: "New idea", content: "hi" }); // not in a forum: ignored
    expect(calls.some((c) => c.url.endsWith("/threads"))).toBe(false);
    await adapter.handleAction({ type: "select", channelId: "120" });
    await adapter.handleAction({ type: "createPost", name: " New idea ", content: "first" });
    const post = calls.find((c) => c.url.endsWith("/channels/120/threads"))!;
    expect(JSON.parse(String(post.init.body))).toEqual({ name: "New idea", message: { content: "first" } });
    expect(chat().channel!.id).toBe("150");
    expect(adapter.state.channels.get("150")).toMatchObject({ guildId: "100", parentId: "120" });
  });

  it("reports failed posts and ignores empty responses", async () => {
    let reply: { status: number; body?: unknown } = { status: 403, body: { code: "MISSING_PERMISSIONS", message: "No" } };
    const { adapter, chat } = await withForum([(url) => (url.endsWith("/channels/120/threads") ? reply : undefined)]);
    await adapter.handleAction({ type: "select", channelId: "120" });
    await adapter.handleAction({ type: "createPost", name: "x", content: "y" });
    expect(chat().error).toBe("Post not created: No");
    reply = { status: 201, body: {} };
    await adapter.handleAction({ type: "createPost", name: "x", content: "y" });
    expect(chat().channel!.id).toBe("120");
  });
});

describe("FluxerAdapter voice", () => {
  async function online(discovery?: unknown) {
    const ctx = setup({
      token: "flx",
      routes: discovery ? [(url) => (url.endsWith("/.well-known/fluxer") ? { status: 200, body: discovery } : undefined)] : [],
    });
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.openServer("100");
    const voiceOps = () => ctx.sockets.at(-1)!.sent.filter((p) => p.op === 4).map((p) => p.d);
    const grant = (extra: Record<string, unknown> = {}) =>
      ctx.sockets.at(-1)!.receive({
        op: 0,
        s: 9,
        t: "VOICE_SERVER_UPDATE",
        d: { guild_id: "100", channel_id: "112", token: "lk-token", endpoint: "voice.fx", connection_id: "conn1", ...extra },
      });
    return { ...ctx, voiceOps, grant };
  }

  it("joins through op 4 and hands the LiveKit grant to the view", async () => {
    const { adapter, chat, voiceOps, grant } = await online();
    await adapter.handleAction({ type: "joinVoice", channelId: "112" });
    expect(voiceOps()).toEqual([
      { guild_id: "100", channel_id: "112", self_mute: false, self_deaf: false, self_video: false, self_stream: false },
    ]);
    expect(chat().voice).toEqual({
      channelId: "112",
      channelName: "voice",
      guildName: "Alpha",
      url: undefined,
      token: undefined,
      mute: false,
      deaf: false,
      video: false,
      stream: false,
    });
    expect(chat().sidebar.find((i) => i.kind === "voice")).toMatchObject({ active: true });

    grant();
    expect(chat().voice).toMatchObject({ url: "wss://voice.fx", token: "lk-token" });
    await adapter.handleAction({ type: "joinVoice", channelId: "112" }); // already there
    expect(voiceOps()).toHaveLength(1);
  });

  it("sends toggles and leaves with the connection id", async () => {
    const { adapter, chat, voiceOps, grant } = await online();
    await adapter.handleAction({ type: "voiceState", mute: true, deaf: false, video: false, stream: false }); // not in voice
    await adapter.handleAction({ type: "joinVoice", channelId: "112" });
    grant();
    await adapter.handleAction({ type: "voiceState", mute: true, deaf: false, video: true, stream: false });
    expect(voiceOps().at(-1)).toEqual({
      guild_id: "100",
      channel_id: "112",
      connection_id: "conn1",
      self_mute: true,
      self_deaf: false,
      self_video: true,
      self_stream: false,
    });
    expect(chat().voice).toMatchObject({ mute: true, video: true });
    await adapter.handleAction({ type: "leaveVoice" });
    expect(voiceOps().at(-1)).toEqual({ guild_id: "100", channel_id: null, connection_id: "conn1" });
    expect(chat().voice).toBeNull();
  });

  it("refuses end-to-end encrypted channels rather than joining unencrypted", async () => {
    const { adapter, chat, voiceOps, grant } = await online();
    await adapter.handleAction({ type: "joinVoice", channelId: "112" });
    grant({ e2ee_key: "secret" });
    expect(chat().voice).toBeNull();
    expect(chat().error).toContain("end-to-end encrypted voice");
    expect(voiceOps().at(-1)).toEqual({ guild_id: "100", channel_id: null, connection_id: "conn1" });
  });

  it("leaves joins it has abandoned and ignores grants without a token", async () => {
    const { adapter, chat, voiceOps, grant } = await online();
    grant(); // nothing pending: an abandoned join
    expect(voiceOps()).toEqual([{ guild_id: "100", channel_id: null, connection_id: "conn1" }]);
    grant({ connection_id: undefined }); // cannot be addressed: ignored
    expect(voiceOps()).toHaveLength(1);

    await adapter.handleAction({ type: "joinVoice", channelId: "112" });
    grant({ token: undefined });
    expect(chat().voice).toMatchObject({ token: undefined });
  });

  it("switches channels by leaving first", async () => {
    const { adapter, voiceOps, grant } = await online();
    adapter.state.apply("CHANNEL_CREATE", { id: "115", type: 2, guild_id: "100", name: "voice 2" });
    await adapter.handleAction({ type: "joinVoice", channelId: "112" });
    grant();
    await adapter.handleAction({ type: "joinVoice", channelId: "115" });
    expect(voiceOps().slice(1)).toEqual([
      { guild_id: "100", channel_id: null, connection_id: "conn1" },
      expect.objectContaining({ channel_id: "115" }),
    ]);
  });

  it("gives up when the server never answers", async () => {
    const { adapter, chat } = await online();
    await adapter.handleAction({ type: "joinVoice", channelId: "112" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(chat()).toMatchObject({ voice: null, error: "Could not join voice: the server did not answer." });
  });

  it("drops voice on failures, new sessions and sign-out", async () => {
    const ctx = await online();
    await ctx.adapter.handleAction({ type: "joinVoice", channelId: "112" });
    ctx.grant();
    await ctx.adapter.handleAction({ type: "voiceError", message: "ICE failed" });
    expect(ctx.chat()).toMatchObject({ voice: null, error: "Voice failed: ICE failed" });

    await ctx.adapter.handleAction({ type: "joinVoice", channelId: "112" });
    ctx.sockets.at(-1)!.receive({ op: 0, s: 10, t: "READY", d: readyPayload() });
    expect(ctx.chat()).toMatchObject({ voice: null, error: "Voice disconnected when the connection was reset." });

    await ctx.adapter.handleAction({ type: "joinVoice", channelId: "112" });
    await ctx.adapter.handleAction({ type: "logout" });
    await ctx.adapter.handleAction({ type: "joinVoice", channelId: "112" }); // no gateway any more
    expect(ctx.adapter.viewState()).toMatchObject({ screen: "login" });
  });

  it("only joins guild voice channels on instances with voice", async () => {
    const off = await online({
      endpoints: { api_public: "https://api.fx", gateway: "wss://gw.fx", media: "https://media.fx" },
      features: { voice_enabled: false },
    });
    await off.adapter.handleAction({ type: "joinVoice", channelId: "112" });
    expect(off.chat()).toMatchObject({ voice: null, error: "Voice is turned off on this Fluxer instance." });

    const on = await online();
    await on.adapter.handleAction({ type: "joinVoice", channelId: "111" }); // text channel
    await on.adapter.handleAction({ type: "joinVoice", channelId: "404" });
    expect(on.voiceOps()).toEqual([]);
  });

  it("lists voice members in the sidebar", async () => {
    const { adapter, chat } = await online();
    adapter.state.apply("VOICE_STATE_UPDATE", { guild_id: "100", user_id: "2", channel_id: "112", connection_id: "a", self_mute: true, self_stream: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(chat().sidebar.find((i) => i.kind === "voice")!.members).toEqual([
      { name: "Ana", avatarUrl: "https://media.fx/avatars/2/av.png?size=64", muted: true, video: true },
    ]);
  });
});

describe("FluxerAdapter emoji", () => {
  it("gives the view the emoji base and the open server's custom emoji", async () => {
    const ctx = setup({ token: "flx" });
    await ctx.adapter.start();
    await ctx.goOnline();
    expect(ctx.chat()).toMatchObject({ emojiBase: "https://media.fx/emojis", customEmoji: [] });
    ctx.adapter.state.apply("GUILD_EMOJIS_UPDATE", { guild_id: "100", emojis: [{ id: "55", name: "party" }] });
    await ctx.adapter.openServer("100");
    expect(ctx.chat().customEmoji).toEqual([{ id: "55", name: "party", animated: false }]);
    await ctx.adapter.openServer("200");
    expect(ctx.chat().customEmoji).toEqual([]);
  });
});

describe("accounts", () => {
  it("reports who is signed in and signs out on the server", async () => {
    const signedOut = setup();
    expect(signedOut.adapter.accountStatus()).toEqual({ state: "signed-out" });

    const { adapter, goOnline, calls } = setup({ token: "flx_saved" });
    await adapter.start();
    expect(adapter.accountStatus()).toEqual({ state: "signed-in" }); // a saved token, before READY
    await goOnline();
    expect(adapter.accountStatus()).toEqual({ state: "signed-in", name: "me" });
    await adapter.signOut();
    expect(calls.some((c) => c.url.endsWith("/auth/logout"))).toBe(true);
    expect(adapter.accountStatus()).toEqual({ state: "signed-out" });
  });

});

describe("DM previews", () => {
  it("previews the last message once it is known, else its attachments", async () => {
    const { adapter, goOnline } = setup({ token: "flx_saved" });
    await adapter.start();
    await goOnline();
    expect(adapter.directs().find((d) => d.key === "900")).not.toHaveProperty("preview");
    adapter.state.apply("MESSAGE_CREATE", message("950", "900", { content: "hi  <@2>\nthere" }));
    expect(adapter.directs().find((d) => d.key === "900")!.preview).toBe("hi @Ana there");
    adapter.state.apply("MESSAGE_CREATE", message("951", "900", { content: "", attachments: [{ id: "1", filename: "cat.png" }, { id: "2", filename: "a.txt" }] }));
    expect(adapter.directs().find((d) => d.key === "900")!.preview).toBe("📎 cat.png, 📎 a.txt");
  });
});

describe("DM preview upkeep", () => {
  it("follows edits and drops a deleted last message", async () => {
    const { adapter, goOnline } = setup({ token: "flx_saved" });
    await adapter.start();
    await goOnline();
    const preview = () => adapter.directs().find((d) => d.key === "900")!.preview;
    adapter.state.apply("MESSAGE_CREATE", message("950", "900", { content: "first" }));
    adapter.state.addHistory("900", [parseMessage(message("940", "900", { content: "older" }))!], true);
    expect(preview()).toBe("first");
    adapter.state.apply("MESSAGE_UPDATE", message("950", "900", { content: "edited", edited_timestamp: "2026-10-14T12:01:00Z" }));
    expect(preview()).toBe("edited");
    adapter.state.removeMessage("900", "950");
    expect(preview()).toBeUndefined();
    adapter.state.apply("MESSAGE_CREATE", message("960", "900", { content: "again" }));
    adapter.state.apply("MESSAGE_DELETE", { id: "960", channel_id: "900" });
    expect(preview()).toBeUndefined();
  });
});
