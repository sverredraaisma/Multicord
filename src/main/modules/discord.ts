import { ipcMain, type IpcMainEvent } from "electron";
import { IPC, isDiscordPage, isDiscordState, isRelayedNotification } from "../../shared/ipc";
import { DiscordAdapter } from "../adapters/discordAdapter";
import { DISCORD } from "../../core/platforms";
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
  },
  load({ def, view, enableScreenShare }) {
    const adapter = new DiscordAdapter(
      (target) => view.webContents.send(IPC.discordNavigate, target),
      def.id,
      (id) => view.webContents.send(IPC.discordNotificationClick, id),
      (update) => view.webContents.send(IPC.discordActivity, update),
    );
    // Only Discord's own page in this view speaks for Discord, not a site the view was led to.
    const fromDiscord = (event: IpcMainEvent): boolean => event.sender === view.webContents && isDiscordPage(event.senderFrame?.url);
    ipcMain.on(IPC.discordState, (event, state) => {
      if (fromDiscord(event) && isDiscordState(state)) adapter.update(state);
    });
    ipcMain.on(IPC.discordNotification, (event, notification) => {
      if (fromDiscord(event) && isRelayedNotification(notification)) adapter.relayNotification(notification);
    });
    view.webContents.on("did-finish-load", () => adapter.replayActivities());
    enableScreenShare();
    return { adapter, start: () => void view.webContents.loadURL(def.url) };
  },
};
