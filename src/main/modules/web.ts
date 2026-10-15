import { GenericWebAdapter } from "../adapters/genericWebAdapter";
import type { ModuleManifest, PlatformModule } from "./types";

/**
 * A platform's own web client in its own partition: one rail entry, unread
 * state from the page title. The page stays sandboxed with no preload.
 */
export function webClientModule(manifest: Pick<ModuleManifest, "id" | "name" | "label" | "color"> & { defaultUrl?: string }): PlatformModule {
  return {
    manifest: { ...manifest, configurable: true },
    load({ def, view }) {
      const adapter = new GenericWebAdapter(def);
      view.webContents.on("page-title-updated", (_event, title) => adapter.updateTitle(title));
      return { adapter, start: () => void view.webContents.loadURL(def.url) };
    },
  };
}

/** Any web chat app, at an address the user gives. */
export const webModule = webClientModule({ id: "web", name: "Web app", label: "Web", color: "#80848e" });

/**
 * Open-source platforms from the study, in their own web clients for now.
 * Each takes its public instance by default; self-hosted ones take their
 * own address.
 */
/** Fluxer's own web client: for what the native client refuses (encrypted voice, DM calls, security keys). */
export const fluxerWebModule = webClientModule({ id: "fluxer-web", name: "Fluxer (web)", label: "Fluxer", color: "#4f8cf7", defaultUrl: "https://web.fluxer.app/" });
export const stoatModule = webClientModule({ id: "stoat", name: "Stoat (web)", label: "Stoat", color: "#ff5a5f", defaultUrl: "https://stoat.chat/app" });
export const matrixModule = webClientModule({ id: "matrix", name: "Matrix (Element)", label: "Matrix", color: "#0dbd8b", defaultUrl: "https://app.element.io" });
export const spacebarModule = webClientModule({ id: "spacebar", name: "Spacebar", label: "Spacebar", color: "#7a5af8", defaultUrl: "https://app.spacebar.chat" });
export const nerimityModule = webClientModule({ id: "nerimity", name: "Nerimity", label: "Nerimity", color: "#4c93ff", defaultUrl: "https://nerimity.com/app" });
/**
 * Mumble, voice only, as the study plans for voice-first apps: its own
 * protocol needs raw TCP and UDP, which no module may open, so it runs in
 * mumble-web, at the address of the server's web client.
 */
export const mumbleModule = webClientModule({ id: "mumble", name: "Mumble (web)", label: "Mumble", color: "#e5a00d" });
