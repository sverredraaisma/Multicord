import { GenericWebAdapter } from "../adapters/genericWebAdapter";
import type { PlatformModule } from "./types";

/** Any web client in its own partition: one rail entry, unread state from the page title. */
export const webModule: PlatformModule = {
  manifest: {
    id: "web",
    name: "Web app",
    label: "Web",
    color: "#80848e",
    configurable: true,
  },
  load({ def, view }) {
    const adapter = new GenericWebAdapter(def);
    view.webContents.on("page-title-updated", (_event, title) => adapter.updateTitle(title));
    return { adapter, start: () => void view.webContents.loadURL(def.url) };
  },
};
