import { contextBridge, ipcRenderer } from "electron";
import { createShellApi } from "../preload/shell";

contextBridge.exposeInMainWorld("multicord", createShellApi(ipcRenderer));
