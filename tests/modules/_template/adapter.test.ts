import { describe, expect, it, vi } from "vitest";
import { CONVERSATION, TemplateAdapter, type TemplateAdapterDeps, type TemplateMessage } from "../../../src/modules/_template/adapter";
import type { AsyncSecretStore } from "../../../src/engine/runtime";
import type { NativeViewState } from "../../../src/shared/native";

const DEF = { id: "template", name: "Example", url: "https://chat.example.org" };
const HELLO: TemplateMessage = { id: "10", author: "bob", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" };

/** An in-memory store, as the shell's scoped one behaves. */
function memorySecrets(initial: Record<string, string> = {}): AsyncSecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    load: async (key) => data.get(key),
    save: async (key, value) => void data.set(key, value),
    delete: async (key) => void data.delete(key),
  };
}

/** The imaginary service the template talks to. */
function fakeService(options: { password?: string; token?: string; fail?: (path: string) => number | Error | string | undefined } = {}) {
  const { password = "secret", token = "t1" } = options;
  const messages = [HELLO];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const failure = options.fail?.(url.pathname);
    if (typeof failure === "number") return new Response("", { status: failure });
    if (failure !== undefined) throw failure;
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    const route = `${init.method} ${url.pathname}`;
    if (route === "POST /api/login") return body.password === password ? json({ token }) : new Response("", { status: 401 });
    if (headers.Authorization !== `Bearer ${token}`) return new Response("", { status: 401 });
    if (route === "GET /api/me") return json({ name: "alice" });
    if (route === "GET /api/messages") return json(messages);
    if (route === "POST /api/messages") {
      const message = { id: String(11 + messages.length), author: "alice", content: body.content, timestamp: "2026-01-02T00:00:00.000Z" };
      messages.push(message);
      return json(message);
    }
    return new Response("", { status: 404 });
  });
  return { fetch, messages };
}

function setup(options: Parameters<typeof fakeService>[0] & { saved?: string; lockHosts?: TemplateAdapterDeps["lockHosts"] | null } = {}) {
  const service = fakeService(options);
  const secrets = memorySecrets(options.saved ? { token: options.saved } : {});
  const render = vi.fn<(state: NativeViewState) => void>();
  const lockHosts = options.lockHosts === null ? undefined : (options.lockHosts ?? vi.fn(async () => {}));
  const adapter = new TemplateAdapter({ def: DEF, fetch: service.fetch as typeof fetch, secrets, render, lockHosts });
  const last = (): NativeViewState => render.mock.lastCall![0];
  return { adapter, service, secrets, render, lockHosts, last };
}

describe("TemplateAdapter", () => {
  it("locks itself to its instance and shows the sign-in screen", async () => {
    const { adapter, lockHosts, last } = setup();
    await adapter.start();
    expect(lockHosts).toHaveBeenCalledWith(["chat.example.org"]);
    expect(last()).toEqual({ screen: "login", platform: "Example", identity: "username", busy: false, error: undefined });
    expect(adapter.accountStatus()).toEqual({ state: "signed-out" });
    expect(await adapter.listDirectConversations()).toEqual([]);
    expect(adapter.homeBadge()).toEqual({ unread: false, mentions: 0 });
  });

  it("starts without a host lock, or when the shell refuses it", async () => {
    await setup({ lockHosts: null }).adapter.start();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter, last } = setup({ lockHosts: async () => Promise.reject(new Error("no")) });
    await adapter.start();
    expect(warn).toHaveBeenCalledWith("[template] host lock refused: no");
    expect(last().screen).toBe("login");
  });

  it("signs in, keeps the token in its own secrets and shows the conversation", async () => {
    const { adapter, secrets, render, last } = setup();
    const directs = vi.fn();
    adapter.onDirectsChanged(directs);
    await adapter.start();
    await adapter.handleAction({ type: "login", identity: "alice", password: "secret" });
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ screen: "login", busy: true }));
    expect(render).toHaveBeenCalledWith({ screen: "connecting", platform: "Example", status: "Connecting…" });
    expect(secrets.data.get("token")).toBe("t1");
    const state = last();
    expect(state).toMatchObject({ screen: "chat", title: "Example", me: "alice", sidebar: [{ id: CONVERSATION, kind: "dm", active: true }], voice: null });
    expect(state.screen === "chat" && state.channel?.messages).toEqual([
      { id: "10", author: "bob", content: "hello", timestamp: HELLO.timestamp, edited: false, mine: false, canEdit: false, canDelete: false, reactions: [], attachments: [] },
    ]);
    expect(adapter.accountStatus()).toEqual({ state: "signed-in", name: "alice" });
    expect(directs).toHaveBeenLastCalledWith([
      { key: CONVERSATION, account: { platform: "template", instance: "chat.example.org", accountId: "default" }, title: "General", lastActivity: Date.parse(HELLO.timestamp), preview: "hello", unread: false, mentions: 0 },
    ]);
  });

  it("says when the password is wrong, or the service fails", async () => {
    const { adapter, last } = setup();
    await adapter.start();
    await adapter.handleAction({ type: "login", identity: "alice", password: "wrong" });
    expect(last()).toMatchObject({ screen: "login", busy: false, error: "Wrong username or password." });
    expect(adapter.accountStatus()).toEqual({ state: "signed-out" });

    const failing = setup({ fail: (path) => (path === "/api/login" ? 500 : undefined) });
    await failing.adapter.handleAction({ type: "login", identity: "alice", password: "secret" });
    expect(failing.last()).toMatchObject({ screen: "login", error: "HTTP 500" });

    const offline = setup({ fail: () => "offline" });
    await offline.adapter.handleAction({ type: "login", identity: "alice", password: "secret" });
    expect(offline.last()).toMatchObject({ screen: "login", error: "offline" });
  });

  it("resumes a saved session, and signs out when the service ended it", async () => {
    const resumed = setup({ saved: "t1" });
    await resumed.adapter.start();
    expect(resumed.last().screen).toBe("chat");

    const ended = setup({ saved: "old" });
    await ended.adapter.start();
    expect(ended.last()).toMatchObject({ screen: "login", error: "Your session ended; sign in again." });
    expect(ended.secrets.data.has("token")).toBe(false);
  });

  it("keeps a saved session it cannot reach, and says why", async () => {
    const { adapter, secrets, last } = setup({ saved: "t1", fail: () => new Error("network down") });
    await adapter.start();
    expect(last()).toEqual({ screen: "connecting", platform: "Example", status: "Can't reach Example: network down" });
    expect(secrets.data.get("token")).toBe("t1");
    expect(adapter.accountStatus()).toEqual({ state: "signed-in" });
  });

  it("sends messages, and says when one is not sent", async () => {
    let failSend = false;
    const { adapter, service, last } = setup({ saved: "t1", fail: (path) => (failSend && path === "/api/messages" ? 503 : undefined) });
    await adapter.start();
    await adapter.handleAction({ type: "send", content: "hi" });
    expect(service.messages.at(-1)).toMatchObject({ author: "alice", content: "hi" });
    const state = last();
    expect(state.screen === "chat" && state.channel?.messages.at(-1)).toMatchObject({ content: "hi", mine: true });
    expect(state).toMatchObject({ error: undefined });

    failSend = true;
    await adapter.handleAction({ type: "send", content: "again" });
    expect(last()).toMatchObject({ screen: "chat", error: "Not sent: HTTP 503" });
  });

  it("sends nothing empty, or before signing in", async () => {
    const { adapter, service } = setup();
    await adapter.start();
    await adapter.handleAction({ type: "send", content: "early" });
    await adapter.handleAction({ type: "login", identity: "alice", password: "secret" });
    const calls = service.fetch.mock.calls.length;
    await adapter.handleAction({ type: "send", content: "   " });
    expect(service.fetch.mock.calls.length).toBe(calls);
    expect(service.messages.map((m) => m.content)).toEqual(["hello"]);
  });

  it("navigates to its one conversation, and refuses others", async () => {
    const { adapter, render } = setup({ saved: "t1" });
    await adapter.start();
    render.mockClear();
    await adapter.openHome();
    await adapter.openConversation(CONVERSATION);
    await adapter.handleAction({ type: "ready" });
    await adapter.handleAction({ type: "select", channelId: CONVERSATION });
    await adapter.handleAction({ type: "loadOlder" });
    expect(render).toHaveBeenCalledTimes(4);
    await expect(adapter.openConversation("2")).rejects.toThrow("Unknown conversation: 2");
    await expect(adapter.openServer("s")).rejects.toThrow("Unknown server: s");
  });

  it("signs out, forgetting the token", async () => {
    const { adapter, secrets, last } = setup({ saved: "t1" });
    const directs = vi.fn();
    adapter.onDirectsChanged(directs);
    await adapter.start();
    await adapter.handleAction({ type: "logout" });
    expect(secrets.data.has("token")).toBe(false);
    expect(directs).toHaveBeenLastCalledWith([]);
    expect(last().screen).toBe("login");
    expect(adapter.accountStatus()).toEqual({ state: "signed-out" });
  });

  it("lists the conversation without a preview when it is empty, and survives odd timestamps", async () => {
    const { adapter, service } = setup({ saved: "t1" });
    service.messages.splice(0);
    await adapter.start();
    const [empty] = await adapter.listDirectConversations();
    expect(empty).toMatchObject({ lastActivity: 0 });
    expect(empty).not.toHaveProperty("preview");
    service.messages.push({ ...HELLO, timestamp: "not a date" });
    await adapter.start();
    expect(await adapter.listDirectConversations()).toEqual([expect.objectContaining({ lastActivity: 0, preview: "hello" })]);
  });
});
