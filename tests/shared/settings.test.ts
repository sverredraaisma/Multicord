import { describe, expect, it } from "vitest";
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  isDeviceChoice,
  isServiceId,
  isSettingsAction,
  isSettingsPatch,
  parseSettings,
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
      { type: "restart" },
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
    ]) {
      expect(isSettingsAction(action)).toBe(false);
    }
    expect(isServiceId("a-1")).toBe(true);
  });
});
