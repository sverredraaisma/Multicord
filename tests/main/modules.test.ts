import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => import("../mocks/electron"));

import { configurableModules, findModule, MODULES } from "../../src/main/modules/index";

describe("module registry", () => {
  it("ships Discord, Fluxer and generic web modules", () => {
    expect(MODULES.map((m) => m.manifest.id)).toEqual(["discord", "fluxer", "fluxer-web", "telegram", "matrix-native", "matrix", "stoat-native", "stoat", "spacebar-native", "spacebar", "nerimity-native", "nerimity", "mumble", "web"]);
    expect(findModule("fluxer")!.manifest.label).toBe("Fluxer");
    expect(findModule("irc")).toBeUndefined();
    expect(configurableModules()).toEqual([
      { id: "discord", defaultUrl: "https://discord.com/app", fixedUrl: true },
      { id: "fluxer", defaultUrl: "https://fluxer.app", fixedUrl: undefined },
      { id: "fluxer-web", defaultUrl: "https://web.fluxer.app/", fixedUrl: undefined },
      { id: "telegram", defaultUrl: "https://telegram.org", fixedUrl: true },
      { id: "matrix-native", defaultUrl: "https://matrix.org", fixedUrl: undefined },
      { id: "matrix", defaultUrl: "https://app.element.io", fixedUrl: undefined },
      { id: "stoat-native", defaultUrl: "https://stoat.chat", fixedUrl: undefined },
      { id: "stoat", defaultUrl: "https://stoat.chat/app", fixedUrl: undefined },
      { id: "spacebar-native", defaultUrl: "https://spacebar.chat", fixedUrl: undefined },
      { id: "spacebar", defaultUrl: "https://app.spacebar.chat", fixedUrl: undefined },
      { id: "nerimity-native", defaultUrl: "https://nerimity.com", fixedUrl: undefined },
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
    expect(native.map((m) => m.manifest.id)).toEqual(["fluxer", "matrix-native", "stoat-native", "nerimity-native"]);
    for (const { manifest } of native) {
      expect(manifest.usesVoiceSettings).toBe(true);
      expect(Boolean(manifest.screenShare)).toBe(Boolean(manifest.capabilities!.screenShare));
    }
  });

  it("marks peer-to-peer calls only on native modules that call", () => {
    for (const { manifest } of MODULES.filter((m) => m.manifest.peerToPeerCalls)) {
      expect(manifest.engine).toBeDefined();
      expect(manifest.capabilities?.voice).toBe(true);
    }
  });

  it("lets only native modules hold media back, those whose adapters use loadMedia keys", async () => {
    const holding = MODULES.filter((m) => m.manifest.holdsMedia);
    expect(holding.map((m) => m.manifest.id)).toEqual(["telegram", "matrix-native"]);
    for (const { manifest } of holding) expect(manifest.preload, manifest.id).toBe("preload-native.js");
  });

  it("declares the same capabilities in each native module's manifest as its adapter has", async () => {
    // The shell reads the manifest's, the engine's adapter reports its own: they must agree.
    const { templateModule } = await import("../../src/main/modules/_template");
    const native = [...MODULES, templateModule].filter((m) => m.manifest.engine);
    expect(native.map((m) => m.manifest.engine)).toEqual(["fluxer", "telegram", "matrix", "stoat", "spacebar", "nerimity", "template"]);
    for (const { manifest } of native) {
      const dir = manifest.engine === "template" ? "_template" : manifest.engine!;
      const { CAPABILITIES } = (await import(`../../src/modules/${dir}/adapter.ts`)) as { CAPABILITIES: unknown };
      expect(manifest.capabilities, manifest.id).toEqual(CAPABILITIES);
    }
  });

  it("declares well-formed settings, with the keys its code handles", async () => {
    const { isServiceSettingFields, TYPING_SETTING } = await import("../../src/shared/settings");
    for (const { manifest } of MODULES) expect(manifest.settings === undefined || isServiceSettingFields(manifest.settings), manifest.id).toBe(true);
    const keys = (id: string) => findModule(id)!.manifest.settings!.map((f) => f.key);
    const { SETTING } = await import("../../src/modules/matrix/adapter");
    // Typing comes from the shell, for modules that send typing indicators.
    expect(SETTING.typing).toBe(TYPING_SETTING);
    expect(findModule("matrix-native")!.manifest.sendsTyping).toBe(true);
    expect(keys("matrix-native")).toEqual(Object.values(SETTING).filter((key) => key !== TYPING_SETTING));
    const { FORGET_API_ID } = await import("../../src/modules/telegram/adapter");
    expect(keys("telegram")).toEqual([FORGET_API_ID]);
    const { RELAY_SETTING } = await import("../../src/modules/fluxer/adapter");
    expect(keys("fluxer")).toEqual([RELAY_SETTING]);
    expect(findModule("fluxer")!.manifest.peerToPeerCalls).toBe(true);
  });

  it("builds an engine bundle for every native module, and none for anything else", async () => {
    const fs = await import("node:fs");
    // scripts/build.mjs bundles each src/entries/engine-<id>.ts as dist/engines/<id>.js.
    const entries = fs.readdirSync("src/entries").flatMap((file) => /^engine-(.+)\.ts$/.exec(file)?.[1] ?? []).sort();
    const engines = [...new Set(MODULES.flatMap((m) => m.manifest.engine ?? []))].sort();
    expect(entries).toEqual(engines);
    for (const { manifest } of MODULES.filter((m) => m.manifest.engine)) {
      expect(manifest.engine, manifest.id).toMatch(/^[a-z0-9-]{1,32}$/);
      // The engine's view is Multicord's own chat view, which needs the native preload.
      expect(manifest.preload, manifest.id).toBe("preload-native.js");
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

  it("keeps the phone's shell page free of Electron and Node; from src/main it takes only modules' manifests and the web apps' and Discord's adapters", async () => {
    const fs = await import("node:fs");
    const manifests = /^\.\.\/main\/(modules\/(fluxer|matrix|nerimity|spacebar|stoat|telegram|web|discordManifest)|adapters\/(genericWebAdapter|discordAdapter))$/;
    for (const file of await filesUnder("src/mobile")) {
      for (const from of importsOf(fs.readFileSync(file, "utf8"))) {
        expect(from, file).toMatch(/^\.\.?\//);
        if (from.includes("/main/")) expect(from, file).toMatch(manifests);
      }
    }
    // Those manifests load nothing at run time but core; the web apps' module, only their adapter, which loads only shared code.
    const runtimeImports = (file: string) => fs.readFileSync(file, "utf8").split("\n").filter((line) => /^\s*import\b/.test(line) && !/^\s*import type\b/.test(line));
    for (const name of ["fluxer", "matrix", "nerimity", "spacebar", "stoat", "telegram"]) {
      for (const line of runtimeImports(`src/main/modules/${name}.ts`)) expect(line, name).toMatch(/from "\.\.\/\.\.\/core\//);
    }
    for (const line of runtimeImports("src/main/modules/web.ts")) expect(line, "web").toMatch(/from "\.\.\/adapters\/genericWebAdapter"/);
    for (const line of runtimeImports("src/main/adapters/genericWebAdapter.ts")) expect(line, "genericWebAdapter").toMatch(/from "\.\.\/\.\.\/shared\/(ipc|baseAdapter)"/);
    // Discord's manifest loads only core; its adapter, only shared code.
    for (const line of runtimeImports("src/main/modules/discordManifest.ts")) expect(line, "discordManifest").toMatch(/from "\.\.\/\.\.\/core\//);
    for (const from of importsOf(fs.readFileSync("src/main/adapters/discordAdapter.ts", "utf8"))) expect(from, "discordAdapter").toMatch(/^\.\.\/\.\.\/shared\//);
    // The phone's Discord page scripts take the desktop preload's Discord half, which is Electron-free (its entry is not).
    for (const file of await filesUnder("src/preload/discord")) {
      for (const from of importsOf(fs.readFileSync(file, "utf8"))) expect(from, file).toMatch(/^\.\.?\/(?!.*\/main\/)/);
    }
  });

  it("keeps core free of Electron, Node and main-process imports, so a mobile host can run it", async () => {
    const fs = await import("node:fs");
    const { builtinModules } = await import("node:module");
    const builtIn = new Set(builtinModules);
    for (const file of await filesUnder("src/core")) {
      for (const from of importsOf(fs.readFileSync(file, "utf8"))) {
        expect(from, file).toMatch(/^\.\.?\//);
        expect(from, file).not.toMatch(/^(electron|node:)|\/main\//);
        expect(builtIn.has(from), `${file}: ${from}`).toBe(false);
      }
      // Node's globals are as much Node as its imports.
      expect(fs.readFileSync(file, "utf8"), file).not.toMatch(/\b(process\.|Buffer\.|require\(|__dirname|NodeJS\.)/);
    }
  });
});
