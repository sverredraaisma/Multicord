import { DISCORD } from "../../core/platforms";
import type { ModuleManifest } from "./types";

/**
 * Discord's manifest, apart from its desktop host code (discord.ts, which needs Electron), so the phone's
 * shell page can use it too (src/mobile/modules.ts).
 */
export const discordManifest: ModuleManifest = {
  id: "discord",
  name: "Discord",
  label: "Discord",
  color: "#5865f2",
  configurable: true,
  defaultUrl: DISCORD.url,
  fixedUrl: true,
  // The study's risk disclosure: honest, not alarmist.
  notice:
    "Multicord runs Discord's own web app, but hides parts of it and reads its data to show your servers and messages here. Discord's terms do not allow modified clients, so using Discord here carries some risk to your account.",
  preload: "preload-discord.js",
  protocols: ["discord"],
  // Discord's web client has push to talk, but only hears the key while focused.
  forwardPushToTalk: true,
  // Discord's own default keybinds for mute and deafen.
  voiceKeys: {
    toggleMute: { keyCode: "M", modifiers: ["commandOrControl", "shift"] },
    toggleDeafen: { keyCode: "D", modifiers: ["commandOrControl", "shift"] },
  },
};
