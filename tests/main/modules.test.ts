import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../mocks/electron"));

import { configurableModules, findModule, MODULES } from "../../src/main/modules/index";

describe("module registry", () => {
  it("ships Discord, Fluxer and generic web modules", () => {
    expect(MODULES.map((m) => m.manifest.id)).toEqual(["discord", "fluxer", "web"]);
    expect(findModule("fluxer")!.manifest.label).toBe("Fluxer");
    expect(findModule("matrix")).toBeUndefined();
    expect(configurableModules()).toEqual([
      { id: "discord", defaultUrl: "https://discord.com/app", fixedUrl: true },
      { id: "fluxer", defaultUrl: "https://fluxer.app", fixedUrl: undefined },
      { id: "web", defaultUrl: undefined, fixedUrl: undefined },
    ]);
  });

  it("gives every module a label, colour and unique id", () => {
    const ids = new Set(MODULES.map((m) => m.manifest.id));
    expect(ids.size).toBe(MODULES.length);
    for (const { manifest } of MODULES) {
      expect(manifest.label.length).toBeGreaterThan(0);
      expect(manifest.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("module boundaries", () => {
  it("keeps the OS secret store and the credential file out of module code", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dirs = ["src/main/modules", "src/main/adapters", "src/main/fluxer"];
    for (const dir of dirs) {
      for (const name of fs.readdirSync(dir)) {
        const source = fs.readFileSync(path.join(dir, name), "utf8");
        expect(source, `${dir}/${name}`).not.toMatch(/safeStorage|credentials\.json|new CredentialStore/);
        expect(source, `${dir}/${name}`).not.toMatch(/import \{[^}]*\bCredentialStore\b[^}]*\} from/);
      }
    }
  });
});
