import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../mocks/electron"));

import * as electron from "../mocks/electron";
import { APP_NAME, createShell, startApp } from "../../src/main/app";
import { IPC } from "../../src/shared/ipc";
import { NATIVE_IPC } from "../../src/shared/native";
import { SETTINGS_IPC } from "../../src/shared/settings";
import { GenericWebAdapter } from "../../src/main/adapters/genericWebAdapter";
import type { PlatformModule } from "../../src/main/modules/types";

const { BaseWindow, WebContentsView, Tray, app, ipcMain, session, desktopCapturer, shell } = electron;

const DIST = "/dist";
let userData: string;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function senderEvent(view: InstanceType<typeof WebContentsView>) {
  return { sender: view.webContents };
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
    expect(window.children).toEqual([railView, discordView, handle.views.get("fluxer"), handle.tooltipView]);

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
    (ses.permissionRequestHandler as (...a: unknown[]) => void)(null, "notifications", callback);
    (ses.permissionRequestHandler as (...a: unknown[]) => void)(null, "geolocation", callback);
    expect(callback.mock.calls).toEqual([[true], [false]]);
    expect((ses.permissionCheckHandler as (...a: unknown[]) => boolean)(null, "media")).toBe(true);
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

    window.isFocused.mockReturnValue(true);
    update(5);
    expect(window.flashFrame).toHaveBeenCalledTimes(1);

    update(0);
    expect(window.setTitle).toHaveBeenLastCalledWith(APP_NAME);
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
  const discovery = {
    endpoints: { api_public: "https://api.fx", gateway: "wss://gw.fx", media: "https://media.fx" },
    features: { account_identity: "email" },
  };

  class StubSocket {
    static urls: string[] = [];
    constructor(url: string) {
      StubSocket.urls.push(url);
    }
    send(): void {}
    close(): void {}
    addEventListener(): void {}
  }

  beforeEach(() => {
    StubSocket.urls = [];
    vi.stubGlobal("WebSocket", StubSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => (String(url).endsWith("/.well-known/fluxer") ? discovery : {}) })),
    );
  });

  it("runs Fluxer in a sandboxed native view fed by the main process", async () => {
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
    await flush();

    ipcMain.emit(NATIVE_IPC.action, senderEvent(railView), { type: "ready" });
    ipcMain.emit(NATIVE_IPC.action, senderEvent(view), { type: "bogus" });
    expect(view.webContents.send).not.toHaveBeenCalledWith(NATIVE_IPC.state, expect.objectContaining({ screen: "chat" }));
    view.webContents.send.mockClear();
    ipcMain.emit(NATIVE_IPC.action, senderEvent(view), { type: "ready" });
    await flush();
    expect(view.webContents.send).toHaveBeenCalledWith(NATIVE_IPC.state, expect.objectContaining({ screen: "login", platform: "Fluxer" }));
  });

  it("logs failed actions instead of crashing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handle } = await shellWith();
    const view = handle.views.get("fluxer") as unknown as InstanceType<typeof WebContentsView>;
    const adapter = handle.adapters.get("fluxer") as unknown as { handleAction: unknown };
    adapter.handleAction = async () => {
      throw new Error("boom");
    };
    ipcMain.emit(NATIVE_IPC.action, senderEvent(view), { type: "ready" });
    await flush();
    expect(warn).toHaveBeenCalledWith("[fluxer] boom");
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

  it("tells the adapter when its view is in front", async () => {
    const { handle, railView } = await shellWith();
    const setVisible = vi.spyOn(handle.adapters.get("fluxer")!, "setVisible");
    ipcMain.emit(IPC.railOpen, senderEvent(railView), "fluxer:home");
    await flush();
    expect(setVisible).toHaveBeenLastCalledWith(true);
    ipcMain.emit(IPC.railOpen, senderEvent(railView), "discord:home");
    await flush();
    expect(setVisible).toHaveBeenLastCalledWith(false);
  });

  it("picks files through the OS dialog for the native client", async () => {
    const { handle, window } = await shellWith();
    const files = (handle.adapters.get("fluxer") as unknown as { deps: { files: { pick(): Promise<string[]>; open(p: string): Promise<unknown> } } }).deps.files;
    expect(await files.pick()).toEqual([]);
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["C:/a.txt"] });
    expect(await files.pick()).toEqual(["C:/a.txt"]);
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(window, { title: "Attach files", properties: ["openFile", "multiSelections"] });
    const file = path.join(userData, "note.txt");
    fs.writeFileSync(file, "hi");
    expect(await files.open(file)).toMatchObject({ filename: "note.txt", size: 2, contentType: "text/plain" });
  });

  it("resumes a stored session with the default network services", async () => {
    // Stored as the mocked safeStorage encrypts it (byte-reversed).
    const encrypted = Buffer.from("flx_saved").reverse().toString("base64");
    fs.writeFileSync(path.join(userData, "credentials.json"), JSON.stringify({ "fluxer:fluxer.app:token": encrypted }));
    await createShell({ dist: DIST, userData }, "win32");
    await flush();
    await flush();
    expect(StubSocket.urls).toEqual(["wss://gw.fx/?v=1&encoding=json"]);
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
    expect(note.options).toEqual({ title: "Ana", body: "hi" });
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

  it("forgets a removed service's data", async () => {
    fs.writeFileSync(path.join(userData, "platforms.json"), JSON.stringify([{ id: "el", name: "Element", url: "https://app.element.io" }]));
    fs.writeFileSync(path.join(userData, "credentials.json"), JSON.stringify({ "el:x:token": "a", "fluxer:x:token": "b" }));
    const { view } = await opened();
    ipcMain.emit(SETTINGS_IPC.action, senderEvent(view), { type: "removeService", id: "el" });
    await flush();
    expect(session.fromPartition("persist:el").clearStorageData).toHaveBeenCalled();
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
    const check = ses.permissionCheckHandler as (...a: unknown[]) => boolean;
    expect(check(null, "notifications")).toBe(true);
    handle.settingsStore.update({ general: { notifications: false } });
    expect(check(null, "notifications")).toBe(false);
    expect(check(null, "media")).toBe(true);
    const callback = vi.fn();
    (ses.permissionRequestHandler as (...a: unknown[]) => void)(null, "notifications", callback);
    expect(callback).toHaveBeenCalledWith(false);

    const fluxer = handle.adapters.get("fluxer") as unknown as { notifications: { emit(n: unknown): void } };
    fluxer.notifications.emit({ title: "Ana", body: "hi", target: "900" });
    expect(electron.Notification.instances).toHaveLength(0);
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
