import path from "node:path";
import { dialog, ipcMain, shell } from "electron";
import { isNativeAction, NATIVE_IPC } from "../../shared/native";
import { FluxerAdapter } from "../adapters/fluxerAdapter";
import { uploadSource } from "../files";
import { decideWindowOpen } from "../sessionPolicy";
import type { PlatformModule } from "./types";

/** Native Fluxer client: the main process talks to Fluxer; Multicord's own view renders it. */
export const fluxerModule: PlatformModule = {
  manifest: {
    id: "fluxer",
    name: "Fluxer",
    label: "Fluxer",
    color: "#4f8cf7",
    configurable: true,
    preload: "preload-native.js",
  },
  load({ def, view, window, dist, platform, services, secrets, enableScreenShare }) {
    const adapter = new FluxerAdapter({
      def,
      fetch: services.fetch,
      createSocket: services.createSocket,
      secrets,
      render: (state) => view.webContents.send(NATIVE_IPC.state, state),
      platform,
      files: {
        pick: async () => {
          const result = await dialog.showOpenDialog(window, { title: "Attach files", properties: ["openFile", "multiSelections"] });
          return result.canceled ? [] : result.filePaths;
        },
        open: uploadSource,
      },
    });
    ipcMain.on(NATIVE_IPC.action, (event, action) => {
      if (event.sender !== view.webContents || !isNativeAction(action)) return;
      adapter.handleAction(action).catch((error: Error) => console.warn(`[${def.id}] ${error.message}`));
    });
    // Our own page: links in messages open in the browser, never in the app.
    view.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      if (decideWindowOpen(url, "file:///") === "external") void shell.openExternal(url);
    });
    enableScreenShare(); // for voice
    return {
      adapter,
      start: () => {
        void view.webContents.loadFile(path.join(dist, "native.html"));
        void adapter.start();
      },
    };
  },
};
