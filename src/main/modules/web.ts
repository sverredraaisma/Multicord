import { GenericWebAdapter } from "../adapters/genericWebAdapter";
import type { ModuleManifest, PlatformModule } from "./types";

/** Where a web app's service answers on its own instance, for Settings > Diagnostics. */
export interface WebServiceCheck {
  name: string;
  /** An absolute path on the configured address's host, e.g. "/api/". */
  path: string;
}

/**
 * A platform's own web client in its own partition: one rail entry, unread
 * state from the page title. The page stays sandboxed with no preload. With
 * `check`, the shell asks that path on the service's own host now and
 * then (without its cookies) whether the service answers.
 */
export function webClientModule(options: Pick<ModuleManifest, "id" | "name" | "label" | "color"> & { defaultUrl?: string; check?: WebServiceCheck }): PlatformModule {
  const { check, ...manifest } = options;
  return {
    manifest: { ...manifest, configurable: true },
    load({ def, view, reach }) {
      const service = check && reach ? { name: check.name, url: new URL(check.path, def.url).href, breaks: "The web app may not load or connect.", reach } : undefined;
      const adapter = new GenericWebAdapter(def, service);
      view.webContents.on("page-title-updated", (_event, title) => adapter.updateTitle(title));
      return {
        adapter,
        start: () => {
          void view.webContents.loadURL(def.url);
          adapter.startChecks();
        },
      };
    },
  };
}

/** Any web chat app, at an address the user gives. */
export const webModule = webClientModule({ id: "web", name: "Web app", label: "Web", color: "#80848e" });

/**
 * Open-source platforms from the study, in their own web clients for now.
 * Each takes its public instance by default; self-hosted ones take their
 * own address. Those whose service is known check that it answers (Element
 * cannot: the homeserver is chosen inside it).
 */
/** Fluxer's own web client: for what the native client refuses (encrypted voice, DM calls, security keys). */
export const fluxerWebModule = webClientModule({ id: "fluxer-web", name: "Fluxer (web)", label: "Fluxer", color: "#4f8cf7", defaultUrl: "https://web.fluxer.app/" });
export const stoatModule = webClientModule({ id: "stoat", name: "Stoat (web)", label: "Stoat", color: "#ff5a5f", defaultUrl: "https://stoat.chat/app", check: { name: "Stoat's API answers", path: "/api/" } });
export const matrixModule = webClientModule({ id: "matrix", name: "Matrix (Element)", label: "Matrix", color: "#0dbd8b", defaultUrl: "https://app.element.io" });
export const spacebarModule = webClientModule({ id: "spacebar", name: "Spacebar", label: "Spacebar", color: "#7a5af8", defaultUrl: "https://app.spacebar.chat", check: { name: "Spacebar's API answers", path: "/api/ping" } });
export const nerimityModule = webClientModule({ id: "nerimity", name: "Nerimity", label: "Nerimity", color: "#4c93ff", defaultUrl: "https://nerimity.com/app", check: { name: "Nerimity's API answers", path: "/api/" } });
/**
 * Mumble, voice only, as the study plans for voice-first apps: its own
 * protocol needs raw TCP and UDP, which no module may open, so it runs in
 * mumble-web, at the address of the server's web client.
 */
export const mumbleModule = webClientModule({ id: "mumble", name: "Mumble (web)", label: "Mumble", color: "#e5a00d" });
