import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../mocks/electron"));

import * as electron from "../mocks/electron";
import { engineStoragePartition, MAX_CRASHES, restartDelay } from "../../src/core/engineAdapter";
import { EngineHub, ATTACH_WINDOW_MS, MAX_FILE_HANDLES, serveEngine, SIGN_IN_WINDOW_MS, type EngineSpec } from "../../src/main/engineHost";
import type { RelaySocket, RelaySocketEvents } from "../../src/core/engineSockets";
import { readRange } from "../../src/main/files";
import { ENGINE_IPC, ENGINE_SCHEME } from "../../src/shared/engine";
import { NATIVE_IPC } from "../../src/shared/native";
import { RELAY_IPC } from "../../src/shared/relay";

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

function setup(extra: Partial<EngineSpec> = {}, openSocket?: (url: string, events: RelaySocketEvents, protocols?: string[]) => RelaySocket) {
  const window = new BaseWindow({});
  const hub = new EngineHub({ dist, os: "win32", window: window as never, openSocket });
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

describe("serveEngine", () => {
  it("serves only the engine page and bundle, with a strict CSP", async () => {
    const page = await serveEngine(dist, "demo", `${ENGINE_SCHEME}://demo/engine.html`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<script src="engine.js">');
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self' blob:; img-src 'self' data: blob:");
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
  it("keeps an engine's storage on disk only when its module asks", () => {
    expect(setup({ persistent: true }).engine.options.webPreferences).toMatchObject({ partition: "persist:engine_demo" });
    expect(engineStoragePartition("x", false)).toBe("engine_x");
    // A service named "Engine Matrix" (id engine-matrix) has persist:engine-matrix: never an engine's.
    expect(engineStoragePartition("matrix", true)).not.toBe("persist:engine-matrix");
  });

  it("runs each engine hidden, sandboxed and in its own in-memory session", () => {
    const { hub, engine, start, window, view } = setup();
    expect(engine.options.webPreferences).toMatchObject({
      preload: path.join(dist, "preload-engine.js"),
      partition: "engine_demo",
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
    const ses = session.fromPartition("engine_demo");
    const callback = vi.fn();
    (ses.permissionRequestHandler as (...a: unknown[]) => void)(null, "media", callback);
    expect(callback).toHaveBeenCalledWith(false);
    expect((ses.permissionCheckHandler as (...a: unknown[]) => boolean)(null, "notifications")).toBe(false);
    const handler = ses.protocolHandlers.get(ENGINE_SCHEME)!;
    const response = (await handler({ url: `${ENGINE_SCHEME}://demo/engine.js` })) as Response;
    expect(response.status).toBe(200);
  });

  it("lets the relay page open only WebSockets to allowed public hosts", async () => {
    const { ask } = setup({ hosts: ["*.demo.example"] });
    await ask({ type: "socketOpen", url: "wss://gw.demo.example/" });
    const relay = WebContentsView.instances.at(-1)!;
    const filter = session.fromPartition("engine_demo").beforeRequest!;
    const decide = (url: string) => {
      return new Promise<boolean>((resolve) => filter({ url, webContents: relay.webContents } as { url: string }, (response) => resolve(response.cancel)));
    };
    expect(await decide(`${ENGINE_SCHEME}://demo/engine.js`)).toBe(false);
    expect(await decide("blob:multicord-engine://demo/1")).toBe(false);
    expect(await decide("wss://gw.demo.example/")).toBe(false);
    expect(await decide("wss://evil.example/")).toBe(true);
    expect(await decide("https://api.demo.example/")).toBe(true); // HTTP goes through the bridge
    expect(await decide("wss://127.0.0.1/")).toBe(true);
    expect(await decide("file:///C:/Users/me/credentials.json")).toBe(true);
  });

  it("lets only the relay page open WebSockets in an engine's session", async () => {
    const { engine, ask } = setup();
    const filter = session.fromPartition("engine_demo").beforeRequest!;
    const cancelled = (url: string, webContents?: unknown) => new Promise<boolean>((resolve) => filter({ url, webContents } as { url: string }, (response) => resolve(response.cancel)));
    expect(await cancelled(`${ENGINE_SCHEME}://demo/engine.js`, engine.webContents)).toBe(false);
    expect(await cancelled("wss://gw.example/", engine.webContents)).toBe(true);
    expect(await cancelled("wss://gw.example/")).toBe(true);
    // The relay page exists once the engine asks for a socket.
    await ask({ type: "socketOpen", url: "wss://gw.example/" });
    const relay = WebContentsView.instances.at(-1)!;
    expect(await cancelled("wss://gw.example/", relay.webContents)).toBe(false);
    expect(await cancelled("wss://127.0.0.1/", relay.webContents)).toBe(true);
    expect(await cancelled("wss://gw.example/", engine.webContents)).toBe(true);
  });

  it("checks what host names resolve to, for the bridge, the engine's sockets and its view", async () => {
    const { view, ask } = setup();
    await ask({ type: "socketOpen", url: "wss://gw.example/" });
    const relay = WebContentsView.instances.at(-1)!;
    const filters = [session.fromPartition("engine_http_demo"), session.fromPartition("engine_demo"), view.webContents.session as unknown as ReturnType<typeof session.fromPartition>];
    for (const ses of filters) ses.resolveHost.mockResolvedValue({ endpoints: [{ address: "10.0.0.5", family: "ipv4" }] });
    for (const [ses, url] of [[filters[0]!, "https://rebind.example/"], [filters[1]!, "wss://rebind.example/"], [filters[2]!, "https://rebind.example/a.png"]] as const) {
      const cancel = await new Promise<boolean>((resolve) => ses.beforeRequest!({ url, webContents: relay.webContents } as { url: string }, (response) => resolve(response.cancel)));
      expect(cancel).toBe(true);
    }
  });

  it("keeps the module's view within the engine's reach", async () => {
    const { ask, view } = setup();
    const filter = (view.webContents.session as unknown as { beforeRequest: (d: { url: string }, cb: (r: { cancel: boolean }) => void) => void }).beforeRequest;
    const cancelled = (url: string) => {
      return new Promise<boolean>((resolve) => filter({ url }, (response) => resolve(response.cancel)));
    };
    expect(await cancelled("file:///C:/app/dist/native.js")).toBe(false);
    expect(await cancelled("data:image/png;base64,AA")).toBe(false);
    expect(await cancelled("blob:file:///1")).toBe(false);
    expect(await cancelled("multicord-media://media/abc")).toBe(false);
    expect(await cancelled("https://cdn.anywhere.example/a.png")).toBe(false);
    expect(await cancelled("https://192.168.1.1/admin")).toBe(true);
    expect(await cancelled("http://cdn.anywhere.example/a.png")).toBe(true);
    await ask({ type: "lockHosts", hosts: ["*.demo.example"] });
    expect(await cancelled("https://cdn.demo.example/a.png")).toBe(false);
    expect(await cancelled("wss://voice.demo.example/")).toBe(false);
    expect(await cancelled("https://evil.example/?leak=1")).toBe(true);
  });

  it("lets an engine lock itself to fewer hosts, for HTTP and WebSockets, but never widen", async () => {
    const { ask } = setup();
    await ask({ type: "socketOpen", url: "wss://gw.example/" });
    const relay = WebContentsView.instances.at(-1)!;
    const http = session.fromPartition("engine_http_demo");
    const sockets = session.fromPartition("engine_demo").beforeRequest!;
    // As the relay page opens them; the HTTP bridge's requests come from no page.
    const cancelled = (filter: typeof sockets, url: string) => {
      return new Promise<boolean>((resolve) => filter({ url, webContents: relay.webContents } as { url: string }, (response) => resolve(response.cancel)));
    };
    expect(await cancelled(sockets, "wss://anywhere.example/")).toBe(false);
    expect(await ask({ type: "lockHosts", hosts: ["*.demo.example"] })).toEqual(["*.demo.example"]);
    expect(await cancelled(sockets, "wss://gw.demo.example/")).toBe(false);
    expect(await cancelled(sockets, "wss://anywhere.example/")).toBe(true);
    expect(await cancelled(http.beforeRequest!, "https://anywhere.example/")).toBe(true);
    await expect(ask({ type: "http", request: { url: "https://anywhere.example/", method: "GET", headers: {} } })).rejects.toThrow("not one of this module's hosts");
    await expect(ask({ type: "lockHosts", hosts: ["anywhere.example"] })).rejects.toThrow("can only narrow");
    expect(await ask({ type: "lockHosts", hosts: ["api.demo.example"] })).toEqual(["api.demo.example"]);
    expect(await cancelled(sockets, "wss://gw.demo.example/")).toBe(true);
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

  it("gives the engine its service's settings values with its info, as they are when asked", async () => {
    let values = { typing: true };
    const { ask, adapter, fromEngine } = setup({ settings: () => values });
    expect(await ask({ type: "info" })).toEqual({ id: "demo", name: "Demo", url: "https://demo.example", os: "win32", settings: { typing: true } });
    values = { typing: false };
    expect(await ask({ type: "info" })).toMatchObject({ settings: { typing: false } });
    // A malformed status from the engine is dropped.
    ipcMain.emit(ENGINE_IPC.event, fromEngine, { type: "settingsStatus", status: { forget: { text: 5 } } });
    expect(adapter.settingsStatus()).toEqual({});
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
    const ses = session.fromPartition("engine_http_demo");
    ses.fetch.mockResolvedValueOnce(new Response("pong", { status: 200, headers: { "x-a": "1" } }));
    const response = (await ask({ type: "http", request: { url: "https://api.demo.example/ping", method: "GET", headers: { Cookie: "x", Accept: "text/plain" } } })) as { status: number; body: Uint8Array };
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe("pong");
    expect(ses.fetch).toHaveBeenCalledWith("https://api.demo.example/ping", { method: "GET", headers: { Accept: "text/plain" }, body: undefined, redirect: "follow", credentials: "omit" });
    await expect(ask({ type: "http", request: { url: "https://other.example/", method: "GET", headers: {} } })).rejects.toThrow("not one of this module's hosts");

    // net.fetch follows redirects itself: the bridge session checks every hop.
    const filter = ses.beforeRequest!;
    const cancelled = (url: string) => {
      return new Promise<boolean>((resolve) => filter({ url }, (response) => resolve(response.cancel)));
    };
    expect(await cancelled("https://api.demo.example/next")).toBe(false);
    expect(await cancelled("https://elsewhere.example/")).toBe(true);
    expect(await cancelled("https://192.168.1.1/")).toBe(true);
    expect(await cancelled("http://api.demo.example/")).toBe(true);
  });

  it("starts single sign-on only right after a sign-in step in the module's view, to an SSO address on its hosts, and hands that engine the token", async () => {
    const { ask, view } = setup({ hosts: ["hs.demo.example"] });
    const submit = () => ipcMain.emit(NATIVE_IPC.action, { sender: view.webContents }, { type: "prompt", id: "sso", values: {} });
    const url = "https://hs.demo.example/_matrix/client/v3/login/sso/redirect";
    const opened: string[] = [];
    electron.shell.openExternal.mockImplementation(async (address: string) => void opened.push(address));
    /** The browser coming back from the homeserver with a token. */
    const comeBack = async (token: string) => {
      await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
      const back = new URL(new URL(opened.shift()!).searchParams.get("redirectUrl")!);
      back.searchParams.set("loginToken", token);
      await fetch(back.href);
    };
    await expect(ask({ type: "ssoSignIn", url })).rejects.toThrow("only when the user signs in");
    submit();
    const signedIn = ask({ type: "ssoSignIn", url });
    await comeBack("syl_ok");
    expect(await signedIn).toEqual({ loginToken: "syl_ok" });
    // Once per sign-in step, and only to an SSO address on the engine's hosts.
    await expect(ask({ type: "ssoSignIn", url })).rejects.toThrow("only when the user signs in");
    submit();
    await expect(ask({ type: "ssoSignIn", url: "https://other.example/_matrix/client/v3/login/sso/redirect" })).rejects.toThrow("not one of this module's hosts");
    submit();
    await expect(ask({ type: "ssoSignIn", url: "https://hs.demo.example/elsewhere" })).rejects.toThrow("no single sign-on address");
    // A new sign-on cancels the one still waiting.
    submit();
    const first = ask({ type: "ssoSignIn", url });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    opened.shift();
    submit();
    const second = ask({ type: "ssoSignIn", url });
    await expect(first).rejects.toThrow("cancelled");
    await comeBack("syl_second");
    expect(await second).toEqual({ loginToken: "syl_second" });
    // A sign-in step long ago does not count.
    vi.useFakeTimers();
    submit();
    vi.advanceTimersByTime(SIGN_IN_WINDOW_MS + 1);
    await expect(ask({ type: "ssoSignIn", url })).rejects.toThrow("only when the user signs in");
  });

  it("lets the engine read only files the user picked for it", async () => {
    const { ask, window, view } = setup();
    const attach = () => ipcMain.emit(NATIVE_IPC.action, { sender: view.webContents }, { type: "attach" });
    const file = path.join(dist, "cat.png");
    fs.writeFileSync(file, "0123456789");
    // No dialog unless the user just clicked attach in the module's view, and one per click.
    await expect(ask({ type: "pickFiles" })).rejects.toThrow("only be picked when the user asks");
    attach();
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await ask({ type: "pickFiles" })).toEqual([]);
    await expect(ask({ type: "pickFiles" })).rejects.toThrow("only be picked when the user asks");
    attach();
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
    const [picked] = (await ask({ type: "pickFiles" })) as { handle: string; name: string; size: number; type: string }[];
    expect(picked).toMatchObject({ name: "cat.png", size: 10, type: "image/png" });
    expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(window, expect.objectContaining({ title: "Attach files to Demo", properties: ["openFile", "multiSelections"] }));
    expect(new TextDecoder().decode((await ask({ type: "readFile", handle: picked!.handle, start: 2, end: 5 })) as Uint8Array)).toBe("234");
    expect(new TextDecoder().decode((await ask({ type: "readFile", handle: picked!.handle, start: 8, end: 100 })) as Uint8Array)).toBe("89");
    await expect(ask({ type: "readFile", handle: "made-up", start: 0, end: 1 })).rejects.toThrow("Unknown file");

    // Old handles are forgotten once there are too many.
    attach();
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: Array.from({ length: MAX_FILE_HANDLES }, () => file) });
    await ask({ type: "pickFiles" });

    // A click long ago does not count.
    vi.useFakeTimers();
    attach();
    vi.advanceTimersByTime(ATTACH_WINDOW_MS + 1);
    await expect(ask({ type: "pickFiles" })).rejects.toThrow("only be picked when the user asks");
    vi.useRealTimers();
    await expect(ask({ type: "readFile", handle: picked!.handle, start: 0, end: 1 })).rejects.toThrow("Unknown file");
  });

  it("hands the engine the shell's files to send, read through handles like picked ones", async () => {
    const { hub, ask, view, engine, start } = setup();
    const file = path.join(dist, "dance.gif");
    fs.writeFileSync(file, "GIF89a");
    start();
    await ask({ type: "info" });
    expect(hub.shareFile(view.webContents as never, { path: file, size: 6, name: "dance.gif", type: "image/gif" }, "42")).toBe(true);
    const [channel, action] = engine.webContents.send.mock.calls.at(-1)! as [string, { type: string; file: { handle: string }; replyTo?: string }];
    expect(channel).toBe(ENGINE_IPC.action);
    expect(action).toEqual({ type: "sendFile", file: { handle: expect.any(String), name: "dance.gif", size: 6, type: "image/gif" }, replyTo: "42" });
    expect(new TextDecoder().decode((await ask({ type: "readFile", handle: action.file.handle, start: 0, end: 3 })) as Uint8Array)).toBe("GIF");
    hub.shareFile(view.webContents as never, { path: file, size: 6, name: "dance.gif", type: "image/gif" });
    expect(engine.webContents.send.mock.calls.at(-1)![1]).not.toHaveProperty("replyTo");
    // Only into an engine's own view.
    expect(hub.shareFile(engine.webContents as never, { path: file, size: 6, name: "x", type: "image/gif" })).toBe(false);
  });

  it("tells the shell which hosts a module's view may reach", async () => {
    const { hub, ask, view, engine } = setup({ hosts: ["*.demo.example"] });
    expect(hub.hostsFor(view.webContents as never)).toEqual(["*.demo.example"]);
    await ask({ type: "lockHosts", hosts: ["cdn.demo.example"] });
    expect(hub.hostsFor(view.webContents as never)).toEqual(["cdn.demo.example"]);
    expect(hub.hostsFor(engine.webContents as never)).toBeUndefined();
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

describe("engine health", () => {
  afterEach(() => vi.useRealTimers());

  it("reports the engine starting, running, busy and restarting", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter, engine, ask } = setup();
    expect(adapter.health()).toEqual([{ name: "Engine running", ok: false, detail: "Starting; messages and notifications arrive once it runs." }]);
    await ask({ type: "info" });
    expect(adapter.health()).toEqual([
      { name: "Engine running", ok: true },
      { name: "Engine responsive", ok: true },
    ]);
    engine.webContents.emit("unresponsive");
    expect(adapter.health()[1]).toEqual({ name: "Engine responsive", ok: false, detail: "The engine is busy; messages and notifications are delayed." });
    engine.webContents.emit("responsive");
    expect(adapter.health()[1]!.ok).toBe(true);

    engine.webContents.emit("render-process-gone", {}, { reason: "oom" });
    expect(adapter.health()[0]!.detail).toBe("Starting; messages and notifications arrive once it runs. It has restarted 1 time (last: oom).");
    vi.advanceTimersByTime(2000);
    await ask({ type: "info" });
    expect(adapter.health()[0]).toEqual({ name: "Engine running", ok: true, detail: "It has restarted 1 time (last: oom)." });
  });

  it("backs off between crashes and gives up on an engine that keeps crashing", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter, engine, ask } = setup();
    expect([1, 2, 3, 4, 5, 6].map(restartDelay)).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
    for (let crash = 1; crash <= MAX_CRASHES; crash++) {
      engine.webContents.reload.mockClear();
      engine.webContents.emit("render-process-gone", {}, { reason: "crashed" });
      vi.advanceTimersByTime(restartDelay(crash) - 1);
      expect(engine.webContents.reload).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(engine.webContents.reload).toHaveBeenCalled();
      await ask({ type: "info" }); // comes back, but crashes again soon
    }
    engine.webContents.reload.mockClear();
    engine.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    vi.advanceTimersByTime(60_000);
    expect(engine.webContents.reload).not.toHaveBeenCalled();
    expect(warn).toHaveBeenLastCalledWith(`[engine demo] stopped (crashed); crashed ${MAX_CRASHES} times in a row, not restarting`);
    expect(adapter.health()).toEqual([
      {
        name: "Engine running",
        ok: false,
        detail: "Stopped after crashing repeatedly; restart Multicord to try again. Nothing from this service arrives. It has restarted 5 times (last: crashed).",
      },
    ]);
  });

  it("starts a fresh count after the engine ran for a while", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { engine, ask } = setup();
    for (let crash = 1; crash <= MAX_CRASHES + 2; crash++) {
      await ask({ type: "info" });
      vi.advanceTimersByTime(60_000);
      engine.webContents.reload.mockClear();
      engine.webContents.emit("render-process-gone", {}, { reason: "crashed" });
      vi.advanceTimersByTime(2000);
      expect(engine.webContents.reload).toHaveBeenCalled();
    }
  });
});

describe("bridged sockets", () => {
  function withSockets(extra: Partial<EngineSpec> = {}) {
    const opened: { url: string; protocols?: string[]; events: RelaySocketEvents; socket: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; bufferedAmount: number } }[] = [];
    const parts = setup(extra, (url, events, protocols) => {
      const socket = { send: vi.fn(), close: vi.fn(), bufferedAmount: 0 };
      opened.push({ url, protocols, events, socket });
      return socket;
    });
    const sent = () => parts.engine.webContents.send.mock.calls.filter(([channel]) => channel === ENGINE_IPC.socket).map(([, event]) => event);
    return { ...parts, opened, sent };
  }

  it("opens the engine's sockets where its own would be allowed, and relays frames both ways", async () => {
    const { ask, opened, sent } = withSockets({ hosts: ["*.demo.example"] });
    await ask({ type: "info" });
    const { id } = (await ask({ type: "socketOpen", url: "wss://gw.demo.example/?v=1" })) as { id: string };
    expect(opened.map((o) => o.url)).toEqual(["wss://gw.demo.example/?v=1"]);
    opened[0]!.events.open();
    await ask({ type: "socketSend", id, data: "hello" });
    expect(opened[0]!.socket.send).toHaveBeenCalledWith("hello");
    opened[0]!.events.message("hi");
    await ask({ type: "socketClose", id, code: 4000, reason: "done" });
    expect(opened[0]!.socket.close).toHaveBeenCalledWith(4000, "done");
    expect(sent()).toEqual([
      { type: "open", id },
      { type: "message", id, data: "hi" },
      { type: "close", id, code: 4000, reason: "done" },
    ]);
    await expect(ask({ type: "socketSend", id, data: "again" })).rejects.toThrow("No such open socket");
  });

  it("offers the server the subprotocols the engine names, and tells it which one was chosen", async () => {
    const { ask, opened, sent } = withSockets();
    await ask({ type: "info" });
    const { id } = (await ask({ type: "socketOpen", url: "wss://gw.example/", protocols: ["binary"] })) as { id: string };
    expect(opened[0]!.protocols).toEqual(["binary"]);
    opened[0]!.events.open("binary");
    expect(sent()).toEqual([{ type: "open", id, protocol: "binary" }]);
    await expect(ask({ type: "socketOpen", url: "wss://gw.example/", protocols: ["not a token"] })).rejects.toThrow("Malformed engine request");
  });

  it("refuses sockets the engine may not open: not wss, other hosts, private addresses", async () => {
    const { ask, opened } = withSockets({ hosts: ["*.demo.example"] });
    await expect(ask({ type: "socketOpen", url: "ws://gw.demo.example/" })).rejects.toThrow("Socket refused: ws: is not allowed");
    await expect(ask({ type: "socketOpen", url: "wss://evil.example/" })).rejects.toThrow("not one of this module's hosts");
    await expect(ask({ type: "socketOpen", url: "wss://127.0.0.1/" })).rejects.toThrow("local or private");
    session.fromPartition("engine_demo").resolveHost.mockResolvedValue({ endpoints: [{ address: "10.0.0.5", family: "ipv4" }] });
    await expect(ask({ type: "socketOpen", url: "wss://rebind.demo.example/" })).rejects.toThrow("resolves to a local or private address");
    // A lock narrows bridged sockets as it does the engine's own.
    await ask({ type: "lockHosts", hosts: ["api.demo.example"] });
    await expect(ask({ type: "socketOpen", url: "wss://gw.demo.example/" })).rejects.toThrow("not one of this module's hosts");
    await expect(ask({ type: "socketOpen", url: "https://api.demo.example/" })).rejects.toThrow("https: is not allowed");
    await expect(ask({ type: "socketSend", id: "1", data: {} })).rejects.toThrow("Malformed engine request");
    expect(opened).toHaveLength(0);
  });

  it("closes the engine's sockets when it reloads, crashes or goes away", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ask, engine, opened } = withSockets();
    const openOne = async () => {
      await ask({ type: "socketOpen", url: "wss://gw.example/" });
      return opened.at(-1)!.socket;
    };
    let socket = await openOne();
    engine.webContents.emit("did-start-loading");
    expect(socket.close).toHaveBeenCalledWith();
    socket = await openOne();
    engine.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(socket.close).toHaveBeenCalledWith();
    socket = await openOne();
    engine.webContents.emit("destroyed");
    expect(socket.close).toHaveBeenCalledWith();
  });

  it("opens sockets in a relay page of its own, in the engine's session, which only its page may report for", async () => {
    const { ask, engine, hub } = setup();
    const otherView = new WebContentsView({ webPreferences: {} });
    const other = hub.add({ def: { id: "other", name: "Other", url: "https://other.example", partition: "persist:other", module: "other" }, engine: "other", home: false, capabilities, view: otherView as never, secrets: { load: () => undefined, save: () => {}, delete: () => {} } });
    await ask({ type: "info" });
    expect(WebContentsView.instances).toHaveLength(4);
    const { id } = (await ask({ type: "socketOpen", url: "wss://gw.example/" })) as { id: string };
    const relay = WebContentsView.instances.at(-1)!;
    expect(relay.options.webPreferences).toMatchObject({
      preload: path.join(dist, "preload-relay.js"),
      partition: "engine_demo",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    });
    expect(electron.BaseWindow.instances[0]!.children).not.toContain(relay);
    expect(relay.webContents.loadURL).toHaveBeenCalledWith(`${ENGINE_SCHEME}://demo.relay/relay.html`);
    expect(relay.webContents.windowOpenHandler!({ url: "https://x" })).toEqual({ action: "deny" });
    const navigation = { preventDefault: vi.fn() };
    relay.webContents.emit("will-navigate", navigation);
    expect(navigation.preventDefault).toHaveBeenCalled();
    // The engine's session serves the relay page on its own host.
    const handler = session.fromPartition("engine_demo").protocolHandlers.get(ENGINE_SCHEME)!;
    const page = (await handler({ url: `${ENGINE_SCHEME}://demo.relay/relay.html` })) as Response;
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; connect-src wss:");

    const report = (sender: unknown, payload: unknown) => ipcMain.emit(RELAY_IPC.event, { sender }, payload);
    report(relay.webContents, { type: "ready" });
    expect(relay.webContents.send).toHaveBeenCalledWith(RELAY_IPC.command, { type: "open", id: "1", url: "wss://gw.example/" });
    // Neither the engine nor another engine's page can report for this relay.
    report(engine.webContents, { type: "open", id: "1" });
    report((other.engine as unknown as View).webContents, { type: "open", id: "1" });
    const events = () => engine.webContents.send.mock.calls.filter(([channel]) => channel === ENGINE_IPC.socket).map(([, event]) => event);
    expect(events()).toEqual([]);
    report(relay.webContents, { type: "open", id: "1" });
    expect(events()).toEqual([{ type: "open", id }]);
    await ask({ type: "socketSend", id, data: "hello" });
    expect(relay.webContents.send).toHaveBeenLastCalledWith(RELAY_IPC.command, { type: "send", id: "1", data: "hello" });

    // When the engine goes away, so do its sockets and its relay page.
    engine.webContents.emit("destroyed");
    expect(relay.webContents.send).toHaveBeenLastCalledWith(RELAY_IPC.command, { type: "close", id: "1" });
    expect(relay.webContents.close).toHaveBeenCalled();
  });
});
