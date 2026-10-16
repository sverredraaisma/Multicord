import { ipcMain, type IpcMainEvent } from "electron";
import { IPC, isDiscordPage, isDiscordState, isRelayedNotification } from "../../shared/ipc";
import { DiscordAdapter } from "../adapters/discordAdapter";
import { discordManifest } from "./discordManifest";
import type { PlatformModule } from "./types";

/** Discord's genuine web client as a hidden engine; its preload reports guilds, folders and DMs. */
export const discordModule: PlatformModule = {
  manifest: discordManifest,
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
