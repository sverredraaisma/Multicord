import fs from "node:fs";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../mocks/electron"));
const updater = vi.hoisted(() => ({
  autoDownload: false,
  autoInstallOnAppQuit: false,
  checkForUpdates: vi.fn(async () => null),
  quitAndInstall: vi.fn(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, listener);
  },
}));
vi.mock("electron-updater", () => ({ autoUpdater: updater }));
// Background push to talk must not hook the real keyboard in tests.
const keyHook = vi.hoisted(() => ({ listeners: new Map<string, (event: { keycode: number }) => void>(), start: () => {}, stop: () => {} }));
vi.mock("../../src/main/pushToTalk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/main/pushToTalk")>()),
  loadKeyHook: () => ({
    on: (event: string, listener: (event: { keycode: number }) => void) => keyHook.listeners.set(event, listener),
    off: (event: string) => keyHook.listeners.delete(event),
    start: () => keyHook.start(),
    stop: () => keyHook.stop(),
  }),
}));
// Game detection must not download Discord's list or scan processes in tests.
const detector = vi.hoisted(() => ({
  covered: undefined as undefined | ((id: string) => boolean),
  onActivity: undefined as undefined | ((update: unknown) => void),
  start: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>,
  stop: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>,
}));
vi.mock("../../src/main/gameDetection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/main/gameDetection")>()),
  createGameDetector: (_platform: string, _list: unknown, onActivity: (update: unknown) => void, covered: (id: string) => boolean) => {
    detector.onActivity = onActivity;
    detector.covered = covered;
    detector.start = vi.fn();
    detector.stop = vi.fn();
    return { start: detector.start, stop: detector.stop };
  },
}));
// The health watch's timer must not run in tests; they call its parts directly.
const health = vi.hoisted(() => ({ deps: undefined as undefined | import("../../src/main/healthWatch").HealthWatchDeps }));
vi.mock("../../src/main/healthWatch", () => ({
  HealthWatch: class {
    constructor(deps: import("../../src/main/healthWatch").HealthWatchDeps) {
      health.deps = deps;
    }
    start() {}
  },
}));
// Rich Presence must not open the real discord-ipc pipes in tests.
const rpc = vi.hoisted(() => ({
  onActivity: undefined as undefined | ((update: unknown) => void),
  listening: true,
  start: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>,
  stop: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>,
}));
vi.mock("../../src/main/richPresence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/main/richPresence")>()),
  createRichPresence: (_platform: string, onActivity: (update: unknown) => void) => {
    rpc.onActivity = onActivity;
    rpc.start = vi.fn(async () => rpc.listening);
    rpc.stop = vi.fn();
    return { start: rpc.start, stop: rpc.stop };
  },
}));
// Streamer mode must not run the OS's process list in tests.
const processList = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock("../../src/main/streamer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/main/streamer")>()),
  listProcesses: async () => processList.names,
}));

import * as electron from "../mocks/electron";
import { APP_NAME, chromiumFeatures, createShell, findAppLink, startApp } from "../../src/main/app";
import { badgeBitmap } from "../../src/main/badge";
import { IPC } from "../../src/shared/ipc";
import { NATIVE_IPC } from "../../src/shared/native";
import { ENGINE_IPC, ENGINE_SCHEME } from "../../src/shared/engine";
import { FAVOURITES_IPC, MEDIA_SCHEME, mediaUrl } from "../../src/shared/favourites";
import { SETTINGS_IPC } from "../../src/shared/settings";
import { GenericWebAdapter } from "../../src/main/adapters/genericWebAdapter";
import type { PlatformModule } from "../../src/main/modules/types";
import { MODULES } from "../../src/main/modules/index";

const { BaseWindow, WebContentsView, Tray, app, ipcMain, session, desktopCapturer, shell } = electron;

const DIST = "/dist";
let userData: string;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function senderEvent(view: InstanceType<typeof WebContentsView>, url = "https://discord.com/channels/@me") {
  return { sender: view.webContents, senderFrame: { url } };
}

async function shellWith(platformsJson?: unknown, platform: NodeJS.Platform = "win32") {
  if (platformsJson !== undefined) fs.writeFileSync(path.join(userData, "platforms.json"), JSON.stringify(platformsJson));
  const handle = await createShell({ dist: DIST, userData }, platform);
  const window = BaseWindow.instances[0]!;
  const discordView = handle.views.get("discord")! as unknown as InstanceType<typeof WebContentsView>;
  const railView = handle.railView as unknown as InstanceType<typeof WebContentsView>;
  return { handle, window, discordView, railView };
}

beforeEach(() => {
  electron.resetElectron();
  // The built-in Fluxer platform discovers its instance on start; tests stay offline.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("offline");
  }));
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "multicord-test-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("createShell", () => {
  it("creates the rail and a sandboxed Discord view in its own partition", async () => {
    const { handle, window, discordView, railView } = await shellWith();
    expect(window.options).toMatchObject({ title: APP_NAME, width: 1280, height: 800 });
    expect(window.maximize).not.toHaveBeenCalled();
    expect(window.children).toEqual([railView, discordView, handle.views.get("fluxer"), handle.views.get("telegram"), handle.tooltipView]);

    expect(railView.options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false });
    expect(railView.webContents.loadFile).toHaveBeenCalledWith(path.join(DIST, "rail.html"));
    expect(discordView.options.webPreferences).toMatchObject({
      partition: "persist:discord",
      preload: path.join(DIST, "preload-discord.js"),
      sandbox: true,
    });
    expect(discordView.webContents.loadURL).toHaveBeenCalledWith("https://discord.com/app");

    expect(railView.bounds).toEqual({ x: 0, y: 0, width: 72, height: 700 });
    expect(discordView.bounds).toEqual({ x: 72, y: 0, width: 928, height: 700 });
    expect(discordView.visible).toBe(true);
  });

  it("configures the session user agent and permissions", async () => {
    await shellWith();
    const ses = session.fromPartition("persist:discord");
    expect(ses.setUserAgent.mock.calls[0]![0]).not.toMatch(/Electron|Multicord/);
    const callback = vi.fn();
    const request = ses.permissionRequestHandler as (...a: unknown[]) => void;
    const check = ses.permissionCheckHandler as (...a: unknown[]) => boolean;
    const from = (requestingUrl: string) => ({ requestingUrl });
    request(null, "notifications", callback, from("https://discord.com/channels/@me"));
    request(null, "geolocation", callback, from("https://discord.com/app"));
    // A page the view navigated to, or a foreign frame, gets nothing.
    request(null, "media", callback, from("https://evil.example/"));
    request(null, "media", callback, from("http://discord.com/"));
    request(null, "media", callback, {});
    expect(callback.mock.calls).toEqual([[true], [false], [false], [false], [false]]);
    expect(check(null, "media", "https://discord.com")).toBe(true);
    expect(check(null, "media", "https://cdn.discord.com")).toBe(true);
    expect(check(null, "media", "https://evil.example")).toBe(false);

    // Native modules show Multicord's own page, which needs the microphone for calls.
    const fluxer = session.fromPartition("persist:fluxer").permissionCheckHandler as (...a: unknown[]) => boolean;
    const own = pathToFileURL(path.join(DIST, "native.html")).href;
    expect(fluxer(null, "media", own)).toBe(true);
    expect(fluxer(null, "media", `${own}?x#y`)).toBe(true);
    expect(fluxer(null, "media", pathToFileURL(path.join(DIST, "other.html")).href)).toBe(false);
    expect(fluxer(null, "media", undefined)).toBe(false);
    expect(check(null, "media", own)).toBe(false); // Discord shows no page of ours
  });

  it("restores saved window state", async () => {
    fs.writeFileSync(
      path.join(userData, "window-state.json"),
      JSON.stringify({ x: 1, y: 2, width: 900, height: 600, maximized: true }),
    );
    const { window } = await shellWith();
    expect(window.options).toMatchObject({ x: 1, y: 2, width: 900, height: 600 });
    expect(window.maximize).toHaveBeenCalled();
  });

  it("adds user platforms as web views and warns about invalid entries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handle } = await shellWith([
      { id: "element", name: "Element", url: "https://app.element.io" },
      { id: "BAD" },
    ]);
    expect(warn).toHaveBeenCalledWith("[platforms] entry 1: id must be lowercase letters, digits or dashes");
    const view = handle.views.get("element") as unknown as InstanceType<typeof WebContentsView>;
    expect(view.options.webPreferences).toMatchObject({ partition: "persist:element", preload: undefined });
    expect(view.webContents.loadURL).toHaveBeenCalledWith("https://app.element.io");
    expect(view.visible).toBe(false);
  });

  it("publishes Discord state from the Discord view only", async () => {
    const { handle, discordView, railView } = await shellWith();
    const state = { guilds: [{ id: "1", name: "One", unread: true, mentions: 0 }], badge: { unread: true, mentions: 0 } };

    ipcMain.emit(IPC.discordState, senderEvent(railView), state);
    ipcMain.emit(IPC.discordState, senderEvent(discordView), { guilds: "bad" });
    ipcMain.emit(IPC.discordState, senderEvent(discordView, "https://evil.example/"), state); // not Discord's page
    ipcMain.emit(IPC.discordState, { sender: discordView.webContents, senderFrame: null }, state);
    expect(handle.registry.state().entries.filter((e) => e.kind === "server")).toHaveLength(0);

    ipcMain.emit(IPC.discordState, senderEvent(discordView), state);
    expect(railView.webContents.send).toHaveBeenLastCalledWith(IPC.railState, {
      ...handle.registry.state(),
      settingsOpen: false,
      messagesOpen: false,
      messagesBadge: { unread: false, mentions: 0 },
    });
    expect(handle.registry.state().entries.filter((e) => e.platform === "discord").map((e) => e.key)).toEqual([
      "discord:home",
      "discord:1",
    ]);
  });

  it("shows mention totals in the title, badge and taskbar", async () => {
    const { window, discordView } = await shellWith();
    const update = (mentions: number) =>
      ipcMain.emit(IPC.discordState, senderEvent(discordView), { guilds: [], badge: { unread: mentions > 0, mentions } });

    update(3);
    expect(window.setTitle).toHaveBeenLastCalledWith(`(3) ${APP_NAME}`);
    expect(app.setBadgeCount).toHaveBeenLastCalledWith(3);
    expect(window.flashFrame).toHaveBeenCalledTimes(1);
    // Windows: the count on the taskbar button, redrawn only when it changes.
    expect(window.setOverlayIcon).toHaveBeenLastCalledWith({ bitmap: badgeBitmap(3), size: { width: 16, height: 16 } }, "3 unread mentions");
    update(3);
    expect(window.setOverlayIcon).toHaveBeenCalledTimes(1);

    window.isFocused.mockReturnValue(true);
    update(5);
    expect(window.flashFrame).toHaveBeenCalledTimes(1);

    update(0);
    expect(window.setTitle).toHaveBeenLastCalledWith(APP_NAME);
    expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
  });

  it("leaves the taskbar overlay to Windows", async () => {
    const { window, discordView } = await shellWith(undefined, "darwin");
    ipcMain.emit(IPC.discordState, senderEvent(discordView), { guilds: [], badge: { unread: true, mentions: 2 } });
    expect(app.setBadgeCount).toHaveBeenLastCalledWith(2);
    expect(window.setOverlayIcon).not.toHaveBeenCalled();
  });

  it("sends rail state when the rail is ready", async () => {
    const { discordView, railView } = await shellWith();
    ipcMain.emit(IPC.railReady, senderEvent(discordView));
    expect(railView.webContents.send).not.toHaveBeenCalled();
    ipcMain.emit(IPC.railReady, senderEvent(railView));
    expect(railView.webContents.send).toHaveBeenCalledWith(IPC.railState, expect.objectContaining({ entries: expect.any(Array) }));
  });

  it("routes rail clicks and switches the visible view", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handle, discordView, railView } = await shellWith([{ id: "element", name: "Element", url: "https://app.element.io" }]);
    const elementView = handle.views.get("element") as unknown as InstanceType<typeof WebContentsView>;

    ipcMain.emit(IPC.railOpen, senderEvent(railView), "element:app");
    await flush();
    expect(elementView.visible).toBe(true);
    expect(discordView.visible).toBe(false);

    ipcMain.emit(IPC.railOpen, senderEvent(railView), "discord:home");
    await flush();
    expect(discordView.webContents.send).toHaveBeenCalledWith(IPC.discordNavigate, "home");
    expect(discordView.visible).toBe(true);

    ipcMain.emit(IPC.railOpen, senderEvent(discordView), "element:app");
    ipcMain.emit(IPC.railOpen, senderEvent(railView), 42);
    ipcMain.emit(IPC.railOpen, senderEvent(railView), "unknown:x");
    await flush();
    expect(discordView.visible).toBe(true);

    ipcMain.emit(IPC.railOpen, senderEvent(railView), "discord:not-a-guild");
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[rail] could not open discord:not-a-guild"));
  });

  it("updates generic platforms from their page title", async () => {
    const { handle } = await shellWith([{ id: "element", name: "Element", url: "https://app.element.io" }]);
    const view = handle.views.get("element") as unknown as InstanceType<typeof WebContentsView>;
    view.webContents.emit("page-title-updated", {}, "Element [2]");
    expect(handle.registry.state().entries.find((e) => e.key === "element:app")).toMatchObject({ mentions: 2 });
  });

  it("checks web apps' services on their own host through a cookie-less session, not on private addresses", async () => {
    const { handle } = await shellWith([
      { id: "st", name: "Stoat", url: "https://stoat.chat/app", module: "stoat" },
      { id: "home", name: "Home Stoat", url: "https://chat.lan/app", module: "stoat" },
      { id: "element", name: "Element", url: "https://app.element.io", module: "matrix" },
    ]);
    await flush();
    const ses = session.fromPartition("service-check-st");
    expect(ses.fetch).toHaveBeenCalledWith("https://stoat.chat/api/", expect.objectContaining({ credentials: "omit" }));
    expect(handle.adapters.get("st")!.health!()).toEqual([{ name: "Stoat's API answers", ok: true }]);
    // A self-hosted service on the local network, and Element, whose homeserver is not known: nothing is asked.
    expect(session.fromPartition("service-check-home").fetch).not.toHaveBeenCalled();
    expect(handle.adapters.get("home")!.health!()).toEqual([]);
    expect(session.fromPartition("service-check-element").fetch).not.toHaveBeenCalled();
  });

  it("keeps same-origin popups and opens other links externally", async () => {
    const { discordView } = await shellWith();
    const open = discordView.webContents.windowOpenHandler!;
    expect(open({ url: "https://discord.com/popout" })).toEqual({ action: "allow" });
    expect(open({ url: "https://example.com" })).toEqual({ action: "deny" });
    expect(shell.openExternal).toHaveBeenCalledWith("https://example.com");
    expect(open({ url: "file:///etc" })).toEqual({ action: "deny" });
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
  });

  it("shows hovered names in a transparent overlay beside the rail", async () => {
    const { handle, window, discordView, railView } = await shellWith();
    const tooltip = handle.tooltipView as unknown as InstanceType<typeof WebContentsView>;
    expect(window.children.at(-1)).toBe(tooltip);
    expect(tooltip.setBackgroundColor).toHaveBeenCalledWith("#00000000");
    expect(tooltip.visible).toBe(false);
    expect(tooltip.webContents.loadFile).toHaveBeenCalledWith(path.join(DIST, "tooltip.html"));

    ipcMain.emit(IPC.railTooltip, senderEvent(discordView), { text: "Spoof", y: 10 });
    ipcMain.emit(IPC.railTooltip, senderEvent(railView), { text: "", y: 10 });
    expect(tooltip.visible).toBe(false);

    ipcMain.emit(IPC.railTooltip, senderEvent(railView), { text: "Gaming Club", y: 100 });
    expect(tooltip.webContents.send).toHaveBeenCalledWith(IPC.tooltipShow, "Gaming Club");
    expect(tooltip.bounds).toEqual({ x: 72, y: 78, width: 280, height: 44 });
    expect(tooltip.visible).toBe(true);

    ipcMain.emit(IPC.railTooltip, senderEvent(railView), null);
    expect(tooltip.visible).toBe(false);

    ipcMain.emit(IPC.railTooltip, senderEvent(railView), { text: "Gaming Club", y: 100 });
    window.emit("blur");
    expect(tooltip.visible).toBe(false);

    const event = { preventDefault: vi.fn() };
    tooltip.webContents.emit("will-navigate", event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("blocks navigation away from the rail page", async () => {
    const { railView } = await shellWith();
    const event = { preventDefault: vi.fn() };
    railView.webContents.emit("will-navigate", event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("relayouts on resize", async () => {
    const { window, discordView } = await shellWith();
    window.contentBounds = { x: 0, y: 0, width: 500, height: 400 };
    window.emit("resize");
    expect(discordView.bounds).toEqual({ x: 72, y: 0, width: 428, height: 400 });
  });

  it("hides to tray on close and saves window state", async () => {
    const { handle, window } = await shellWith();
    const event = { preventDefault: vi.fn() };
    window.emit("close", event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(window.hide).toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(userData, "window-state.json"), "utf8"))).toEqual({
      x: 10,
      y: 20,
      width: 1100,
      height: 750,
      maximized: false,
    });

    handle.setQuitting();
    const quitEvent = { preventDefault: vi.fn() };
    window.emit("close", quitEvent);
    expect(quitEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("offers show and quit from the tray", async () => {
    const { window } = await shellWith();
    const tray = Tray.instances[0]!;
    expect(tray.icon).toEqual({ path: path.join(DIST, "icon.png") });
    expect(tray.setToolTip).toHaveBeenCalledWith(APP_NAME);

    tray.emit("click");
    expect(window.show).toHaveBeenCalled();
    expect(window.restore).not.toHaveBeenCalled();

    window.isMinimized.mockReturnValue(true);
    tray.menu!.template.find((i) => i.label === `Show ${APP_NAME}`)!.click!();
    expect(window.restore).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();

    tray.menu!.template.find((i) => i.label === "Quit")!.click!();
    expect(app.quit).toHaveBeenCalled();
  });

  it("shares the screen through our picker", async () => {
    const { window } = await shellWith();
    const source = { id: "screen:0", name: "Screen", thumbnail: { toDataURL: () => "data:x" } };
    desktopCapturer.getSources.mockResolvedValue([source]);
    const ses = session.fromPartition("persist:discord");
    const callback = vi.fn();
    const done = (ses.displayMediaRequestHandler as (...a: unknown[]) => Promise<void>)({}, callback);
    await flush();

    expect(desktopCapturer.getSources).toHaveBeenCalledWith({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } });
    const picker = WebContentsView.instances.at(-1)!;
    expect(window.children).toContain(picker);
    expect(picker.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 700 });
    expect(picker.webContents.loadFile).toHaveBeenCalledWith(path.join(DIST, "picker.html"));

    picker.webContents.emit("did-finish-load");
    expect(picker.webContents.send).toHaveBeenCalledWith(IPC.pickerSources, {
      sources: [{ id: "screen:0", name: "Screen", thumbnail: "data:x" }],
      audioSupported: true,
    });

    ipcMain.emit(IPC.pickerChoose, { sender: {} }, { id: "screen:0", audio: true });
    ipcMain.emit(IPC.pickerChoose, senderEvent(picker), "bogus");
    expect(window.children).toContain(picker);

    ipcMain.emit(IPC.pickerChoose, senderEvent(picker), { id: "screen:0", audio: true });
    await done;
    expect(callback).toHaveBeenCalledWith({ video: source, audio: "loopback" });
    expect(window.children).not.toContain(picker);
    expect(picker.webContents.close).toHaveBeenCalled();
    expect(ipcMain.listenerCount(IPC.pickerChoose)).toBe(0);
  });
});

describe("native Fluxer platform", () => {
  const engineOf = (id: string) =>
    WebContentsView.instances.find((v) => v.options.webPreferences.partition === `engine_${id}`)!;

  it("runs Fluxer's logic in a sandboxed engine and renders it in a native view", async () => {
    const { handle, railView } = await shellWith();
    const view = handle.views.get("fluxer") as unknown as InstanceType<typeof WebContentsView>;
    expect(view.options.webPreferences).toMatchObject({
      preload: path.join(DIST, "preload-native.js"),
      partition: "persist:fluxer",
      sandbox: true,
      contextIsolation: true,
    });
    expect(view.webContents.loadFile).toHaveBeenCalledWith(path.join(DIST, "native.html"));
    expect(view.webContents.loadURL).not.toHaveBeenCalled();

    const engine = engineOf("fluxer");
    expect(engine.options.webPreferences).toMatchObject({ preload: path.join(DIST, "preload-engine.js"), sandbox: true, nodeIntegration: false });
    expect(engine.webContents.loadURL).toHaveBeenCalledWith(`${ENGINE_SCHEME}://fluxer/engine.html`);
    expect(BaseWindow.instances[0]!.children).not.toContain(engine);

    // The view's actions reach the engine once it is up; its display state reaches the view.
    ipcMain.emit(NATIVE_IPC.action, senderEvent(railView), { type: "ready" });
    ipcMain.emit(NATIVE_IPC.action, senderEvent(view), { type: "ready" });
    expect(await ipcMain.invoke(ENGINE_IPC.invoke, senderEvent(engine), { type: "info" })).toEqual({
      id: "fluxer",
      name: "Fluxer",
      url: "https://fluxer.app",
      os: "win32",
      settings: { typing: true },
    });
    expect(engine.webContents.send).toHaveBeenCalledWith(ENGINE_IPC.action, { type: "ready" });
    // Only the view's action came through, not the rail's; held commands (e.g. visibility) follow.
    expect(engine.webContents.send.mock.calls.filter(([channel]) => channel === ENGINE_IPC.action)).toHaveLength(1);
    expect(engine.webContents.send).toHaveBeenCalledWith(ENGINE_IPC.command, { type: "visible", visible: false });
    ipcMain.emit(ENGINE_IPC.render, senderEvent(engine), { screen: "login", platform: "Fluxer" });
    expect(view.webContents.send).toHaveBeenCalledWith(NATIVE_IPC.state, { screen: "login", platform: "Fluxer" });
  });

  it("keeps favourites in the shell, for native views only", async () => {
    const { handle, railView, discordView } = await shellWith();
    const view = handle.views.get("fluxer") as unknown as InstanceType<typeof WebContentsView>;
    const engine = engineOf("fluxer");
    // Served to the view's session, never the engine's.
    const serve = session.fromPartition("persist:fluxer").protocolHandlers.get(MEDIA_SCHEME)!;
    expect(serve).toBeTypeOf("function");
    expect(session.fromPartition("engine_fluxer").protocolHandlers.has(MEDIA_SCHEME)).toBe(false);
    const module = { name: "Fluxer", label: "Fluxer", color: "#4f8cf7" };
    view.webContents.emit("did-finish-load");
    expect(view.webContents.send).toHaveBeenCalledWith(FAVOURITES_IPC.state, { categories: [], items: [], module, saving: [] });
    discordView.webContents.emit("did-finish-load");
    expect(discordView.webContents.send.mock.calls.some(([channel]) => channel === FAVOURITES_IPC.state)).toBe(false);
    expect(engine.webContents.send.mock.calls.some(([channel]) => channel === FAVOURITES_IPC.state)).toBe(false);

    const latest = () => view.webContents.send.mock.calls.filter(([channel]) => channel === FAVOURITES_IPC.state).at(-1)![1] as { items: { id: string; source: unknown }[]; categories: unknown[] };
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const add = { type: "add", url: `data:image/png;base64,${png.toString("base64")}`, kind: "image", name: "Cat" };
    // Only native views may change them, and only with well-formed actions.
    ipcMain.emit(FAVOURITES_IPC.action, senderEvent(railView), add);
    ipcMain.emit(FAVOURITES_IPC.action, senderEvent(discordView), add);
    ipcMain.emit(FAVOURITES_IPC.action, senderEvent(engine), add);
    ipcMain.emit(FAVOURITES_IPC.action, senderEvent(view), { ...add, url: "file:///etc/passwd" });
    await flush();
    expect(latest().items).toEqual([]);
    ipcMain.emit(FAVOURITES_IPC.action, senderEvent(view), add);
    await flush();
    const [item] = latest().items;
    expect(item!.source).toEqual({ platform: "Fluxer", label: "Fluxer", color: "#4f8cf7" });
    expect(fs.existsSync(path.join(userData, "favourites", "files", item!.id))).toBe(true);
    const served = (await serve({ url: mediaUrl(item!.id) })) as Response;
    expect(served.headers.get("content-type")).toBe("image/png");

    // Sending hands the engine the file to upload.
    await ipcMain.invoke(ENGINE_IPC.invoke, senderEvent(engine), { type: "info" });
    ipcMain.emit(FAVOURITES_IPC.action, senderEvent(view), { type: "send", id: item!.id, replyTo: "7" });
    await flush();
    expect(engine.webContents.send).toHaveBeenCalledWith(ENGINE_IPC.action, { type: "sendFile", file: { handle: expect.any(String), name: "Cat.png", size: png.length, type: "image/png" }, replyTo: "7" });
  });

  it("shows the favourites in Settings, kept current while it is open", async () => {
    const { handle, railView } = await shellWith();
    const view = handle.views.get("fluxer") as unknown as InstanceType<typeof WebContentsView>;
    ipcMain.emit(IPC.railSettings, senderEvent(railView), true);
    const settingsView = handle.settingsView()! as unknown as InstanceType<typeof WebContentsView>;
    const lastSettings = () => settingsView.webContents.send.mock.calls.filter(([c]) => c === SETTINGS_IPC.state).at(-1)![1] as { favourites: { categories: unknown[] } };
    expect(lastSettings().favourites).toEqual({ categories: [], items: 0, cacheBytes: 0, pinned: 0 });
    ipcMain.emit(FAVOURITES_IPC.action, senderEvent(view), { type: "createCategory", name: "Cats" });
    await flush();
    expect(lastSettings().favourites.categories).toEqual([{ id: expect.any(String), name: "Cats", count: 0 }]);
    ipcMain.emit(SETTINGS_IPC.action, senderEvent(settingsView), { type: "clearFavouriteCache" });
    await flush();
    // Not while Settings is closed.
    ipcMain.emit(IPC.railSettings, senderEvent(railView), false);
    const sent = settingsView.webContents.send.mock.calls.length;
    ipcMain.emit(FAVOURITES_IPC.action, senderEvent(view), { type: "createCategory", name: "Dogs" });
    await flush();
    expect(settingsView.webContents.send.mock.calls.length).toBe(sent);
  });

  it("downloads favourites only over https from public addresses", async () => {
    const { handle } = await shellWith();
    const view = handle.views.get("fluxer") as unknown as InstanceType<typeof WebContentsView>;
    const ses = session.fromPartition("multicord-favourites");
    expect(ses.permissionCheckHandler!()).toBe(false);
    const callback = vi.fn();
    (ses.permissionRequestHandler as (...a: unknown[]) => void)(null, "media", callback);
    expect(callback).toHaveBeenCalledWith(false);
    const cancelled = (url: string) => new Promise<boolean>((resolve) => ses.beforeRequest!({ url }, (r) => resolve(r.cancel)));
    expect(await cancelled("http://cdn.example/a.gif")).toBe(true);
    expect(await cancelled("https://cdn.example/a.gif")).toBe(false);
    ses.resolveHost.mockResolvedValueOnce({ endpoints: [{ address: "10.0.0.2", family: "ipv4" }] });
    expect(await cancelled("https://inside.example/a.gif")).toBe(true);

    const gif = Buffer.from("GIF89a NETSCAPE2.0");
    ses.fetch.mockResolvedValueOnce(new Response(gif, { headers: { "content-type": "image/gif" } }));
    ipcMain.emit(FAVOURITES_IPC.action, senderEvent(view), { type: "add", url: "https://cdn.example/a.gif", kind: "gif", name: "A" });
    await flush();
    await flush();
    expect(ses.fetch).toHaveBeenCalledWith("https://cdn.example/a.gif", { method: "GET", redirect: "follow", credentials: "omit" });
    const states = view.webContents.send.mock.calls.filter(([channel]) => channel === FAVOURITES_IPC.state);
    expect((states.at(-1)![1] as { items: { kind: string; origin: string }[] }).items[0]).toMatchObject({ kind: "gif", origin: "https://cdn.example/a.gif" });
  });

  it("gives the engine only its own instance's secrets", async () => {
    // Stored as the mocked safeStorage encrypts it (byte-reversed).
    const encrypt = (text: string) => Buffer.from(text).reverse().toString("base64");
    fs.writeFileSync(
      path.join(userData, "credentials.json"),
      JSON.stringify({ "fluxer:fluxer.app:token": encrypt("flx_saved"), "discord:token": encrypt("other") }),
    );
    await shellWith();
    const ask = (key: string) => ipcMain.invoke(ENGINE_IPC.invoke, senderEvent(engineOf("fluxer")), { type: "secretLoad", key });
    expect(await ask("fluxer.app:token")).toBe("flx_saved");
    expect(await ask("token")).toBeUndefined();
    expect(await ask("../discord:token")).toBeUndefined();
  });

  it("gives Fluxer voice the same screen share picker", async () => {
    await shellWith();
    expect(session.fromPartition("persist:fluxer").displayMediaRequestHandler).toBeTypeOf("function");
  });

  it("opens links to the platform's own site from message popups in the browser too", async () => {
    const { handle } = await shellWith();
    const view = handle.views.get("fluxer") as unknown as InstanceType<typeof WebContentsView>;
    expect(view.webContents.windowOpenHandler!({ url: "https://fluxer.app/invite/x" })).toEqual({ action: "deny" });
    expect(shell.openExternal).toHaveBeenCalledWith("https://fluxer.app/invite/x");
    expect(view.webContents.windowOpenHandler!({ url: "file:///etc/passwd" })).toEqual({ action: "deny" });
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
  });

  it("opens message links in the browser, never inside the app", async () => {
    const { handle } = await shellWith();
    const view = handle.views.get("fluxer") as unknown as InstanceType<typeof WebContentsView>;
    const event = { preventDefault: vi.fn() };
    view.webContents.emit("will-navigate", event, "https://example.com/page");
    view.webContents.emit("will-navigate", event, "file:///C:/secrets");
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
    expect(shell.openExternal).toHaveBeenCalledWith("https://example.com/page");
  });

  it("tells the engine when its view is in front", async () => {
    const { handle, railView } = await shellWith();
    const setVisible = vi.spyOn(handle.adapters.get("fluxer")!, "setVisible");
    ipcMain.emit(IPC.railOpen, senderEvent(railView), "fluxer:home");
    await flush();
    expect(setVisible).toHaveBeenLastCalledWith(true);
    ipcMain.emit(IPC.railOpen, senderEvent(railView), "discord:home");
    await flush();
    expect(setVisible).toHaveBeenLastCalledWith(false);
  });

  it("starts an engine module without capabilities as one that supports nothing", async () => {
    const bare: PlatformModule = { manifest: { id: "bare", name: "Bare", label: "Bare", color: "#000000", configurable: true, engine: "bare", defaultUrl: "https://bare.example" } };
    fs.writeFileSync(path.join(userData, "platforms.json"), JSON.stringify([{ id: "fluxer", enabled: false }, { id: "b", name: "B", module: "bare" }]));
    const handle = await createShell({ dist: DIST, userData }, "win32", undefined, [...MODULES, bare]);
    expect(handle.adapters.get("b")!.capabilities).toEqual({ directMessages: false, messagePreviews: false, voice: false, screenShare: false });
    expect(handle.adapters.get("b")!.openHome).toBeUndefined();
    expect(session.fromPartition("persist:b").displayMediaRequestHandler).toBeUndefined();
  });
});

describe("notifications", () => {
  async function withNotifier() {
    const ctx = await shellWith();
    const fluxer = ctx.handle.adapters.get("fluxer") as unknown as {
      notifications: { emit(n: unknown): void };
      openConversation(key: string): Promise<void>;
    };
    const open = vi.spyOn(fluxer, "openConversation").mockResolvedValue();
    const emit = (n: Record<string, unknown>) => fluxer.notifications.emit({ title: "Ana", body: "hi", target: "900", ...n });
    return { ...ctx, emit, open };
  }

  it("shows native notifications and opens the conversation on click", async () => {
    const { handle, window, emit, open } = await withNotifier();
    emit({ railKey: "dm:900" });
    const note = electron.Notification.instances[0]!;
    expect(note.options).toEqual({ title: "Ana · Fluxer", body: "hi" });
    expect(note.show).toHaveBeenCalled();
    note.emit("click");
    await flush();
    expect(window.show).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("900");
    const fluxerView = handle.views.get("fluxer") as unknown as InstanceType<typeof WebContentsView>;
    expect(fluxerView.visible).toBe(true);
    expect(handle.registry.state().activeKey).toBe("fluxer:dm:900");

    emit({});
    electron.Notification.instances[1]!.emit("close");
  });

  it("stays quiet for the conversation already in front", async () => {
    const { window, railView, emit } = await withNotifier();
    ipcMain.emit(IPC.railOpen, senderEvent(railView), "fluxer:home");
    await flush();
    window.isFocused.mockReturnValue(true);
    emit({ inView: true });
    expect(electron.Notification.instances).toHaveLength(0);
    window.isFocused.mockReturnValue(false);
    emit({ inView: true });
    expect(electron.Notification.instances).toHaveLength(1);
  });

  it("stays quiet for a service whose notifications are off", async () => {
    const { handle, emit } = await withNotifier();
    handle.settingsStore.update({ services: { fluxer: { notifications: false } } });
    emit({});
    expect(electron.Notification.instances).toHaveLength(0);
    handle.settingsStore.update({ services: { fluxer: null } });
    emit({});
    expect(electron.Notification.instances).toHaveLength(1);
  });

  it("does nothing where notifications are unsupported", async () => {
    const { emit } = await withNotifier();
    electron.Notification.isSupported.mockReturnValue(false);
    emit({});
    expect(electron.Notification.instances).toHaveLength(0);
  });

  it("logs notifications that fail to open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emit, open } = await withNotifier();
    open.mockRejectedValue(new Error("gone"));
    emit({});
    electron.Notification.instances[0]!.emit("click");
    await flush();
    expect(warn).toHaveBeenCalledWith("[fluxer] could not open notification: gone");
  });
});

describe("server order and modules", () => {
  it("restores, applies and saves the app-owned server order", async () => {
    fs.writeFileSync(path.join(userData, "rail-order.json"), JSON.stringify(["fluxer:folder:1", "discord:9"]));
    const { handle, railView, discordView } = await shellWith();
    expect(handle.registry.getOrder()).toEqual(["fluxer:folder:1", "discord:9"]);

    ipcMain.emit(IPC.railReorder, senderEvent(discordView), ["x:1"]);
    ipcMain.emit(IPC.railReorder, senderEvent(railView), "not a list");
    expect(handle.registry.getOrder()).toEqual(["fluxer:folder:1", "discord:9"]);

    ipcMain.emit(IPC.railReorder, senderEvent(railView), ["discord:9", "discord:3"]);
    expect(JSON.parse(fs.readFileSync(path.join(userData, "rail-order.json"), "utf8"))).toEqual([
      "discord:9",
      "discord:3",
      "fluxer:folder:1",
    ]);
  });

  it("ignores a corrupt order file", async () => {
    fs.writeFileSync(path.join(userData, "rail-order.json"), "{nope");
    const { handle } = await shellWith();
    expect(handle.registry.getOrder()).toEqual([]);
    fs.writeFileSync(path.join(userData, "rail-order.json"), JSON.stringify({ not: "a list" }));
    electron.resetElectron();
    expect((await shellWith()).handle.registry.getOrder()).toEqual([]);
  });

  it("labels rail entries with their module", async () => {
    const { handle } = await shellWith();
    const entries = handle.registry.state().entries;
    expect(entries.find((e) => e.key === "discord:home")!.module).toEqual({ label: "Discord", color: "#5865f2" });
    expect(entries.find((e) => e.key === "fluxer:home")!.module).toEqual({ label: "Fluxer", color: "#4f8cf7" });
  });

  it("loads platforms through the given modules and skips unknown ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = vi.fn();
    const custom: PlatformModule = {
      manifest: { id: "custom", name: "Custom", label: "Custom", color: "#123456", configurable: true },
      load: ({ def }) => ({ adapter: new GenericWebAdapter(def), start: started }),
    };
    fs.writeFileSync(
      path.join(userData, "platforms.json"),
      JSON.stringify([{ id: "mine", name: "Mine", url: "https://mine.example", module: "custom" }]),
    );
    const handle = await createShell({ dist: DIST, userData }, "win32", undefined, [custom]);
    expect([...handle.adapters.keys()]).toEqual(["mine"]);
    expect(started).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(`[platforms] discord: unknown module "discord"`);
    expect(warn).toHaveBeenCalledWith(`[platforms] fluxer: unknown module "fluxer"`);
  });
});

describe("chromiumFeatures", () => {
  it("routes global shortcuts through the portal on Linux (Wayland)", () => {
    expect(chromiumFeatures("linux")).toEqual(["GlobalShortcutsPortal"]);
    expect(chromiumFeatures("win32")).toEqual([]);
  });
});

describe("startApp", () => {
  it("quits when another instance holds the lock", () => {
    app.requestSingleInstanceLock.mockReturnValue(false);
    startApp(DIST);
    expect(app.quit).toHaveBeenCalled();
    expect(app.whenReady).not.toHaveBeenCalled();
  });

  it("creates the shell when ready and wires lifecycle events", async () => {
    app.getPath.mockReturnValue(userData);
    app.emit("second-instance"); // no listeners yet; must not throw
    startApp(DIST);
    expect(app.setName).toHaveBeenCalledWith(APP_NAME);
    expect(electron.protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      { scheme: ENGINE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
      { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    ]);

    app.emit("activate"); // before ready: nothing to show
    await flush();
    const window = BaseWindow.instances[0]!;
    app.emit("second-instance");
    app.emit("activate");
    expect(window.show).toHaveBeenCalledTimes(2);

    app.emit("before-quit");
    const event = { preventDefault: vi.fn() };
    window.emit("close", event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("settings", () => {
  async function opened() {
    const ctx = await shellWith();
    ipcMain.emit(IPC.railSettings, senderEvent(ctx.railView), true);
    const view = ctx.handle.settingsView() as unknown as InstanceType<typeof WebContentsView>;
    return { ...ctx, view };
  }

  it("opens the settings page from the rail gear, above the platforms and below the tooltip", async () => {
    const { handle, window, discordView, railView } = await shellWith();
    expect(handle.settingsView()).toBeUndefined();
    ipcMain.emit(IPC.railSettings, senderEvent(discordView), true); // only the rail may
    ipcMain.emit(IPC.railSettings, senderEvent(railView), "yes");
    expect(handle.settingsView()).toBeUndefined();

    ipcMain.emit(IPC.railSettings, senderEvent(railView), true);
    const view = handle.settingsView() as unknown as InstanceType<typeof WebContentsView>;
    expect(view.options.webPreferences).toMatchObject({
      preload: path.join(DIST, "preload-settings.js"),
      partition: "multicord-settings",
      sandbox: true,
      contextIsolation: true,
    });
    expect(view.webContents.loadFile).toHaveBeenCalledWith(path.join(DIST, "settings.html"));
    expect(window.children.at(-2)).toBe(view);
    expect(window.children.at(-1)).toBe(handle.tooltipView);
    expect(view.visible).toBe(true);
    expect(view.bounds).toEqual({ x: 72, y: 0, width: 928, height: 700 });
    expect(discordView.visible).toBe(false);
    expect(railView.webContents.send).toHaveBeenLastCalledWith(IPC.railState, expect.objectContaining({ settingsOpen: true }));
    expect(view.webContents.send).toHaveBeenCalledWith(SETTINGS_IPC.state, expect.objectContaining({ version: "0.1.0" }));

    const ses = session.fromPartition("multicord-settings");
    let cancelled: boolean | undefined;
    ses.beforeRequest!({ url: "https://192.168.1.1/" }, (response) => (cancelled = response.cancel));
    expect(cancelled).toBe(true);
    const callback = vi.fn();
    (ses.permissionRequestHandler as (...a: unknown[]) => void)(null, "media", callback);
    (ses.permissionRequestHandler as (...a: unknown[]) => void)(null, "notifications", callback);
    expect(callback.mock.calls).toEqual([[true], [false]]);
    expect((ses.permissionCheckHandler as (...a: unknown[]) => boolean)(null, "media")).toBe(true);
    const navigation = { preventDefault: vi.fn() };
    view.webContents.emit("will-navigate", navigation);
    expect(navigation.preventDefault).toHaveBeenCalled();
    expect(view.webContents.windowOpenHandler!({ url: "https://x.example" })).toEqual({ action: "deny" });

    ipcMain.emit(IPC.railSettings, senderEvent(railView), false);
    expect(view.visible).toBe(false);
    expect(discordView.visible).toBe(true);
    ipcMain.emit(IPC.railSettings, senderEvent(railView), true);
    expect(handle.settingsView()).toBe(view); // created once
  });

  it("leaves settings when a server is opened", async () => {
    const { view, discordView, railView } = await opened();
    ipcMain.emit(IPC.discordState, senderEvent(discordView), { guilds: [{ id: "1", name: "One", unread: false, mentions: 0 }], badge: { unread: false, mentions: 0 } });
    ipcMain.emit(IPC.railOpen, senderEvent(railView), "discord:1");
    await flush();
    expect(view.visible).toBe(false);
    expect(discordView.visible).toBe(true);
  });

  it("answers the page's requests and actions from the page only", async () => {
    const { handle, view, railView } = await opened();
    view.webContents.send.mockClear();
    ipcMain.emit(SETTINGS_IPC.ready, senderEvent(railView));
    expect(view.webContents.send).not.toHaveBeenCalled();
    ipcMain.emit(SETTINGS_IPC.ready, senderEvent(view));
    expect(view.webContents.send).toHaveBeenCalledWith(SETTINGS_IPC.state, expect.objectContaining({ restartNeeded: false }));

    ipcMain.emit(SETTINGS_IPC.action, senderEvent(railView), { type: "setEnabled", id: "fluxer", enabled: false });
    ipcMain.emit(SETTINGS_IPC.action, senderEvent(view), { type: "explode" });
    await flush();
    expect(fs.existsSync(path.join(userData, "platforms.json"))).toBe(false);
    ipcMain.emit(SETTINGS_IPC.action, senderEvent(view), { type: "setEnabled", id: "fluxer", enabled: false });
    await flush();
    expect(JSON.parse(fs.readFileSync(path.join(userData, "platforms.json"), "utf8"))).toEqual([{ id: "fluxer", enabled: false }]);
    expect(view.webContents.send).toHaveBeenLastCalledWith(SETTINGS_IPC.state, expect.objectContaining({ restartNeeded: true }));
    expect(handle.settings).toBeDefined();
  });

  it("ignores page messages before the page exists", async () => {
    const { railView } = await shellWith();
    ipcMain.emit(SETTINGS_IPC.ready, senderEvent(railView));
    ipcMain.emit(SETTINGS_IPC.action, senderEvent(railView), { type: "restart" });
    expect(app.relaunch).not.toHaveBeenCalled();
  });

  it("opens a service from the settings page", async () => {
    const { view, discordView } = await opened();
    ipcMain.emit(SETTINGS_IPC.action, senderEvent(view), { type: "openService", id: "fluxer" });
    await flush();
    expect(view.visible).toBe(false);
    expect(discordView.visible).toBe(false);
    expect((electron.WebContentsView.instances.find((v) => v.options.webPreferences.partition === "persist:fluxer")!).visible).toBe(true);
  });

  it("signs web sessions out by clearing them and reloading", async () => {
    const { view, discordView } = await opened();
    ipcMain.emit(SETTINGS_IPC.action, senderEvent(view), { type: "signOut", id: "discord" });
    await flush();
    expect(session.fromPartition("persist:discord").clearStorageData).toHaveBeenCalled();
    expect(discordView.webContents.reload).toHaveBeenCalled();
  });

  it("restarts one service: a web page reloads, a native module's engine starts again", async () => {
    const { view, discordView } = await opened();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    ipcMain.emit(SETTINGS_IPC.action, senderEvent(view), { type: "restartService", id: "discord" });
    await flush();
    expect(discordView.webContents.reload).toHaveBeenCalledTimes(1);
    const engine = WebContentsView.instances.find((v) => v.options.webPreferences.partition === "engine_fluxer")!;
    engine.webContents.loadURL.mockClear();
    ipcMain.emit(SETTINGS_IPC.action, senderEvent(view), { type: "restartService", id: "fluxer" });
    await flush();
    expect(engine.webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(discordView.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it("forgets a removed service's data", async () => {
    fs.writeFileSync(path.join(userData, "platforms.json"), JSON.stringify([{ id: "el", name: "Element", url: "https://app.element.io" }]));
    fs.writeFileSync(path.join(userData, "credentials.json"), JSON.stringify({ "el:x:token": "a", "fluxer:x:token": "b" }));
    const { view } = await opened();
    ipcMain.emit(SETTINGS_IPC.action, senderEvent(view), { type: "removeService", id: "el" });
    await flush();
    expect(session.fromPartition("persist:el").clearStorageData).toHaveBeenCalled();
    expect(session.fromPartition("persist:engine_el").clearStorageData).toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(userData, "credentials.json"), "utf8"))).toEqual({ "fluxer:x:token": "b" });
  });

  it("restarts on request", async () => {
    const { handle, view, window } = await opened();
    ipcMain.emit(SETTINGS_IPC.action, senderEvent(view), { type: "restart" });
    await flush();
    expect(app.relaunch).toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalled();
    const event = { preventDefault: vi.fn() };
    window.emit("close", event); // quitting: the window really closes
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(handle).toBeDefined();
  });

  it("quits on close when not kept in the tray", async () => {
    const { handle, window } = await shellWith();
    handle.settingsStore.update({ general: { closeToTray: false } });
    const event = { preventDefault: vi.fn() };
    window.emit("close", event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(window.hide).not.toHaveBeenCalled();
  });

  it("registers launch at login, with the app path when unpackaged", async () => {
    const { handle } = await shellWith();
    handle.settingsStore.update({ general: { notifications: true } });
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    handle.settingsStore.update({ general: { launchAtLogin: true } });
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true, args: ["/app"] });
    app.isPackaged = true;
    handle.settingsStore.update({ general: { launchAtLogin: false } });
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false });
    app.isPackaged = false;
  });

  it("does not offer launch at login on Linux", async () => {
    const { handle } = await shellWith(undefined, "linux");
    handle.settingsStore.update({ general: { launchAtLogin: true } });
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(handle.settings.state().launchAtLoginSupported).toBe(false);
  });

  it("turns notifications off for platform pages and native notifications", async () => {
    const { handle } = await shellWith();
    const ses = session.fromPartition("persist:discord");
    const check = (permission: string) => (ses.permissionCheckHandler as (...a: unknown[]) => boolean)(null, permission, "https://discord.com");
    expect(check("notifications")).toBe(true);
    handle.settingsStore.update({ general: { notifications: false } });
    expect(check("notifications")).toBe(false);
    expect(check("media")).toBe(true);
    const callback = vi.fn();
    (ses.permissionRequestHandler as (...a: unknown[]) => void)(null, "notifications", callback, { requestingUrl: "https://discord.com/app" });
    expect(callback).toHaveBeenCalledWith(false);

    const fluxer = handle.adapters.get("fluxer") as unknown as { notifications: { emit(n: unknown): void } };
    fluxer.notifications.emit({ title: "Ana", body: "hi", target: "900" });
    expect(electron.Notification.instances).toHaveLength(0);
  });

  it("sends a module that holds media back only its own service's limit for media that loads by itself", async () => {
    const { handle } = await shellWith();
    const telegramView = handle.views.get("telegram") as unknown as InstanceType<typeof WebContentsView>;
    const fluxerView = handle.views.get("fluxer") as unknown as InstanceType<typeof WebContentsView>;
    const limits = () => telegramView.webContents.send.mock.calls.filter(([channel]) => channel === SETTINGS_IPC.mediaAutoLoad).map(([, limit]) => limit);
    telegramView.webContents.emit("did-finish-load");
    fluxerView.webContents.emit("did-finish-load");
    expect(limits()).toEqual([5 * 1024 * 1024]);
    handle.settingsStore.update({ general: { closeToTray: true } });
    handle.settingsStore.update({ services: { fluxer: { mediaAutoLoad: "off" } } });
    expect(limits()).toHaveLength(1);
    handle.settingsStore.update({ general: { mediaAutoLoad: "all" } });
    handle.settingsStore.update({ services: { telegram: { mediaAutoLoad: "1mb" } } });
    expect(limits()).toEqual([5 * 1024 * 1024, Number.POSITIVE_INFINITY, 1024 * 1024]);
    // Fluxer shows media from its own servers and holds none back.
    expect(fluxerView.webContents.send).not.toHaveBeenCalledWith(SETTINGS_IPC.mediaAutoLoad, expect.anything());
  });

  it("sends voice settings to modules that run calls", async () => {
    const { handle, discordView } = await shellWith();
    const fluxerView = handle.views.get("fluxer") as unknown as InstanceType<typeof WebContentsView>;
    fluxerView.webContents.emit("did-finish-load");
    expect(fluxerView.webContents.send).toHaveBeenCalledWith(SETTINGS_IPC.voice, handle.settingsStore.get().voice);
    fluxerView.webContents.send.mockClear();
    handle.settingsStore.update({ general: { closeToTray: true } });
    expect(fluxerView.webContents.send).not.toHaveBeenCalledWith(SETTINGS_IPC.voice, expect.anything());
    handle.settingsStore.update({ voice: { noiseSuppression: false } });
    expect(fluxerView.webContents.send).toHaveBeenCalledWith(SETTINGS_IPC.voice, expect.objectContaining({ noiseSuppression: false }));
    expect(discordView.webContents.send).not.toHaveBeenCalledWith(SETTINGS_IPC.voice, expect.anything());
  });

  it("keeps an open settings page current as accounts change", async () => {
    const { view, discordView } = await opened();
    view.webContents.send.mockClear();
    ipcMain.emit(IPC.discordState, senderEvent(discordView), { guilds: [], badge: { unread: false, mentions: 0 }, user: { name: "Ana" } });
    expect(view.webContents.send).toHaveBeenCalledWith(
      SETTINGS_IPC.state,
      expect.objectContaining({ services: expect.arrayContaining([expect.objectContaining({ id: "discord", account: { state: "signed-in", name: "Ana" } })]) }),
    );
  });

  it("gives each engine its own service's settings values, checked against its module's fields", async () => {
    fs.writeFileSync(
      path.join(userData, "settings.json"),
      JSON.stringify({ services: { mx: { notifications: true, typing: false, options: { slidingSync: false, sneaky: true } }, mx2: { notifications: true, options: { slidingSync: "no" } } } }),
    );
    const { handle } = await shellWith([
      { id: "mx", name: "Matrix", url: "https://x.org", module: "matrix-native" },
      { id: "mx2", name: "Matrix 2", url: "https://y.org", module: "matrix-native" },
    ]);
    const engineOf = (id: string) => WebContentsView.instances.find((v) => v.options.webPreferences.partition === `persist:engine_${id}` || v.options.webPreferences.partition === `engine_${id}`)!;
    const info = (id: string) => ipcMain.invoke(ENGINE_IPC.invoke, senderEvent(engineOf(id)), { type: "info" });
    expect(((await info("mx")) as { settings: unknown }).settings).toEqual({ typing: false, readReceipts: true, slidingSync: false });
    expect(((await info("mx2")) as { settings: unknown }).settings).toEqual({ typing: true, readReceipts: true, slidingSync: true });
    expect(((await info("telegram")) as { settings: unknown }).settings).toEqual({ typing: true });
    expect(((await info("fluxer")) as { settings: unknown }).settings).toEqual({ typing: true });

    // A change reaches only that service's engine.
    engineOf("mx").webContents.send.mockClear();
    engineOf("mx2").webContents.send.mockClear();
    handle.settingsStore.update({ services: { mx2: { options: { slidingSync: false } } } });
    expect(engineOf("mx2").webContents.send).toHaveBeenCalledWith(ENGINE_IPC.command, { type: "settings", values: { typing: true, readReceipts: true, slidingSync: false } });
    expect(engineOf("mx").webContents.send).not.toHaveBeenCalledWith(ENGINE_IPC.command, expect.objectContaining({ type: "settings" }));
    handle.settingsStore.update({ general: { closeToTray: false } });
    expect(engineOf("mx2").webContents.send).toHaveBeenCalledTimes(1);
    handle.settingsStore.update({ services: { mx2: null } });
    expect(engineOf("mx2").webContents.send).toHaveBeenLastCalledWith(ENGINE_IPC.command, { type: "settings", values: { typing: true, readReceipts: true, slidingSync: true } });

    // The general typing choice reaches every engine that sends typing, unless the service chose its own.
    engineOf("mx").webContents.send.mockClear();
    engineOf("telegram").webContents.send.mockClear();
    handle.settingsStore.update({ general: { typingIndicators: false } });
    expect(engineOf("mx2").webContents.send).toHaveBeenLastCalledWith(ENGINE_IPC.command, { type: "settings", values: { typing: false, readReceipts: true, slidingSync: true } });
    expect(engineOf("mx").webContents.send).toHaveBeenLastCalledWith(ENGINE_IPC.command, { type: "settings", values: { typing: false, readReceipts: true, slidingSync: false } });
    expect(engineOf("telegram").webContents.send).toHaveBeenLastCalledWith(ENGINE_IPC.command, { type: "settings", values: { typing: false } });
    handle.settingsStore.update({ services: { mx: { typing: true } } });
    expect(engineOf("mx").webContents.send).toHaveBeenLastCalledWith(ENGINE_IPC.command, { type: "settings", values: { typing: true, readReceipts: true, slidingSync: false } });
  });

  it("shows what an engine says about its settings while the page is open, and runs its actions", async () => {
    const { handle, railView } = await shellWith([{ id: "mx", name: "Matrix", url: "https://x.org", module: "matrix-native" }]);
    const engine = WebContentsView.instances.find((v) => v.options.webPreferences.partition === "persist:engine_mx")!;
    const status = { forgetCallServices: { text: "Remembered: jwt.x.org" } };
    ipcMain.emit(ENGINE_IPC.event, senderEvent(engine), { type: "settingsStatus", status }); // page closed: nothing to refresh
    ipcMain.emit(IPC.railSettings, senderEvent(railView), true);
    const view = handle.settingsView() as unknown as InstanceType<typeof WebContentsView>;
    view.webContents.send.mockClear();
    ipcMain.emit(ENGINE_IPC.event, senderEvent(engine), { type: "settingsStatus", status: { forgetCallServices: { text: "None remembered yet.", disabled: true } } });
    expect(view.webContents.send).toHaveBeenLastCalledWith(
      SETTINGS_IPC.state,
      expect.objectContaining({ services: expect.arrayContaining([expect.objectContaining({ id: "mx", settingsStatus: { forgetCallServices: { text: "None remembered yet.", disabled: true } } })]) }),
    );
    await ipcMain.invoke(ENGINE_IPC.invoke, senderEvent(engine), { type: "info" });
    ipcMain.emit(SETTINGS_IPC.action, senderEvent(view), { type: "serviceAction", id: "mx", key: "forgetCallServices" });
    await flush();
    expect(engine.webContents.send).toHaveBeenCalledWith(ENGINE_IPC.command, { type: "settingAction", key: "forgetCallServices" });
  });

  it("gives a module that wires its own view its values, and changes to its adapter", async () => {
    let host: Parameters<NonNullable<PlatformModule["load"]>>[0] | undefined;
    const applySettings = vi.fn();
    const custom: PlatformModule = {
      manifest: { id: "custom", name: "Custom", label: "Custom", color: "#123456", configurable: true, settings: [{ kind: "toggle", key: "sound", label: "Sound", default: true }] },
      load: (h) => {
        host = h;
        return { adapter: Object.assign(new GenericWebAdapter(h.def), { applySettings }), start: () => {} };
      },
    };
    const bare: PlatformModule = { manifest: { ...custom.manifest, id: "bare" }, load: ({ def }) => ({ adapter: new GenericWebAdapter(def), start: () => {} }) };
    fs.writeFileSync(
      path.join(userData, "platforms.json"),
      JSON.stringify([{ id: "mine", name: "Mine", url: "https://mine.example", module: "custom" }, { id: "b", name: "B", url: "https://b.example", module: "bare" }]),
    );
    const handle = await createShell({ dist: DIST, userData }, "win32", undefined, [custom, bare]);
    expect(host!.settings()).toEqual({ sound: true });
    handle.settingsStore.update({ services: { mine: { options: { sound: false } } } });
    expect(host!.settings()).toEqual({ sound: false });
    expect(applySettings).toHaveBeenCalledWith({ sound: false });
    // An adapter without applySettings is left alone.
    handle.settingsStore.update({ services: { b: { options: { sound: false } } } });
    expect(applySettings).toHaveBeenCalledOnce();
  });

  it("opens settings from the tray", async () => {
    const { handle, window } = await shellWith();
    const tray = Tray.instances[0]!;
    tray.menu!.template.find((item) => item.label === "Settings")!.click!();
    expect(window.show).toHaveBeenCalled();
    expect((handle.settingsView() as unknown as InstanceType<typeof WebContentsView>).visible).toBe(true);
  });
});

describe("unified Messages", () => {
  const dms = [
    { id: "5", title: "Ana", unread: true, mentions: 2, lastActivity: 200 },
    { id: "6", title: "Bo", unread: false, mentions: 0, lastActivity: 100 },
  ];
  async function withDms() {
    const ctx = await shellWith();
    ipcMain.emit(IPC.discordState, senderEvent(ctx.discordView), { guilds: [], badge: { unread: true, mentions: 2 }, dms });
    return ctx;
  }
  const fluxerView = (handle: Awaited<ReturnType<typeof shellWith>>["handle"]) =>
    handle.views.get("fluxer") as unknown as InstanceType<typeof WebContentsView>;

  it("opens the list across the content area and badges the rail button", async () => {
    const { handle, window, railView, discordView } = await withDms();
    expect(railView.webContents.send).toHaveBeenLastCalledWith(
      IPC.railState,
      expect.objectContaining({ messagesOpen: false, messagesBadge: { unread: true, mentions: 2 } }),
    );
    ipcMain.emit(IPC.railMessages, senderEvent(discordView), true); // only the rail may
    ipcMain.emit(IPC.railMessages, senderEvent(railView), 1);
    expect(handle.messagesView()).toBeUndefined();

    ipcMain.emit(IPC.railMessages, senderEvent(railView), true);
    const view = handle.messagesView() as unknown as InstanceType<typeof WebContentsView>;
    expect(view.options.webPreferences).toMatchObject({ preload: path.join(DIST, "preload-messages.js"), partition: "multicord-messages", sandbox: true });
    expect(view.webContents.loadFile).toHaveBeenCalledWith(path.join(DIST, "messages.html"));
    expect(window.children.at(-1)).toBe(handle.tooltipView);
    expect(view.visible).toBe(true);
    expect(view.bounds).toEqual({ x: 72, y: 0, width: 928, height: 700 });
    expect(discordView.visible).toBe(false);
    expect(railView.webContents.send).toHaveBeenLastCalledWith(IPC.railState, expect.objectContaining({ messagesOpen: true, settingsOpen: false }));
    expect(view.webContents.send).toHaveBeenLastCalledWith(IPC.messagesState, {
      conversations: [
        expect.objectContaining({ key: "discord:dm:5", title: "Ana", module: { label: "Discord", color: "#5865f2" } }),
        expect.objectContaining({ key: "discord:dm:6" }),
      ],
      activeKey: null,
    });
    const check = session.fromPartition("multicord-messages").permissionCheckHandler as (...a: unknown[]) => boolean;
    expect(check(null, "media")).toBe(false);

    // Platform pages hide their own sidebars meanwhile, and learn it again after a reload.
    expect(discordView.webContents.send).toHaveBeenCalledWith(IPC.viewCompact, true);
    discordView.webContents.send.mockClear();
    discordView.webContents.emit("did-finish-load");
    expect(discordView.webContents.send).toHaveBeenCalledWith(IPC.viewCompact, true);

    ipcMain.emit(IPC.railMessages, senderEvent(railView), false);
    expect(view.visible).toBe(false);
    expect(discordView.visible).toBe(true);
    expect(discordView.webContents.send).toHaveBeenLastCalledWith(IPC.viewCompact, false);
  });

  it("opens a conversation beside the list", async () => {
    const { handle, railView, discordView } = await withDms();
    ipcMain.emit(IPC.railMessages, senderEvent(railView), true);
    const view = handle.messagesView() as unknown as InstanceType<typeof WebContentsView>;
    ipcMain.emit(IPC.messagesOpen, senderEvent(railView), "discord:dm:5");
    ipcMain.emit(IPC.messagesOpen, senderEvent(view), "discord:dm:404"); // not a listed conversation
    ipcMain.emit(IPC.messagesOpen, senderEvent(view), 5);
    await flush();
    expect(discordView.webContents.send).not.toHaveBeenCalledWith(IPC.discordNavigate, expect.anything());

    ipcMain.emit(IPC.messagesOpen, senderEvent(view), "discord:dm:5");
    await flush();
    expect(discordView.webContents.send).toHaveBeenCalledWith(IPC.discordNavigate, "dm:5");
    expect(view.bounds).toEqual({ x: 72, y: 0, width: 320, height: 700 });
    expect(discordView.bounds).toEqual({ x: 392, y: 0, width: 608, height: 700 });
    expect(discordView.visible).toBe(true);
    expect(fluxerView(handle).visible).toBe(false);
    expect(view.webContents.send).toHaveBeenLastCalledWith(IPC.messagesState, expect.objectContaining({ activeKey: "discord:dm:5" }));

    // A server from the rail leaves the Messages page.
    ipcMain.emit(IPC.railOpen, senderEvent(railView), "discord:home");
    await flush();
    expect(view.visible).toBe(false);
    expect(discordView.bounds).toEqual({ x: 72, y: 0, width: 928, height: 700 });
  });

  it("logs conversations that fail to open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handle, railView } = await withDms();
    ipcMain.emit(IPC.railMessages, senderEvent(railView), true);
    const view = handle.messagesView() as unknown as InstanceType<typeof WebContentsView>;
    vi.spyOn(handle.registry, "open").mockRejectedValueOnce(new Error("gone")).mockResolvedValueOnce(undefined);
    ipcMain.emit(IPC.messagesOpen, senderEvent(view), "discord:dm:5");
    await flush();
    expect(warn).toHaveBeenCalledWith("[messages] could not open discord:dm:5: gone");
    ipcMain.emit(IPC.messagesOpen, senderEvent(view), "discord:dm:5"); // resolves without a target
    await flush();
    expect(view.bounds).toEqual({ x: 72, y: 0, width: 928, height: 700 });
  });

  it("answers the page when it is ready and only sends changes otherwise", async () => {
    const { handle, railView, discordView } = await withDms();
    ipcMain.emit(SETTINGS_IPC.ready, senderEvent(railView));
    ipcMain.emit(IPC.messagesReady, senderEvent(railView)); // before the page exists
    handle.setMessagesOpen(true);
    const view = handle.messagesView() as unknown as InstanceType<typeof WebContentsView>;
    view.webContents.send.mockClear();
    ipcMain.emit(IPC.messagesReady, senderEvent(railView));
    expect(view.webContents.send).not.toHaveBeenCalled();
    ipcMain.emit(IPC.messagesReady, senderEvent(view));
    expect(view.webContents.send).toHaveBeenCalledTimes(1);
    ipcMain.emit(IPC.discordState, senderEvent(discordView), { guilds: [{ id: "1", name: "One", unread: false, mentions: 0 }], badge: { unread: true, mentions: 2 }, dms });
    expect(view.webContents.send).toHaveBeenCalledTimes(1); // same conversations
    ipcMain.emit(IPC.discordState, senderEvent(discordView), { guilds: [], badge: { unread: false, mentions: 0 }, dms: dms.slice(1) });
    expect(view.webContents.send).toHaveBeenCalledTimes(2);
  });

  it("switches between settings and Messages without stacking them", async () => {
    const { handle, railView, discordView } = await withDms();
    handle.setMessagesOpen(true);
    handle.setSettingsOpen(true);
    expect((handle.messagesView() as unknown as InstanceType<typeof WebContentsView>).visible).toBe(false);
    expect((handle.settingsView() as unknown as InstanceType<typeof WebContentsView>).visible).toBe(true);
    expect(discordView.webContents.send).toHaveBeenLastCalledWith(IPC.viewCompact, false);
    expect(railView.webContents.send).toHaveBeenLastCalledWith(IPC.railState, expect.objectContaining({ messagesOpen: false, settingsOpen: true }));
  });

  it("stays quiet about the conversation open beside the list", async () => {
    const { handle, window, railView } = await shellWith();
    const fluxer = handle.adapters.get("fluxer") as unknown as { notifications: { emit(n: unknown): void }; directsChanged: { emit(d: unknown): void } };
    fluxer.directsChanged.emit([{ key: "900", account: {}, title: "Ana", lastActivity: 5, unread: false, mentions: 0 }]);
    vi.spyOn(handle.adapters.get("fluxer")!, "openConversation").mockResolvedValue();
    ipcMain.emit(IPC.railMessages, senderEvent(railView), true);
    ipcMain.emit(IPC.messagesOpen, senderEvent(handle.messagesView() as unknown as InstanceType<typeof WebContentsView>), "fluxer:dm:900");
    await flush();
    window.isFocused.mockReturnValue(true);
    fluxer.notifications.emit({ title: "Ana", body: "hi", target: "900", inView: true });
    expect(electron.Notification.instances).toHaveLength(0);
  });
});

describe("incoming calls", () => {
  const ring = (discordView: InstanceType<typeof WebContentsView>, calls: unknown[]) =>
    ipcMain.emit(IPC.discordState, senderEvent(discordView), { guilds: [], badge: { unread: false, mentions: 0 }, calls });

  it("rings with an urgent notification and a taskbar flash when the platform is not in front", async () => {
    const { handle, window, discordView } = await shellWith();
    handle.setMessagesOpen(true);
    ring(discordView, [{ channelId: "7", from: "Ana" }]);
    expect(window.flashFrame).toHaveBeenCalledWith(true);
    const note = electron.Notification.instances[0]!;
    expect(note.options).toEqual({ title: "Incoming call · Discord", body: "Ana is calling you on Discord", urgency: "critical", timeoutType: "never" });
    note.emit("click");
    await flush();
    expect(discordView.webContents.send).toHaveBeenCalledWith(IPC.discordNavigate, "dm:7");
    expect(discordView.visible).toBe(true);
  });

  it("leaves ringing to the platform when its view is in front of a focused window", async () => {
    const { window, discordView } = await shellWith();
    window.isFocused.mockReturnValue(true);
    ring(discordView, [{ channelId: "7", from: "Ana" }]);
    expect(electron.Notification.instances).toHaveLength(0);
    expect(window.flashFrame).not.toHaveBeenCalled();
  });

  it("still flashes when notifications are off", async () => {
    const { handle, window, discordView } = await shellWith();
    handle.settingsStore.update({ general: { notifications: false } });
    handle.setSettingsOpen(true);
    ring(discordView, [{ channelId: "7", from: "Ana" }]);
    expect(window.flashFrame).toHaveBeenCalledWith(true);
    expect(electron.Notification.instances).toHaveLength(0);
  });

  it("names the platform by its id when it has no definition", async () => {
    const { handle, window } = await shellWith();
    const fluxer = handle.adapters.get("fluxer") as unknown as { incomingCalls: { emit(c: unknown): void } };
    window.isFocused.mockReturnValue(false);
    fluxer.incomingCalls.emit({ conversationKey: "9", from: "Bo", video: true });
    expect(electron.Notification.instances.at(-1)!.options).toMatchObject({ body: "Bo is calling you on Fluxer" });
  });
});

describe("zoom, spell check and grouping", () => {
  it("applies the settings to every content view and session, and follows changes", async () => {
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ general: { zoom: 1.25, spellcheck: false, railGrouping: "platform" } }));
    const { handle, discordView, railView } = await shellWith();
    expect(discordView.webContents.setZoomFactor).toHaveBeenCalledWith(1.25);
    expect(railView.webContents.setZoomFactor).not.toHaveBeenCalled(); // the rail keeps its size
    expect(session.fromPartition("persist:discord").setSpellCheckerEnabled).toHaveBeenCalledWith(false);
    expect(handle.registry.state().grouped).toBe(true);

    handle.setSettingsOpen(true);
    const settingsView = handle.settingsView() as unknown as InstanceType<typeof WebContentsView>;
    expect(settingsView.webContents.setZoomFactor).toHaveBeenCalledWith(1.25);

    handle.settingsStore.update({ general: { zoom: 1.5, spellcheck: true, railGrouping: "mixed" } });
    expect(discordView.webContents.setZoomFactor).toHaveBeenLastCalledWith(1.5);
    expect(settingsView.webContents.setZoomFactor).toHaveBeenLastCalledWith(1.5);
    expect(session.fromPartition("persist:fluxer").setSpellCheckerEnabled).toHaveBeenLastCalledWith(true);
    expect(handle.registry.state()).not.toHaveProperty("grouped");

    discordView.webContents.setZoomFactor.mockClear();
    discordView.webContents.emit("did-finish-load");
    expect(discordView.webContents.setZoomFactor).toHaveBeenCalledWith(1.5);
  });

  it("zooms with Ctrl and +, - or 0 in any content view", async () => {
    const { handle, discordView } = await shellWith();
    const press = (key: string, control = true) => {
      const event = { preventDefault: vi.fn() };
      discordView.webContents.emit("before-input-event", event, { type: "keyDown", control, meta: false, key });
      return event.preventDefault;
    };
    expect(press("=")).toHaveBeenCalled();
    expect(handle.settingsStore.get().general.zoom).toBe(1.1);
    press("-");
    press("-");
    expect(handle.settingsStore.get().general.zoom).toBe(0.9);
    press("0");
    expect(handle.settingsStore.get().general.zoom).toBe(1);
    expect(press("a")).not.toHaveBeenCalled();
    expect(press("=", false)).not.toHaveBeenCalled();
    expect(discordView.webContents.setZoomFactor).toHaveBeenLastCalledWith(1);
  });
});

describe("streamer mode", () => {
  it("keeps message content out of notifications and the Messages page while on", async () => {
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ general: { streamerMode: "on" } }));
    const { handle, discordView } = await shellWith();
    const fluxer = handle.adapters.get("fluxer") as unknown as { notifications: { emit(n: unknown): void }; directsChanged: { emit(d: unknown): void } };
    fluxer.notifications.emit({ title: "Ana", body: "secret plans", target: "900" });
    expect(electron.Notification.instances[0]!.options).toEqual({ title: "New message", body: "On Fluxer" });
    ipcMain.emit(IPC.discordState, senderEvent(discordView), { guilds: [], badge: { unread: false, mentions: 0 }, calls: [{ channelId: "7", from: "Ana" }] });
    expect(electron.Notification.instances[1]!.options).toMatchObject({ title: "Incoming call", body: "Someone is calling you on Discord" });

    fluxer.directsChanged.emit([{ key: "900", account: {}, title: "Ana", preview: "secret plans", lastActivity: 5, unread: false, mentions: 0 }]);
    handle.setMessagesOpen(true);
    const view = handle.messagesView() as unknown as InstanceType<typeof WebContentsView>;
    const sent = view.webContents.send.mock.calls.at(-1)![1] as { conversations: { title: string; preview?: string }[] };
    expect(sent.conversations[0]).toMatchObject({ title: "Ana" });
    expect(sent.conversations[0]).not.toHaveProperty("preview");
    expect(handle.settings.state().streaming).toBe(true);

    handle.settingsStore.update({ general: { streamerMode: "off" } });
    const after = view.webContents.send.mock.calls.at(-1)![1] as { conversations: { preview?: string }[] };
    expect(after.conversations[0]!.preview).toBe("secret plans");
  });

  it("hides Discord's DM previews the same way", async () => {
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ general: { streamerMode: "on" } }));
    const { handle, discordView } = await shellWith();
    const dm = { id: "7", title: "Ana", unread: false, mentions: 0, lastActivity: 5, preview: "Ana: secret plans" };
    ipcMain.emit(IPC.discordState, senderEvent(discordView), { guilds: [], badge: { unread: false, mentions: 0 }, dms: [dm] });
    handle.setMessagesOpen(true);
    const view = handle.messagesView() as unknown as InstanceType<typeof WebContentsView>;
    const sent = view.webContents.send.mock.calls.at(-1)![1] as { conversations: { key: string; title: string; preview?: string }[] };
    const discord = sent.conversations.find((c) => c.title === "Ana")!;
    expect(discord).toBeDefined();
    expect(discord).not.toHaveProperty("preview");

    handle.settingsStore.update({ general: { streamerMode: "off" } });
    const after = view.webContents.send.mock.calls.at(-1)![1] as { conversations: { title: string; preview?: string }[] };
    expect(after.conversations.find((c) => c.title === "Ana")!.preview).toBe("Ana: secret plans");
  });

  it("turns on by itself while streaming software runs", async () => {
    vi.useFakeTimers();
    try {
      processList.names = ["obs64.exe"];
      const { handle } = await shellWith(); // "auto" is the default
      expect(handle.settings.state()).not.toHaveProperty("streaming");
      handle.setSettingsOpen(true);
      await vi.advanceTimersByTimeAsync(2000);
      expect(handle.settings.state().streaming).toBe(true);
      const settingsView = handle.settingsView() as unknown as InstanceType<typeof WebContentsView>;
      expect(settingsView.webContents.send).toHaveBeenLastCalledWith(SETTINGS_IPC.state, expect.objectContaining({ streaming: true }));
      handle.settingsStore.update({ general: { streamerMode: "off" } });
      expect(handle.settings.state()).not.toHaveProperty("streaming");
      handle.settingsStore.update({ general: { streamerMode: "auto" } });
      await vi.advanceTimersByTimeAsync(2000);
      expect(handle.settings.state().streaming).toBe(true);
    } finally {
      processList.names = [];
      vi.useRealTimers();
    }
  });
});

describe("app links", () => {
  it("finds an app link among arguments, not web links or files", () => {
    expect(findAppLink(["electron.exe", ".", "--flag", "discord://-/channels/1"])).toBe("discord://-/channels/1");
    expect(findAppLink(["https://discord.com", "file:///x", "C:\\Users\\x"])).toBeUndefined();
  });

  it("registers declared schemes only when the user opts in, and opens links in their module", async () => {
    const { handle, discordView } = await shellWith();
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    expect(await handle.openLink("discord://-/channels/@me/5")).toBe(false); // off: ignored
    expect(handle.settings.state().linkSchemes).toEqual(["discord"]);

    handle.settingsStore.update({ general: { openLinks: true } });
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith("discord", process.execPath, ["/app"]);
    handle.setMessagesOpen(true);
    expect(await handle.openLink("discord://-/channels/@me/5")).toBe(true);
    expect(discordView.webContents.send).toHaveBeenCalledWith(IPC.discordNavigate, "dm:5");
    expect(discordView.visible).toBe(true);
    expect(await handle.openLink("discord://-/store")).toBe(false);
    expect(await handle.openLink("matrix://room")).toBe(false);
    expect(await handle.openLink("::not a url")).toBe(false);

    app.isDefaultProtocolClient.mockReturnValueOnce(false).mockReturnValueOnce(true);
    handle.settingsStore.update({ general: { openLinks: false } });
    expect(app.removeAsDefaultProtocolClient).not.toHaveBeenCalled();
    app.isPackaged = true;
    handle.settingsStore.update({ general: { openLinks: false } });
    expect(app.removeAsDefaultProtocolClient).toHaveBeenCalledWith("discord", process.execPath, []);
    app.isPackaged = false;
  });

  it("opens links from a second launch, from macOS and from the first launch", async () => {
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ general: { openLinks: true } }));
    app.getPath.mockReturnValue(userData);
    const argv = process.argv;
    process.argv = [...argv, "discord://-/channels/@me/1"];
    try {
      const early = { preventDefault: vi.fn() };
      startApp(DIST);
      app.emit("open-url", early, "discord://-/channels/@me/2"); // before the shell is ready
      expect(early.preventDefault).toHaveBeenCalled();
      await flush();
      await flush();
      const discordView = WebContentsView.instances.find((v) => v.options.webPreferences.partition === "persist:discord")!;
      expect(discordView.webContents.send).toHaveBeenCalledWith(IPC.discordNavigate, "dm:2");
      app.emit("second-instance", {}, ["electron.exe", "discord://-/channels/@me/3"]);
      app.emit("second-instance", {}, ["electron.exe"]);
      app.emit("open-url", { preventDefault: vi.fn() }, "discord://-/channels/@me/4");
      await flush();
      expect(discordView.webContents.send).toHaveBeenCalledWith(IPC.discordNavigate, "dm:3");
      expect(discordView.webContents.send).toHaveBeenCalledWith(IPC.discordNavigate, "dm:4");
    } finally {
      process.argv = argv;
    }
  });

  it("opens a link given on the first launch", async () => {
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ general: { openLinks: true } }));
    app.getPath.mockReturnValue(userData);
    const argv = process.argv;
    process.argv = [...argv, "discord://-/channels/@me/1"];
    try {
      startApp(DIST);
      await flush();
      await flush();
      const discordView = WebContentsView.instances.find((v) => v.options.webPreferences.partition === "persist:discord")!;
      expect(discordView.webContents.send).toHaveBeenCalledWith(IPC.discordNavigate, "dm:1");
    } finally {
      process.argv = argv;
    }
  });
});

describe("updates", () => {
  it("checks automatically in packaged builds, follows the setting and restarts into an update", async () => {
    app.isPackaged = true;
    try {
      updater.checkForUpdates.mockClear();
      const { handle, window } = await shellWith();
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
      handle.setSettingsOpen(true);
      const view = handle.settingsView() as unknown as InstanceType<typeof WebContentsView>;
      updater.listeners.get("update-downloaded")!({ version: "9.9.9" });
      expect(view.webContents.send).toHaveBeenLastCalledWith(SETTINGS_IPC.state, expect.objectContaining({ update: { state: "ready", version: "9.9.9" } }));
      handle.settingsStore.update({ general: { autoUpdate: false } });
      ipcMain.emit(SETTINGS_IPC.action, senderEvent(view), { type: "installUpdate" });
      await flush();
      expect(updater.quitAndInstall).toHaveBeenCalled();
      const event = { preventDefault: vi.fn() };
      window.emit("close", event);
      expect(event.preventDefault).not.toHaveBeenCalled(); // quitting into the update
    } finally {
      app.isPackaged = false;
    }
  });

  it("does not check in development runs", async () => {
    updater.checkForUpdates.mockClear();
    const { handle } = await shellWith();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(handle.settings.state().update).toEqual({ state: "unavailable" });
  });
});

describe("Discord notifications", () => {
  it("shows them through the shell, honouring streamer mode, and clicks run Discord's handler", async () => {
    const { handle, discordView, railView } = await shellWith();
    ipcMain.emit(IPC.discordNotification, senderEvent(railView), { id: "1", title: "Ana", body: "hi" });
    ipcMain.emit(IPC.discordNotification, senderEvent(discordView), { id: "x", title: "Ana", body: "hi" });
    expect(electron.Notification.instances).toHaveLength(0);
    ipcMain.emit(IPC.discordNotification, senderEvent(discordView), { id: "1", title: "Ana", body: "hi" });
    const note = electron.Notification.instances[0]!;
    expect(note.options).toEqual({ title: "Ana · Discord", body: "hi" });
    note.emit("click");
    await flush();
    expect(discordView.webContents.send).toHaveBeenCalledWith(IPC.discordNotificationClick, "1");
    handle.settingsStore.update({ general: { streamerMode: "on" } });
    ipcMain.emit(IPC.discordNotification, senderEvent(discordView), { id: "2", title: "Ana", body: "secret" });
    expect(electron.Notification.instances[1]!.options).toEqual({ title: "New message", body: "On Discord" });
  });
});

describe("global shortcuts", () => {
  it("registers the user's shortcuts and routes them to calls and the window", async () => {
    electron.globalShortcut.taken.add("Ctrl+Shift+D");
    const { handle, window, discordView } = await shellWith();
    const fluxerView = handle.views.get("fluxer") as unknown as InstanceType<typeof WebContentsView>;
    expect(electron.globalShortcut.register).not.toHaveBeenCalled(); // none set by default
    handle.settingsStore.update({ shortcuts: { toggleMute: "Ctrl+Shift+M", toggleDeafen: "Ctrl+Shift+D", showApp: "F13" } });
    expect(handle.settings.state().shortcutErrors).toEqual(["toggleDeafen"]);

    electron.globalShortcut.callbacks.get("Ctrl+Shift+M")!();
    expect(fluxerView.webContents.send).toHaveBeenCalledWith(SETTINGS_IPC.voiceCommand, "toggleMute");
    expect(discordView.webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: "keyDown", keyCode: "M", modifiers: ["control", "shift"] }],
      [{ type: "keyUp", keyCode: "M", modifiers: ["control", "shift"] }],
    ]);

    window.isFocused.mockReturnValue(true);
    electron.globalShortcut.callbacks.get("F13")!();
    expect(window.hide).toHaveBeenCalled();
    window.isFocused.mockReturnValue(false);
    electron.globalShortcut.callbacks.get("F13")!();
    expect(window.show).toHaveBeenCalled();

    handle.settingsStore.update({ shortcuts: { toggleMute: null } });
    expect(electron.globalShortcut.callbacks.has("Ctrl+Shift+M")).toBe(false);
  });

  it("drops every shortcut when the app quits", () => {
    startApp(DIST);
    app.emit("will-quit");
    expect(electron.globalShortcut.unregisterAll).toHaveBeenCalled();
  });
});

describe("Rich Presence", () => {
  it("listens only while turned on and hands activities to Discord", async () => {
    const { handle, discordView } = await shellWith();
    expect(rpc.start).not.toHaveBeenCalled();
    handle.settingsStore.update({ general: { richPresence: true } });
    expect(rpc.start).toHaveBeenCalled();
    expect(detector.start).toHaveBeenCalled();
    const update = { source: "rpc-1", activity: null };
    rpc.onActivity!(update);
    expect(discordView.webContents.send).toHaveBeenCalledWith(IPC.discordActivity, update);

    // A game an app already reports is not detected twice; detected games don't count as apps.
    rpc.onActivity!({ source: "rpc-2", activity: { application_id: "42", type: 0, flags: 0 } });
    expect(detector.covered!("42")).toBe(true);
    detector.onActivity!({ source: "rpc-0", activity: { application_id: "7", type: 0, flags: 0 } });
    expect(detector.covered!("7")).toBe(false);
    // A reloaded Discord page is given what is showing now.
    discordView.webContents.send.mockClear();
    discordView.webContents.emit("did-finish-load");
    expect(discordView.webContents.send).toHaveBeenCalledWith(IPC.discordActivity, { source: "rpc-2", activity: { application_id: "42", type: 0, flags: 0 } });
    rpc.onActivity!({ source: "rpc-2", activity: null });
    expect(detector.covered!("42")).toBe(false);

    handle.settingsStore.update({ general: { richPresence: false } });
    expect(rpc.stop).toHaveBeenCalled();
    expect(detector.stop).toHaveBeenCalled();
  });

  it("warns when every discord-ipc path is taken", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rpc.listening = false;
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ general: { richPresence: true } }));
    await shellWith();
    await flush();
    expect(warn).toHaveBeenCalledWith("[rich presence] every discord-ipc path is taken; not listening");
    rpc.listening = true;
  });
});

describe("voice keys in every native call", () => {
  it("reach Matrix and Stoat views as they reach Fluxer's, and no view without calls", async () => {
    const { handle } = await shellWith([
      { id: "mx", name: "Matrix", url: "https://x.org", module: "matrix-native" },
      { id: "st", name: "Stoat", url: "https://stoat.chat", module: "stoat-native" },
    ]);
    const viewOf = (id: string) => handle.views.get(id) as unknown as InstanceType<typeof WebContentsView>;
    handle.settingsStore.update({ shortcuts: { toggleDeafen: "Ctrl+Shift+D" }, voice: { pushToTalk: "Backquote", pushToTalkGlobal: true } });
    electron.globalShortcut.callbacks.get("Ctrl+Shift+D")!();
    keyHook.listeners.get("keydown")!({ keycode: 41 });
    for (const id of ["fluxer", "mx", "st"]) {
      expect(viewOf(id).webContents.send).toHaveBeenCalledWith(SETTINGS_IPC.voiceCommand, "toggleDeafen");
      expect(viewOf(id).webContents.send).toHaveBeenCalledWith(SETTINGS_IPC.voiceCommand, "talkStart");
    }
    expect(viewOf("telegram").webContents.send).not.toHaveBeenCalledWith(SETTINGS_IPC.voiceCommand, expect.anything());
    app.emit("will-quit");
  });
});

describe("push to talk in the background", () => {
  it("talks in native calls and passes the key to Discord while unfocused", async () => {
    const { handle, window, discordView } = await shellWith();
    const fluxerView = handle.views.get("fluxer") as unknown as InstanceType<typeof WebContentsView>;
    handle.settingsStore.update({ voice: { pushToTalk: "Backquote", pushToTalkGlobal: true } });
    expect(handle.settings.state()).not.toHaveProperty("pushToTalkError");
    window.isFocused.mockReturnValue(false);
    keyHook.listeners.get("keydown")!({ keycode: 41 });
    expect(fluxerView.webContents.send).toHaveBeenCalledWith(SETTINGS_IPC.voiceCommand, "talkStart");
    expect(discordView.webContents.sendInputEvent).toHaveBeenLastCalledWith({ type: "keyDown", keyCode: "`" });
    window.isFocused.mockReturnValue(true);
    discordView.webContents.sendInputEvent.mockClear();
    keyHook.listeners.get("keyup")!({ keycode: 41 });
    expect(fluxerView.webContents.send).toHaveBeenCalledWith(SETTINGS_IPC.voiceCommand, "talkStop");
    expect(discordView.webContents.sendInputEvent).not.toHaveBeenCalled(); // focused: Discord hears the key itself

    handle.settingsStore.update({ voice: { pushToTalk: "MediaPlayPause" } });
    expect(handle.settings.state().pushToTalkError).toBe("This key cannot be watched while Multicord is in the background.");
    handle.settingsStore.update({ voice: { pushToTalkGlobal: false } });
    expect(keyHook.listeners.size).toBe(0);
    app.emit("will-quit");
  });
});

describe("health watch", () => {
  it("collects services' checks and tells the user when one breaks", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handle, window } = await shellWith();
    const discord = handle.adapters.get("discord")!;
    vi.spyOn(discord, "health").mockReturnValue([{ name: "Server list", ok: false }]);
    const checks = health.deps!.checks();
    expect(checks.get("discord")).toEqual({ signedIn: false, checks: [{ name: "Server list", ok: false }] });
    expect(checks.has("fluxer")).toBe(true); // engines report theirs too

    health.deps!.onBroken("discord", [{ name: "Server list", ok: false }]);
    expect(warn).toHaveBeenCalledWith("[discord] stopped working: Server list");
    const note = electron.Notification.instances.at(-1)!;
    expect(note.options).toEqual({ title: "Part of Discord stopped working", body: "Server list. Settings > Diagnostics has the details." });
    note.emit("click");
    expect(window.show).toHaveBeenCalled();
    expect(handle.settings.state()).toBeDefined();
    note.emit("close");

    handle.settingsStore.update({ services: { discord: { notifications: false } } });
    const before = electron.Notification.instances.length;
    health.deps!.onBroken("discord", [{ name: "Server list", ok: false }]);
    health.deps!.onBroken("gone", [{ name: "X", ok: false }]);
    expect(electron.Notification.instances.length).toBe(before + 1);
    expect(electron.Notification.instances.at(-1)!.options).toMatchObject({ title: "Part of gone stopped working" });
  });
});

describe("Linux screen-share sound", () => {
  it("stops venmic when a platform view's share ends, and only then", async () => {
    const { railView, discordView } = await shellWith();
    const { SystemAudio } = await import("../../src/main/systemAudio");
    const stop = vi.spyOn(SystemAudio.prototype, "stop");
    ipcMain.emit(IPC.screenAudioEnd, { sender: railView.webContents });
    expect(stop).not.toHaveBeenCalled();
    ipcMain.emit(IPC.screenAudioEnd, { sender: discordView.webContents });
    expect(stop).toHaveBeenCalledTimes(1);
    stop.mockRestore();
  });
});
