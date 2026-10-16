import { describe, expect, it } from "vitest";
import { nextPage, regionStep } from "../../src/main/focusCycle";

const key = (key: string, more: Partial<{ type: string; shift: boolean; alt: boolean; meta: boolean }> = {}) => ({ type: "keyDown", key, shift: false, alt: false, meta: false, ...more });

describe("regionStep", () => {
  it("moves forward on F6 (and Ctrl+F6), back on Shift+F6", () => {
    expect(regionStep(key("F6"))).toBe(1);
    expect(regionStep(key("F6", { shift: true }))).toBe(-1);
  });

  it("ignores other keys, key-ups and Alt or Meta with F6", () => {
    expect(regionStep(key("F5"))).toBeUndefined();
    expect(regionStep(key("F6", { type: "keyUp" }))).toBeUndefined();
    expect(regionStep(key("F6", { alt: true }))).toBeUndefined();
    expect(regionStep(key("F6", { meta: true }))).toBeUndefined();
  });
});

describe("nextPage", () => {
  it("steps through the pages and wraps around", () => {
    expect(nextPage(["rail", "settings"], "rail", 1)).toBe("settings");
    expect(nextPage(["rail", "settings"], "settings", 1)).toBe("rail");
    expect(nextPage(["rail", "settings"], "rail", -1)).toBe("settings");
  });

  it("starts at an end from a page that is not on screen, and has nothing without pages", () => {
    expect(nextPage(["rail", "list", "service"], "gone", 1)).toBe("rail");
    expect(nextPage(["rail", "list", "service"], "gone", -1)).toBe("service");
    expect(nextPage([], "gone", 1)).toBeUndefined();
  });
});
