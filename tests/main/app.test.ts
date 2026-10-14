import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../mocks/electron"));

import * as electron from "../mocks/electron";
import { APP_NAME, createShell, startApp } from "../../src/main/app";
import { IPC } from "../../src/shared/ipc";
import { NATIVE_IPC } from "../../src/shared/native";

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
    expect(railView.webContents.send).toHaveBeenLastCalledWith(IPC.railState, handle.registry.state());
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
