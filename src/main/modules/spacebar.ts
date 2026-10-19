import type { PlatformModule } from "./types";

/**
 * Native Spacebar client, for Spacebar's Discord-compatible API. Its logic
 * (sign-in, the gateway, REST) runs in the sandboxed "spacebar" engine and
 * renders in Multicord's own chat view. It declares no hosts: instances put
 * their API, gateway and CDN on hosts of their own, so the engine locks
 * itself to those once it has discovered them. Calls go through the
 * instance's voice server (src/webrtc, Discord's web-client WebRTC
 * protocol): the view connects to it, with signalling through the engine.
 * The web-client module "spacebar" stays for existing configurations and
 * Spacebar's own client.
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
    usesVoiceSettings: true,
    // Its voice server is named only when the user joins a call (VOICE_SERVER_UPDATE), after the lock: one host more for sockets, on the instance's own domain.
    voiceHost: "sibling",
    capabilities: { directMessages: true, messagePreviews: true, voice: true, screenShare: false },
  },
};
