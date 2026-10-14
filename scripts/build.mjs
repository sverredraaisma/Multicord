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
    },
    platform: "browser",
    format: "cjs",
    external: ["electron"],
    outdir: "dist",
  }),
  build({
    ...common,
    entryPoints: { rail: "src/entries/rail.ts", picker: "src/entries/picker.ts" },
    platform: "browser",
    format: "iife",
    outdir: "dist",
  }),
]);
