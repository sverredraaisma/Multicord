import { describe, expect, it } from "vitest";
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  fitsServiceFields,
  isDeviceChoice,
  isServiceId,
  isServiceSettingFields,
  isServiceSettingStatus,
  isServiceSettingValues,
  isSettingsAction,
  isSettingsPatch,
  MAX_SERVICE_FIELDS,
  MAX_STATUS_TEXT,
  parseSettings,
  serviceSettingValues,
  type ServiceSettingField,
  type ServiceSettingValues,
} from "../../src/shared/settings";

const mic = { id: "abc", label: "Headset" };

describe("parseSettings", () => {
  it("falls back to the defaults for anything missing or broken", () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ general: "x", voice: [] })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ general: { closeToTray: "no", notifications: false }, voice: { input: { id: "" } } })).toEqual({
      ...DEFAULT_SETTINGS,
      general: { ...DEFAULT_SETTINGS.general, notifications: false },
    });
  });

  it("keeps valid values and never shares the defaults object", () => {
    const parsed = parseSettings({ general: { launchAtLogin: true }, voice: { input: mic, autoGainControl: false } });
    expect(parsed.general.launchAtLogin).toBe(true);
    expect(parsed.voice).toEqual({ ...DEFAULT_SETTINGS.voice, input: mic, autoGainControl: false });
    parsed.general.closeToTray = false;
    expect(DEFAULT_SETTINGS.general.closeToTray).toBe(true);
  });
});

describe("settings patches", () => {
  it("accepts known keys with the right types only", () => {
    expect(isSettingsPatch({})).toBe(true);
    expect(isSettingsPatch({ general: { notifications: false }, voice: { input: mic, output: null, echoCancellation: false } })).toBe(true);
    for (const bad of [
      null,
      [],
      { other: {} },
      { general: 1 },
      { general: { notifications: "no" } },
      { general: { theme: true } },
      { voice: 1 },
      { voice: { echoCancellation: 1 } },
      { voice: { input: { id: 5 } } },
      { voice: { volume: 3 } },
    ]) {
      expect(isSettingsPatch(bad)).toBe(false);
    }
  });

  it("applies values and clears devices with null", () => {
    const withMic = applySettingsPatch(DEFAULT_SETTINGS, { voice: { input: mic }, general: { closeToTray: false } });
    expect(withMic.voice.input).toEqual(mic);
    expect(withMic.general.closeToTray).toBe(false);
    expect(DEFAULT_SETTINGS.voice.input).toBeUndefined();
    expect(applySettingsPatch(withMic, { voice: { input: null } }).voice).not.toHaveProperty("input");
  });

  it("checks device choices", () => {
    expect(isDeviceChoice(mic)).toBe(true);
    expect(isDeviceChoice({ id: "", label: "x" })).toBe(false);
    expect(isDeviceChoice({ id: "a".repeat(501), label: "x" })).toBe(false);
  });
});

describe("settings actions", () => {
  it("accepts well-formed actions", () => {
    for (const action of [
      { type: "update", patch: { general: { notifications: true } } },
      { type: "setEnabled", id: "fluxer", enabled: false },
      { type: "addService", module: "web", name: "Element", url: "https://app.element.io" },
      { type: "addService", module: "discord", name: "Work" },
      { type: "renameService", id: "discord", name: "Personal" },
      { type: "removeService", id: "element" },
      { type: "signOut", id: "fluxer" },
      { type: "openService", id: "fluxer" },
      { type: "serviceAction", id: "matrix", key: "forgetCallServices" },
      { type: "restart" },
      { type: "checkUpdates" },
      { type: "copyReport" },
      { type: "installUpdate" },
      { type: "clearFavouriteCache" },
    ]) {
      expect(isSettingsAction(action)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const action of [
      null,
      { type: "explode" },
      { type: "update", patch: { voice: { volume: 1 } } },
      { type: "setEnabled", id: "Bad Id", enabled: true },
      { type: "setEnabled", id: "fluxer" },
      { type: "addService", module: "web", name: "  " },
      { type: "addService", module: "web", name: "x".repeat(65) },
      { type: "addService", module: "web", name: "A", url: 5 },
      { type: "renameService", id: "discord" },
      { type: "signOut", id: "../x" },
      { type: "serviceAction", id: "matrix", key: "Bad-Key" },
      { type: "serviceAction", id: "matrix" },
    ]) {
      expect(isSettingsAction(action)).toBe(false);
    }
    expect(isServiceId("a-1")).toBe(true);
  });
});

describe("zoom and other general settings", () => {
  it("steps through the zoom levels and stops at the ends", async () => {
    const { stepZoom, ZOOM_LEVELS } = await import("../../src/shared/settings");
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(0.67, -1)).toBe(0.67);
    expect(stepZoom(1.05, 1)).toBe(1.1); // between steps: the next one in that direction
    expect(stepZoom(1.05, -1)).toBe(1);
    expect(ZOOM_LEVELS).toContain(1);
  });

  it("reads zoom shortcuts", async () => {
    const { zoomShortcut } = await import("../../src/shared/settings");
    const key = (k: string, extra: Partial<{ type: string; control: boolean; meta: boolean }> = {}) => zoomShortcut({ type: "keyDown", control: true, meta: false, key: k, ...extra });
    expect(key("=")).toBe(1);
    expect(key("+")).toBe(1);
    expect(key("-")).toBe(-1);
    expect(key("_")).toBe(-1);
    expect(key("0")).toBe(0);
    expect(key("a")).toBeUndefined();
    expect(key("=", { control: false })).toBeUndefined();
    expect(key("=", { control: false, meta: true })).toBe(1);
    expect(key("=", { type: "keyUp" })).toBeUndefined();
  });

  it("validates grouping, zoom and spell check values", () => {
    expect(parseSettings({ general: { railGrouping: "platform", zoom: 1.5, spellcheck: false } }).general).toMatchObject({ railGrouping: "platform", zoom: 1.5, spellcheck: false });
    expect(parseSettings({ general: { railGrouping: "chaos", zoom: 1.3 } }).general).toMatchObject({ railGrouping: "mixed", zoom: 1 });
    expect(isSettingsPatch({ general: { zoom: 2, railGrouping: "mixed", spellcheck: true } })).toBe(true);
    expect(isSettingsPatch({ general: { zoom: 3 } })).toBe(false);
    expect(isSettingsPatch({ general: { railGrouping: true } })).toBe(false);
    expect(isSettingsPatch({ general: { streamerMode: "auto" } })).toBe(true);
    expect(isSettingsPatch({ general: { streamerMode: "loud" } })).toBe(false);
    expect(isSettingsPatch({ general: { openLinks: true } })).toBe(true);
    expect(isSettingsPatch({ general: { openLinks: "yes" } })).toBe(false);
    expect(isSettingsPatch({ general: { autoUpdate: false } })).toBe(true);
    expect(parseSettings({ general: { streamerMode: "on" } }).general.streamerMode).toBe("on");
  });
});

describe("shortcuts and push to talk", () => {
  it("accepts shortcuts with a modifier, or F13 to F24 alone", async () => {
    const { isAccelerator, isPushToTalkKey } = await import("../../src/shared/settings");
    for (const ok of ["Ctrl+Shift+M", "CommandOrControl+Alt+F5", "Super+Space", "F13", "F24", "Ctrl+`", "Alt+Shift+Ctrl+Super+1"]) expect(isAccelerator(ok)).toBe(true);
    for (const bad of ["M", "Space", "F12", "Ctrl+", "Ctrl+Shift", "Hyper+M", 5, "Ctrl+M".repeat(20)]) expect(isAccelerator(bad)).toBe(false);
    expect(isPushToTalkKey("Backquote")).toBe(true);
    expect(isPushToTalkKey("Key A")).toBe(false);
  });

  it("reads, patches and clears shortcuts and the push-to-talk key", () => {
    expect(DEFAULT_SETTINGS.shortcuts).toEqual({ toggleMute: null, toggleDeafen: null, showApp: null });
    const parsed = parseSettings({ shortcuts: { toggleMute: "Ctrl+Shift+M", showApp: "M" }, voice: { pushToTalk: "Backquote" } });
    expect(parsed.shortcuts).toEqual({ toggleMute: "Ctrl+Shift+M", toggleDeafen: null, showApp: null });
    expect(parsed.voice.pushToTalk).toBe("Backquote");
    expect(parseSettings({ voice: { pushToTalk: "bad key!" } }).voice).not.toHaveProperty("pushToTalk");
    expect(isSettingsPatch({ shortcuts: { toggleMute: "Ctrl+M", showApp: null }, voice: { pushToTalk: null } })).toBe(true);
    for (const bad of [{ shortcuts: 1 }, { shortcuts: { toggleMute: "M" } }, { shortcuts: { launch: "Ctrl+M" } }, { voice: { pushToTalk: "!" } }]) expect(isSettingsPatch(bad)).toBe(false);
    const withKey = applySettingsPatch(DEFAULT_SETTINGS, { shortcuts: { toggleMute: "Ctrl+M" }, voice: { pushToTalk: "F13" } });
    expect(withKey.shortcuts.toggleMute).toBe("Ctrl+M");
    expect(applySettingsPatch(withKey, { voice: { pushToTalk: null } }).voice).not.toHaveProperty("pushToTalk");
  });
});

describe("per-service settings", () => {
  it("reads, patches and resets a service's notifications", async () => {
    const { serviceSettings, MAX_SERVICE_SETTINGS } = await import("../../src/shared/settings");
    expect(DEFAULT_SETTINGS.services).toEqual({});
    const parsed = parseSettings({ services: { fluxer: { notifications: false }, "Bad Id": { notifications: false }, web: { notifications: "no" }, other: 1 } });
    expect(parsed.services).toEqual({ fluxer: { notifications: false } });
    expect(serviceSettings(parsed, "fluxer").notifications).toBe(false);
    expect(serviceSettings(parsed, "discord").notifications).toBe(true);
    expect(serviceSettings(parsed, "constructor").notifications).toBe(true);
    expect(isSettingsPatch({ services: { fluxer: { notifications: true }, web: null } })).toBe(true);
    for (const bad of [{ services: [] }, { services: { "No!": null } }, { services: { a: { notifications: 1 } } }, { services: { a: { badge: true } } }, { services: { a: 5 } }]) {
      expect(isSettingsPatch(bad)).toBe(false);
    }
    const many = Object.fromEntries(Array.from({ length: MAX_SERVICE_SETTINGS + 1 }, (_, i) => [`s${i}`, null]));
    expect(isSettingsPatch({ services: many })).toBe(false);
    const off = applySettingsPatch(DEFAULT_SETTINGS, { services: { fluxer: { notifications: false } } });
    expect(off.services).toEqual({ fluxer: { notifications: false } });
    expect(applySettingsPatch(off, { services: { fluxer: null } }).services).toEqual({});

    // Full: existing entries still change, new ones are not added.
    const full = { ...DEFAULT_SETTINGS, services: Object.fromEntries(Array.from({ length: MAX_SERVICE_SETTINGS }, (_, i) => [`s${i}`, { notifications: true }])) };
    const next = applySettingsPatch(full, { services: { s0: { notifications: false }, extra: { notifications: false } } });
    expect(next.services.s0).toEqual({ notifications: false });
    expect(next.services).not.toHaveProperty("extra");
    const capped = parseSettings({ services: Object.fromEntries(Array.from({ length: MAX_SERVICE_SETTINGS + 5 }, (_, i) => [`s${i}`, { notifications: false }])) });
    expect(Object.keys(capped.services)).toHaveLength(MAX_SERVICE_SETTINGS);
  });
});

describe("media that loads by itself", () => {
  it("has a general limit, 5 MB unless chosen otherwise, checked strictly", () => {
    expect(DEFAULT_SETTINGS.general.mediaAutoLoad).toBe("5mb");
    expect(parseSettings({ general: { mediaAutoLoad: "25mb" } }).general.mediaAutoLoad).toBe("25mb");
    expect(parseSettings({ general: { mediaAutoLoad: "7mb" } }).general.mediaAutoLoad).toBe("5mb");
    expect(isSettingsPatch({ general: { mediaAutoLoad: "off" } })).toBe(true);
    for (const bad of ["inherit", "3mb", 5, null]) expect(isSettingsPatch({ general: { mediaAutoLoad: bad } })).toBe(false);
  });

  it("lets a service choose its own limit, or go back to the general one", () => {
    const parsed = parseSettings({ services: { matrix: { notifications: true, mediaAutoLoad: "all" }, telegram: { notifications: true, mediaAutoLoad: "huge" } } });
    expect(parsed.services).toEqual({ matrix: { notifications: true, mediaAutoLoad: "all" }, telegram: { notifications: true } });
    expect(isSettingsPatch({ services: { matrix: { mediaAutoLoad: "inherit" }, telegram: { mediaAutoLoad: "1mb" } } })).toBe(true);
    expect(isSettingsPatch({ services: { matrix: { mediaAutoLoad: "2mb" } } })).toBe(false);
    const own = applySettingsPatch(DEFAULT_SETTINGS, { services: { matrix: { mediaAutoLoad: "off" } } });
    expect(own.services.matrix).toEqual({ notifications: true, mediaAutoLoad: "off" });
    // Changing something else keeps it; "inherit" drops it.
    expect(applySettingsPatch(own, { services: { matrix: { notifications: false } } }).services.matrix).toEqual({ notifications: false, mediaAutoLoad: "off" });
    expect(applySettingsPatch(own, { services: { matrix: { mediaAutoLoad: "inherit" } } }).services.matrix).toEqual({ notifications: true });
  });

  it("gives each service its limit in bytes", async () => {
    const { mediaAutoLoadLimit } = await import("../../src/shared/settings");
    const settings = applySettingsPatch(DEFAULT_SETTINGS, { general: { mediaAutoLoad: "10mb" }, services: { matrix: { mediaAutoLoad: "off" }, telegram: { mediaAutoLoad: "all" }, stoat: { mediaAutoLoad: "1mb" } } });
    expect(mediaAutoLoadLimit(settings, "matrix")).toBe(0);
    expect(mediaAutoLoadLimit(settings, "telegram")).toBe(Number.POSITIVE_INFINITY);
    expect(mediaAutoLoadLimit(settings, "stoat")).toBe(1024 * 1024);
    expect(mediaAutoLoadLimit(settings, "fluxer")).toBe(10 * 1024 * 1024);
    expect(mediaAutoLoadLimit(DEFAULT_SETTINGS, "fluxer")).toBe(5 * 1024 * 1024);
  });
});

describe("settings modules declare for their services", () => {
  const FIELDS: ServiceSettingField[] = [
    { kind: "toggle", key: "typing", label: "Send typing notices", default: true },
    { kind: "choice", key: "theme", label: "Theme", hint: "Colours", options: [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }], default: "light" },
    { kind: "action", key: "forget", label: "Forget", confirm: "Sure?" },
  ];

  it("checks the fields a manifest declares", () => {
    expect(isServiceSettingFields(FIELDS)).toBe(true);
    expect(isServiceSettingFields([])).toBe(true);
    const toggle = FIELDS[0]!;
    const choice = FIELDS[1] as Extract<ServiceSettingField, { kind: "choice" }>;
    for (const bad of [
      "x",
      [null],
      [toggle, toggle],
      [{ ...toggle, key: "Bad-Key" }],
      [{ ...toggle, label: " " }],
      [{ ...toggle, hint: "x".repeat(301) }],
      [{ ...toggle, default: "yes" }],
      [{ ...choice, default: "blue" }],
      [{ ...choice, options: [choice.options[0]] }],
      [{ ...choice, options: "light" }],
      [{ ...choice, options: [...choice.options, { value: "Not Ok", label: "x" }] }],
      [{ ...choice, options: [...choice.options, { value: "ok", label: "" }] }],
      [{ ...choice, options: Array.from({ length: 17 }, (_, i) => ({ value: `v${i}`, label: "V" })), default: "v0" }],
      [{ kind: "action", key: "a", label: "A", confirm: "" }],
      [{ kind: "text", key: "a", label: "A" }],
      Array.from({ length: MAX_SERVICE_FIELDS + 1 }, (_, i) => ({ ...toggle, key: `k${i}` })),
    ]) {
      expect(isServiceSettingFields(bad)).toBe(false);
    }
  });

  it("gives each toggle and choice its stored value when it fits, else the default; actions have none", () => {
    expect(serviceSettingValues(FIELDS, undefined)).toEqual({ typing: true, theme: "light" });
    expect(serviceSettingValues(undefined, { typing: false })).toEqual({});
    expect(serviceSettingValues(FIELDS, { typing: false, theme: "dark", forget: true, other: true })).toEqual({ typing: false, theme: "dark" });
    expect(serviceSettingValues(FIELDS, { typing: "no", theme: "blue" })).toEqual({ typing: true, theme: "light" });
    // Stored values never reach a module through the prototype.
    expect(serviceSettingValues(FIELDS, JSON.parse('{"__proto__": {"typing": false}}'))).toEqual({ typing: true, theme: "light" });
  });

  it("lets a patch change only declared toggles and choices, with fitting values", () => {
    expect(fitsServiceFields(FIELDS, { typing: false, theme: "dark" })).toBe(true);
    expect(fitsServiceFields(FIELDS, {})).toBe(true);
    for (const bad of [{ typing: "dark" }, { theme: true }, { theme: "blue" }, { forget: true }, { other: true }] as ServiceSettingValues[]) expect(fitsServiceFields(FIELDS, bad)).toBe(false);
    expect(fitsServiceFields(undefined, { typing: true })).toBe(false);
  });

  it("stores values leniently, patches them strictly and merges them per key", () => {
    const parsed = parseSettings({ services: { m: { notifications: true, options: { typing: false, theme: "dark", "Bad-Key": true, n: 5, s: "Not Ok" } }, e: { notifications: true, options: { "Bad-Key": true } }, f: { notifications: true, options: [] } } });
    expect(parsed.services).toEqual({ m: { notifications: true, options: { typing: false, theme: "dark" } }, e: { notifications: true }, f: { notifications: true } });
    const capped = parseSettings({ services: { m: { notifications: true, options: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, true])) } } });
    expect(Object.keys(capped.services.m!.options!)).toHaveLength(MAX_SERVICE_FIELDS);

    expect(isSettingsPatch({ services: { m: { options: { typing: false, theme: "dark" } } } })).toBe(true);
    for (const options of [[], { "Bad-Key": true }, { typing: 1 }, { theme: "Not Ok" }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, true]))]) {
      expect(isSettingsPatch({ services: { m: { options } } })).toBe(false);
    }
    const one = applySettingsPatch(DEFAULT_SETTINGS, { services: { m: { options: { typing: false } } } });
    expect(one.services.m).toEqual({ notifications: true, options: { typing: false } });
    const two = applySettingsPatch(one, { services: { m: { options: { theme: "dark" } } } });
    expect(two.services.m).toEqual({ notifications: true, options: { typing: false, theme: "dark" } });
    expect(applySettingsPatch(two, { services: { m: { notifications: false } } }).services.m).toEqual({ notifications: false, options: { typing: false, theme: "dark" } });
    const full = { ...DEFAULT_SETTINGS, services: { m: { notifications: true, options: Object.fromEntries(Array.from({ length: MAX_SERVICE_FIELDS }, (_, i) => [`k${i}`, true])) } } };
    const kept = applySettingsPatch(full, { services: { m: { options: { last: false } } } }).services.m!.options!;
    expect(Object.keys(kept)).toHaveLength(MAX_SERVICE_FIELDS);
    expect(kept).toMatchObject({ last: false });
    expect(kept).not.toHaveProperty("k0");
  });

  it("checks what a running service reports about its fields", () => {
    expect(isServiceSettingStatus({ forget: { text: "Remembered: a.org", disabled: false }, typing: {} })).toBe(true);
    for (const bad of [null, [], { "Bad-Key": {} }, { forget: "text" }, { forget: { text: 5 } }, { forget: { text: "x".repeat(MAX_STATUS_TEXT + 1) } }, { forget: { disabled: "no" } }, { forget: { html: "<b>" } }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, {}]))]) {
      expect(isServiceSettingStatus(bad)).toBe(false);
    }
    expect(isServiceSettingValues({ a: true, b: "x-1" })).toBe(true);
    expect(isServiceSettingValues(null)).toBe(false);
  });
});

describe("diagnosticsReport", () => {
  it("lists versions and every service's checks, failures with what they break", async () => {
    const { diagnosticsReport } = await import("../../src/shared/settings");
    const service = (moduleName: string, health?: { name: string; ok: boolean; detail?: string }[]) =>
      ({ id: moduleName.toLowerCase(), name: moduleName, url: "", module: "", moduleName, label: "", color: "", enabled: true, builtIn: true, health }) as never;
    expect(
      diagnosticsReport(
        {
          version: "1.2.3",
          services: [
            service("Discord", [
              { name: "Server list", ok: false, detail: "Rail" },
              { name: "Bridge", ok: true },
              { name: "Calls", ok: false },
            ]),
            service("Fluxer", [{ name: "Engine running", ok: true }]),
            service("Web"),
          ],
        },
        "win32 10.0",
      ),
    ).toBe(
      [
        "Multicord diagnostics",
        "Version: 1.2.3",
        "OS: win32 10.0",
        "",
        "## Discord (2 not working)",
        "- [FAILED] Server list — affects: Rail",
        "- [ok] Bridge",
        "- [FAILED] Calls",
        "",
        "## Fluxer (all working)",
        "- [ok] Engine running",
      ].join("\n"),
    );
    expect(diagnosticsReport({ version: "1", services: [] }, "linux")).toContain("No running service reports checks.");
  });
});
