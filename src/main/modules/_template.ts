import type { PlatformModule } from "./types";

/**
 * The manifest of the example engine module in src/modules/_template. It is
 * deliberately not in MODULES and has no src/entries/engine-template.ts, so
 * it never ships; tests keep it compiling. Copy it for a new native module
 * (see docs/modules.md).
 */
export const templateModule: PlatformModule = {
  manifest: {
    id: "template",
    name: "Template",
    label: "Template",
    color: "#80848e",
    configurable: true,
    defaultUrl: "https://chat.example.org",
    preload: "preload-native.js",
    engine: "template",
    home: true,
    capabilities: { directMessages: true, messagePreviews: true, voice: false, screenShare: false },
  },
};
