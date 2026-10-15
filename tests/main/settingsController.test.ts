import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../mocks/electron"));

import { MODULES } from "../../src/main/modules/index";
import { SettingsController, type SettingsDeps } from "../../src/main/settingsController";
import { SettingsStore } from "../../src/main/settingsStore";
import type { PlatformAdapter } from "../../src/shared/adapter";
import { DEFAULT_SETTINGS, type ServiceSettingValues, type SettingsViewState } from "../../src/shared/settings";

let dir: string;
let platformsFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicord-settings-"));
  platformsFile = path.join(dir, "platforms.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const readPlatforms = () => JSON.parse(fs.readFileSync(platformsFile, "utf8")) as unknown[];

function controller(adapters: Record<string, Partial<PlatformAdapter>> = {}, overrides: Partial<SettingsDeps> = {}) {
  const published: SettingsViewState[] = [];
  const deps: SettingsDeps = {
    platformsFile,
    modules: MODULES,
    store: new SettingsStore(path.join(dir, "settings.json")),
    adapters: new Map(Object.entries(adapters)) as unknown as Map<string, PlatformAdapter>,
    secretsPersistent: () => true,
    launchAtLoginSupported: true,
    version: "1.2.3",
    openService: vi.fn(),
    clearSession: vi.fn(async () => {}),
    forgetSecrets: vi.fn(),
    restart: vi.fn(),
    publish: (state) => published.push(state),
    ...overrides,
  };
  const last = () => published.at(-1)!;
  return { settings: new SettingsController(deps), deps, published, last };
}

describe("settings state", () => {
  it("lists every service with its module and account", () => {
    fs.writeFileSync(platformsFile, JSON.stringify([{ id: "el", name: "Element", url: "https://app.element.io", enabled: false }]));
    const { settings } = controller({
      discord: { accountStatus: () => ({ state: "signed-in", name: "Ana" }) },
      fluxer: {},
    });
    const state = settings.state();
    expect(state.services).toEqual([
      {
        id: "discord",
        name: "Discord",
        url: "https://discord.com/app",
        module: "discord",
        moduleName: "Discord",
        label: "Discord",
        color: "#5865f2",
        notice: expect.stringContaining("carries some risk to your account"),
        enabled: true,
        builtIn: true,
        account: { state: "signed-in", name: "Ana" },
      },
      expect.objectContaining({ id: "fluxer", account: { state: "unknown" } }),
      expect.objectContaining({ id: "telegram", label: "Telegram", holdsMedia: true }),
      expect.objectContaining({ id: "el", enabled: false, builtIn: false, label: "Web" }),
    ]);
    expect(state.services[3]).not.toHaveProperty("account");
    // Fluxer shows media from its own servers: no limit to choose.
    expect(state.services[1]).not.toHaveProperty("holdsMedia");
    expect(state.modules.map((m) => [m.id, m.fixedUrl])).toEqual([
      ["discord", true],
      ["fluxer", false],
      ["fluxer-web", false],
      ["telegram", true],
      ["matrix-native", false],
      ["matrix", false],
      ["stoat-native", false],
      ["stoat", false],
      ["spacebar-native", false],
      ["spacebar", false],
      ["nerimity-native", false],
      ["nerimity", false],
      ["mumble", false],
      ["web", false],
    ]);
    expect(state.modules.filter((m) => m.calls).map((m) => m.id)).toEqual(["fluxer", "matrix-native", "stoat-native"]);
    expect(state).toMatchObject({ settings: DEFAULT_SETTINGS, restartNeeded: false, secretsPersistent: true, launchAtLoginSupported: true, version: "1.2.3" });
    expect(state).not.toHaveProperty("error");
  });

  it("passes on each service's health checks", () => {
    const { settings } = controller({ discord: { health: () => [{ name: "Guild bar", ok: false, detail: "Rail" }] }, fluxer: {} });
    const services = settings.state().services;
    expect(services.find((s) => s.id === "discord")!.health).toEqual([{ name: "Guild bar", ok: false, detail: "Rail" }]);
    expect(services.find((s) => s.id === "fluxer")).not.toHaveProperty("health");
  });

  it("shows the update status and checks or installs on request", async () => {
    const updates = { status: { state: "ready", version: "2" } as const, check: vi.fn(async () => {}), install: vi.fn() };
    const { settings } = controller({}, { updates });
    expect(settings.state().update).toEqual({ state: "ready", version: "2" });
    await settings.handle({ type: "checkUpdates" });
    await settings.handle({ type: "installUpdate" });
    expect(updates.check).toHaveBeenCalled();
    expect(updates.install).toHaveBeenCalled();
    const bare = controller().settings;
    expect(bare.state()).not.toHaveProperty("update");
    await bare.handle({ type: "checkUpdates" });
    await bare.handle({ type: "installUpdate" });
  });

  it("shows the favourites and clears their cache on request", async () => {
    const summary = { categories: [{ id: "0123456789abcdef", name: "Cats", count: 2 }], items: 3, cacheBytes: 2048, pinned: 1 };
    const favourites = { summary: vi.fn(() => summary), clearCache: vi.fn() };
    const { settings } = controller({}, { favourites });
    expect(settings.state().favourites).toEqual(summary);
    await settings.handle({ type: "clearFavouriteCache" });
    expect(favourites.clearCache).toHaveBeenCalled();
    const bare = controller().settings;
    expect(bare.state()).not.toHaveProperty("favourites");
    await bare.handle({ type: "clearFavouriteCache" });
  });

  it("copies the diagnostics report", async () => {
    const copyText = vi.fn();
    const { settings } = controller({ discord: { health: () => [{ name: "Bridge", ok: false }] } }, { copyText, os: "linux 6.8" });
    await settings.handle({ type: "copyReport" });
    expect(copyText.mock.calls[0]![0]).toContain("OS: linux 6.8");
    expect(copyText.mock.calls[0]![0]).toContain("- [FAILED] Bridge");
    await controller().settings.handle({ type: "copyReport" }); // nowhere to copy to
    const noOs = vi.fn();
    await controller({}, { copyText: noOs }).settings.handle({ type: "copyReport" });
    expect(noOs.mock.calls[0]![0]).toContain("OS: unknown");
  });

  it("reports shortcuts another app holds", () => {
    expect(controller({}, { shortcutErrors: () => ["toggleMute"] }).settings.state().shortcutErrors).toEqual(["toggleMute"]);
    expect(controller({}, { shortcutErrors: () => [] }).settings.state()).not.toHaveProperty("shortcutErrors");
    expect(controller({}, { pushToTalkError: () => "No hook" }).settings.state().pushToTalkError).toBe("No hook");
    expect(controller({}, { pushToTalkError: () => undefined }).settings.state()).not.toHaveProperty("pushToTalkError");
  });

  it("lists the app link schemes the modules open", () => {
    expect(controller({}, { linkSchemes: ["discord"] }).settings.state().linkSchemes).toEqual(["discord"]);
    expect(controller({}, { linkSchemes: [] }).settings.state()).not.toHaveProperty("linkSchemes");
  });

  it("says when streamer mode is hiding content", () => {
    expect(controller({}, { streaming: () => true }).settings.state().streaming).toBe(true);
    expect(controller({}, { streaming: () => false }).settings.state()).not.toHaveProperty("streaming");
  });

  it("only republishes changes unless forced", () => {
    const { settings, published } = controller();
    settings.refresh();
    settings.refresh();
    expect(published).toHaveLength(1);
    settings.refresh(true);
    expect(published).toHaveLength(2);
  });

  it("names modules it does not know by their id", () => {
    const { settings } = controller({}, { modules: MODULES.filter((m) => m.manifest.id !== "fluxer") });
    expect(settings.state().services.find((s) => s.id === "fluxer")).toMatchObject({ moduleName: "fluxer", label: "fluxer", color: "#80848e" });
  });
});

describe("settings actions", () => {
  it("updates settings through the store", async () => {
    const { settings, deps, last } = controller();
    await settings.handle({ type: "update", patch: { general: { notifications: false } } });
    expect(deps.store.get().general.notifications).toBe(false);
    expect(last().settings.general.notifications).toBe(false);
    expect(new SettingsStore(path.join(dir, "settings.json")).get().general.notifications).toBe(false);
  });

  it("turns services off, but never the last one", async () => {
    const { settings, last } = controller();
    await settings.handle({ type: "setEnabled", id: "fluxer", enabled: false });
    expect(readPlatforms()).toEqual([{ id: "fluxer", enabled: false }]);
    expect(last().restartNeeded).toBe(true);
    expect(last().services.find((s) => s.id === "fluxer")!.enabled).toBe(false);

    await settings.handle({ type: "setEnabled", id: "telegram", enabled: false });
    await settings.handle({ type: "setEnabled", id: "discord", enabled: false });
    expect(last().error).toBe("Keep at least one service turned on.");
    expect(readPlatforms()).toEqual([{ id: "fluxer", enabled: false }, { id: "telegram", enabled: false }]);
    await settings.handle({ type: "restart" });
    expect(last()).not.toHaveProperty("error"); // cleared by the next action
  });

  it("adds, renames and removes services", async () => {
    const { settings, deps, last } = controller();
    await settings.handle({ type: "addService", module: "discord", name: "Work" });
    expect(readPlatforms()).toEqual([{ id: "work", name: "Work", module: "discord" }]);
    expect(last().services.at(-1)).toMatchObject({ id: "work", url: "https://discord.com/app", enabled: true });

    await settings.handle({ type: "renameService", id: "work", name: "Job" });
    expect(readPlatforms()).toEqual([{ id: "work", name: "Job", module: "discord" }]);

    await settings.handle({ type: "removeService", id: "work" });
    expect(readPlatforms()).toEqual([]);
    expect(deps.forgetSecrets).toHaveBeenCalledWith("work");
    expect(deps.clearSession).toHaveBeenCalledWith("work");
  });

  it("explains a service that cannot be added", async () => {
    const { settings, last } = controller();
    await settings.handle({ type: "addService", module: "web", name: "Element" });
    expect(last().error).toBe("Could not add Element: url must be an https URL.");
    await settings.handle({ type: "addService", module: "irc", name: "M" });
    expect(last().error).toBe("That module cannot be added.");
    expect(fs.existsSync(platformsFile)).toBe(false);
  });

  it("will not remove the last service that is on", async () => {
    fs.writeFileSync(platformsFile, JSON.stringify([{ id: "discord", enabled: false }, { id: "fluxer", enabled: false }, { id: "telegram", enabled: false }, { id: "w", name: "W", module: "discord" }]));
    const { settings, deps, last } = controller();
    await settings.handle({ type: "removeService", id: "w" });
    expect(last().error).toBe("Keep at least one service turned on.");
    expect(deps.forgetSecrets).not.toHaveBeenCalled();
  });

  it("never overwrites a platforms.json it cannot read", async () => {
    fs.writeFileSync(platformsFile, "{broken");
    const { settings, last } = controller();
    await settings.handle({ type: "setEnabled", id: "fluxer", enabled: false });
    expect(last().error).toMatch(/syntax error/);
    expect(fs.readFileSync(platformsFile, "utf8")).toBe("{broken");
  });

  it("signs out through the adapter, else by clearing the web session", async () => {
    const signOut = vi.fn(async () => {});
    const { settings, deps } = controller({ fluxer: { signOut }, discord: {} });
    await settings.handle({ type: "signOut", id: "fluxer" });
    expect(signOut).toHaveBeenCalled();
    expect(deps.clearSession).not.toHaveBeenCalled();
    await settings.handle({ type: "signOut", id: "discord" });
    expect(deps.clearSession).toHaveBeenCalledWith("discord");
    await settings.handle({ type: "signOut", id: "gone" });
    expect(deps.clearSession).toHaveBeenCalledTimes(1);
  });

  it("opens running services and restarts", async () => {
    const { settings, deps } = controller({ fluxer: {} });
    await settings.handle({ type: "openService", id: "fluxer" });
    await settings.handle({ type: "openService", id: "element" });
    expect(deps.openService).toHaveBeenCalledTimes(1);
    expect(deps.openService).toHaveBeenCalledWith("fluxer");
    await settings.handle({ type: "restart" });
    expect(deps.restart).toHaveBeenCalled();
  });
});

describe("settings modules declare", () => {
  const withMatrix = () => fs.writeFileSync(platformsFile, JSON.stringify([{ id: "mx", name: "Matrix", url: "https://x.org", module: "matrix-native" }]));

  it("shows a module's fields with each service, and only declared keys of what the service reports", () => {
    withMatrix();
    const { settings } = controller({
      mx: { settingsStatus: () => ({ forgetCallServices: { text: "Remembered: a.org" }, sneaky: { text: "not declared" } }) },
      telegram: { settingsStatus: () => ({}) },
    });
    const services = settings.state().services;
    const mx = services.find((s) => s.id === "mx")!;
    expect(mx.settings!.map((f) => f.key)).toEqual(["readReceipts", "slidingSync", "forgetCallServices"]);
    // Typing indicators are the shell's setting, offered for modules that send them.
    expect(mx.sendsTyping).toBe(true);
    expect(services.find((s) => s.id === "discord")).not.toHaveProperty("sendsTyping");
    expect(mx.settingsStatus).toEqual({ forgetCallServices: { text: "Remembered: a.org" } });
    // Declares settings but reports nothing (or is off): no status.
    expect(services.find((s) => s.id === "telegram")!.settings!.map((f) => f.key)).toEqual(["forgetApiId"]);
    expect(services.find((s) => s.id === "telegram")).not.toHaveProperty("settingsStatus");
    expect(services.find((s) => s.id === "discord")).not.toHaveProperty("settings");
  });

  it("stores values only for the service's own declared toggles and choices", async () => {
    withMatrix();
    const { settings, deps, last } = controller();
    await settings.handle({ type: "update", patch: { services: { mx: { options: { slidingSync: false } } } } });
    expect(deps.store.get().services.mx).toEqual({ notifications: true, options: { slidingSync: false } });
    for (const options of [{ slidingSync: "dark" }, { typing: false }, { forgetCallServices: true }, { other: true }] as ServiceSettingValues[]) {
      await settings.handle({ type: "update", patch: { services: { mx: { options } } } });
      expect(last().error).toBe("That setting does not exist for this service.");
    }
    // Not for another module's fields, nor for a service that does not exist.
    await settings.handle({ type: "update", patch: { services: { discord: { options: { slidingSync: false } } } } });
    expect(last().error).toBe("That setting does not exist for this service.");
    await settings.handle({ type: "update", patch: { services: { nope: { options: { slidingSync: false } } } } });
    expect(last().error).toBe("That setting does not exist for this service.");
    expect(deps.store.get().services.mx).toEqual({ notifications: true, options: { slidingSync: false } });
    // Notifications and resets need no fields.
    await settings.handle({ type: "update", patch: { services: { discord: { notifications: false }, mx: null } } });
    expect(last().error).toBeUndefined();
    expect(deps.store.get().services).toEqual({ discord: { notifications: false } });
  });

  it("runs a declared action on the running service only", async () => {
    withMatrix();
    const runSettingAction = vi.fn(async () => {});
    const { settings, last } = controller({ mx: { runSettingAction }, telegram: {} });
    await settings.handle({ type: "serviceAction", id: "mx", key: "forgetCallServices" });
    expect(runSettingAction).toHaveBeenCalledWith("forgetCallServices");
    expect(last().error).toBeUndefined();
    await settings.handle({ type: "serviceAction", id: "mx", key: "typing" });
    expect(last().error).toBe("That setting does not exist for this service.");
    await settings.handle({ type: "serviceAction", id: "discord", key: "forgetCallServices" });
    expect(last().error).toBe("That setting does not exist for this service.");
    await settings.handle({ type: "serviceAction", id: "telegram", key: "forgetApiId" });
    expect(last().error).toBe("Turn the service on first.");
    expect(runSettingAction).toHaveBeenCalledOnce();
  });
});

describe("settings store", () => {
  it("reads leniently and announces changes", () => {
    const file = path.join(dir, "nested", "settings.json");
    const store = new SettingsStore(file);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    const changed = vi.fn();
    store.changed.on(changed);
    store.update({ voice: { echoCancellation: false } });
    expect(changed).toHaveBeenCalledWith({ settings: store.get(), patch: { voice: { echoCancellation: false } } });
    fs.writeFileSync(file, "not json");
    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS);
  });
});
