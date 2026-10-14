import { describe, expect, it, vi } from "vitest";
import { GlobalShortcuts, inputModifiers } from "../../src/main/shortcuts";

describe("GlobalShortcuts", () => {
  it("registers set shortcuts, reports taken or invalid ones, and replaces the set", () => {
    const callbacks = new Map<string, () => void>();
    const registry = {
      register: vi.fn((accelerator: string, callback: () => void) => {
        if (accelerator === "Bad") throw new Error("invalid accelerator");
        if (accelerator === "Ctrl+Shift+T") return false;
        callbacks.set(accelerator, callback);
        return true;
      }),
      unregister: vi.fn((accelerator: string) => void callbacks.delete(accelerator)),
    };
    const run = vi.fn();
    const shortcuts = new GlobalShortcuts(registry, run);
    expect(shortcuts.apply({ toggleMute: "Ctrl+Shift+M", toggleDeafen: "Ctrl+Shift+T", showApp: "Bad" })).toEqual(["toggleDeafen", "showApp"]);
    callbacks.get("Ctrl+Shift+M")!();
    expect(run).toHaveBeenCalledWith("toggleMute");
    expect(shortcuts.apply({ toggleMute: null, toggleDeafen: null, showApp: "F13" })).toEqual([]);
    expect(registry.unregister).toHaveBeenCalledWith("Ctrl+Shift+M");
    expect([...callbacks.keys()]).toEqual(["F13"]);
    shortcuts.clear();
    expect(callbacks.size).toBe(0);
  });

  it("maps page key modifiers to the OS", () => {
    const keys = { keyCode: "M", modifiers: ["commandOrControl", "shift"] as const };
    expect(inputModifiers({ ...keys, modifiers: [...keys.modifiers] }, "win32")).toEqual(["control", "shift"]);
    expect(inputModifiers({ ...keys, modifiers: [...keys.modifiers, "alt"] }, "darwin")).toEqual(["meta", "shift", "alt"]);
  });
});
