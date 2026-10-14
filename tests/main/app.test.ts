import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../mocks/electron"));

import * as electron from "../mocks/electron";
import { APP_NAME, createShell, startApp } from "../../src/main/app";
import { IPC } from "../../src/shared/ipc";

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
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "multicord-test-"));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("createShell", () => {
  it("creates the rail and a sandboxed Discord view in its own partition", async () => {
    const { window, discordView, railView } = await shellWith();
    expect(window.options).toMatchObject({ title: APP_NAME, width: 1280, height: 800 });
    expect(window.maximize).not.toHaveBeenCalled();
    expect(window.children).toEqual([railView, discordView]);

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
    expect(handle.registry.state().entries.map((e) => e.key)).toEqual(["discord:home", "discord:1"]);
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
