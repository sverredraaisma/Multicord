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
    // Media is downloaded (and decrypted) in the engine when the view asks.
    holdsMedia: true,
    capabilities: { directMessages: true, messagePreviews: true, voice: true, screenShare: true },
    // "Send typing indicators" comes from the shell, as SETTING.typing.
    sendsTyping: true,
    // Keys as SETTING in src/modules/matrix/adapter.ts names them (tested).
    settings: [
      {
        kind: "toggle",
        key: "readReceipts",
        label: "Send read receipts",
        hint: "Others in a room see how far you have read. Off, Multicord sends private receipts instead: your unread counts still clear on your other devices, but nobody else sees them.",
        default: true,
      },
      {
        kind: "toggle",
        key: "slidingSync",
        label: "Fast sync (sliding sync)",
        hint: "Starts faster by loading the most recent rooms first, when your homeserver offers sliding sync (MSC4186); otherwise Multicord uses classic sync. Turn it off to always use classic sync.",
        default: true,
      },
      {
        kind: "action",
        key: "forgetCallServices",
        label: "Forget call services",
        hint: "Calls reach only the call services your homeserver named and the call servers they sent you to, remembered from before. Forget them if your homeserver changed its call setup: they are looked up again now, and new ones work after a restart.",
        confirm: "Click again to forget",
      },
    ],
  },
};
