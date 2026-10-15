import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../../mocks/electron"));

import { templateModule } from "../../../src/main/modules/_template";
import { MODULES } from "../../../src/main/modules/index";
import { TemplateAdapter } from "../../../src/modules/_template/adapter";

describe("template module", () => {
  it("never ships: it is not registered and has no engine bundle entry", () => {
    expect(MODULES).not.toContain(templateModule);
    expect(MODULES.map((m) => m.manifest.id)).not.toContain(templateModule.manifest.id);
    expect(existsSync(`src/entries/engine-${templateModule.manifest.engine}.ts`)).toBe(false);
  });

  it("is a valid native manifest that matches its adapter", () => {
    const { manifest } = templateModule;
    expect(templateModule.load).toBeUndefined();
    expect(manifest.engine).toMatch(/^[a-z0-9-]{1,32}$/);
    expect(manifest.preload).toBe("preload-native.js");
    expect(manifest.color).toMatch(/^#[0-9a-f]{6}$/i);
    const adapter = new TemplateAdapter({ def: { id: "t", name: "T", url: manifest.defaultUrl! }, fetch, secrets: {} as never, render: () => {} });
    expect(manifest.capabilities).toEqual(adapter.capabilities);
  });
});
