// The modules the phone app runs. Native ones run their logic in an engine
// and render in Multicord's own chat view; web-client ones are the service's
// own web app in a plain WebView of its own (no bridge, no scripts), its
// unread count read from the page title as on the desktop; Discord is
// Discord's own web app with the desktop's hooks ported (docs/mobile.md,
// section 3). Their manifests are the desktop's own (src/main/modules), which
// import nothing but types, core and the shared adapters.
import type { ModuleManifest } from "../core/modules";
import { discordManifest } from "../main/modules/discordManifest";
import { fluxerModule } from "../main/modules/fluxer";
import { matrixNativeModule } from "../main/modules/matrix";
import { nerimityNativeModule } from "../main/modules/nerimity";
import { spacebarNativeModule } from "../main/modules/spacebar";
import { stoatNativeModule } from "../main/modules/stoat";
import { telegramModule } from "../main/modules/telegram";
import { fluxerWebModule, matrixModule, nerimityModule, spacebarModule, stoatModule, webModule } from "../main/modules/web";
import type { ServiceSettingField } from "../shared/settings";

export interface MobileModule {
  manifest: ModuleManifest;
  /** A web-client module: the service's own web app in a WebView, rather than an engine and Multicord's chat view. */
  web?: true;
  /** Discord: its own web app in a WebView with the desktop's hooks (src/mobile/discordView.ts), reporting to a DiscordAdapter. */
  discord?: true;
  /**
   * Keys of the manifest's settings that native code applies to the service's WebViews, not the engine: they
   * go with the start command and, as they change, in a hostSettings command; engines never see them.
   */
  hostSettings?: string[];
}

/** Discord's web app as a computer's browser gets it, or as a phone's. */
export const DESKTOP_SITE: ServiceSettingField = {
  kind: "toggle",
  key: "desktopSite",
  label: "Desktop site",
  hint: "Load Discord's web app as a computer's browser gets it (a desktop user agent and client hints), which is the one Multicord's hooks are made for. Turn it off for the page Discord gives a phone's browser.",
  default: true,
};

/** Discord on the phone: the desktop's manifest, with the phone's own settings for its view. */
const DISCORD_MODULE: MobileModule = {
  manifest: { ...discordManifest, settings: [DESKTOP_SITE] },
  discord: true,
  hostSettings: [DESKTOP_SITE.key],
};

/** The web-client modules: Element, Stoat, Fluxer, Spacebar and Nerimity's own web apps, and any web app at an address the user gives. */
const WEB_MODULES: readonly MobileModule[] = [matrixModule, stoatModule, fluxerWebModule, spacebarModule, nerimityModule, webModule].map(({ manifest }) => ({ manifest, web: true }));

export const MOBILE_MODULES: readonly MobileModule[] = [
  DISCORD_MODULE,
  matrixNativeModule,
  fluxerModule,
  telegramModule,
  stoatNativeModule,
  spacebarNativeModule,
  nerimityNativeModule,
  ...WEB_MODULES,
];

/** What native code needs to run a module, which it never takes from the page. */
export interface NativeModuleSpec {
  id: string;
  /** The engine bundle, assets/web/engines/<engine>.js; none for a web-client module or Discord. */
  engine?: string;
  /** When set, the only hosts the engine may reach. */
  hosts?: string[];
  /** Keep the module's web storage on disk (an engine's IndexedDB; a web app's cookies and storage always). */
  storage: boolean;
  /** A web-client module: native code shows the service's own web app, with no bridge and nothing injected. */
  web?: true;
  /** Discord: native code shows Discord's own web app with the Discord view's scripts and listener. */
  discord?: true;
}

/** The table the build writes to dist/mobile/modules.json for native code. */
export function nativeModuleTable(modules: readonly MobileModule[] = MOBILE_MODULES): NativeModuleSpec[] {
  return modules.flatMap(({ manifest: { id, engine, hosts, storage }, web, discord }): NativeModuleSpec[] => {
    if (discord) return [{ id, storage: true, discord: true }];
    if (web) return [{ id, storage: true, web: true }];
    if (!engine) return [];
    const spec: NativeModuleSpec = { id, engine, storage: storage === true };
    if (hosts) spec.hosts = [...hosts];
    return [spec];
  });
}
