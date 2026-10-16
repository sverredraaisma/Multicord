import { contextBridge, ipcRenderer } from "electron";
import { createFocusApi } from "../preload/focus";
import { createShellApi } from "../preload/shell";

contextBridge.exposeInMainWorld("multicord", createShellApi(ipcRenderer));
// F6 travel between the window's pages.
contextBridge.exposeInMainWorld("multicordFocus", createFocusApi(ipcRenderer));
