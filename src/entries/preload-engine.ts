import { contextBridge, ipcRenderer } from "electron";
import { createEngineBridge } from "../preload/engine";

contextBridge.exposeInMainWorld("multicordEngine", createEngineBridge(ipcRenderer));
