import { contextBridge, ipcRenderer } from "electron";
import { startDiscordPreload } from "../preload/discord/index";

startDiscordPreload(ipcRenderer, document, window, (func, args) => contextBridge.executeInMainWorld({ func, args }));
