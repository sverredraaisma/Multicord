import { ipcRenderer } from "electron";
import { startDiscordPreload } from "../preload/discord/index";

startDiscordPreload(ipcRenderer, document, window);
