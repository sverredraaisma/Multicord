import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../mocks/electron"));

import { configurableModules, findModule, MODULES } from "../../src/main/modules/index";

describe("module registry", () => {
  it("ships Discord, Fluxer and generic web modules", () => {
    expect(MODULES.map((m) => m.manifest.id)).toEqual(["discord", "fluxer", "telegram", "matrix-native", "matrix", "stoat-native", "stoat", "spacebar", "nerimity", "mumble", "web"]);
    expect(findModule("fluxer")!.manifest.label).toBe("Fluxer");
    expect(findModule("irc")).toBeUndefined();
    expect(configurableModules()).toEqual([
      { id: "discord", defaultUrl: "https://discord.com/app", fixedUrl: true },
      { id: "fluxer", defaultUrl: "https://fluxer.app", fixedUrl: undefined },
      { id: "telegram", defaultUrl: "https://telegram.org", fixedUrl: true },
      { id: "matrix-native", defaultUrl: "https://matrix.org", fixedUrl: undefined },
      { id: "matrix", defaultUrl: "https://app.element.io", fixedUrl: undefined },
      { id: "stoat-native", defaultUrl: "https://stoat.chat", fixedUrl: undefined },
      { id: "stoat", defaultUrl: "https://stoat.chat/app", fixedUrl: undefined },
      { id: "spacebar", defaultUrl: "https://app.spacebar.chat", fixedUrl: undefined },
      { id: "nerimity", defaultUrl: "https://nerimity.com/app", fixedUrl: undefined },
      { id: "mumble", defaultUrl: undefined, fixedUrl: undefined },
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
    const dirs = ["src/main/modules", "src/main/adapters", "src/modules/fluxer", "src/modules/matrix", "src/modules/stoat", "src/engine"];
    for (const dir of dirs) {
      for (const name of fs.readdirSync(dir)) {
        const source = fs.readFileSync(path.join(dir, name), "utf8");
        expect(source, `${dir}/${name}`).not.toMatch(/safeStorage|credentials\.json|new CredentialStore/);
        expect(source, `${dir}/${name}`).not.toMatch(/import \{[^}]*\bCredentialStore\b[^}]*\} from/);
      }
    }
  });

  it("keeps engine code free of Electron, Node and main-process imports", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of [...walk("src/modules"), ...walk("src/engine")]) {
      const source = fs.readFileSync(file, "utf8");
      const imports = [...source.matchAll(/^import[^"]*"([^"]+)"/gm)].map((m) => m[1]!);
      for (const from of imports) {
        expect(from, file).not.toMatch(/^(electron|node:|fs$|path$|child_process$)|\/main\//);
      }
    }
  });
});
