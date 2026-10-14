import { ipcMain } from "electron";
import { IPC, isDiscordState, isRelayedNotification } from "../../shared/ipc";
import { DiscordAdapter } from "../adapters/discordAdapter";
import { DISCORD } from "../platforms";
import type { PlatformModule } from "./types";

/** Discord's genuine web client as a hidden engine; its preload reports guilds, folders and DMs. */
export const discordModule: PlatformModule = {
  manifest: {
    id: "discord",
    name: "Discord",
    label: "Discord",
    color: "#5865f2",
    configurable: true,
    defaultUrl: DISCORD.url,
    fixedUrl: true,
    preload: "preload-discord.js",
    protocols: ["discord"],
    // Discord's own default keybinds for mute and deafen.
    voiceKeys: {
      toggleMute: { keyCode: "M", modifiers: ["commandOrControl", "shift"] },
      toggleDeafen: { keyCode: "D", modifiers: ["commandOrControl", "shift"] },
    },
  },
  load({ def, view, enableScreenShare }) {
    const adapter = new DiscordAdapter(
      (target) => view.webContents.send(IPC.discordNavigate, target),
      def.id,
      (id) => view.webContents.send(IPC.discordNotificationClick, id),
      (update) => view.webContents.send(IPC.discordActivity, update),
    );
    ipcMain.on(IPC.discordState, (event, state) => {
      if (event.sender === view.webContents && isDiscordState(state)) adapter.update(state);
    });
    ipcMain.on(IPC.discordNotification, (event, notification) => {
      if (event.sender === view.webContents && isRelayedNotification(notification)) adapter.relayNotification(notification);
    });
    enableScreenShare();
    return { adapter, start: () => void view.webContents.loadURL(def.url) };
  },
};
