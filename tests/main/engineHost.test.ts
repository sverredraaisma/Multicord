import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../mocks/electron"));

import * as electron from "../mocks/electron";
import { EngineAdapter, EngineHub, MAX_FILE_HANDLES, serveEngine, type EngineSpec } from "../../src/main/engineHost";
import { readRange } from "../../src/main/files";
import { ENGINE_IPC, ENGINE_SCHEME } from "../../src/shared/engine";
import { NATIVE_IPC } from "../../src/shared/native";

const { ipcMain, session, WebContentsView, dialog, BaseWindow } = electron;
type View = InstanceType<typeof WebContentsView>;

let dist: string;

beforeEach(() => {
  electron.resetElectron();
  dist = fs.mkdtempSync(path.join(os.tmpdir(), "multicord-engine-"));
  fs.mkdirSync(path.join(dist, "engines"));
  fs.writeFileSync(path.join(dist, "engines", "demo.js"), "console.log('engine')");
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dist, { recursive: true, force: true });
});

const capabilities = { directMessages: true, messagePreviews: true, voice: false, screenShare: false };

function setup(extra: Partial<EngineSpec> = {}) {
  const window = new BaseWindow({});
  const hub = new EngineHub({ dist, os: "win32", window: window as never });
  const view = new WebContentsView({ webPreferences: {} });
  const secrets = new Map<string, string>();
  const spec: EngineSpec = {
    def: { id: "demo", name: "Demo", url: "https://demo.example", partition: "persist:demo", module: "demo" },
    engine: "demo",
    home: true,
    capabilities,
    view: view as never,
    secrets: { load: (k) => secrets.get(k), save: (k, v) => void secrets.set(k, v), delete: (k) => void secrets.delete(k) },
    ...extra,
  };
  const { adapter, engine, start } = hub.add(spec);
  const engineView = engine as unknown as View;
  const fromEngine = { sender: engineView.webContents };
  const ask = (request: unknown) => ipcMain.invoke(ENGINE_IPC.invoke, fromEngine, request);
  return { hub, adapter, engine: engineView, view, start, secrets, fromEngine, ask, window };
}

describe("EngineAdapter", () => {
  it("keeps what the engine reports and turns shell calls into commands", async () => {
    const send = vi.fn();
    const adapter = new EngineAdapter("demo", "demo.example", capabilities, send, true);
    const servers = vi.fn();
    const directs = vi.fn();
    const notes = vi.fn();
    const calls = vi.fn();
    const accounts = vi.fn();
    adapter.onServersChanged(servers);
    adapter.onDirectsChanged(directs);
    adapter.onNotification(notes);
    adapter.onIncomingCall(calls);
    adapter.onAccountChanged(accounts);

    adapter.handle({ type: "servers", servers: [{ key: "g", name: "G", unread: false, mentions: 0, kind: "group", children: [{ key: "1", name: "One", unread: true, mentions: 1 }] }] });
    const account = { platform: "demo", instance: "demo.example", accountId: "default" };
    expect(await adapter.listServers()).toEqual([
      { key: "g", name: "G", unread: false, mentions: 0, kind: "group", account, children: [{ key: "1", name: "One", unread: true, mentions: 1, account }] },
    ]);
    adapter.handle({ type: "directs", directs: [{ key: "5", title: "Ana", lastActivity: 1, unread: true, mentions: 1 }] });
    expect(await adapter.listDirectConversations()).toEqual([{ key: "5", title: "Ana", lastActivity: 1, unread: true, mentions: 1, account }]);
    expect(directs).toHaveBeenCalled();
    adapter.handle({ type: "notification", notification: { title: "Ana", body: "hi", target: "5" } });
    adapter.handle({ type: "call", call: { conversationKey: "5", from: "Ana", video: false } });
    expect(notes).toHaveBeenCalledWith({ title: "Ana", body: "hi", target: "5" });
    expect(calls).toHaveBeenCalledWith({ conversationKey: "5", from: "Ana", video: false });
    expect(adapter.accountStatus()).toEqual({ state: "unknown" });
    adapter.handle({ type: "account", account: { state: "signed-in", name: "me" } });
    expect(adapter.accountStatus()).toEqual({ state: "signed-in", name: "me" });
    expect(accounts).toHaveBeenCalledWith({ state: "signed-in", name: "me" });
    servers.mockClear();
    adapter.handle({ type: "homeBadge", badge: { unread: true, mentions: 2 } });
    expect(adapter.homeBadge()).toEqual({ unread: true, mentions: 2 });
    expect(servers).toHaveBeenCalled(); // so the rail picks the badge up

    await adapter.openHome!();
    await adapter.openServer("1");
    await adapter.openConversation("5");
    await adapter.toggleGroup("g");
    adapter.setVisible(true);
    await adapter.signOut();
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { type: "openHome" },
      { type: "openServer", key: "1" },
      { type: "openConversation", key: "5" },
      { type: "toggleGroup", key: "g" },
      { type: "visible", visible: true },
      { type: "signOut" },
    ]);
    expect(adapter.mode).toBe("native");
    expect(new EngineAdapter("x", "x", capabilities, send, false).openHome).toBeUndefined();
  });
});

describe("serveEngine", () => {
  it("serves only the engine page and bundle, with a strict CSP", async () => {
    const page = await serveEngine(dist, "demo", `${ENGINE_SCHEME}://demo/engine.html`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<script src="engine.js">');
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await serveEngine(dist, "demo", `${ENGINE_SCHEME}://demo/`)).status).toBe(200);
    const script = await serveEngine(dist, "demo", `${ENGINE_SCHEME}://demo/engine.js`);
    expect(await script.text()).toBe("console.log('engine')");
    expect(script.headers.get("content-type")).toContain("javascript");
    expect((await serveEngine(dist, "demo", `${ENGINE_SCHEME}://demo/engine.js.map`)).status).toBe(404);
    expect((await serveEngine(dist, "demo", `${ENGINE_SCHEME}://other/engine.js`)).status).toBe(404);
    expect((await serveEngine(dist, "demo", `${ENGINE_SCHEME}://demo/../../credentials.json`)).status).toBe(404);
    expect((await serveEngine(dist, "demo", `${ENGINE_SCHEME}://demo/secret.txt`)).status).toBe(404);
  });
});

describe("EngineHub", () => {
  it("runs each engine hidden, sandboxed and in its own in-memory session", () => {
    const { hub, engine, start, window, view } = setup();
    expect(engine.options.webPreferences).toMatchObject({
      preload: path.join(dist, "preload-engine.js"),
      partition: "engine-demo",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    });
    expect(window.children).not.toContain(engine);
    start();
    expect(engine.webContents.loadURL).toHaveBeenCalledWith(`${ENGINE_SCHEME}://demo/engine.html`);
    expect(engine.webContents.windowOpenHandler!({ url: "https://x" })).toEqual({ action: "deny" });
    const navigation = { preventDefault: vi.fn() };
    engine.webContents.emit("will-navigate", navigation);
    expect(navigation.preventDefault).toHaveBeenCalled();
    expect(() =>
      hub.add({ def: { id: "x", name: "X", url: "https://x.example", partition: "persist:x", module: "x" }, engine: "../bad", home: false, capabilities, view: view as never, secrets: { load: () => undefined, save: () => {}, delete: () => {} } }),
    ).toThrow("Invalid engine id");
  });

  it("denies the engine every permission and serves its page", async () => {
    setup();
    const ses = session.fromPartition("engine-demo");
    const callback = vi.fn();
    (ses.permissionRequestHandler as (...a: unknown[]) => void)(null, "media", callback);
    expect(callback).toHaveBeenCalledWith(false);
    expect((ses.permissionCheckHandler as (...a: unknown[]) => boolean)(null, "notifications")).toBe(false);
    const handler = ses.protocolHandlers.get(ENGINE_SCHEME)!;
    const response = (await handler({ url: `${ENGINE_SCHEME}://demo/engine.js` })) as Response;
    expect(response.status).toBe(200);
  });

  it("lets engines open only WebSockets to allowed public hosts", () => {
    setup({ hosts: ["*.demo.example"] });
    const filter = session.fromPartition("engine-demo").beforeRequest!;
    const decide = (url: string) => {
      let cancel: boolean | undefined;
      filter({ url }, (response) => (cancel = response.cancel));
      return cancel;
    };
    expect(decide(`${ENGINE_SCHEME}://demo/engine.js`)).toBe(false);
    expect(decide("blob:multicord-engine://demo/1")).toBe(false);
    expect(decide("wss://gw.demo.example/")).toBe(false);
    expect(decide("wss://evil.example/")).toBe(true);
    expect(decide("https://api.demo.example/")).toBe(true); // HTTP goes through the bridge
    expect(decide("wss://127.0.0.1/")).toBe(true);
    expect(decide("file:///C:/Users/me/credentials.json")).toBe(true);
  });

  it("answers only its own engines, and holds messages until the engine is up", async () => {
    const { adapter, engine, view, fromEngine, ask } = setup();
    await expect(ipcMain.invoke(ENGINE_IPC.invoke, { sender: view.webContents }, { type: "info" })).rejects.toThrow("Not an engine");
    await expect(ask({ type: "bogus" })).rejects.toThrow("Malformed engine request");

    await adapter.openServer("1");
    ipcMain.emit(NATIVE_IPC.action, { sender: view.webContents }, { type: "ready" });
    ipcMain.emit(NATIVE_IPC.action, { sender: view.webContents }, { type: "bogus" });
    ipcMain.emit(NATIVE_IPC.action, { sender: engine.webContents }, { type: "ready" }); // not a view
    expect(engine.webContents.send).not.toHaveBeenCalled();

    expect(await ask({ type: "info" })).toEqual({ id: "demo", name: "Demo", url: "https://demo.example", os: "win32" });
    expect(engine.webContents.send.mock.calls).toEqual([
      [ENGINE_IPC.command, { type: "openServer", key: "1" }],
      [ENGINE_IPC.action, { type: "ready" }],
    ]);
    adapter.setVisible(false);
    expect(engine.webContents.send).toHaveBeenLastCalledWith(ENGINE_IPC.command, { type: "visible", visible: false });

    // A reload holds messages again until the engine asks for its info.
    engine.webContents.emit("did-start-loading");
    await adapter.openConversation("5");
    expect(engine.webContents.send).toHaveBeenCalledTimes(3);
    await ask({ type: "info" });
    expect(engine.webContents.send).toHaveBeenLastCalledWith(ENGINE_IPC.command, { type: "openConversation", key: "5" });
    expect(fromEngine.sender).toBe(engine.webContents);
  });

  it("validates engine events and relays its display state to its own view only", () => {
    const { adapter, view, fromEngine } = setup();
    const servers = vi.fn();
    adapter.onServersChanged(servers);
    ipcMain.emit(ENGINE_IPC.event, fromEngine, { type: "servers", servers: [{ key: "1", name: "One", unread: false, mentions: 0, iconUrl: "javascript:alert(1)" }] });
    ipcMain.emit(ENGINE_IPC.event, { sender: view.webContents }, { type: "servers", servers: [] });
    expect(servers).not.toHaveBeenCalled();
    ipcMain.emit(ENGINE_IPC.event, fromEngine, { type: "servers", servers: [{ key: "1", name: "One", unread: false, mentions: 0 }] });
    expect(servers).toHaveBeenCalledOnce();

    ipcMain.emit(ENGINE_IPC.render, fromEngine, "not an object");
    ipcMain.emit(ENGINE_IPC.render, { sender: view.webContents }, { screen: "chat" });
    expect(view.webContents.send).not.toHaveBeenCalled();
    ipcMain.emit(ENGINE_IPC.render, fromEngine, { screen: "login" });
    expect(view.webContents.send).toHaveBeenCalledWith(NATIVE_IPC.state, { screen: "login" });
  });

  it("gives the engine its own secrets", async () => {
    const { ask, secrets } = setup();
    await ask({ type: "secretSave", key: "token", value: "abc" });
    expect(secrets.get("token")).toBe("abc");
    expect(await ask({ type: "secretLoad", key: "token" })).toBe("abc");
    await ask({ type: "secretDelete", key: "token" });
    expect(secrets.has("token")).toBe(false);
  });

  it("makes HTTP requests with the engine session, within its hosts", async () => {
    const { ask } = setup({ hosts: ["api.demo.example"] });
    const ses = session.fromPartition("engine-demo");
    ses.fetch.mockResolvedValueOnce(new Response("pong", { status: 200, headers: { "x-a": "1" } }));
    const response = (await ask({ type: "http", request: { url: "https://api.demo.example/ping", method: "GET", headers: { Cookie: "x", Accept: "text/plain" } } })) as { status: number; body: Uint8Array };
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe("pong");
    expect(ses.fetch).toHaveBeenCalledWith("https://api.demo.example/ping", { method: "GET", headers: { Accept: "text/plain" }, body: undefined, redirect: "manual" });
    await expect(ask({ type: "http", request: { url: "https://other.example/", method: "GET", headers: {} } })).rejects.toThrow("not one of this module's hosts");
  });

  it("lets the engine read only files the user picked for it", async () => {
    const { ask, window } = setup();
    const file = path.join(dist, "cat.png");
    fs.writeFileSync(file, "0123456789");
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await ask({ type: "pickFiles" })).toEqual([]);
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
    const [picked] = (await ask({ type: "pickFiles" })) as { handle: string; name: string; size: number; type: string }[];
    expect(picked).toMatchObject({ name: "cat.png", size: 10, type: "image/png" });
    expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(window, expect.objectContaining({ properties: ["openFile", "multiSelections"] }));
    expect(new TextDecoder().decode((await ask({ type: "readFile", handle: picked!.handle, start: 2, end: 5 })) as Uint8Array)).toBe("234");
    expect(new TextDecoder().decode((await ask({ type: "readFile", handle: picked!.handle, start: 8, end: 100 })) as Uint8Array)).toBe("89");
    await expect(ask({ type: "readFile", handle: "made-up", start: 0, end: 1 })).rejects.toThrow("Unknown file");

    // Old handles are forgotten once there are too many.
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: Array.from({ length: MAX_FILE_HANDLES }, () => file) });
    await ask({ type: "pickFiles" });
    await expect(ask({ type: "readFile", handle: picked!.handle, start: 0, end: 1 })).rejects.toThrow("Unknown file");
  });

  it("restarts an engine whose renderer stopped", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { engine } = setup();
    engine.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(warn).toHaveBeenCalledWith("[engine demo] stopped (crashed); restarting");
    vi.advanceTimersByTime(2000);
    expect(engine.webContents.reload).toHaveBeenCalled();
  });
});

describe("readRange", () => {
  it("reads a byte range, short at the end of the file", async () => {
    const file = path.join(dist, "data.bin");
    fs.writeFileSync(file, "abcdef");
    expect(new TextDecoder().decode(await readRange(file, 1, 3))).toBe("bc");
    expect(new TextDecoder().decode(await readRange(file, 4, 10))).toBe("ef");
    expect((await readRange(file, 3, 3)).byteLength).toBe(0);
  });
});
