import type { PlatformModule } from "./types";

/**
 * Native Stoat (formerly Revolt) client. Its logic (sign-in, the events
 * WebSocket, REST) runs in the sandboxed "stoat" engine and renders in
 * Multicord's own chat view. Like Fluxer it declares no hosts: self-hosted
 * instances put their API, events and file servers on hosts of their own,
 * so the shell's general engine rules (https/wss to public addresses only)
 * apply. The web-client module "stoat" stays for existing configurations.
 */
export const stoatNativeModule: PlatformModule = {
  manifest: {
    id: "stoat-native",
    name: "Stoat",
    label: "Stoat",
    color: "#ff5a5f",
    configurable: true,
    defaultUrl: "https://stoat.chat",
    preload: "preload-native.js",
    engine: "stoat",
    home: true,
    capabilities: { directMessages: true, messagePreviews: true, voice: false, screenShare: false },
  },
};
