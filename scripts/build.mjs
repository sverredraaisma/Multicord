import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { telegramBrowser } from "./telegramBrowser.mjs";

const common = { bundle: true, sourcemap: true, target: "chrome140", logLevel: "info" };

mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });
// RNNoise's AudioWorklet script, loaded by native views for enhanced noise suppression.
mkdirSync("dist/audio", { recursive: true });
cpSync("node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise/workletProcessor.js", "dist/audio/rnnoise-worklet.js");
// LiveKit's end-to-end encryption worker, for encrypted Matrix calls; a file of our own, so native.html's CSP needs no blob: workers.
cpSync("node_modules/livekit-client/dist/livekit-client.e2ee.worker.js", "dist/livekit-e2ee-worker.js");

await Promise.all([
  build({
    ...common,
    entryPoints: { main: "src/entries/main.ts" },
    platform: "node",
    format: "cjs",
    // Shipped as a dependency; it loads its own platform-specific parts.
    external: ["electron", "electron-updater", "uiohook-napi", "@vencord/venmic"],
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
  // Module engines: sandboxed pages, served from dist/engines.
  build({
    ...common,
    entryPoints: { "engines/fluxer": "src/entries/engine-fluxer.ts", "engines/stoat": "src/entries/engine-stoat.ts" },
    platform: "browser",
    format: "iife",
    outdir: "dist",
  }),
  // Matrix bundles the crypto library's WebAssembly as bytes: the engine's origin serves nothing but its script.
  build({
    ...common,
    entryPoints: { "engines/matrix": "src/entries/engine-matrix.ts" },
    platform: "browser",
    format: "iife",
    outdir: "dist",
    loader: { ".wasm": "binary" },
    // The package's own loader builds a default URL from import.meta.url when imported; it is never fetched.
    define: { "import.meta.url": JSON.stringify("multicord-engine://matrix/engine.js") },
  }),
  build({
    ...common,
    entryPoints: { "engines/telegram": "src/entries/engine-telegram.ts" },
    platform: "browser",
    format: "iife",
    outdir: "dist",
    plugins: [telegramBrowser()],
    inject: ["scripts/telegramGlobals.mjs"],
    define: {
      // Telegram issues API credentials per app (my.telegram.org); without them users enter their own.
      __TELEGRAM_API_ID__: JSON.stringify(process.env.MULTICORD_TELEGRAM_API_ID ?? ""),
      __TELEGRAM_API_HASH__: JSON.stringify(process.env.MULTICORD_TELEGRAM_API_HASH ?? ""),
      __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync("package.json", "utf8")).version),
    },
  }),
]);
