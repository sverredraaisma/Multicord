import { contextBridge, ipcRenderer } from "electron";
import { createSettingsApi } from "../preload/settings";

contextBridge.exposeInMainWorld("multicordSettings", createSettingsApi(ipcRenderer));
