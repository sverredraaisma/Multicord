import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { telegramBrowser } from "./telegramBrowser.mjs";

// metafile: every bundle's inputs, for the third-party notice check at the end.
const common = { bundle: true, sourcemap: true, metafile: true, target: "chrome140", logLevel: "info" };

/**
 * Module engines: every src/entries/engine-<id>.ts becomes dist/engines/<id>.js,
 * served to sandboxed engine pages (see docs/modules.md). Ids follow the
 * rule the engine host enforces (src/main/engineHost.ts).
 */
const ENGINE_ID = /^[a-z0-9-]{1,32}$/;
const engineIds = readdirSync("src/entries")
  .map((file) => /^engine-(.+)\.ts$/.exec(file)?.[1])
  .filter((id) => id !== undefined)
  .sort();
for (const id of engineIds) if (!ENGINE_ID.test(id)) throw new Error(`Engine id "${id}" must be lowercase letters, digits or dashes`);

/** Build options beyond the defaults, for engines that need them. */
const engineOptions = {
  // Matrix bundles the crypto library's WebAssembly as bytes: the engine's origin serves nothing but its script.
  matrix: {
    loader: { ".wasm": "binary" },
    // The package's own loader builds a default URL from import.meta.url when imported; it is never fetched.
    define: { "import.meta.url": JSON.stringify("multicord-engine://matrix/engine.js") },
  },
  telegram: {
    plugins: [telegramBrowser()],
    // GramJS opens its sockets with the websocket package; this engine's go through the shell's relay instead.
    alias: { websocket: "./src/modules/telegram/websocket.ts" },
    inject: ["scripts/telegramGlobals.mjs"],
    define: {
      // Telegram issues API credentials per app (my.telegram.org); without them users enter their own.
      __TELEGRAM_API_ID__: JSON.stringify(process.env.MULTICORD_TELEGRAM_API_ID ?? ""),
      __TELEGRAM_API_HASH__: JSON.stringify(process.env.MULTICORD_TELEGRAM_API_HASH ?? ""),
      __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync("package.json", "utf8")).version),
    },
  },
};
for (const id of Object.keys(engineOptions)) if (!engineIds.includes(id)) throw new Error(`Build options for engine "${id}", which has no src/entries/engine-${id}.ts`);

mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });
// RNNoise's AudioWorklet script, loaded by native views for enhanced noise suppression.
mkdirSync("dist/audio", { recursive: true });
cpSync("node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise/workletProcessor.js", "dist/audio/rnnoise-worklet.js");
// LiveKit's end-to-end encryption worker, for encrypted Matrix calls; a file of our own, so native.html's CSP needs no blob: workers.
cpSync("node_modules/livekit-client/dist/livekit-client.e2ee.worker.js", "dist/livekit-e2ee-worker.js");

const results = await Promise.all([
  build({
    ...common,
    entryPoints: { main: "src/entries/main.ts" },
    platform: "node",
    format: "cjs",
    // Shipped as a dependency; it loads its own platform-specific parts.
    external: ["electron", "electron-updater", "uiohook-napi", "@vencord/venmic"],
    // The Public Suffix List (src/core/publicSuffix.ts) as its text.
    loader: { ".dat": "text" },
    outdir: "dist",
  }),
  // Sandboxed preloads can only require("electron"), so each is bundled into one file.
  build({
    ...common,
    entryPoints: {
      "preload-discord": "src/entries/preload-discord.ts",
      "preload-shell": "src/entries/preload-shell.ts",
      "preload-native": "src/entries/preload-native.ts",
      "preload-settings": "src/entries/preload-settings.ts",
      "preload-messages": "src/entries/preload-messages.ts",
      "preload-engine": "src/entries/preload-engine.ts",
      "preload-relay": "src/entries/preload-relay.ts",
    },
    platform: "browser",
    format: "cjs",
    external: ["electron"],
    outdir: "dist",
  }),
  build({
    ...common,
    entryPoints: {
      rail: "src/entries/rail.ts",
      picker: "src/entries/picker.ts",
      tooltip: "src/entries/tooltip.ts",
      unreachable: "src/entries/unreachable.ts",
      native: "src/entries/native.ts",
      gallery: "src/entries/gallery.ts",
      settings: "src/entries/settings.ts",
      messages: "src/entries/messages.ts",
    },
    platform: "browser",
    format: "iife",
    outdir: "dist",
    loader: { ".wasm": "binary" },
  }),
  // The phone app's shell page (mobile/android): src/core with the mobile glue, beside static/mobile.
  build({
    ...common,
    entryPoints: {
      "mobile/shell": "src/entries/mobile-shell.ts",
      // Discord's page on the phone: the main-world scripts, and the relay native code puts beside its message listener.
      "mobile/discord-page": "src/entries/mobile-discord-page.ts",
      "mobile/discord-relay": "src/entries/mobile-discord-relay.ts",
      // The USB camera in a page: Discord's and the chat views' (CameraPort.kt hands it the frames).
      "mobile/usb-camera": "src/entries/mobile-usb-camera.ts",
    },
    platform: "browser",
    format: "iife",
    outdir: "dist",
  }),
  // Module engines, one bundle each.
  ...engineIds.map((id) =>
    build({
      ...common,
      entryPoints: { [`engines/${id}`]: `src/entries/engine-${id}.ts` },
      platform: "browser",
      format: "iife",
      outdir: "dist",
      ...engineOptions[id],
    }),
  ),
]);

// The phone app's module table (engine, hosts, storage per module), which native code takes from here, never from the page.
const table = await build({ entryPoints: ["src/entries/mobile-modules.ts"], bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "warning" });
const { default: modules } = await import(`data:text/javascript;base64,${Buffer.from(table.outputFiles[0].text).toString("base64")}`);
writeFileSync("dist/mobile/modules.json", `${JSON.stringify(modules, null, 2)}\n`);
// The Public Suffix List, which native code reads for the voice-host rule as the desktop bundles it (src/core/publicSuffix.ts).
cpSync("src/core/publicsuffix/public_suffix_list.dat", "dist/mobile/public_suffix_list.dat");

// Third-party code in the bundles (and the two files copied above) goes out with its licence texts,
// in dist/THIRD_PARTY_LICENSES.txt; packages installed beside the app keep their own licence files.
// Every package the app ships either way must be named in NOTICE.md, so a new one is looked at first.
const packageDir = (file) => /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file.replace(/\\/g, "/"))?.[1];
const bundled = new Set(["node_modules/@sapphi-red/web-noise-suppressor", "node_modules/livekit-client"]);
for (const { metafile } of results) for (const input of Object.keys(metafile.inputs)) bundled.add(packageDir(input));
bundled.delete(undefined);
// livekit-client's own build carries these inside it.
for (const name of ["@livekit/mutex", "@bufbuild/protobuf", "events", "jose", "loglevel", "sdp", "sdp-transform", "tslib", "webrtc-adapter"]) bundled.add(`node_modules/${name}`);
const nameOf = (dir) => dir.replace(/^.*node_modules\//, "");
const texts = [...bundled]
  .map((dir) => ({ dir, pkg: JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) }))
  .sort((a, b) => nameOf(a.dir).localeCompare(nameOf(b.dir)) || a.pkg.version.localeCompare(b.pkg.version))
  .map(({ dir, pkg }) => {
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
    const text = file ? readFileSync(`${dir}/${file}`, "utf8").trim() : `The package has no licence file; its licence is ${pkg.license}. See NOTICE.md.`;
    return `${nameOf(dir)} ${pkg.version} (${pkg.license})\n\n${text}\n`;
  });
writeFileSync("dist/THIRD_PARTY_LICENSES.txt", `Third-party code bundled into Multicord, with its licences.\n\n${[...new Set(texts)].join(`\n${"=".repeat(72)}\n\n`)}`);
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const shipped = new Set([...bundled].map(nameOf));
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) shipped.add(name);
const notice = readFileSync("NOTICE.md", "utf8");
const unnamed = [...shipped].filter((name) => !notice.includes(`\`${name}\``)).sort();
if (unnamed.length > 0) throw new Error(`NOTICE.md does not name these shipped packages: ${unnamed.join(", ")}`);
