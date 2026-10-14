import { contextBridge, ipcRenderer } from "electron";
import { createMessagesApi } from "../preload/messages";

contextBridge.exposeInMainWorld("multicordMessages", createMessagesApi(ipcRenderer));
