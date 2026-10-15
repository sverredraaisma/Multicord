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

  it("checks the instance's health endpoints now and then, for Diagnostics", async () => {
    const { HEALTH_INTERVAL_MS } = await import("../../../src/modules/fluxer/adapter");
    let gateway: { status: number } | Error = { status: 503 };
    let found = false;
    const { adapter, calls, renders } = setup({
      routes: [
        (url) => (url.endsWith("/.well-known/fluxer") && !found ? { status: 503 } : undefined),
        (url) => (url.endsWith("/.well-known/fluxer") ? { status: 200, body: { ...DISCOVERY, app_public: { branding: { status_page_url: "https://status.fx" } } } } : undefined),
        (url) => {
          if (url !== "https://gw.fx/_health") return undefined;
          if (gateway instanceof Error) throw gateway;
          return gateway;
        },
      ],
    });
    expect(adapter.health()).toEqual([]);
    await adapter.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.health()).toEqual([{ name: "Instance found", ok: false, detail: "Could not reach Fluxer: Instance discovery failed (HTTP 503) Nothing works until it does." }]);
    found = true;
    const shown = renders.length;
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    expect(calls.filter((c) => c.url.endsWith("/_health")).map((c) => c.url)).toEqual(["https://api.fx/_health", "https://gw.fx/_health", "https://media.fx/_health"]);
    expect(adapter.health()).toEqual([
      { name: "API answers", ok: true },
      { name: "Gateway answers", ok: false, detail: "It answered HTTP 503. New messages, typing and calls do not arrive. Its status page: https://status.fx" },
      { name: "Media answers", ok: true },
    ]);
    // Each round renders, so the engine reports it.
    expect(renders.length).toBeGreaterThan(shown);
    gateway = new Error("offline");
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    expect(adapter.health()[1]).toEqual({ name: "Gateway answers", ok: false, detail: "It could not be reached (offline). New messages, typing and calls do not arrive. Its status page: https://status.fx" });
    // Nothing is sent with them: no token, no body.
    expect(calls.filter((c) => c.url.endsWith("/_health")).every((c) => c.init.headers === undefined && c.init.body === undefined)).toBe(true);
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
    expect(state.channel!.can).toEqual({ reply: true, react: true, attach: false, typing: true, members: true, stickers: true, gifs: false, pins: true, search: true, forward: true, call: false });
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

  it("marks where a channel's news began when it was opened, from its read state", async () => {
    const ctx = setup({
      token: "flx",
      routes: [
        (url) =>
          url.includes("/channels/111/messages?")
            ? { status: 200, body: [message("430", "111"), message("420", "111", { author: ME }), message("410", "111"), message("390", "111")] }
            : undefined,
      ],
    });
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.openConversation("111");
    expect(ctx.chat().channel!.unread).toEqual({ firstId: "410" });
    // Read meanwhile, it keeps its marker while open; opened again, it has none.
    ctx.adapter.setVisible(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.chat().channel!.unread).toEqual({ firstId: "410" });
    await ctx.adapter.openConversation("113");
    expect(ctx.chat().channel).not.toHaveProperty("unread");
    await ctx.adapter.openConversation("111");
    expect(ctx.chat().channel).not.toHaveProperty("unread");
  });

  it("says a channel's news began above the loaded messages, and gives none where the loaded ones hold nothing new", async () => {
    const ctx = setup({
      token: "flx",
      routes: [(url) => (url.includes("/channels/111/messages?") ? { status: 200, body: Array.from({ length: 50 }, (_, i) => message(String(1000 - i), "111")) } : undefined)],
    });
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.openConversation("111");
    expect(ctx.chat().channel!.unread).toEqual({});
    // The DM was read up to 700; only an older message is loaded, and nothing older is left.
    await ctx.adapter.openConversation("900");
    expect(ctx.chat().channel!.unread).toBeUndefined();
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
                      { id: "4", filename: "clip.mp4", content_type: "video/mp4", url: "https://media.fx/a/clip.mp4", width: 1280, height: 720, size: 99 },
                      { id: "6", filename: "song.ogg", content_type: "audio/ogg", url: "https://media.fx/a/song.ogg" },
                    ],
                    sticker_items: [
                      { id: "50", name: "Wave", format_type: 1 },
                      { id: "51", name: "Dance", format_type: 4 },
                      { id: "52", name: "Lottie", format_type: 3 },
                      { id: "53", name: "Blink", format_type: 2 },
                      { id: "54", name: "Spin", animated: true },
                    ],
                    embeds: [
                      { type: "gifv", video: { url: "https://media.fx/g.mp4" } },
                      { type: "video", video: { url: "https://media.fx/v.mp4" } },
                      { type: "image", image: { url: "https://media.fx/i.png" } },
                      { type: "article", url: "https://site/a", title: "Read" },
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
      canPin: true,
      source: undefined,
      authorId: "2",
      authorMention: "<@2>",
      reply: undefined,
      reactions: [],
      attachments: [
        { name: "cat.png", kind: "image", url: "https://media.fx/a/cat.png", width: undefined, height: undefined, size: undefined, mime: "image/png" },
        { name: "notes.txt", kind: "file", url: "https://media.fx/a/notes.txt", width: undefined, height: undefined, size: undefined, mime: undefined },
        { name: "old.png", kind: "image", url: undefined, width: undefined, height: undefined, size: undefined, mime: "image/png" },
        { name: "clip.mp4", kind: "video", url: "https://media.fx/a/clip.mp4", width: 1280, height: 720, size: 99, mime: "video/mp4" },
        { name: "song.ogg", kind: "audio", url: "https://media.fx/a/song.ogg", width: undefined, height: undefined, size: undefined, mime: "audio/ogg" },
        { name: "Wave", kind: "sticker", url: "https://media.fx/stickers/50.webp?size=160" },
        { name: "Dance", kind: "sticker", url: "https://media.fx/stickers/51.webp?size=160&animated=true" },
        { name: "Lottie", kind: "sticker", url: undefined },
        { name: "Blink", kind: "sticker", url: "https://media.fx/stickers/53.webp?size=160&animated=true" },
        { name: "Spin", kind: "sticker", url: "https://media.fx/stickers/54.webp?size=160&animated=true" },
        { name: "GIF", kind: "video", url: "https://media.fx/g.mp4", previewUrl: undefined, width: undefined, height: undefined, loop: true },
        { name: "Video", kind: "video", url: "https://media.fx/v.mp4", previewUrl: undefined, width: undefined, height: undefined, loop: undefined },
        { name: "Image", kind: "image", url: "https://media.fx/i.png", previewUrl: undefined, width: undefined, height: undefined, loop: undefined },
      ],
      embeds: [{ url: "https://site/a", title: "Read" }],
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

  it("marks messages that mention the user or everyone, never their own", async () => {
    const { adapter, chat } = await online();
    await adapter.openConversation("900");
    await vi.advanceTimersByTimeAsync(100);
    adapter.state.apply("MESSAGE_CREATE", message("801", "900", { mentions: [{ id: "1" }] }));
    adapter.state.apply("MESSAGE_CREATE", message("802", "900", { mention_everyone: true }));
    adapter.state.apply("MESSAGE_CREATE", message("803", "900"));
    adapter.state.apply("MESSAGE_CREATE", message("804", "900", { author: ME, mention_everyone: true }));
    await vi.advanceTimersByTimeAsync(100);
    const shown = chat().channel!.messages.filter((m) => Number(m.id) > 800);
    expect(shown.map((m) => [m.id, m.mentionsMe === true])).toEqual([["801", true], ["802", true], ["803", false], ["804", false]]);
  });

  it("shows channels and DMs muted in Fluxer as muted, without offering to change it", async () => {
    const { adapter, chat } = await online();
    adapter.state.apply("USER_GUILD_SETTINGS_UPDATE", { guild_id: "100", channel_overrides: { "113": { muted: true } } });
    adapter.state.apply("USER_GUILD_SETTINGS_UPDATE", { guild_id: null, muted: true });
    await adapter.openServer("100");
    const lobby = chat().sidebar.find((i) => i.id === "113")!;
    expect(lobby).toMatchObject({ muted: true });
    expect(lobby).not.toHaveProperty("canMute");
    expect(chat().sidebar.find((i) => i.id === "111")).not.toHaveProperty("muted");
    expect(chat().sidebar.filter((i) => i.kind === "category").some((i) => "muted" in i)).toBe(false);
    await adapter.openHome();
    expect(chat().sidebar.every((i) => i.muted === true)).toBe(true);
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
    expect(chat().channel!.can.attach).toBe(true);
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

  it("sends a file the shell hands over at once, or with the files waiting", async () => {
    // One upload slot per file asked for.
    const plan: Handler = (url, init) =>
      url.endsWith("/channels/113/attachments")
        ? { status: 200, body: { attachments: JSON.parse(String(init.body)).attachments.map((_: unknown, i: number) => ({ upload_filename: `up/${i}`, upload_url: `https://store/${i}` })) } }
        : undefined;
    const { adapter, chat, calls } = await withFiles([["a.txt"], Array.from({ length: 10 }, (_, i) => `f${i}.txt`)], [plan]);
    const open = vi.fn((file: { name: string; size: number; type: string }) => ({ filename: file.name, size: file.size, contentType: file.type, read: async () => new Uint8Array([1]) }));
    (adapter as unknown as { deps: { files: { open: typeof open } } }).deps.files.open = open;
    const shared = { handle: "h", name: "dance.gif", size: 1, type: "image/gif" };
    await adapter.handleAction({ type: "sendFile", file: shared, replyTo: "900" });
    expect(open).toHaveBeenCalledWith(shared);
    expect(chat().error).toBeUndefined();
    const sent = calls.filter((c) => c.init.method === "POST" && c.url.endsWith("/channels/113/messages"));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0]!.init.body))).toMatchObject({ content: "", message_reference: { message_id: "900" } });
    expect(chat().channel!.pending).toEqual([]);

    // With files picked already, it joins them.
    await adapter.handleAction({ type: "attach" });
    await adapter.handleAction({ type: "sendFile", file: shared });
    expect(chat().channel!.pending.map((f) => f.name)).toEqual(["a.txt", "dance.gif"]);
    await adapter.handleAction({ type: "send", content: "" });
    await adapter.handleAction({ type: "attach" });
    await adapter.handleAction({ type: "sendFile", file: shared });
    expect(chat().error).toBe("At most 10 files per message.");
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
    await ctx.adapter.handleAction({ type: "sendFile", file: { handle: "h", name: "a.gif", size: 1, type: "image/gif" } }); // nor a way to open files
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
    // A camera that won't start: still in the call, the camera off for everyone.
    await ctx.adapter.handleAction({ type: "voiceState", mute: false, deaf: false, video: true, stream: false });
    await ctx.adapter.handleAction({ type: "voiceNotice", message: "The camera could not start: busy", off: "video" });
    expect(ctx.chat()).toMatchObject({ voice: { video: false }, error: "The camera could not start: busy" });
    expect(ctx.sockets.at(-1)!.sent.at(-1)).toMatchObject({ d: { self_video: false } });
    await ctx.adapter.handleAction({ type: "voiceNotice", message: "Could not switch devices: gone" });
    expect(ctx.chat()).toMatchObject({ voice: { channelId: "112" }, error: "Could not switch devices: gone" });
    await ctx.adapter.handleAction({ type: "voiceError", message: "ICE failed" });
    expect(ctx.chat()).toMatchObject({ voice: null, error: "Voice failed: ICE failed" });
    await ctx.adapter.handleAction({ type: "voiceNotice", message: "late" }); // no call any more
    expect(ctx.chat().error).toBe("Voice failed: ICE failed");

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

describe("FluxerAdapter DM and group calls", () => {
  async function online(routes: Handler[] = []) {
    const ctx = setup({ token: "flx", routes });
    const incoming = vi.fn();
    ctx.adapter.onIncomingCall(incoming);
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.openHome();
    const socket = () => ctx.sockets.at(-1)!;
    const voiceOps = () => socket().sent.filter((p) => p.op === 4).map((p) => p.d);
    let seq = 20;
    const dispatch = async (t: string, d: unknown) => {
      socket().receive({ op: 0, s: seq++, t, d });
      await vi.advanceTimersByTimeAsync(100);
    };
    const rings = () => ctx.calls.filter((c) => c.url.endsWith("/call/ring"));
    return { ...ctx, incoming, socket, voiceOps, dispatch, rings };
  }

  it("offers a call in DMs and groups, starts one by ringing, and joins it without a guild", async () => {
    const { adapter, chat, voiceOps, rings, dispatch } = await online();
    await adapter.handleAction({ type: "select", channelId: "900" });
    expect(chat().channel!.can.call).toBe(true);
    await adapter.handleAction({ type: "joinVoice", channelId: "900" });
    expect(rings().map((c) => [c.init.method, c.init.body])).toEqual([["POST", "{}"]]);
    expect(voiceOps()).toEqual([{ guild_id: null, channel_id: "900", self_mute: false, self_deaf: false, self_video: false, self_stream: false }]);
    expect(chat().voice).toMatchObject({ channelId: "900", channelName: "Ana", guildName: "Call" });
    // The grant for a call has no guild; toggles and leaving say so too.
    await dispatch("VOICE_SERVER_UPDATE", { channel_id: "900", token: "lk", endpoint: "voice.fx", connection_id: "c9" });
    expect(chat().voice).toMatchObject({ url: "wss://voice.fx", token: "lk" });
    await adapter.handleAction({ type: "voiceState", mute: true, deaf: false, video: false, stream: false });
    expect(voiceOps().at(-1)).toMatchObject({ guild_id: null, channel_id: "900", connection_id: "c9", self_mute: true });
    await dispatch("CALL_CREATE", { channel_id: "900", message_id: "5", ringing: ["2"], voice_states: [{ user_id: "1", channel_id: "900", connection_id: "c9" }] });
    expect(chat().sidebar.find((i) => i.id === "900")!.members).toEqual([{ name: "me", avatarUrl: undefined, muted: false, video: false }]);
    await adapter.handleAction({ type: "leaveVoice" });
    expect(voiceOps().at(-1)).toEqual({ guild_id: null, channel_id: null, connection_id: "c9" });
    // A call that is going on is joined without ringing again.
    await adapter.handleAction({ type: "joinVoice", channelId: "900" });
    expect(rings()).toHaveLength(1);
    // Guild text channels take no calls of their own.
    await adapter.openServer("100");
    expect(chat().channel!.can.call).toBe(false);
  });

  it("joins when a call started meanwhile, and says when one cannot start", async () => {
    let answer: { status: number; body?: unknown } = { status: 400, body: { code: "CALL_ALREADY_EXISTS", message: "exists" } };
    const { adapter, chat, voiceOps } = await online([(url) => (url.endsWith("/call/ring") ? answer : undefined)]);
    await adapter.handleAction({ type: "joinVoice", channelId: "901" });
    expect(voiceOps()).toHaveLength(1);
    expect(chat().voice).toMatchObject({ channelId: "901", channelName: "Group" });
    await adapter.handleAction({ type: "leaveVoice" });
    answer = { status: 400, body: { code: "CANNOT_SEND_MESSAGES_TO_USER", message: "Cannot send messages to this user" } };
    await adapter.handleAction({ type: "joinVoice", channelId: "900" });
    expect(voiceOps()).toHaveLength(1);
    expect(chat().error).toMatch(/^Could not start the call: /);
    expect(chat().voice).toBeNull();
  });

  it("shows a call ringing for the user once, with Accept joining and Decline stopping it", async () => {
    const { adapter, chat, incoming, voiceOps, rings, dispatch, calls } = await online();
    const ring = { channel_id: "900", message_id: "5", ringing: ["1"], voice_states: [{ user_id: "2", channel_id: "900", connection_id: "a" }] };
    await dispatch("CALL_CREATE", ring);
    expect(chat().incomingCall).toEqual({ channelId: "900", from: "Ana" });
    expect(incoming).toHaveBeenCalledExactlyOnceWith({ conversationKey: "900", from: "Ana", video: false });
    await dispatch("CALL_UPDATE", ring);
    expect(incoming).toHaveBeenCalledOnce();
    // Declined: the bar goes at once, and Fluxer stops ringing the user alone.
    await adapter.handleAction({ type: "declineCall", channelId: "900" });
    expect(chat().incomingCall).toBeUndefined();
    const stop = calls.filter((c) => c.url.endsWith("/channels/900/call/stop-ringing"));
    expect(stop.map((c) => [c.init.method, c.init.body])).toEqual([["POST", undefined]]);
    // No longer rung, then rung again: news once more.
    await dispatch("CALL_UPDATE", { ...ring, ringing: [] });
    await dispatch("CALL_UPDATE", ring);
    expect(chat().incomingCall).toBeUndefined();
    await dispatch("CALL_DELETE", { channel_id: "900" });
    expect(chat().sidebar.find((i) => i.id === "900")).not.toHaveProperty("members");
    await dispatch("CALL_CREATE", { ...ring, voice_states: [] });
    // With nobody in it yet, the DM's name says who calls.
    expect(chat().incomingCall).toEqual({ channelId: "900", from: "Ana" });
    expect(incoming).toHaveBeenCalledTimes(2);
    await adapter.handleAction({ type: "joinVoice", channelId: "900" });
    expect(rings()).toHaveLength(0);
    expect(voiceOps()).toEqual([expect.objectContaining({ guild_id: null, channel_id: "900" })]);
    expect(chat().incomingCall).toBeUndefined();
    // Calls in unknown channels, or ringing others, are not the user's.
    await dispatch("CALL_CREATE", { channel_id: "404", ringing: ["1"] });
    await dispatch("CALL_CREATE", { channel_id: "901", ringing: ["2"] });
    await dispatch("CALL_CREATE", { channel_id: "x", ringing: ["1"] });
    expect(chat().incomingCall).toBeUndefined();
    await adapter.handleAction({ type: "declineCall", channelId: "903" }); // no such call
    expect(calls.filter((c) => c.url.includes("/call/stop-ringing"))).toHaveLength(1);
  });

  it("says when declining failed", async () => {
    const { adapter, chat, dispatch } = await online([(url) => (url.endsWith("/stop-ringing") ? { status: 404, body: { code: "NO_ACTIVE_CALL", message: "No call" } } : undefined)]);
    await dispatch("CALL_CREATE", { channel_id: "900", ringing: ["1"] });
    await adapter.handleAction({ type: "declineCall", channelId: "900" });
    expect(chat().error).toMatch(/^Could not decline the call: /);
  });

  it("gives up joins Fluxer refuses, and peer-to-peer calls it cannot join", async () => {
    const { adapter, chat, socket, voiceOps, dispatch } = await online();
    await dispatch("CALL_CREATE", { channel_id: "900", ringing: [] });
    await adapter.handleAction({ type: "joinVoice", channelId: "900" });
    socket().receive({ op: 12, d: { code: "VOICE_P2P_CONSENT_REQUIRED", message: "This call is peer-to-peer" } });
    expect(chat()).toMatchObject({ voice: null, error: "This call connects people directly (peer-to-peer), which Multicord does not support." });
    await adapter.handleAction({ type: "joinVoice", channelId: "900" });
    socket().receive({ op: 12, d: { code: "VOICE_CHANNEL_FULL" } });
    expect(chat()).toMatchObject({ voice: null, error: "Could not join: the call is full." });
    await adapter.handleAction({ type: "joinVoice", channelId: "900" });
    socket().receive({ op: 12, d: { code: "SOMETHING_NEW" } });
    expect(chat().error).toBe("Could not join voice (SOMETHING_NEW).");
    // Nothing to give up, or a malformed error: nothing happens.
    socket().receive({ op: 12, d: { code: 5 } });
    socket().receive({ op: 12, d: { code: "VOICE_CHANNEL_FULL" } });
    // A peer-to-peer grant is left at once.
    await adapter.handleAction({ type: "joinVoice", channelId: "900" });
    await dispatch("VOICE_SERVER_UPDATE", { channel_id: "900", connection_id: "p1", p2p: true, ice_servers: [] });
    expect(voiceOps().at(-1)).toEqual({ guild_id: null, channel_id: null, connection_id: "p1" });
    expect(chat().voice).toBeNull();
    // A grant connected already is not given up over a later error.
    await adapter.handleAction({ type: "joinVoice", channelId: "900" });
    await dispatch("VOICE_SERVER_UPDATE", { channel_id: "900", token: "lk", endpoint: "voice.fx", connection_id: "c2" });
    socket().receive({ op: 12, d: { code: "VOICE_CHANNEL_FULL" } });
    expect(chat().voice).toMatchObject({ token: "lk" });
    // A grant for an abandoned call is left without a guild.
    await dispatch("VOICE_SERVER_UPDATE", { channel_id: "901", token: "lk", endpoint: "voice.fx", connection_id: "c3" });
    expect(voiceOps().at(-1)).toEqual({ guild_id: null, channel_id: null, connection_id: "c3" });
  });

  it("offers no calls where the instance runs no voice", async () => {
    const { adapter, chat } = await online([
      (url) => (url.endsWith("/.well-known/fluxer") ? { status: 200, body: { ...DISCOVERY, features: { voice_enabled: false } } } : undefined),
    ]);
    await adapter.handleAction({ type: "select", channelId: "900" });
    expect(chat().channel!.can.call).toBe(false);
  });
});

describe("FluxerAdapter emoji and stickers", () => {
  const PARTY = { id: "55", name: "party", animated: false, url: "https://media.fx/emojis/55.webp?size=48", source: "Alpha" };
  const DANCE = { id: "56", name: "dance", animated: true, url: "https://media.fx/emojis/56.webp?size=48&animated=true", source: "Beta" };
  const ALPHA_PACK = { id: "100", name: "Alpha", stickers: [{ id: "70", name: "Wave", format: "webp", url: "https://media.fx/stickers/70.webp?size=160" }] };
  const BETA_PACK = { id: "200", name: "Beta", stickers: [{ id: "71", name: "Spin", format: "webp", url: "https://media.fx/stickers/71.webp?size=160&animated=true" }] };

  /** Online with emoji and stickers in both guilds; `discovery` replaces the instance's /.well-known/fluxer. */
  async function online(options: { discovery?: unknown; premium?: boolean; routes?: Handler[] } = {}) {
    const discovery = options.discovery;
    const ctx = setup({
      token: "flx",
      routes: [...(options.routes ?? []), ...(discovery ? [(url: string) => (url.endsWith("/.well-known/fluxer") ? { status: 200, body: discovery } : undefined)] : [])],
    });
    await ctx.adapter.start();
    await ctx.goOnline();
    const state = ctx.adapter.state;
    state.apply("GUILD_EMOJIS_UPDATE", { guild_id: "100", emojis: [{ id: "55", name: "party" }] });
    state.apply("GUILD_EMOJIS_UPDATE", { guild_id: "200", emojis: [{ id: "56", name: "dance", animated: true }] });
    state.apply("GUILD_STICKERS_UPDATE", { guild_id: "100", stickers: [{ id: "70", name: "Wave", tags: ["wave"] }, { name: "bad" }] });
    state.apply("GUILD_STICKERS_UPDATE", { guild_id: "200", stickers: [{ id: "71", name: "Spin", animated: true }] });
    if (options.premium) state.apply("USER_UPDATE", { ...ME, traits: ["premium", 7] });
    await vi.advanceTimersByTimeAsync(100);
    return ctx;
  }

  it("offers only the open guild's emoji and stickers without premium, and none in DMs", async () => {
    const ctx = await online();
    expect(ctx.chat()).toMatchObject({ emojiBase: "https://media.fx/emojis", customEmoji: [], stickers: [] });
    await ctx.adapter.openServer("100");
    expect(ctx.chat()).toMatchObject({ customEmoji: [PARTY], stickers: [ALPHA_PACK], channel: { can: { stickers: true } } });
    await ctx.adapter.openServer("200");
    expect(ctx.chat()).toMatchObject({ customEmoji: [DANCE], stickers: [BETA_PACK] });
    await ctx.adapter.openConversation("900");
    expect(ctx.chat()).toMatchObject({ customEmoji: [], stickers: [], channel: { can: { stickers: false } } });
    // A guild without a channel open still counts as the open guild.
    ctx.adapter.state.apply("GUILD_CREATE", { id: "400", properties: { name: "Empty" }, channels: [], emojis: [{ id: "57", name: "x" }], stickers: [] });
    await ctx.adapter.openServer("400");
    expect(ctx.chat()).toMatchObject({ channel: null, customEmoji: [{ id: "57", source: "Empty" }], stickers: [] });
  });

  it("offers every guild's emoji and stickers with premium, the open guild's first", async () => {
    const ctx = await online({ premium: true });
    expect(ctx.adapter.state.traits).toEqual(["premium"]);
    await ctx.adapter.openServer("200");
    expect(ctx.chat()).toMatchObject({ customEmoji: [DANCE, PARTY], stickers: [BETA_PACK, ALPHA_PACK] });
    await ctx.adapter.openConversation("900");
    // In the rail's order: Beta's folder comes first.
    expect(ctx.chat()).toMatchObject({ customEmoji: [DANCE, PARTY], stickers: [BETA_PACK, ALPHA_PACK], channel: { can: { stickers: true } } });
    // A user update without traits keeps them; a guild that goes away takes its expressions along.
    ctx.adapter.state.apply("USER_UPDATE", ME);
    ctx.adapter.state.apply("GUILD_DELETE", { id: "200" });
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.chat()).toMatchObject({ customEmoji: [PARTY], stickers: [ALPHA_PACK] });
    expect(ctx.adapter.state.stickers.has("200")).toBe(false);
  });

  it("follows the instance's published limits", async () => {
    const limits = (rules: unknown[]) => ({ ...DISCOVERY, limits: { version: 2, traitDefinitions: ["premium"], rules, defaultsHash: "x" } });
    const premiumRule = { id: "premium", filters: { traits: ["premium"] }, overrides: { feature_global_expressions: 1 } };
    const free = await online({ discovery: limits([premiumRule, { id: "default", overrides: {} }]) });
    await free.adapter.openConversation("900");
    expect(free.chat().customEmoji).toEqual([]);
    // A self-hosted instance that gives everyone global expressions.
    const everyone = await online({ discovery: limits([{ id: "default", overrides: { feature_global_expressions: 1 } }]) });
    await everyone.adapter.openConversation("900");
    expect(everyone.chat().customEmoji).toEqual([DANCE, PARTY]);
  });

  it("sends offered stickers as stickers and ignores any other id", async () => {
    const ctx = await online();
    await ctx.adapter.handleAction({ type: "sendSticker", stickerId: "70" }); // no channel open
    await ctx.adapter.openServer("100");
    await ctx.adapter.handleAction({ type: "sendSticker", stickerId: "71" }); // Beta's: not usable in Alpha without premium
    await ctx.adapter.handleAction({ type: "sendSticker", stickerId: "999" });
    const posts = () => ctx.calls.filter((c) => c.init.method === "POST" && c.url.endsWith("/messages"));
    expect(posts()).toHaveLength(0);
    await ctx.adapter.handleAction({ type: "sendSticker", stickerId: "70", replyTo: "450" });
    expect(JSON.parse(String(posts()[0]!.init.body))).toMatchObject({ content: "", sticker_ids: ["70"], message_reference: { message_id: "450" } });
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.chat().channel!.messages.map((m) => m.id)).toContain("990");
  });

  it("shows a sticker that could not be sent", async () => {
    let posts = 0;
    const answers = [{ status: 204 }, { status: 403, body: { code: "MISSING_PERMISSIONS", message: "Missing permissions" } }];
    const ctx = await online({ routes: [(url, init) => (init.method === "POST" && url.endsWith("/messages") ? answers[posts++] : undefined)] });
    await ctx.adapter.openServer("100");
    await ctx.adapter.handleAction({ type: "sendSticker", stickerId: "70" }); // accepted without the message in the answer
    expect(ctx.chat().error).toBeUndefined();
    await ctx.adapter.handleAction({ type: "sendSticker", stickerId: "70" });
    expect(ctx.chat().error).toBe("Sticker not sent: Missing permissions");
  });
});

describe("FluxerAdapter GIF search", () => {
  const WITH_GIFS = { ...DISCOVERY, gif: { provider: "klipy", display_name: "Klipy", attribution_required: false }, services: { gif_enabled: true } };
  const GIF = {
    id: "g1",
    url: "https://klipy.com/gifs/cat",
    title: "Cat",
    proxy_src: "https://media.fx/proxy/cat.gif",
    media: { tinymp4: { src: "https://static.klipy.com/cat.mp4", proxy_src: "https://media.fx/proxy/cat.mp4", width: 200, height: 150 } },
  };

  async function online(discovery: unknown, routes: Handler[] = []) {
    const ctx = setup({
      token: "flx",
      routes: [...routes, (url) => (url.endsWith("/.well-known/fluxer") ? { status: 200, body: discovery } : undefined)],
    });
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.openServer("100");
    return ctx;
  }

  it("searches the instance's GIFs once typing pauses, trending for an empty query", async () => {
    const ctx = await online(WITH_GIFS, [(url) => (url.includes("/gifs/") ? { status: 200, body: [GIF, { id: "bad" }] } : undefined)]);
    expect(ctx.chat()).toMatchObject({ channel: { can: { gifs: true } } });
    expect(ctx.chat().gifs).toBeUndefined();
    await ctx.adapter.handleAction({ type: "searchGifs", query: "" });
    expect(ctx.chat().gifs).toEqual({ query: "", results: [], loading: true });
    await vi.advanceTimersByTimeAsync(300);
    const cat = { id: "g1", url: "https://klipy.com/gifs/cat", preview: "https://media.fx/proxy/cat.mp4", video: true, width: 200, height: 150, name: "Cat" };
    expect(ctx.chat().gifs).toEqual({ query: "", results: [cat], loading: false });

    // Typing "c", "ca", "cat " quickly searches once, for the last; earlier results stay while it loads.
    await ctx.adapter.handleAction({ type: "searchGifs", query: "c" });
    await vi.advanceTimersByTimeAsync(100);
    await ctx.adapter.handleAction({ type: "searchGifs", query: "cat " });
    expect(ctx.chat().gifs).toEqual({ query: "cat", results: [cat], loading: true });
    await vi.advanceTimersByTimeAsync(300);
    const searches = ctx.calls.filter((c) => c.url.includes("/gifs/")).map((c) => c.url);
    expect(searches).toEqual(["https://api.fx/v1/gifs/trending", "https://api.fx/v1/gifs/search?q=cat"]);
    expect(ctx.chat().gifs).toMatchObject({ query: "cat", loading: false });
  });

  it("shows only the latest search's answer, and failures", async () => {
    let fail = false;
    const ctx = await online(WITH_GIFS, [(url) => (url.includes("/gifs/") ? (fail ? { status: 500, body: { message: "Provider down" } } : { status: 200, body: [GIF] }) : undefined)]);
    const { FluxerRest } = await import("../../../src/modules/fluxer/rest");
    let release!: (value: never[]) => void;
    const slow = vi.spyOn(FluxerRest.prototype, "gifs").mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    await ctx.adapter.handleAction({ type: "searchGifs", query: "dog" });
    await vi.advanceTimersByTimeAsync(300); // "dog" is now waiting on the server
    await ctx.adapter.handleAction({ type: "searchGifs", query: "cat" });
    await vi.advanceTimersByTimeAsync(300);
    release([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.chat().gifs).toMatchObject({ query: "cat", results: [{ id: "g1" }], loading: false });
    slow.mockRestore();

    fail = true;
    await ctx.adapter.handleAction({ type: "searchGifs", query: "cow" });
    await vi.advanceTimersByTimeAsync(300);
    expect(ctx.chat().gifs).toEqual({ query: "cow", results: [], loading: false, error: "GIF search failed: Provider down" });

    // Signing out forgets the search.
    await ctx.adapter.handleAction({ type: "logout" });
    expect(ctx.adapter.viewState()).toMatchObject({ screen: "login" });
  });

  it("offers no GIF search where the instance has none", async () => {
    for (const discovery of [DISCOVERY, { ...WITH_GIFS, services: { gif_enabled: false } }]) {
      const ctx = await online(discovery);
      await ctx.adapter.handleAction({ type: "searchGifs", query: "cat" });
      await vi.advanceTimersByTimeAsync(300);
      expect(ctx.chat()).toMatchObject({ channel: { can: { gifs: false } } });
      expect(ctx.chat().gifs).toBeUndefined();
      expect(ctx.calls.some((c) => c.url.includes("/gifs/"))).toBe(false);
    }
    // Before signing in there is nothing to search with.
    const signedOut = setup();
    await signedOut.adapter.handleAction({ type: "searchGifs", query: "cat" });
    expect(signedOut.calls).toHaveLength(0);
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

describe("FluxerAdapter pins", () => {
  async function opened(routes: Handler[] = []) {
    const ctx = setup({ token: "flx_saved", routes });
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.openServer("100");
    return ctx;
  }
  const pinsOf = (ctx: Awaited<ReturnType<typeof opened>>) => ctx.chat().channel!.pins;

  it("lists the open channel's pins while the panel is open, following pin changes", async () => {
    let page: unknown = { items: [{ message: message("440", "113", { content: "<@2> said", pinned: true }), pinned_at: "t" }, { message: message("441", "113", { content: "", attachments: [{ id: "1", filename: "a.png" }] }) }, { message: message("442", "113", { content: "", sticker_items: [{ id: "5", name: "Wave" }] }) }, { message: message("443", "113", { content: "" }) }, "junk"], has_more: false };
    const ctx = await opened([(url) => (url.endsWith("/channels/113/messages/pins?limit=50") ? { status: 200, body: page } : undefined)]);
    expect(ctx.chat().channel!.can.pins).toBe(true);
    expect(pinsOf(ctx)).toBeUndefined();
    const pending = ctx.adapter.handleAction({ type: "pins", open: true });
    expect(pinsOf(ctx)).toEqual({ messages: [], loading: true });
    await pending;
    expect(pinsOf(ctx)).toEqual({
      messages: [
        { id: "440", author: "Ana", avatarUrl: "https://media.fx/avatars/2/av.png?size=64", content: "@Ana said", timestamp: "2026-10-14T12:00:00Z" },
        expect.objectContaining({ id: "441", content: "📎 a.png" }),
        expect.objectContaining({ id: "442", content: "Wave (sticker)" }),
        expect.objectContaining({ id: "443", content: "" }),
      ],
      loading: false,
    });
    // Someone pins elsewhere: nothing; here: the list is fetched again.
    page = { items: [] };
    ctx.sockets[0]!.receive({ op: 0, s: 2, t: "CHANNEL_PINS_UPDATE", d: { channel_id: "999" } });
    ctx.sockets[0]!.receive({ op: 0, s: 3, t: "CHANNEL_PINS_UPDATE", d: null });
    await vi.advanceTimersByTimeAsync(100);
    expect(pinsOf(ctx)!.messages).toHaveLength(4);
    ctx.sockets[0]!.receive({ op: 0, s: 4, t: "CHANNEL_PINS_UPDATE", d: { channel_id: "113" } });
    await vi.advanceTimersByTimeAsync(100);
    expect(pinsOf(ctx)!.messages).toEqual([]);
    await ctx.adapter.handleAction({ type: "pins", open: false });
    expect(pinsOf(ctx)).toBeUndefined();
    ctx.sockets[0]!.receive({ op: 0, s: 5, t: "CHANNEL_PINS_UPDATE", d: { channel_id: "113" } });
    // Another channel drops the panel; reopening the same one keeps it.
    await ctx.adapter.handleAction({ type: "pins", open: true });
    await ctx.adapter.handleAction({ type: "select", channelId: "113" });
    expect(pinsOf(ctx)).toBeDefined();
    await ctx.adapter.handleAction({ type: "select", channelId: "111" });
    expect(ctx.chat().channel!.pins).toBeUndefined();
  });

  it("says when the pins cannot be loaded, and drops answers for a closed panel", async () => {
    let fail = true;
    let release: () => void = () => {};
    const ctx = await opened([
      (url) => (url.includes("/messages/pins") && fail ? { status: 403, body: { code: "MISSING_ACCESS", message: "Missing access" } } : undefined),
    ]);
    await ctx.adapter.handleAction({ type: "pins", open: true });
    expect(pinsOf(ctx)).toEqual({ messages: [], loading: false, error: "Could not load pinned messages: Missing access" });
    fail = false;
    ctx.routes.unshift((url) => (url.includes("/messages/pins") ? (release(), { status: 200, body: { items: [] } }) : undefined));
    const reopening = ctx.adapter.handleAction({ type: "pins", open: true });
    await ctx.adapter.handleAction({ type: "pins", open: false });
    await reopening;
    expect(pinsOf(ctx)).toBeUndefined();
    // With no open channel there is nothing to list.
    await ctx.adapter.openHome();
    await ctx.adapter.handleAction({ type: "pins", open: true });
    expect(ctx.calls.filter((c) => c.url.includes("/messages/pins"))).toHaveLength(2);
  });

  it("pins and unpins messages, refreshing the open list, and shows a refusal", async () => {
    let refuse = false;
    const ctx = await opened([
      (url, init) => (url.endsWith("/channels/113/pins/450") ? (refuse ? { status: 403, body: { code: "MISSING_PERMISSIONS", message: "Missing permissions" } } : { status: 204 }) : init.method === "GET" && url.includes("/messages/pins") ? { status: 200, body: { items: [] } } : undefined),
    ]);
    expect(ctx.chat().channel!.messages[0]).toMatchObject({ id: "450", canPin: true });
    expect(ctx.chat().channel!.messages[0]!.pinned).toBeUndefined();
    await ctx.adapter.handleAction({ type: "pin", messageId: "450", pin: true });
    expect(ctx.calls.at(-1)).toMatchObject({ url: "https://api.fx/v1/channels/113/pins/450", init: { method: "PUT" } });
    expect(ctx.chat().channel!.messages[0]!.pinned).toBe(true);
    await ctx.adapter.handleAction({ type: "pins", open: true });
    await ctx.adapter.handleAction({ type: "pin", messageId: "450", pin: false });
    expect(ctx.calls.at(-2)).toMatchObject({ init: { method: "DELETE" } });
    expect(ctx.calls.at(-1)!.url).toContain("/messages/pins");
    expect(ctx.chat().channel!.messages[0]!.pinned).toBeUndefined();
    // A message not loaded here is still sent to the server.
    await ctx.adapter.handleAction({ type: "pin", messageId: "451", pin: true });
    refuse = true;
    await ctx.adapter.handleAction({ type: "pin", messageId: "450", pin: true });
    expect(ctx.chat().error).toBe("Message not pinned: Missing permissions");
    await ctx.adapter.handleAction({ type: "pin", messageId: "450", pin: false });
    expect(ctx.chat().error).toBe("Message not unpinned: Missing permissions");
    await ctx.adapter.openHome();
    const before = ctx.calls.length;
    await ctx.adapter.handleAction({ type: "pin", messageId: "450", pin: true });
    expect(ctx.calls.length).toBe(before);
  });
});

describe("FluxerAdapter search", () => {
  async function opened(routes: Handler[] = []) {
    const ctx = setup({ token: "flx_saved", routes });
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.openServer("100");
    return ctx;
  }
  const searches = (ctx: Awaited<ReturnType<typeof opened>>) => ctx.calls.filter((c) => c.url.endsWith("/search/messages"));

  it("searches a server channel in its server, and a DM among the DMs", async () => {
    let answer: unknown = { messages: [message("440", "113", { content: "found it" }), "junk"], total: 1 };
    const ctx = await opened([(url) => (url.endsWith("/search/messages") ? { status: 200, body: answer } : undefined)]);
    expect(ctx.chat().channel!.can.search).toBe(true);
    const pending = ctx.adapter.handleAction({ type: "search", query: " found " });
    expect(ctx.chat().channel!.search).toEqual({ query: "found", messages: [], loading: true });
    await pending;
    expect(JSON.parse(searches(ctx)[0]!.init.body as string)).toEqual({ context_guild_id: "100", channel_ids: ["113"], content: "found", hits_per_page: 25, page: 1 });
    expect(ctx.chat().channel!.search).toEqual({ query: "found", messages: [expect.objectContaining({ id: "440", content: "found it" })], loading: false });
    // Still indexing: said so.
    answer = { indexing: true };
    await ctx.adapter.handleAction({ type: "search", query: "more" });
    expect(ctx.chat().channel!.search).toMatchObject({ query: "more", messages: [], note: expect.stringContaining("still indexing") });
    answer = "odd";
    await ctx.adapter.handleAction({ type: "search", query: "odd" });
    expect(ctx.chat().channel!.search).toEqual({ query: "odd", messages: [], loading: false });
    // Ended, then another channel.
    await ctx.adapter.handleAction({ type: "search", query: "" });
    expect(ctx.chat().channel!.search).toBeUndefined();
    await ctx.adapter.handleAction({ type: "search", query: "x" });
    await ctx.adapter.handleAction({ type: "select", channelId: "113" });
    expect(ctx.chat().channel!.search).toBeDefined();
    await ctx.adapter.handleAction({ type: "select", channelId: "111" });
    expect(ctx.chat().channel!.search).toBeUndefined();
    await ctx.adapter.openHome();
    await ctx.adapter.handleAction({ type: "select", channelId: "900" });
    await ctx.adapter.handleAction({ type: "search", query: "hi" });
    expect(JSON.parse(searches(ctx).at(-1)!.init.body as string)).toEqual({ scope: "all_dms", channel_ids: ["900"], content: "hi", hits_per_page: 25, page: 1 });
  });

  it("shows failures, and drops answers to earlier searches", async () => {
    let fail = true;
    const ctx = await opened([(url) => (url.endsWith("/search/messages") ? (fail ? { status: 400, body: { code: "BAD", message: "Search is off" } } : { status: 200, body: { messages: [] } }) : undefined)]);
    await ctx.adapter.handleAction({ type: "search", query: "a" });
    expect(ctx.chat().channel!.search).toEqual({ query: "a", messages: [], loading: false, error: "Search failed: Search is off" });
    fail = false;
    const first = ctx.adapter.handleAction({ type: "search", query: "first" });
    const second = ctx.adapter.handleAction({ type: "search", query: "second" });
    await first;
    expect(ctx.chat().channel!.search).toMatchObject({ query: "second", loading: true });
    await second;
    expect(ctx.chat().channel!.search).toMatchObject({ query: "second", loading: false });
    // Ended while running: dropped.
    const ending = ctx.adapter.handleAction({ type: "search", query: "third" });
    await ctx.adapter.handleAction({ type: "search", query: "" });
    await ending;
    expect(ctx.chat().channel!.search).toBeUndefined();
    await ctx.adapter.openHome();
    const before = ctx.calls.length;
    await ctx.adapter.handleAction({ type: "search", query: "nowhere" });
    expect(ctx.calls.length).toBe(before);
  });
});

describe("FluxerAdapter forwarding", () => {
  async function opened(routes: Handler[] = []) {
    const ctx = setup({ token: "flx_saved", routes });
    await ctx.adapter.start();
    await ctx.goOnline();
    await ctx.adapter.openServer("100");
    return ctx;
  }

  it("forwards as a FORWARD reference into another channel or DM, and shows a refusal", async () => {
    let refuse = false;
    const forwarded = message("990", "111", { author: ME, content: "", message_snapshots: [{ message: { content: "m450\nline two", attachments: [{ id: "7", filename: "a.png", url: "https://media.fx/a.png" }] } }] });
    const ctx = await opened([(url, init) => (init.method === "POST" && url.endsWith("/messages") ? (refuse ? { status: 403, body: { code: "NO", message: "Cannot send" } } : { status: 200, body: forwarded }) : undefined)]);
    expect(ctx.chat().channel!.can.forward).toBe(true);
    // Into a loaded channel: it shows there at once, quoted under "Forwarded".
    await ctx.adapter.handleAction({ type: "select", channelId: "111" });
    await ctx.adapter.handleAction({ type: "select", channelId: "113" });
    await ctx.adapter.handleAction({ type: "forward", messageId: "450", channelId: "111" });
    const post = ctx.calls.at(-1)!;
    expect(post.url).toBe("https://api.fx/v1/channels/111/messages");
    expect(JSON.parse(post.init.body as string)).toEqual({ message_reference: { type: 1, message_id: "450", channel_id: "113", guild_id: "100" }, nonce: expect.any(String) });
    await ctx.adapter.handleAction({ type: "select", channelId: "111" });
    const shown = ctx.chat().channel!.messages.at(-1)!;
    expect(shown.content).toBe("*Forwarded*\n> m450\n> line two");
    expect(shown.attachments).toEqual([expect.objectContaining({ name: "a.png", url: "https://media.fx/a.png" })]);
    // From a DM, into a DM not loaded: no guild, nothing added.
    await ctx.adapter.openHome();
    await ctx.adapter.handleAction({ type: "select", channelId: "900" });
    await ctx.adapter.handleAction({ type: "forward", messageId: "450", channelId: "901" });
    expect(JSON.parse(ctx.calls.at(-1)!.init.body as string).message_reference).toEqual({ type: 1, message_id: "450", channel_id: "900" });
    // No such target, or not a text one: nothing sent.
    const before = ctx.calls.length;
    await ctx.adapter.handleAction({ type: "forward", messageId: "450", channelId: "999" });
    await ctx.adapter.handleAction({ type: "forward", messageId: "450", channelId: "112" });
    expect(ctx.calls.length).toBe(before);
    refuse = true;
    await ctx.adapter.handleAction({ type: "forward", messageId: "450", channelId: "901" });
    expect(ctx.chat().error).toBe("Message not forwarded: Cannot send");
  });

  it("shows a forward with words of its own, and one without the original's text", async () => {
    const { parseMessage: parse } = await import("../../../src/modules/fluxer/types");
    expect(parse(message("1", "113", { message_snapshots: [{ message: { content: 5 } }] }))!.forwarded).toEqual({ content: "", attachments: [] });
    expect(parse(message("1", "113", { message_snapshots: ["junk"] }))!.forwarded).toBeUndefined();
    const ctx = await opened([(url) => (url.includes("/messages?") ? { status: 200, body: [message("451", "113", { content: "look", message_snapshots: [{ message: {} }] })] } : undefined)]);
    expect(ctx.chat().channel!.messages[0]!.content).toBe("look\n*Forwarded*");
  });
});

describe("FluxerAdapter members and profiles", () => {
  async function opened(routes: Handler[] = []) {
    const ctx = setup({ token: "flx_saved", routes });
    await ctx.adapter.start();
    await ctx.goOnline();
    ctx.adapter.state.apply("GUILD_SYNC", {
      id: "100",
      properties: { name: "Alpha" },
      roles: [{ id: "100", name: "@everyone", position: 0 }, { id: "50", name: "Mods", color: 0xff0000, position: 2 }, { id: "51", name: "Blue", color: 0x0000ff, position: 1 }, { id: "52", name: "Plain", position: 3 }],
    });
    await ctx.adapter.openServer("100");
    return ctx;
  }
  type Ctx = Awaited<ReturnType<typeof opened>>;
  const lazy = (ctx: Ctx) => ctx.sockets.at(-1)!.sent.filter((p) => p.op === 14).map((p) => p.d);
  const membersOf = (ctx: Ctx) => ctx.chat().channel!.members;
  const dispatch = (ctx: Ctx, t: string, d: unknown) => ctx.sockets.at(-1)!.receive({ op: 0, s: 9, t, d });
  const offline = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ member: { user: { id: String(from + i), username: `u${from + i}` }, roles: [], presence: { status: "offline" } } }));
  /** A list of 2 hoisted, 1 online and 150 offline members: 156 positions. */
  const firstWindow = () => ({
    guild_id: "100",
    id: "113",
    member_count: 153,
    online_count: 3,
    groups: [{ id: "50", count: 2 }, { id: "online", count: 1 }, { id: "offline", count: 150 }],
    ops: [
      {
        op: "SYNC",
        range: [0, 99],
        items: [
          { group: { id: "50", count: 2 } },
          { member: { user: ANA, nick: "Annie", roles: ["50", "51", "999"], presence: { status: "online", custom_status: { text: "brb" } } } },
          { member: { user: { id: "3", username: "bot", bot: true }, roles: ["51"], presence: { status: "dnd" } } },
          { group: { id: "online", count: 1 } },
          { member: { user: { id: "4", username: "cy" }, roles: [], presence: { status: "idle" } } },
          { group: { id: "offline", count: 150 } },
          ...offline(1000, 94),
        ],
      },
    ],
  });

  it("subscribes to the open channel's member list while the panel is open, a window at a time", async () => {
    const ctx = await opened();
    expect(ctx.chat().channel!.can.members).toBe(true);
    expect(membersOf(ctx)).toBeUndefined();
    await ctx.adapter.handleAction({ type: "members", open: true });
    expect(lazy(ctx).at(-1)).toEqual({ subscriptions: { "100": { active: true, typing: true, member_list_channels: { "113": [[0, 99]] } } } });
    expect(membersOf(ctx)).toEqual({ sections: [], hasMore: false, loading: true });

    // A list for another channel is ignored.
    dispatch(ctx, "GUILD_MEMBER_LIST_UPDATE", { ...firstWindow(), id: "111" });
    dispatch(ctx, "GUILD_MEMBER_LIST_UPDATE", firstWindow());
    await vi.advanceTimersByTimeAsync(100);
    const list = membersOf(ctx)!;
    expect(list.sections.map((s) => [s.name, s.members.length])).toEqual([["Mods — 2", 2], ["Online — 1", 1], ["Offline — 150", 94]]);
    expect(list.sections[0]!.members).toEqual([
      { id: "2", name: "Annie", avatarUrl: "https://media.fx/avatars/2/av.png?size=64", presence: "online", color: "#ff0000", status: "brb", mention: "<@2>" },
      { id: "3", name: "bot", presence: "dnd", color: "#0000ff", status: "Bot", mention: "<@3>" },
    ]);
    expect(list.sections[1]!.members[0]).toEqual({ id: "4", name: "cy", presence: "idle", mention: "<@4>" });
    expect(list).toMatchObject({ hasMore: true, loading: false, more: 56 });
    // Their presence is known elsewhere too, e.g. in profiles.
    expect(ctx.adapter.state.presences.get("2")).toEqual({ userId: "2", status: "online", text: "brb" });

    // Only a matching offset asks for the next window, and only once.
    await ctx.adapter.handleAction({ type: "loadMembers", offset: 10 });
    expect(lazy(ctx)).toHaveLength(2);
    await ctx.adapter.handleAction({ type: "loadMembers", offset: 97 });
    expect(lazy(ctx).at(-1)).toEqual({ subscriptions: { "100": { active: true, typing: true, member_list_channels: { "113": [[0, 99], [100, 199]] } } } });
    expect(membersOf(ctx)).toMatchObject({ hasMore: false, loading: true });
    await ctx.adapter.handleAction({ type: "loadMembers", offset: 97 });
    expect(lazy(ctx)).toHaveLength(3);
    dispatch(ctx, "GUILD_MEMBER_LIST_UPDATE", { ...firstWindow(), ops: [{ op: "SYNC", range: [100, 199], items: offline(1094, 56) }] });
    await vi.advanceTimersByTimeAsync(100);
    expect(membersOf(ctx)!.sections.at(-1)!.members).toHaveLength(150);
    expect(membersOf(ctx)).toMatchObject({ hasMore: false, loading: false });
    expect(membersOf(ctx)!.more).toBeUndefined();

    // Closing ends the subscription and forgets the list.
    await ctx.adapter.handleAction({ type: "members", open: false });
    expect(lazy(ctx).at(-1)).toEqual({ subscriptions: { "100": { member_list_channels: { "113": [] } } } });
    expect(membersOf(ctx)).toBeUndefined();
    expect(ctx.adapter.state.memberLists.size).toBe(0);
    await ctx.adapter.handleAction({ type: "loadMembers", offset: 0 });
    expect(lazy(ctx)).toHaveLength(4);
  });

  it("follows the open channel and a new session, and says when no list comes", async () => {
    const ctx = await opened();
    await ctx.adapter.handleAction({ type: "members", open: true });
    await ctx.adapter.handleAction({ type: "select", channelId: "111" });
    expect(lazy(ctx).slice(-2)).toEqual([
      { subscriptions: { "100": { member_list_channels: { "113": [] } } } },
      { subscriptions: { "100": { active: true, typing: true, member_list_channels: { "111": [[0, 99]] } } } },
    ]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(membersOf(ctx)).toEqual({ sections: [], hasMore: false, loading: true, error: "Fluxer did not send this channel's members." });
    // A list that comes late still shows; members before any heading go under "Members", as do unknown roles.
    dispatch(ctx, "GUILD_MEMBER_LIST_UPDATE", {
      guild_id: "100",
      id: "111",
      member_count: 2,
      groups: [{ id: "77", count: 1 }],
      ops: [{ op: "SYNC", range: [0, 2], items: [{ member: { user: ANA, roles: [], presence: { status: "online" } } }, { group: { id: "77", count: 1 } }, { member: { user: { id: "4", username: "cy" }, roles: [] } }] }],
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(membersOf(ctx)!.sections.map((s) => [s.name, s.members.map((m) => m.id)])).toEqual([["Members", ["2"]], ["Members — 1", ["4"]]]);
    expect(membersOf(ctx)).toMatchObject({ hasMore: false, loading: false });
    // A new session subscribes again.
    dispatch(ctx, "READY", readyPayload());
    expect(lazy(ctx).at(-1)).toEqual({ subscriptions: { "100": { active: true, typing: true, member_list_channels: { "111": [[0, 99]] } } } });
    // A list answered in time shows no error.
    await ctx.adapter.openServer("100");
    await ctx.adapter.handleAction({ type: "select", channelId: "113" });
    dispatch(ctx, "GUILD_MEMBER_LIST_UPDATE", { guild_id: "100", id: "113", member_count: 0, groups: [], ops: [] });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(membersOf(ctx)).toEqual({ sections: [], hasMore: false, loading: false });
  });

  it("lists a DM's people with their presence, and forgets the panel with the session", async () => {
    const ctx = await opened();
    await ctx.adapter.handleAction({ type: "members", open: true });
    await ctx.adapter.openHome();
    await ctx.adapter.handleAction({ type: "select", channelId: "900" });
    expect(ctx.chat().channel!.can.members).toBe(true);
    expect(membersOf(ctx)).toEqual({
      sections: [{ name: "Members", members: [{ id: "2", name: "Ana", avatarUrl: "https://media.fx/avatars/2/av.png?size=64", mention: "<@2>" }, { id: "1", name: "me", mention: "<@1>" }] }],
      hasMore: false,
      loading: false,
    });
    dispatch(ctx, "PRESENCE_UPDATE", { user: { id: "1" }, status: "online" });
    dispatch(ctx, "PRESENCE_UPDATE_BULK", { presences: [{ user: { id: "2" }, status: "invisible" }] });
    await vi.advanceTimersByTimeAsync(100);
    expect(membersOf(ctx)!.sections[0]!.members.map((m) => [m.id, m.presence])).toEqual([["1", "online"], ["2", "offline"]]);
    await ctx.adapter.handleAction({ type: "logout" });
    expect(ctx.last().screen).toBe("login");
  });

  it("answers profile cards from what is known, then Fluxer's profile with the open guild's roles", async () => {
    let refuse = false;
    let release: () => void = () => {};
    const ctx = await opened([
      (url) => (refuse && url.includes("/profile") ? { status: 403, body: { code: "MISSING_ACCESS", message: "No" } } : undefined),
      (url) =>
        url === "https://api.fx/v1/users/2/profile?guild_id=100"
          ? { status: 200, body: { user: { ...ANA, discriminator: "0042" }, user_profile: { bio: "Hi there", pronouns: "she/her" }, guild_member: { nick: "Annie", roles: ["50", "100", "51", "52"] } } }
          : undefined,
      (url) => (url === "https://api.fx/v1/users/4/profile" ? (release(), { status: 200, body: { user: { id: "4", username: "cy", discriminator: "0000", bot: true } } }) : undefined),
    ]);
    await ctx.adapter.handleAction({ type: "profile", id: "not an id" });
    expect(ctx.chat().profile).toBeUndefined();
    const pending = ctx.adapter.handleAction({ type: "profile", id: "2" });
    expect(ctx.chat().profile).toEqual({ id: "2", loading: true, name: "Ana", username: "@ana", avatarUrl: "https://media.fx/avatars/2/av.png?size=128" });
    await pending;
    expect(ctx.chat().profile).toEqual({
      id: "2",
      name: "Annie",
      username: "ana#0042",
      avatarUrl: "https://media.fx/avatars/2/av.png?size=128",
      status: "she/her",
      about: "Hi there",
      roles: [{ name: "Plain" }, { name: "Mods", color: "#ff0000" }, { name: "Blue", color: "#0000ff" }],
    });

    // In a DM: no guild; an unknown user starts empty; a card replaced meanwhile is dropped.
    await ctx.adapter.openHome();
    await ctx.adapter.handleAction({ type: "select", channelId: "900" });
    let next: Promise<void> | undefined;
    release = () => {
      release = () => {};
      next = ctx.adapter.handleAction({ type: "profile", id: "5" });
    };
    await ctx.adapter.handleAction({ type: "profile", id: "4" });
    await next;
    expect(ctx.chat().profile).toEqual({ id: "5" });
    ctx.adapter.state.apply("PRESENCE_UPDATE", { user: { id: "4" }, status: "idle" });
    await ctx.adapter.handleAction({ type: "profile", id: "4" });
    expect(ctx.chat().profile).toEqual({ id: "4", name: "cy", username: "@cy", presence: "idle", status: "Bot" });

    // Refused: the card keeps what it has.
    refuse = true;
    await ctx.adapter.handleAction({ type: "profile", id: "2" });
    expect(ctx.chat().profile).toEqual({ id: "2", name: "Ana", username: "@ana", avatarUrl: "https://media.fx/avatars/2/av.png?size=128" });
  });
});
