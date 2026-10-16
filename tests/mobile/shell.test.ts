import { describe, expect, it, vi } from "vitest";
import { MOBILE_MODULES, nativeModuleTable } from "../../src/mobile/modules";
import { isShellCommand, type BootInfo, type NativeEvent, type ShellBridge, type ShellCommand } from "../../src/mobile/protocol";
import { FIRST_PLATFORMS, MobileShell, type UiState } from "../../src/mobile/shell";
import type { SettingsViewState } from "../../src/shared/settings";

/** A native side in memory: what the page sent, and a way to send it events. */
function fakeBridge(files: BootInfo["files"] = {}, boot?: unknown) {
  const sent: ShellCommand[] = [];
  let listener: ((event: unknown) => void) | undefined;
  const bridge: ShellBridge = {
    request: vi.fn(async () => boot ?? { files, version: "0.1.0", os: "android 14" }),
    send: (command) => {
      // Everything the page sends must pass native code's check.
      expect(isShellCommand(command), JSON.stringify(command)).toBe(true);
      sent.push(command);
    },
    onEvent: (cb) => {
      listener = cb;
    },
  };
  const emit = async (event: NativeEvent | unknown) => {
    listener!(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const of = <T extends ShellCommand["type"]>(type: T) => sent.filter((c): c is Extract<ShellCommand, { type: T }> => c.type === type);
  return { bridge, sent, emit, of };
}

const MATRIX = { id: "matrix", name: "Matrix", module: "matrix-native", url: "https://matrix.org" };
const TWO = JSON.stringify([{ id: "discord", enabled: false }, { id: "fluxer", enabled: false }, { id: "telegram", enabled: false }, MATRIX, { id: "tg", name: "TG", module: "telegram" }]);

async function started(files: BootInfo["files"] = { platforms: TWO }) {
  const fake = fakeBridge(files);
  const renders: UiState[] = [];
  const settings: SettingsViewState[] = [];
  const shell = new MobileShell(fake.bridge, { render: (state) => renders.push(state), settings: (state) => settings.push(state) });
  await shell.start();
  return { ...fake, shell, renders, settings, last: () => renders.at(-1)! };
}

describe("module table", () => {
  it("lists every module the phone runs, with the engine's hosts and storage, or as a web client", () => {
    expect(nativeModuleTable().map((m) => m.id)).toEqual(MOBILE_MODULES.map((m) => m.manifest.id));
    expect(nativeModuleTable().find((m) => m.id === "telegram")).toEqual({ id: "telegram", engine: "telegram", storage: false, hosts: ["*.web.telegram.org"] });
    expect(nativeModuleTable().find((m) => m.id === "matrix-native")).toEqual({ id: "matrix-native", engine: "matrix", storage: true });
    // Element, Stoat, Fluxer, Spacebar and Nerimity's own web apps, and any web app; Discord is not on the phone yet.
    expect(nativeModuleTable().filter((m) => m.web).map((m) => m.id)).toEqual(["matrix", "stoat", "fluxer-web", "spacebar", "nerimity", "web"]);
    expect(nativeModuleTable().find((m) => m.id === "web")).toEqual({ id: "web", storage: true, web: true });
    expect(nativeModuleTable().some((m) => m.id === "discord")).toBe(false);
    // A module with neither an engine nor a web app does not run.
    expect(nativeModuleTable([{ manifest: { id: "web", name: "Web", label: "W", color: "#000000", configurable: true } }])).toEqual([]);
  });
});

describe("starting", () => {
  it("starts each service that is on, with its settings, and shows the first", async () => {
    const { of, last, shell } = await started();
    expect(of("start")).toEqual([
      { type: "start", instance: "matrix", module: "matrix-native", name: "Matrix", url: "https://matrix.org", settings: { readReceipts: true, slidingSync: true, typing: true } },
      { type: "start", instance: "tg", module: "telegram", name: "TG", url: "https://telegram.org", settings: { typing: true } },
    ]);
    // Both hold media: their views get the limit (5 MB by default).
    expect(of("viewSettings")).toEqual([
      { type: "viewSettings", instance: "matrix", mediaAutoLoad: 5 * 1024 * 1024 },
      { type: "viewSettings", instance: "tg", mediaAutoLoad: 5 * 1024 * 1024 },
    ]);
    expect(of("layout").at(-1)).toEqual({ type: "layout", instance: "matrix", overlay: false });
    expect(last()).toMatchObject({ screen: { page: "service", instance: "matrix" }, title: "Matrix", drawer: false });
    expect(last().services).toEqual([
      { id: "matrix", name: "Matrix", label: "Matrix", color: "#0dbd8b" },
      { id: "tg", name: "TG", label: "Telegram", color: "#2aabee" },
    ]);
    expect([...shell.adapters.keys()]).toEqual(["matrix", "tg"]);
    // The shown engine learns it is seen; the other that it is not.
    expect(of("command").filter((c) => c.command.type === "visible")).toEqual([
      { type: "command", instance: "matrix", command: { type: "visible", visible: true } },
      { type: "command", instance: "tg", command: { type: "visible", visible: false } },
    ]);
  });

  it("turns Discord off on a first run, and starts the built-in services that remain", async () => {
    const { of } = await started({});
    expect(of("save")[0]).toEqual({ type: "save", file: "platforms", text: FIRST_PLATFORMS });
    expect(of("start").map((s) => s.instance)).toEqual(["fluxer", "telegram"]);
  });

  it("skips services whose module does not run here, and shows the home page when none is left", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const platforms = JSON.stringify([{ id: "fluxer", enabled: false }, { id: "telegram", enabled: false }]);
    const { of, last } = await started({ platforms });
    expect(of("start")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('discord: module "discord" does not run on this phone'));
    expect(last()).toMatchObject({ screen: { page: "home" }, title: "Multicord" });
    expect(of("layout").at(-1)).toEqual({ type: "layout", instance: null, overlay: false });
  });

  it("restores the rail order and settings, and leaves broken files at their defaults", async () => {
    const { shell } = await started({ platforms: TWO, order: JSON.stringify(["tg:s1"]), settings: JSON.stringify({ general: { railGrouping: "platform" } }) });
    expect(shell.registry.getOrder()).toEqual(["tg:s1"]);
    expect(shell.registry.state().grouped).toBe(true);
    const broken = await started({ platforms: TWO, order: "{", settings: "{" });
    expect(broken.shell.registry.getOrder()).toEqual([]);
  });

  it("refuses boot info that does not check out", async () => {
    const fake = fakeBridge({}, { files: [] });
    const shell = new MobileShell(fake.bridge, { render: vi.fn(), settings: vi.fn() });
    await expect(shell.start()).rejects.toThrow("no valid boot info");
  });
});

const DIRECTS = {
  type: "engine",
  instance: "tg",
  event: {
    type: "directs",
    directs: [
      { key: "1", title: "Ana", preview: "hi", lastActivity: 100, unread: true, mentions: 2 },
      { key: "2", title: "Bo", lastActivity: 300, unread: false, mentions: 0 },
    ],
  },
};

describe("web-client services", () => {
  const WEB = JSON.stringify([{ id: "fluxer", enabled: false }, { id: "telegram", enabled: false }, { id: "el", name: "Element", module: "matrix", url: "https://app.element.io" }, { id: "tg", name: "TG", module: "telegram" }]);

  it("start as the service's own web app, with an entry in the drawer that shows it", async () => {
    const { of, last, shell } = await started({ platforms: WEB });
    expect(of("start")[0]).toEqual({ type: "start", instance: "el", module: "matrix", name: "Element", url: "https://app.element.io" });
    expect(last().screen).toEqual({ page: "service", instance: "el" });
    expect(last().services[0]).toEqual({ id: "el", name: "Element", label: "Matrix", color: "#0dbd8b" });
    expect([...shell.webAdapters.keys()]).toEqual(["el"]);
    // Web apps are told nothing about being seen; engines are.
    expect(of("command").map((c) => c.instance)).toEqual(["tg"]);
    shell.show("tg");
    await shell.open("el:app");
    expect(last().screen).toEqual({ page: "service", instance: "el" });
  });

  it("take their unread count from the page title, as on the desktop", async () => {
    const { emit, last, of } = await started({ platforms: WEB });
    await emit({ type: "title", instance: "el", title: "(3) Element" });
    expect(last().rail.entries.find((e) => e.key === "el:app")).toMatchObject({ unread: true, mentions: 3 });
    expect(of("badge").at(-1)).toEqual({ type: "badge", count: 3 });
    await emit({ type: "title", instance: "tg", title: "(9) Telegram" });
    await emit({ type: "title", instance: "gone", title: "(9) x" });
    expect(last().mentions).toBe(3);
  });

  it("show in Settings with a Restart, which reloads the web app", async () => {
    const { shell, of } = await started({ platforms: WEB });
    expect(shell.settings.state().services.find((s) => s.id === "el")).toMatchObject({ restartable: true, account: { state: "unknown" } });
    await shell.settingsAction({ type: "restartService", id: "el" });
    expect(of("restartEngine")).toEqual([{ type: "restartEngine", instance: "el" }]);
  });
});

describe("the unified Messages list", () => {
  it("lists every service's direct conversations, newest first, with the unread badge", async () => {
    const { emit, last } = await started();
    await emit(DIRECTS);
    await emit({ ...DIRECTS, instance: "matrix", event: { type: "directs", directs: [{ key: "!r", title: "Cy", lastActivity: 200, unread: false, mentions: 0 }] } });
    expect(last().messages.conversations.map((c) => [c.key, c.title])).toEqual([["tg:dm:2", "Bo"], ["matrix:dm:!r", "Cy"], ["tg:dm:1", "Ana"]]);
    expect(last().messages.conversations[2]).toMatchObject({ preview: "hi", module: { label: "Telegram" } });
    expect(last().messagesBadge).toEqual({ unread: true, mentions: 2 });
  });

  it("opens as a page of its own, and back returns to the service shown before", async () => {
    const { shell, last, of } = await started();
    shell.setDrawer(true);
    shell.setMessagesOpen(true);
    expect(last()).toMatchObject({ screen: { page: "messages" }, title: "Messages", drawer: false });
    expect(of("layout").at(-1)).toEqual({ type: "layout", instance: null, overlay: false });
    shell.back();
    expect(last()).toMatchObject({ screen: { page: "service", instance: "matrix" } });
    shell.setMessagesOpen(true);
    shell.setMessagesOpen(false);
    expect(last().screen).toEqual({ page: "service", instance: "matrix" });
  });

  it("goes home when closed before any service was shown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { shell, last } = await started({ platforms: JSON.stringify([{ id: "fluxer", enabled: false }, { id: "telegram", enabled: false }]) });
    expect(warn).toHaveBeenCalled();
    shell.setMessagesOpen(true);
    shell.setMessagesOpen(false);
    expect(last()).toMatchObject({ screen: { page: "home" }, title: "Multicord" });
  });

  it("opens a conversation in its service's chat view, and only conversations it lists", async () => {
    const { emit, shell, last, of } = await started();
    await emit(DIRECTS);
    shell.setMessagesOpen(true);
    await shell.openConversation("tg:dm:1");
    expect(of("command").at(-2)).toEqual({ type: "command", instance: "tg", command: { type: "openConversation", key: "1" } });
    expect(last().screen).toEqual({ page: "service", instance: "tg" });
    const sent = of("command").length;
    await shell.openConversation("tg:dm:nope");
    expect(of("command")).toHaveLength(sent);
  });

  it("keeps message previews out while streaming", async () => {
    const { emit, shell, last } = await started();
    await shell.settingsAction({ type: "update", patch: { general: { streamerMode: "on" } } });
    await emit(DIRECTS);
    expect(last().messages.conversations.every((c) => c.preview === undefined)).toBe(true);
    expect(last().messages.conversations.map((c) => c.title)).toEqual(["Bo", "Ana"]);
  });
});

describe("events from native code", () => {
  it("hands engine events to their adapter, and ignores what does not check out", async () => {
    const { emit, shell, last, of } = await started();
    await emit({ type: "engine", instance: "matrix", event: { type: "servers", servers: [{ key: "s1", name: "Room", unread: true, mentions: 2 }] } });
    expect(last().rail.entries.map((e) => e.key)).toContain("matrix:s1");
    expect(last()).toMatchObject({ mentions: 2, unread: true });
    expect(of("badge").at(-1)).toEqual({ type: "badge", count: 2 });
    await emit({ type: "engine", instance: "matrix", event: { type: "servers", servers: "nope" } });
    await emit({ type: "engine", instance: "gone", event: { type: "homeBadge", badge: { unread: false, mentions: 0 } } });
    expect(shell.registry.state().entries.map((e) => e.key)).toContain("matrix:s1");
  });

  it("reports engine health in Settings", async () => {
    const { emit, shell } = await started();
    await emit({ type: "health", instance: "matrix", state: "stopped", restarts: 6, lastExit: "crashed" });
    expect(shell.adapters.get("matrix")!.health()[0]).toMatchObject({ ok: false, detail: expect.stringContaining("(last: crashed)") });
    await emit({ type: "health", instance: "matrix", state: "running", restarts: 1 });
    expect(shell.adapters.get("matrix")!.health()[0]).toEqual({ name: "Engine running", ok: true, detail: "It has restarted 1 time." });
  });

  it("tells engines when the app leaves the screen and comes back", async () => {
    const { emit, of } = await started();
    await emit({ type: "appVisible", visible: false });
    expect(of("command").at(-1)).toEqual({ type: "command", instance: "matrix", command: { type: "visible", visible: false } });
    await emit({ type: "appVisible", visible: true });
    expect(of("command").at(-1)).toEqual({ type: "command", instance: "matrix", command: { type: "visible", visible: true } });
  });

  it("opens a tapped notification in its service", async () => {
    const { emit, of, last } = await started();
    await emit({ type: "openNotification", instance: "tg", target: "42", railKey: "dm:42" });
    expect(of("command").some((c) => c.instance === "tg" && c.command.type === "openConversation")).toBe(true);
    expect(last().screen).toEqual({ page: "service", instance: "tg" });
    expect(last().rail.activeKey).toBe("tg:dm:42");
    await emit({ type: "openNotification", instance: "matrix", target: "7" });
    expect(last().screen).toEqual({ page: "service", instance: "matrix" });
    await emit({ type: "openNotification", instance: "gone", target: "7" });
    expect(last().screen).toEqual({ page: "service", instance: "matrix" });
  });

  it("logs a notification that cannot be opened", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emit, shell } = await started();
    vi.spyOn(shell.registry, "openNotification").mockRejectedValueOnce(new Error("boom"));
    await emit({ type: "openNotification", instance: "tg", target: "42" });
    expect(warn).toHaveBeenCalledWith("[tg] could not open a notification: boom");
  });
});

describe("notifications", () => {
  const message = (inView = false) => ({ type: "engine", instance: "tg", event: { type: "notification", notification: { title: "Ana", body: "hi", target: "42", railKey: "dm:42", inView } } });

  it("shows engines' notifications, naming the service", async () => {
    const { emit, of } = await started();
    await emit(message());
    expect(of("notify")).toEqual([{ type: "notify", instance: "tg", title: "Ana · TG", body: "hi", target: "42", railKey: "dm:42" }]);
  });

  it("leaves out what is on screen, unless the app is not", async () => {
    const { emit, of, shell } = await started();
    shell.show("tg");
    await emit(message(true));
    expect(of("notify")).toEqual([]);
    shell.setDrawer(true);
    await emit(message(true));
    expect(of("notify")).toHaveLength(1);
    shell.setDrawer(false);
    await emit({ type: "appVisible", visible: false });
    await emit(message(true));
    expect(of("notify")).toHaveLength(2);
  });

  it("follows the notification settings, in general and per service", async () => {
    const { emit, of, shell } = await started();
    await shell.settingsAction({ type: "update", patch: { services: { tg: { notifications: false } } } });
    await emit(message());
    expect(of("notify")).toEqual([]);
    await shell.settingsAction({ type: "update", patch: { services: { tg: { notifications: true } }, general: { notifications: false } } });
    await emit(message());
    expect(of("notify")).toEqual([]);
  });

  it("keeps content out in streamer mode", async () => {
    const { emit, of, shell } = await started();
    await shell.settingsAction({ type: "update", patch: { general: { streamerMode: "on" } } });
    await emit(message());
    await emit({ type: "engine", instance: "tg", event: { type: "call", call: { conversationKey: "42", from: "Ana", video: false } } });
    expect(of("notify")).toEqual([
      { type: "notify", instance: "tg", title: "New message", body: "On TG", target: "42", railKey: "dm:42" },
      { type: "notify", instance: "tg", title: "Incoming call", body: "Someone is calling you on TG", target: "42", railKey: "dm:42", urgent: true },
    ]);
  });

  it("rings for calls while the service is not in front, and clips long text", async () => {
    const { emit, of, shell } = await started();
    await emit({ type: "engine", instance: "tg", event: { type: "call", call: { conversationKey: "k".repeat(199), from: "Ana", video: true } } });
    expect(of("notify")[0]).toEqual({ type: "notify", instance: "tg", title: "Incoming call · TG", body: "Ana is calling you on TG", target: "k".repeat(199), urgent: true });
    shell.show("tg");
    await emit({ type: "engine", instance: "tg", event: { type: "call", call: { conversationKey: "1", from: "Ana", video: false } } });
    expect(of("notify")).toHaveLength(1);
    await emit({ type: "engine", instance: "matrix", event: { type: "notification", notification: { title: "t".repeat(200), body: "b".repeat(2000), target: "1" } } });
    const clipped = of("notify")[1]!;
    expect(clipped.title).toHaveLength(200);
    expect(clipped.title.endsWith("…")).toBe(true);
    expect(clipped.body).toBe("b".repeat(2000));
  });
});

describe("settings", () => {
  it("publishes only services that run here, once the page is open", async () => {
    const { shell, settings, last } = await started();
    shell.setSettingsOpen(true);
    expect(last()).toMatchObject({ screen: { page: "settings" }, title: "Settings" });
    expect(settings.at(-1)!.services.map((s) => s.id)).toEqual(["fluxer", "telegram", "matrix", "tg"]);
    expect(settings.at(-1)).toMatchObject({ secretsPersistent: true, launchAtLoginSupported: true, version: "0.1.0" });
    shell.settingsReady();
    expect(settings.length).toBeGreaterThan(1);
  });

  it("sends a service's settings to its engine, and its media limit to its view", async () => {
    const { shell, of } = await started();
    await shell.settingsAction({ type: "update", patch: { services: { matrix: { options: { readReceipts: false } } } } });
    expect(of("command").at(-1)).toEqual({ type: "command", instance: "matrix", command: { type: "settings", values: { readReceipts: false, slidingSync: true, typing: true } } });
    expect(of("viewSettings").at(-1)).toEqual({ type: "viewSettings", instance: "matrix", mediaAutoLoad: 5 * 1024 * 1024 });
    await shell.settingsAction({ type: "update", patch: { general: { mediaAutoLoad: "all", typingIndicators: false } } });
    expect(of("viewSettings").slice(-2)).toEqual([
      { type: "viewSettings", instance: "matrix", mediaAutoLoad: null },
      { type: "viewSettings", instance: "tg", mediaAutoLoad: null },
    ]);
    expect(of("command").filter((c) => c.command.type === "settings").slice(-2).map((c) => c.instance)).toEqual(["matrix", "tg"]);
    await shell.settingsAction({ type: "update", patch: { general: { zoom: 1.1 } } });
    expect(of("save").at(-1)).toMatchObject({ type: "save", file: "settings" });
    await shell.settingsAction({ type: "update", patch: { general: { railGrouping: "platform" } } });
    expect(shell.registry.state().grouped).toBe(true);
    await shell.settingsAction({ nope: true });
  });

  it("removes a service: its platforms entry, secrets and web storage; restarts on request", async () => {
    const { shell, of } = await started();
    await shell.settingsAction({ type: "removeService", id: "tg" });
    expect(JSON.parse(of("save").at(-1)!.text).map((e: { id: string }) => e.id)).toEqual(["discord", "fluxer", "telegram", "matrix"]);
    expect(of("forgetSecrets")).toEqual([{ type: "forgetSecrets", instance: "tg" }]);
    expect(of("clearSession")).toEqual([{ type: "clearSession", instance: "tg" }]);
    await shell.settingsAction({ type: "restart" });
    expect(of("restart")).toHaveLength(1);
  });

  it("restarts one service's engine, and says how when it was left stopped", async () => {
    const { shell, of, emit } = await started();
    expect(shell.settings.state().services.find((s) => s.id === "matrix")!.restartable).toBe(true);
    await shell.settingsAction({ type: "restartService", id: "matrix" });
    expect(of("restartEngine")).toEqual([{ type: "restartEngine", instance: "matrix" }]);
    await emit({ type: "health", instance: "matrix", state: "stopped", restarts: 5 });
    expect(shell.adapters.get("matrix")!.health()[0]!.detail).toContain("tap Restart beside it in Settings to try again");
  });

  it("adds a service, signs out, copies the report and opens services", async () => {
    const { shell, of, last } = await started();
    await shell.settingsAction({ type: "addService", module: "stoat-native", name: "Stoat" });
    expect(JSON.parse(of("save").at(-1)!.text).at(-1)).toEqual({ id: "stoat", name: "Stoat", module: "stoat-native" });
    await shell.settingsAction({ type: "signOut", id: "matrix" });
    expect(of("command").at(-1)).toEqual({ type: "command", instance: "matrix", command: { type: "signOut" } });
    await shell.settingsAction({ type: "copyReport" });
    expect(of("copyText")[0]!.text).toContain("Version: 0.1.0");
    shell.setSettingsOpen(true);
    await shell.settingsAction({ type: "openService", id: "tg" });
    expect(last().screen).toEqual({ page: "service", instance: "tg" });
  });

  it("refreshes the open page as accounts and health change", async () => {
    const { shell, emit, settings } = await started();
    shell.setSettingsOpen(true);
    const before = settings.length;
    await emit({ type: "engine", instance: "matrix", event: { type: "account", account: { state: "signed-in", name: "Ana" } } });
    await emit({ type: "engine", instance: "matrix", event: { type: "settingsStatus", status: { readReceipts: { text: "On" } } } });
    expect(settings.length).toBeGreaterThan(before);
    expect(settings.at(-1)!.services.find((s) => s.id === "matrix")!.account).toEqual({ state: "signed-in", name: "Ana" });
  });
});

describe("navigation", () => {
  it("opens drawer entries in their service, closing the drawer", async () => {
    const { shell, emit, last, of } = await started();
    await emit({ type: "engine", instance: "tg", event: { type: "servers", servers: [{ key: "g", name: "Folder", unread: false, mentions: 0, kind: "group", children: [] }, { key: "s", name: "Chat", unread: false, mentions: 0 }] } });
    shell.setDrawer(true);
    expect(of("layout").at(-1)).toEqual({ type: "layout", instance: "matrix", overlay: true });
    shell.setDrawer(true);
    await shell.open("tg:g");
    expect(last()).toMatchObject({ drawer: true, screen: { instance: "matrix" } });
    await shell.open("tg:s");
    expect(last()).toMatchObject({ drawer: false, screen: { page: "service", instance: "tg" }, title: "TG" });
    await shell.open("nope");
    shell.show("gone");
    expect(last().screen).toEqual({ page: "service", instance: "tg" });
  });

  it("logs an entry that cannot be opened", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { shell } = await started();
    vi.spyOn(shell.registry, "open").mockRejectedValueOnce(new Error("boom"));
    await shell.open("tg:s");
    expect(warn).toHaveBeenCalledWith("[drawer] could not open tg:s: boom");
  });

  it("goes back from the drawer, then the settings page, then out of the app", async () => {
    const { shell, emit, last, of } = await started();
    shell.setDrawer(true);
    await emit({ type: "back" });
    expect(last().drawer).toBe(false);
    shell.setSettingsOpen(true);
    await emit({ type: "back" });
    expect(last().screen).toEqual({ page: "service", instance: "matrix" });
    await emit({ type: "back" });
    expect(of("backUnhandled")).toHaveLength(1);
  });

  it("closes settings to the home page when no service ever showed", async () => {
    const platforms = JSON.stringify([{ id: "fluxer", enabled: false }, { id: "telegram", enabled: false }, { id: "discord", enabled: true }]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { shell, last, of } = await started({ platforms });
    shell.setSettingsOpen(true);
    shell.back();
    expect(of("backUnhandled")).toHaveLength(1);
    shell.setSettingsOpen(false);
    expect(last().screen).toEqual({ page: "home" });
    expect(shell.settings).toBeDefined();
  });
});
