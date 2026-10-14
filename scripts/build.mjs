import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const common = { bundle: true, sourcemap: true, target: "chrome140", logLevel: "info" };

mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });

await Promise.all([
  build({
    ...common,
    entryPoints: { main: "src/entries/main.ts" },
    platform: "node",
    format: "cjs",
    external: ["electron"],
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
      "engines/fluxer": "src/entries/engine-fluxer.ts",
      messages: "src/entries/messages.ts",
    },
    platform: "browser",
    format: "iife",
    outdir: "dist",
  }),
]);
