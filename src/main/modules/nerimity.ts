import type { PlatformModule } from "./types";

/**
 * Native Nerimity client. Its logic (sign-in, the socket.io events, REST)
 * runs in the sandboxed "nerimity" engine and renders in Multicord's own
 * chat view. It declares no hosts, as Nerimity can be self-hosted: the
 * engine locks itself to the site's host and its CDN (cdn.<host>) at start.
 * The web-client module "nerimity" stays for existing configurations and
 * Nerimity's own client.
 */
export const nerimityNativeModule: PlatformModule = {
  manifest: {
    id: "nerimity-native",
    name: "Nerimity",
    label: "Nerimity",
    color: "#4c93ff",
    configurable: true,
    defaultUrl: "https://nerimity.com",
    preload: "preload-native.js",
    engine: "nerimity",
    home: true,
    sendsTyping: true,
    capabilities: { directMessages: true, messagePreviews: true, voice: false, screenShare: false },
  },
};
