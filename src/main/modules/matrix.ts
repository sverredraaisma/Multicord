import type { PlatformModule } from "./types";

/**
 * Native Matrix client. Its logic (plain Client-Server API calls) runs in
 * the sandboxed "matrix" engine. Homeservers can be anywhere, so it declares
 * no hosts; the HTTP bridge still keeps it off local and private addresses.
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
    preload: "preload-native.js",
    engine: "matrix",
    home: true,
    capabilities: { directMessages: true, messagePreviews: true, voice: false, screenShare: false },
  },
};
