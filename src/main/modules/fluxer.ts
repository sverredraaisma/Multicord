import { FLUXER } from "../../core/platforms";
import type { PlatformModule } from "./types";

/**
 * Native Fluxer client. Its logic (login, gateway, REST, state) runs in the
 * sandboxed "fluxer" engine and renders in Multicord's own chat view; the
 * main process runs none of its code. Calls go through Fluxer's voice
 * servers (LiveKit), or, where others started one peer-to-peer and the user
 * allows it, straight between the people in it (Fluxer's mesh), with
 * signalling through the engine and only the STUN servers Fluxer names.
 */
export const fluxerModule: PlatformModule = {
  manifest: {
    id: "fluxer",
    name: "Fluxer",
    label: "Fluxer",
    color: "#4f8cf7",
    configurable: true,
    defaultUrl: FLUXER.url,
    usesVoiceSettings: true,
    preload: "preload-native.js",
    engine: "fluxer",
    home: true,
    screenShare: true,
    sendsTyping: true,
    peerToPeerCalls: true,
    capabilities: { directMessages: true, messagePreviews: true, voice: true, screenShare: true },
    settings: [
      {
        kind: "toggle",
        key: "relayOnly",
        label: "Calls through a relay only",
        hint: "Fluxer can connect a small call straight between the people in it, which shows them your IP address, and it has no relay for such calls. On, Multicord does not join them; off, it does, and the others see your public address. Applies from the next call you join.",
        default: true,
      },
    ],
  },
};
