import type { PlatformModule } from "./types";

/**
 * Native Spacebar client, for Spacebar's Discord-compatible API. Its logic
 * (sign-in, the gateway, REST) runs in the sandboxed "spacebar" engine and
 * renders in Multicord's own chat view. It declares no hosts: instances put
 * their API, gateway and CDN on hosts of their own, so the engine locks
 * itself to those once it has discovered them. The web-client module
 * "spacebar" stays for existing configurations and Spacebar's own client.
 */
export const spacebarNativeModule: PlatformModule = {
  manifest: {
    id: "spacebar-native",
    name: "Spacebar",
    label: "Spacebar",
    color: "#7a5af8",
    configurable: true,
    // spacebar.chat publishes where the official instance's API, CDN and gateway are.
    defaultUrl: "https://spacebar.chat",
    preload: "preload-native.js",
    engine: "spacebar",
    home: true,
    sendsTyping: true,
    capabilities: { directMessages: true, messagePreviews: true, voice: false, screenShare: false },
  },
};
