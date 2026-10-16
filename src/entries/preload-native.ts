import { contextBridge, ipcRenderer } from "electron";
import { createFocusApi } from "../preload/focus";
import { createNativeApi } from "../preload/native";

contextBridge.exposeInMainWorld("multicordNative", createNativeApi(ipcRenderer));
// F6 travel between the window's pages.
contextBridge.exposeInMainWorld("multicordFocus", createFocusApi(ipcRenderer));
