import { describe, expect, it } from "vitest";
import type { ModuleRule } from "../../src/main/platforms";
import {
  addService,
  configEntries,
  keepsOneEnabled,
  newServiceId,
  removeService,
  renameService,
  setServiceEnabled,
} from "../../src/main/services";

const modules: ModuleRule[] = [
  { id: "discord", defaultUrl: "https://discord.com/app", fixedUrl: true },
  { id: "fluxer", defaultUrl: "https://fluxer.app" },
  { id: "web" },
];

describe("editing platforms.json", () => {
  it("starts over from anything but an array", () => {
    expect(configEntries({ broken: true })).toEqual([]);
    const raw = [{ id: "a" }];
    expect(configEntries(raw)).not.toBe(raw);
  });

  it("turns services off and on, adding an override entry when needed", () => {
    const off = setServiceEnabled([], "fluxer", false);
    expect(off).toEqual([{ id: "fluxer", enabled: false }]);
    expect(setServiceEnabled(off, "fluxer", true)).toEqual([{ id: "fluxer" }]);
    const hand = [{ id: "el", name: "Element", url: "https://app.element.io", custom: 1 }];
    expect(setServiceEnabled(hand, "el", false)).toEqual([{ ...hand[0], enabled: false }]);
    expect(hand[0]).not.toHaveProperty("enabled"); // the input is not changed
  });

  it("renames services", () => {
    expect(renameService([null, { id: "discord" }], "discord", "  Personal ")).toEqual([null, { id: "discord", name: "Personal" }]);
  });

  it("removes user services but never built-ins", () => {
    const raw = [{ id: "discord", enabled: false }, { id: "el", name: "E", url: "https://e.example" }];
    expect(removeService(raw, "el")).toEqual([{ id: "discord", enabled: false }]);
    expect(removeService(raw, "discord")).toEqual(raw);
  });
});

describe("new service ids", () => {
  it("slugs the name and avoids taken ids", () => {
    expect(newServiceId("My Server!", "web", new Set())).toBe("my-server");
    expect(newServiceId("Discord", "discord", new Set(["discord", "discord-2"]))).toBe("discord-3");
    expect(newServiceId("日本", "web", new Set())).toBe("web");
    expect(newServiceId("Ünïcode", "web", new Set())).toBe("unicode");
  });
});

describe("adding services", () => {
  it("adds a second Discord account at Discord's address", () => {
    const result = addService([], { module: "discord", name: " Work " }, modules);
    expect(result).toEqual({ ok: true, id: "work", raw: [{ id: "work", name: "Work", module: "discord" }] });
  });

  it("adds a web app with its address and a free id", () => {
    const raw = [{ id: "element", name: "E", url: "https://e.example" }, "junk"];
    const result = addService(raw, { module: "web", name: "Element", url: " https://app.element.io " }, modules);
    expect(result).toMatchObject({ ok: true, id: "element-2" });
    if (result.ok) expect(result.raw.at(-1)).toEqual({ id: "element-2", name: "Element", module: "web", url: "https://app.element.io" });
  });

  it("does not reuse a built-in id", () => {
    expect(addService([], { module: "fluxer", name: "Fluxer" }, modules)).toMatchObject({ ok: true, id: "fluxer-2" });
  });

  it("reports what is wrong with the new service", () => {
    expect(addService([], { module: "web", name: "Element" }, modules)).toEqual({ ok: false, error: "url must be an https URL" });
    expect(addService([], { module: "web", name: "Element", url: "http://x.example" }, modules)).toEqual({ ok: false, error: "url must be an https URL" });
  });
});

describe("keeping a service on", () => {
  it("knows when nothing would be on", () => {
    expect(keepsOneEnabled([{ id: "discord", enabled: false }], modules)).toBe(true);
    expect(keepsOneEnabled([{ id: "discord", enabled: false }, { id: "fluxer", enabled: false }], modules)).toBe(false);
    expect(
      keepsOneEnabled([{ id: "discord", enabled: false }, { id: "fluxer", enabled: false }, { id: "w", name: "W", module: "discord" }], modules),
    ).toBe(true);
  });
});
