import { FLUXER } from "../platforms";
import type { PlatformModule } from "./types";

/**
 * Native Fluxer client. Its logic (login, gateway, REST, state) runs in the
 * sandboxed "fluxer" engine and renders in Multicord's own chat view; the
 * main process runs none of its code.
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
    capabilities: { directMessages: true, messagePreviews: true, voice: true, screenShare: true },
  },
};
