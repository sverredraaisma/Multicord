import { describe, expect, it } from "vitest";
import { configurableModules, findModule, type ModuleEntry } from "../../src/core/modules";

const modules: ModuleEntry[] = [
  { manifest: { id: "fixed", name: "Fixed", label: "F", color: "#000000", configurable: true, defaultUrl: "https://fixed.example", fixedUrl: true } },
  { manifest: { id: "builtin", name: "Built in", label: "B", color: "#000000", configurable: false } },
  { manifest: { id: "open", name: "Open", label: "O", color: "#000000", configurable: true } },
];

describe("module list", () => {
  it("finds a module by id", () => {
    expect(findModule("open", modules)).toBe(modules[2]);
    expect(findModule("none", modules)).toBeUndefined();
  });

  it("gives the address rules of the modules users may add", () => {
    expect(configurableModules(modules)).toEqual([
      { id: "fixed", defaultUrl: "https://fixed.example", fixedUrl: true },
      { id: "open", defaultUrl: undefined, fixedUrl: undefined },
    ]);
  });
});
