import { TELEGRAM } from "../platforms";
import type { PlatformModule } from "./types";

/**
 * Native Telegram client for direct messages. Its logic (GramJS over
 * MTProto WebSockets) runs in the sandboxed "telegram" engine, which may
 * reach only Telegram's web endpoints.
 */
export const telegramModule: PlatformModule = {
  manifest: {
    id: "telegram",
    name: "Telegram",
    label: "Telegram",
    color: "#2aabee",
    configurable: true,
    defaultUrl: TELEGRAM.url,
    fixedUrl: true,
    preload: "preload-native.js",
    engine: "telegram",
    hosts: ["*.web.telegram.org"],
    home: true,
    capabilities: { directMessages: true, messagePreviews: true, voice: false, screenShare: false },
  },
};
