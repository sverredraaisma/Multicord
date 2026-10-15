import type { PlatformModule } from "./types";

/**
 * Native Matrix client. Its logic (plain Client-Server API calls) runs in
 * the sandboxed "matrix" engine. Homeservers can be anywhere, so it declares
 * no hosts; the HTTP bridge still keeps it off local and private addresses.
 * End-to-end encryption keys stay in the engine's own storage on disk.
 * The web-view module "matrix" (Element) stays alongside it.
 */
export const matrixNativeModule: PlatformModule = {
  manifest: {
    id: "matrix-native",
    name: "Matrix",
    label: "Matrix",
    color: "#0dbd8b",
    configurable: true,
    defaultUrl: "https://matrix.org",
    // Calls run in the shared call view: the unified devices, processing, shortcuts and push-to-talk apply.
    usesVoiceSettings: true,
    preload: "preload-native.js",
    engine: "matrix",
    // Encryption keys live in the engine's own IndexedDB, kept on disk per instance.
    storage: true,
    home: true,
    screenShare: true,
    capabilities: { directMessages: true, messagePreviews: true, voice: true, screenShare: true },
  },
};
