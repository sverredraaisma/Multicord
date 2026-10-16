// The modules the phone app runs. Native ones run their logic in an engine
// and render in Multicord's own chat view; web-client ones are the service's
// own web app in a plain WebView of its own (no bridge, no scripts), its
// unread count read from the page title as on the desktop. Their manifests
// are the desktop's own (src/main/modules), which import nothing but types,
// core and the shared adapters. Discord comes later (docs/mobile.md, phase 3).
import type { ModuleManifest } from "../core/modules";
import { fluxerModule } from "../main/modules/fluxer";
import { matrixNativeModule } from "../main/modules/matrix";
import { nerimityNativeModule } from "../main/modules/nerimity";
import { spacebarNativeModule } from "../main/modules/spacebar";
import { stoatNativeModule } from "../main/modules/stoat";
import { telegramModule } from "../main/modules/telegram";
import { fluxerWebModule, matrixModule, nerimityModule, spacebarModule, stoatModule, webModule } from "../main/modules/web";

export interface MobileModule {
  manifest: ModuleManifest;
  /** A web-client module: the service's own web app in a WebView, rather than an engine and Multicord's chat view. */
  web?: true;
}

/** The web-client modules: Element, Stoat, Fluxer, Spacebar and Nerimity's own web apps, and any web app at an address the user gives. */
const WEB_MODULES: readonly MobileModule[] = [matrixModule, stoatModule, fluxerWebModule, spacebarModule, nerimityModule, webModule].map(({ manifest }) => ({ manifest, web: true }));

export const MOBILE_MODULES: readonly MobileModule[] = [
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
  /** The engine bundle, assets/web/engines/<engine>.js; none for a web-client module. */
  engine?: string;
  /** When set, the only hosts the engine may reach. */
  hosts?: string[];
  /** Keep the module's web storage on disk (an engine's IndexedDB; a web app's cookies and storage always). */
  storage: boolean;
  /** A web-client module: native code shows the service's own web app, with no bridge and nothing injected. */
  web?: true;
}

/** The table the build writes to dist/mobile/modules.json for native code. */
export function nativeModuleTable(modules: readonly MobileModule[] = MOBILE_MODULES): NativeModuleSpec[] {
  return modules.flatMap(({ manifest: { id, engine, hosts, storage }, web }): NativeModuleSpec[] => {
    if (web) return [{ id, storage: true, web: true }];
    if (!engine) return [];
    const spec: NativeModuleSpec = { id, engine, storage: storage === true };
    if (hosts) spec.hosts = [...hosts];
    return [spec];
  });
}
