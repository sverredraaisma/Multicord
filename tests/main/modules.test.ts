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

  it("gives every native module that calls the shared voice settings and screen-share picker", () => {
    const native = MODULES.filter((m) => m.manifest.preload === "preload-native.js" && m.manifest.capabilities?.voice);
    expect(native.map((m) => m.manifest.id)).toEqual(["fluxer", "matrix-native"]);
    for (const { manifest } of native) {
      expect(manifest.usesVoiceSettings).toBe(true);
      expect(Boolean(manifest.screenShare)).toBe(Boolean(manifest.capabilities!.screenShare));
    }
  });
});

/** Every file under these directories, however deep. */
async function filesUnder(...dirs: string[]): Promise<string[]> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  return dirs.flatMap(walk);
}

/** What a source file loads: static imports and re-exports, import(), require(). */
function importsOf(source: string): string[] {
  const patterns = [
    /^\s*(?:import|export)\b[^"'`;]*?\bfrom\s*["'`]([^"'`]+)["'`]/gm,
    /^\s*import\s*["'`]([^"'`]+)["'`]/gm,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\brequire\s*\(\s*["'`]([^"'`]+)["'`]/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1]!));
}

describe("module boundaries", () => {
  it("finds every way of loading code", () => {
    const source = [
      'import { a } from "electron";',
      "import type {\n  B,\n} from 'node:fs';",
      'export { c } from "../main/app";',
      'export * from "fs";',
      'import "path";',
      'const d = await import("child_process");',
      "const e = require(`node:os`);",
    ].join("\n");
    expect(importsOf(source)).toEqual(["electron", "node:fs", "../main/app", "fs", "path", "child_process", "node:os"]);
  });

  it("keeps the OS secret store and the credential file out of module code", async () => {
    const fs = await import("node:fs");
    for (const file of await filesUnder("src/main/modules", "src/main/adapters", "src/modules", "src/engine")) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/safeStorage|credentials\.json|new CredentialStore/);
      expect(source, file).not.toMatch(/\{[^}]*\bCredentialStore\b[^}]*\}\s*from/);
    }
  });

  it("keeps engine code free of Electron, Node and main-process imports", async () => {
    const fs = await import("node:fs");
    for (const file of await filesUnder("src/modules", "src/engine")) {
      for (const from of importsOf(fs.readFileSync(file, "utf8"))) {
        expect(from, file).not.toMatch(/^(electron|node:|fs$|path$|os$|child_process$|net$|http$|https$)|\/main\//);
      }
    }
  });
});
