import { ipcMain } from "electron";
import { IPC, isDiscordState } from "../../shared/ipc";
import { DiscordAdapter } from "../adapters/discordAdapter";
import type { PlatformModule } from "./types";

/** Discord's genuine web client as a hidden engine; its preload reports guilds, folders and DMs. */
export const discordModule: PlatformModule = {
  manifest: {
    id: "discord",
    name: "Discord",
    label: "Discord",
    color: "#5865f2",
    configurable: false,
    preload: "preload-discord.js",
  },
  load({ def, view, enableScreenShare }) {
    const adapter = new DiscordAdapter((target) => view.webContents.send(IPC.discordNavigate, target));
    ipcMain.on(IPC.discordState, (event, state) => {
      if (event.sender === view.webContents && isDiscordState(state)) adapter.update(state);
    });
    enableScreenShare();
    return { adapter, start: () => void view.webContents.loadURL(def.url) };
  },
};
