import { contextBridge, ipcRenderer } from "electron";
import { createFocusApi } from "../preload/focus";
import { createSettingsApi } from "../preload/settings";

contextBridge.exposeInMainWorld("multicordSettings", createSettingsApi(ipcRenderer));
// F6 travel between the window's pages.
contextBridge.exposeInMainWorld("multicordFocus", createFocusApi(ipcRenderer));
