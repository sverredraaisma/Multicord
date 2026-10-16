import type { PlatformModule } from "./types";

/**
 * Native Nerimity client. Its logic (sign-in, the socket.io events, REST)
 * runs in the sandboxed "nerimity" engine and renders in Multicord's own
 * chat view. It declares no hosts, as Nerimity can be self-hosted: the
 * engine locks itself to the site's host and its CDN (cdn.<host>) at start.
 * Calls are Nerimity's own peer-to-peer WebRTC: the view connects to each
 * person in a call, with signalling through the engine and only the TURN
 * and STUN servers Nerimity hands out. The web-client module "nerimity"
 * stays for existing configurations and Nerimity's own client.
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
    usesVoiceSettings: true,
    peerToPeerCalls: true,
    capabilities: { directMessages: true, messagePreviews: true, voice: true, screenShare: false },
    settings: [
      {
        kind: "toggle",
        key: "relayOnly",
        label: "Calls through a relay only",
        hint: "Nerimity's calls connect you straight to the others in them, which shows them your IP address. On, the call goes through Nerimity's relay (TURN) server instead, so they see only the relay's; it may add a little delay. Applies from the next call you join.",
        default: true,
      },
    ],
  },
};
