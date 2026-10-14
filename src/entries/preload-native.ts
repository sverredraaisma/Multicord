import { contextBridge, ipcRenderer } from "electron";
import { createNativeApi } from "../preload/native";

contextBridge.exposeInMainWorld("multicordNative", createNativeApi(ipcRenderer));
