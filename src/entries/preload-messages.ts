import { contextBridge, ipcRenderer } from "electron";
import { createFocusApi } from "../preload/focus";
import { createMessagesApi } from "../preload/messages";

contextBridge.exposeInMainWorld("multicordMessages", createMessagesApi(ipcRenderer));
// F6 travel between the window's pages.
contextBridge.exposeInMainWorld("multicordFocus", createFocusApi(ipcRenderer));
